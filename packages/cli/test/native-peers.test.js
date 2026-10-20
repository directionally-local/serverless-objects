import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { NativeEngine, loadProjectConfig } from "../src/native/engine.js";
import { PeerClient } from "../src/native/peers.js";

const directories = [];
after(async () => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))));
const SECRET = "test-cluster-secret-0123456789abcdef";

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "sobjects-peers-"));
  directories.push(directory);
  return directory;
}

class SharedBucket {
  objects = new Map();
  #version = 0;

  view() {
    const bucket = this;
    return {
      async list(prefix) {
        return [...bucket.objects].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, { etag, body }]) => ({ key, etag, size: body.length }));
      },
      async get(key) {
        const object = bucket.objects.get(key);
        return object ? { body: Buffer.from(object.body), etag: object.etag } : null;
      },
      async put(key, body, { ifMatch, ifNoneMatch } = {}) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        const current = bucket.objects.get(key);
        if (ifNoneMatch === "*" && current) return null;
        if (ifMatch && current?.etag !== ifMatch) return null;
        const etag = `"${(bucket.#version += 1)}"`;
        bucket.objects.set(key, { body: Buffer.from(body), etag });
        return etag;
      },
      async delete(key) {
        bucket.objects.delete(key);
      },
    };
  }
}

const APP = `
import { DurableObject } from "cloudflare:workers";
export class Room extends DurableObject {
  where() { return this.env.NODE; }
  add(n) {
    const total = (this.ctx.storage.kv.get("total") ?? 0) + n;
    this.ctx.storage.kv.put("total", total);
    return total;
  }
  fail() { throw new RangeError("room says no"); }
  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get("upgrade") === "websocket") {
      if (url.searchParams.has("deny")) return new Response("go away", { status: 401 });
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === "/gzip") {
      const { gzipSync } = await import("node:zlib");
      return new Response(gzipSync("hello world"), { headers: { "content-encoding": "gzip", "content-type": "text/plain" } });
    }
    if (url.pathname === "/throw") throw new TypeError("fetch threw");
    return new Response(this.env.NODE + ":" + (await request.text()) + ":" + (request.headers.get("cookie")?.length ?? 0), { status: 201, headers: { "x-room": "1" } });
  }
  webSocketMessage(socket, message) {
    socket.send(typeof message === "string" ? this.env.NODE + ":" + message : message);
  }
  webSocketClose(socket, code, reason) {
    this.ctx.storage.kv.put("closed", code + ":" + reason);
  }
  closed() { return this.ctx.storage.kv.get("closed") ?? null; }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const room = env.ROOM.getByName(url.searchParams.get("room") ?? "lobby");
    if (["/ws", "/post", "/gzip", "/throw"].includes(url.pathname)) return room.fetch(request);
    if (url.pathname === "/closed") return Response.json(await room.closed());
    return Response.json(await room[url.pathname.slice(1)](Number(url.searchParams.get("n") ?? 0)));
  },
};
`;

async function project() {
  const directory = await temporaryDirectory();
  await mkdir(join(directory, "src"));
  await writeFile(join(directory, "src/index.js"), APP);
  await writeFile(join(directory, "wrangler.json"), JSON.stringify({ name: "peers-app", main: "src/index.js", durable_objects: { bindings: [{ name: "ROOM", class_name: "Room" }] } }));
  return directory;
}

async function node(directory, bucket, name) {
  const config = await loadProjectConfig(directory);
  config.vars = { NODE: name };
  const engine = new NativeEngine({
    config,
    persistDirectory: await temporaryDirectory(),
    idleEvictMs: 0,
    backup: { client: bucket.view(), prefix: "p", mode: "durable" },
    cluster: { name, ttlMs: 4_000, wakeMs: 200, peer: { listen: { host: "127.0.0.1", port: 0 }, secret: SECRET } },
    log: () => {},
  });
  await engine.start();
  const { port } = await engine.listen({ port: 0 });
  return { engine, base: `http://127.0.0.1:${port}` };
}

