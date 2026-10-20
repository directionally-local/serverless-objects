import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadProjectConfig } from "../src/native/engine.js";
import { parseNativeDevArgs } from "../src/native/dev.js";
import { ThreadedEngine } from "../src/native/threads.js";

const directories = [];
after(async () => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))));

const APP = `
import { DurableObject } from "cloudflare:workers";
import { threadId } from "node:worker_threads";
export class Box extends DurableObject {
  where() { return threadId; }
  add(amount) {
    const value = (this.ctx.storage.kv.get("value") ?? 0) + amount;
    this.ctx.storage.kv.put("value", value);
    return value;
  }
  spin() { for (;;) {} }
  crash() { setTimeout(() => { throw new Error("boom"); }); return "ok"; }
  fail() { throw new RangeError("nope"); }
  async fetch(request) {
    return new Response(JSON.stringify({ thread: threadId, body: await request.text() }), { headers: { "x-box": "1" } });
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const box = env.BOX.getByName(url.searchParams.get("id") ?? "a");
    if (url.pathname === "/proxy") return box.fetch(new Request("http://box/", { method: "POST", body: "hello" }));
    try {
      return Response.json({ worker: threadId, result: await box[url.pathname.slice(1)](Number(url.searchParams.get("n") ?? 0)) });
    } catch (error) {
      return Response.json({ error: error.name + ": " + error.message }, { status: 500 });
    }
  },
};
`;

async function startEngine(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "sobjects-threads-"));
  directories.push(directory);
  await mkdir(join(directory, "src"));
  await writeFile(join(directory, "src/index.js"), APP);
  await writeFile(join(directory, "wrangler.json"), JSON.stringify({ name: "threads-app", main: "src/index.js", durable_objects: { bindings: [{ name: "BOX", class_name: "Box" }] } }));
  const logs = [];
  const engine = new ThreadedEngine({ config: await loadProjectConfig(directory), persistDirectory: join(directory, ".state"), threads: 3, idleEvictMs: 0, log: (line) => logs.push(line), ...options });
  await engine.start();
  const { port } = await engine.listen({ port: 0 });
  const get = async (path) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  return { engine, get, logs };
}

async function until(check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("objects live on one thread each, spread across threads, and are reached from any thread", async () => {
  const { engine, get } = await startEngine();
  try {
    const homes = new Map();
    const workers = new Set();
    for (let index = 0; index < 12; index += 1) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const { body } = await get(`/where?id=box-${index}`);
        workers.add(body.worker);
        if (homes.has(index)) assert.equal(body.result, homes.get(index), "an object stays on its thread");
        homes.set(index, body.result);
      }
    }
    assert.equal(new Set(homes.values()).size, 3, "objects are spread over all three threads");
    assert.equal(workers.size, 3, "requests are spread over all three threads");
    // State, errors and fetch bodies cross threads.
    assert.equal((await get("/add?id=counter&n=2")).body.result, 2);
    assert.equal((await get("/add?id=counter&n=3")).body.result, 5);
    assert.equal((await get("/fail?id=counter")).body.error, "RangeError: nope");
    const proxied = await get("/proxy?id=counter");
    assert.equal(proxied.body.body, "hello");
    assert.equal(proxied.headers.get("x-box"), "1");
  } finally {
    await engine.close();
  }
});

test("a stuck object stalls only its thread, which is replaced; its state survives", async () => {
  const { engine, get, logs } = await startEngine({ stallMs: 1_500 });
  try {
    await get("/add?id=stuck&n=7");
    const stuckThread = (await get("/where?id=stuck")).body.result;
    // An object on another thread.
    let other;
    for (let index = 0; !other; index += 1) {
      const { body } = await get(`/where?id=other-${index}`);
      if (body.result !== stuckThread) other = `other-${index}`;
    }
    const spinning = get("/spin?id=stuck").catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Requests whose Worker runs on another thread still reach other objects.
    await until(async () => (await get(`/add?id=${other}&n=1`)).status === 200);
    await until(async () => engine.restarts >= 1);
    assert.ok(logs.some((line) => /did not answer/.test(line)));
    await spinning;
    // The replacement thread loads the object from disk.
    assert.equal((await until(async () => {
      const { body } = await get("/add?id=stuck&n=1");
      return body.result;
    })), 8);
  } finally {
    await engine.close();
  }
});

test("a thread that crashes is replaced", async () => {
  const { engine, get, logs } = await startEngine();
  try {
    await get("/add?id=crashy&n=1");
    await get("/crash?id=crashy");
    await until(async () => engine.restarts >= 1);
    assert.ok(logs.some((line) => /boom/.test(line)));
    assert.equal((await until(async () => (await get("/add?id=crashy&n=1")).body.result)), 2);
  } finally {
    await engine.close();
  }
});

test("native dev parses the thread options", () => {
  const options = parseNativeDevArgs(["--threads", "4", "--thread-stall-seconds", "5", "--thread-memory-mb", "256"], "/tmp");
  assert.equal(options.threads, 4);
  assert.equal(options.threadStallSeconds, 5);
  assert.equal(options.threadMemoryMb, 256);
  assert.throws(() => parseNativeDevArgs(["--threads", "-1"], "/tmp"), /--threads must be/);
  assert.throws(() => parseNativeDevArgs(["--thread-memory-mb", "1"], "/tmp"), /16 or more/);
});
