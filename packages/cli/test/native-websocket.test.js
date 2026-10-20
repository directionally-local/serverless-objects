import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { FrameParser, WebSocketPair, acceptKey, encodeFrame } from "../src/native/websocket.js";
import { NativeEngine, loadProjectConfig } from "../src/native/engine.js";

const directories = [];
after(async () => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))));

function maskedFrame(opcode, payload, fin = true) {
  const mask = Buffer.from([1, 2, 3, 4]);
  const body = Buffer.from(payload);
  const masked = Buffer.from(body.map((byte, index) => byte ^ mask[index & 3]));
  const header = body.length < 126
    ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | body.length])
    : Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 126]), Buffer.from([body.length >> 8, body.length & 0xff])]);
  return Buffer.concat([header, mask, masked]);
}

test("the handshake key matches RFC 6455", () => {
  assert.equal(acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

test("frames are unmasked, reassembled across fragments and chunk boundaries, and checked", () => {
  const frames = [];
  const errors = [];
  const parser = new FrameParser((opcode, payload) => frames.push([opcode, payload.toString()]), (error) => errors.push(error.message));
  const data = Buffer.concat([
    maskedFrame(0x1, "hel", false),
    maskedFrame(0x9, "ping"),
    maskedFrame(0x0, "lo"),
    maskedFrame(0x2, "x".repeat(300)),
  ]);
  for (let offset = 0; offset < data.length; offset += 7) parser.push(data.subarray(offset, offset + 7));
  assert.deepEqual(frames, [[0x9, "ping"], [0x1, "hello"], [0x2, "x".repeat(300)]]);

  const strict = new FrameParser(() => {}, (error) => errors.push(error.message));
  strict.push(Buffer.from([0x81, 0x02, 0x68, 0x69]));
  assert.deepEqual(errors, ["client frames must be masked"]);
  const header = encodeFrame(0x1, Buffer.from("hi"));
  assert.deepEqual([...header], [0x81, 0x02, 0x68, 0x69]);
  assert.equal(encodeFrame(0x2, Buffer.alloc(70_000)).readBigUInt64BE(2), 70_000n);
});

test("pair ends deliver messages after accept(), keep attachments, and close both sides", async () => {
  const [client, server] = new WebSocketPair();
  const received = [];
  server.addEventListener("message", (event) => received.push(event.data));
  const closes = [];
  server.addEventListener("close", (event) => closes.push(["server", event.code, event.reason]));
  client.addEventListener("close", (event) => closes.push(["client", event.code, event.reason]));
  client.accept();
  client.send("early");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, []);
  server.accept();
  client.send(new Uint8Array([1, 2]));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(received[0], "early");
  assert.deepEqual([...new Uint8Array(received[1])], [1, 2]);

  server.serializeAttachment({ user: "a" });
  assert.deepEqual(server.deserializeAttachment(), { user: "a" });
  assert.equal(client.deserializeAttachment(), null);

  client.close(4000, "done");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(closes.sort(), [["client", 4000, "done"], ["server", 4000, "done"]]);
  assert.throws(() => client.send("late"), /after close/);
});

const APP = `
import { DurableObject } from "cloudflare:workers";

export class Room extends DurableObject {
  async fetch(request) {
    const [client, server] = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [new URL(request.url).searchParams.get("tag") ?? "none"]);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(socket, message) {
    if (message === "bye") return socket.close(4001, "asked");
    for (const peer of this.ctx.getWebSockets("lobby")) peer.send(\`\${this.ctx.getTags(socket)[0]}: \${message}\`);
  }
  async webSocketClose(socket, code, reason) {
    await this.ctx.storage.put("closed", { code, reason });
  }
  async closed() {
    return (await this.ctx.storage.get("closed")) ?? null;
  }
}

export default {
  async fetch(request, env) {
    const room = env.ROOM.getByName("main");
    if (new URL(request.url).pathname === "/closed") return Response.json(await room.closed());
    if (request.headers.get("upgrade") !== "websocket") return new Response("expected a WebSocket", { status: 426 });
    return room.fetch(request);
  },
};
`;

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.addEventListener("message", (event) => resolve(event.data), { once: true });
    socket.addEventListener("error", () => reject(new Error("socket error")), { once: true });
  });
}

test("Durable Objects accept hibernatable WebSockets through the engine", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sobjects-native-ws-"));
  directories.push(directory);
  await mkdir(join(directory, "src"));
  await writeFile(join(directory, "src/index.js"), APP);
  await writeFile(join(directory, "wrangler.json"), JSON.stringify({ name: "ws", main: "src/index.js", durable_objects: { bindings: [{ name: "ROOM", class_name: "Room" }] } }));
  const engine = new NativeEngine({ config: await loadProjectConfig(directory), persistDirectory: join(directory, ".state"), log: () => {} });
  await engine.start();
  const { port } = await engine.listen({ port: 0 });
  try {
    const plain = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(plain.status, 426);

    const a = new WebSocket(`ws://127.0.0.1:${port}/?tag=lobby`);
    const b = new WebSocket(`ws://127.0.0.1:${port}/?tag=lobby`);
    await Promise.all([a, b].map((socket) => new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }))));

    const pong = nextMessage(a);
    a.send("ping");
    assert.equal(await pong, "pong");

    const toA = nextMessage(a);
    const toB = nextMessage(b);
    b.send("hello");
    assert.deepEqual([await toA, await toB], ["lobby: hello", "lobby: hello"]);

    const closed = new Promise((resolve) => a.addEventListener("close", (event) => resolve([event.code, event.reason]), { once: true }));
    a.send("bye");
    assert.deepEqual(await closed, [4001, "asked"]);

    b.close(1000, "leaving");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/closed`)).json(), { code: 1000, reason: "leaving" });
  } finally {
    await engine.close();
  }
});