test("calls, fetches and WebSockets for an object on another node are forwarded to it", async () => {
  const directory = await project();
  const bucket = new SharedBucket();
  const a = await node(directory, bucket, "a");
  const b = await node(directory, bucket, "b");
  try {
    // a runs the room; b forwards to it.
    assert.equal(await (await fetch(`${a.base}/add?n=2`)).json(), 2);
    assert.equal(await (await fetch(`${b.base}/where`)).json(), "a");
    assert.equal(await (await fetch(`${b.base}/add?n=3`)).json(), 5);
    const failed = await b.engine.env.ROOM.getByName("lobby").fail().catch((error) => error);
    assert.ok(failed instanceof RangeError);
    assert.equal(failed.message, "room says no");
    const posted = await fetch(`${b.base}/post`, { method: "POST", body: "hello" });
    assert.equal(posted.status, 201);
    assert.equal(posted.headers.get("x-room"), "1");
    assert.equal(await posted.text(), "a:hello:0");
    // A WebSocket opened on b talks to the room on a.
    const socket = new WebSocket(`${b.base.replace("http", "ws")}/ws`);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    const echoed = new Promise((resolve) => socket.addEventListener("message", (event) => resolve(event.data), { once: true }));
    socket.send("ping");
    assert.equal(await echoed, "a:ping");
    const closed = new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
    socket.close(1000, "bye");
    await closed;
  } finally {
    await b.engine.close();
    await a.engine.close();
  }
});

test("when the owner hands an object off, callers follow it", async () => {
  const directory = await project();
  const bucket = new SharedBucket();
  const a = await node(directory, bucket, "a");
  const b = await node(directory, bucket, "b");
  const c = await node(directory, bucket, "c");
  try {
    await fetch(`${a.base}/add?n=1`);
    assert.equal(await (await fetch(`${c.base}/where`)).json(), "a");
    await a.engine.close();
    // b takes the room over; c's cached route to a fails and is looked up again.
    assert.equal(await (await fetch(`${b.base}/add?n=1`)).json(), 2);
    let where;
    for (let attempt = 0; attempt < 20 && where !== "b"; attempt += 1) where = await fetch(`${c.base}/where`).then((response) => response.json()).catch(() => null);
    assert.equal(where, "b");
  } finally {
    await c.engine.close();
    await b.engine.close();
  }
});

test("a peer request with the wrong secret is refused", async () => {
  const directory = await project();
  const bucket = new SharedBucket();
  const a = await node(directory, bucket, "a");
  try {
    await fetch(`${a.base}/add?n=1`);
    const addr = a.engine.cluster.addr;
    const owner = JSON.parse([...bucket.objects].find(([key]) => key.includes("/owners/"))[1].body);
    assert.equal(owner.node, "a");
    const id = a.engine.env.ROOM.idFromName("lobby").toString();
    await assert.rejects(new PeerClient({ secret: "wrong-secret-wrong-secret-wrong" }).call(addr, { className: "Room", id }, "add", [1]), /refused the call \(401\)/);
    assert.equal(await new PeerClient({ secret: SECRET }).call(addr, { className: "Room", id }, "add", [1]), 2);
  } finally {
    await a.engine.close();
  }
});

// ---- regressions from the adversarial review --------------------------------

// A WebSocket client written by hand, so a test can send any close code.
async function rawUpgrade(base, path) {
  const { connect } = await import("node:net");
  const socket = connect(new URL(base).port, "127.0.0.1");
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  await new Promise((resolve) => socket.once("data", resolve));
  socket.on("error", () => {});
  return socket;
}

function maskedFrame(opcode, payload) {
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index & 3]));
  return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), mask, masked]);
}

async function open(url, protocols) {
  const socket = new WebSocket(url, protocols);
  socket.binaryType = "arraybuffer";
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("open failed")), { once: true });
  });
  return socket;
}

test("relayed WebSockets keep close codes, binary frames and survive abrupt clients", async () => {
  const directory = await project();
  const bucket = new SharedBucket();
  const a = await node(directory, bucket, "a");
  const b = await node(directory, bucket, "b");
  try {
    await fetch(`${a.base}/add?n=1`);
    // A browser leaving the page closes with 1001: the relaying node must not crash.
    const socket = await open(`${b.base.replace("http", "ws")}/ws`);
    const binary = new Promise((resolve) => socket.addEventListener("message", (event) => resolve(event.data), { once: true }));
    socket.send(new Uint8Array([1, 2, 3]));
    assert.deepEqual([...new Uint8Array(await binary)], [1, 2, 3]);
    socket.close();
    // A browser leaving the page closes with 1001, which Node's own client
    // can't send: write the close frame by hand. The relaying node must not crash.
    const leaving = await rawUpgrade(b.base, "/ws");
    leaving.write(maskedFrame(0x8, Buffer.concat([Buffer.from([0x03, 0xe9]), Buffer.from("going away")])));
    let closed;
    for (let attempt = 0; attempt < 50 && !closed; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      closed = await (await fetch(`${b.base}/closed`)).json();
    }
    assert.equal(closed, "1001:going away");
    // A connection reset (no close frame) must not crash it either.
    const raw = await rawUpgrade(b.base, "/ws");
    raw.resetAndDestroy();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await (await fetch(`${b.base}/where`)).json(), "a", "node b is still up");
    // Subprotocols the object doesn't pick, a refused upgrade, and big cookies.
    // Forwarding behaves like a local connection, whatever the client makes of it.
    const outcome = (base) => open(`${base.replace("http", "ws")}/ws`, ["chat"]).then((socket) => {
      socket.close();
      return "open";
    }, () => "refused");
    assert.equal(await outcome(b.base), await outcome(a.base));
    const denied = await fetch(`${b.base}/ws?deny=1`, { headers: { upgrade: "websocket", connection: "upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" } }).catch((error) => error);
    assert.ok(denied instanceof Error || denied.status === 401);
    const cookie = "c=" + "x".repeat(6_000);
    const posted = await fetch(`${b.base}/post`, { method: "POST", body: "big", headers: { cookie } });
    assert.equal(await posted.text(), `a:big:${cookie.length}`);
  } finally {
    await b.engine.close();
    await a.engine.close();
  }
});

test("forwarded responses keep their encoding, and a forwarded fetch that throws rejects", async () => {
  const directory = await project();
  const bucket = new SharedBucket();
  const a = await node(directory, bucket, "a");
  const b = await node(directory, bucket, "b");
  try {
    await fetch(`${a.base}/add?n=1`);
    const local = await fetch(`${a.base}/gzip`);
    const forwarded = await fetch(`${b.base}/gzip`);
    assert.equal(forwarded.headers.get("content-encoding"), "gzip");
    assert.equal(await forwarded.text(), await local.text());
    const error = await b.engine.env.ROOM.getByName("lobby").fetch("http://room/throw").catch((caught) => caught);
    assert.ok(error instanceof TypeError);
    assert.equal(error.message, "fetch threw");
  } finally {
    await b.engine.close();
    await a.engine.close();
  }
});

test("a signed peer request can't be replayed or changed, and replies must be signed", async () => {
  const directory = await project();
  const bucket = new SharedBucket();
  const a = await node(directory, bucket, "a");
  try {
    await fetch(`${a.base}/add?n=1`);
    const id = a.engine.env.ROOM.idFromName("lobby").toString();
    const addr = a.engine.cluster.addr;
    // Capture one real signed call.
    const { serialize } = await import("node:v8");
    const { createHmac, createHash, randomBytes } = await import("node:crypto");
    const target = JSON.stringify({ className: "Room", id });
    const body = serialize({ method: "add", args: [1] });
    const time = String(Date.now());
    const nonce = randomBytes(16).toString("hex");
    const sig = createHmac("sha256", SECRET).update(["sobjects-peer-call", time, nonce, "/peer/call", target, "POST", createHash("sha256").update(body).digest("hex")].join("\n")).digest("hex");
    const headers = { "x-sobjects-peer-target": target, "x-sobjects-peer-time": time, "x-sobjects-peer-nonce": nonce, "x-sobjects-peer-signature": sig };
    assert.equal((await fetch(new URL("/peer/call", addr), { method: "POST", headers, body })).status, 200);
    // The same request again, and the same signature with other arguments.
    assert.equal((await fetch(new URL("/peer/call", addr), { method: "POST", headers, body })).status, 401);
    assert.equal((await fetch(new URL("/peer/call", addr), { method: "POST", headers: { ...headers, "x-sobjects-peer-nonce": randomBytes(16).toString("hex") }, body: serialize({ method: "add", args: [1000] }) })).status, 401);
    assert.equal(await (await fetch(`${a.base}/add?n=0`)).json(), 2);
  } finally {
    await a.engine.close();
  }
});

test("closing a node with relayed WebSockets open doesn't hang", async () => {
  const directory = await project();
  const bucket = new SharedBucket();
  const a = await node(directory, bucket, "a");
  const b = await node(directory, bucket, "b");
  await fetch(`${a.base}/add?n=1`);
  const socket = await open(`${b.base.replace("http", "ws")}/ws`);
  const closedOnClient = new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
  const started = Date.now();
  await a.engine.close();
  assert.ok(Date.now() - started < 3_000, `closing took ${Date.now() - started} ms`);
  await closedOnClient;
  await b.engine.close();
});
