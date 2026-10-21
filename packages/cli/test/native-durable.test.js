import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { after, test } from "node:test";
import { NativeEngine, loadProjectConfig } from "../src/native/engine.js";
import { decodeSegment } from "../src/native/durable.js";

const directories = [];
after(async () => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))));

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "sobjects-durable-"));
  directories.push(directory);
  return directory;
}

// A bucket in memory with conditional PUTs; `hold` delays every PUT until released.
class MemoryBucket {
  objects = new Map();
  puts = 0;
  hold = null;
  failing = false;
  // Network latency per PUT; with none, nothing ever waits long enough to share an upload.
  latencyMs = 0;
  #version = 0;

  async list(prefix) {
    return [...this.objects].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, { etag, body }]) => ({ key, etag, size: body.length }));
  }

  async get(key) {
    const object = this.objects.get(key);
    return object ? { body: Buffer.from(object.body), etag: object.etag } : null;
  }

  // behavior(key) -> "ok" | "fail" | "ghost" (stored, but the response is lost).
  behavior = null;

  async put(key, body, { ifMatch, ifNoneMatch } = {}) {
    if (this.hold) await this.hold;
    const mode = this.behavior?.(key) ?? "ok";
    if (mode === "fail") throw new Error("S3 PUT failed: ECONNRESET");
    if (this.latencyMs) await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    if (this.failing) throw new Error("S3 PUT failed: ECONNREFUSED");
    this.puts += 1;
    const current = this.objects.get(key);
    if (ifNoneMatch === "*" && current) return null;
    if (ifMatch && current?.etag !== ifMatch) return null;
    const etag = `"${(this.#version += 1)}"`;
    this.objects.set(key, { body: Buffer.from(body), etag });
    if (mode === "ghost") throw new Error("S3 PUT timed out");
    return etag;
  }

  async delete(key) {
    this.objects.delete(key);
  }
}

const APP = `
import { DurableObject } from "cloudflare:workers";
export class Ledger extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS entries (seq INTEGER PRIMARY KEY, body TEXT)");
  }
  append(seq) {
    this.ctx.storage.sql.exec("INSERT INTO entries VALUES (?, ?)", seq, "x".repeat(seq % 500));
    this.ctx.storage.kv.put("last", seq);
    return seq;
  }
  read() {
    return { count: this.ctx.storage.sql.exec("SELECT count(*) AS n FROM entries").one().n, last: this.ctx.storage.kv.get("last") ?? null };
  }
  async later(ms, hangFirstRun = false) {
    if (hangFirstRun) this.ctx.storage.kv.put("hang", true);
    await this.ctx.storage.setAlarm(Date.now() + ms);
  }
  async alarm() {
    const runs = (this.ctx.storage.kv.get("runs") ?? 0) + 1;
    this.ctx.storage.kv.put("runs", runs);
    if (runs === 1 && this.ctx.storage.kv.get("hang")) await new Promise(() => {});
    this.ctx.storage.kv.put("fired", true);
  }
  fired() {
    return this.ctx.storage.kv.get("fired") ?? false;
  }
  runs() {
    return this.ctx.storage.kv.get("runs") ?? 0;
  }
}
export default { fetch: () => new Response("ok") };
`;

async function project() {
  const directory = await temporaryDirectory();
  await mkdir(join(directory, "src"));
  await writeFile(join(directory, "src/index.js"), APP);
  await writeFile(join(directory, "wrangler.json"), JSON.stringify({ name: "durable-app", main: "src/index.js", durable_objects: { bindings: [{ name: "LEDGER", class_name: "Ledger" }] } }));
  return directory;
}

async function engineFor(directory, bucket, { tuning = {}, persistDirectory, logs = [] } = {}) {
  const engine = new NativeEngine({
    config: await loadProjectConfig(directory),
    persistDirectory: persistDirectory ?? (await temporaryDirectory()),
    idleEvictMs: 0,
    backup: { client: bucket, prefix: "p", mode: "durable", tuning },
    log: (line) => logs.push(line),
  });
  await engine.start();
  return engine;
}

test("a write is acknowledged only once it is in the bucket", async () => {
  const directory = await project();
  const bucket = new MemoryBucket();
  const engine = await engineFor(directory, bucket);
  try {
    let release;
    bucket.hold = new Promise((resolve) => (release = resolve));
    let acknowledged = false;
    const pending = engine.env.LEDGER.getByName("a").append(1).then(() => (acknowledged = true));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(acknowledged, false, "the result waits for the bucket");
    // A read that follows waits too: it may reveal the write.
    let readDone = false;
    const reading = engine.env.LEDGER.getByName("a").read().then(() => (readDone = true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(readDone, false);
    bucket.hold = null;
    release();
    await pending;
    await reading;
    const segments = [...bucket.objects.keys()].filter((key) => key.endsWith(".seg"));
    assert.ok(segments.length >= 1);
    assert.match(segments[0], /^p\/native\/durable-app\/log\/t0\/[0-9a-f]{16}\/000000000001\.seg$/);
    assert.ok(decodeSegment(bucket.objects.get(segments[0]).body).some((entry) => entry.class === "Ledger"));
  } finally {
    await engine.close();
  }
});

test("writes from many objects share uploads, and a lost disk is rebuilt with every acknowledged write", async () => {
  const directory = await project();
  const bucket = new MemoryBucket();
  bucket.latencyMs = 10;
  const first = await engineFor(directory, bucket, { tuning: { snapshotTransactions: 25 } });
  const calls = [];
  for (let seq = 1; seq <= 60; seq += 1) for (const name of ["a", "b", "c", "d"]) calls.push(first.env.LEDGER.getByName(name).append(seq));
  await Promise.all(calls);
  await first.env.LEDGER.getByName("b").later(400);
  assert.ok(bucket.puts < calls.length, `${bucket.puts} uploads for ${calls.length} writes`);
  assert.ok([...bucket.objects.keys()].some((key) => key.includes("/snapshot-")), "snapshots were taken");
  // The node dies without closing anything; its disk is gone.
  const second = await engineFor(directory, bucket);
  try {
    assert.equal(second.restoredObjects, 4);
    for (const name of ["a", "b", "c", "d"]) assert.deepEqual(await second.env.LEDGER.getByName(name).read(), { count: 60, last: 60 });
    const deadline = Date.now() + 5_000;
    while (!(await second.env.LEDGER.getByName("b").fired())) {
      assert.ok(Date.now() < deadline, "the restored alarm fired");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    await second.close();
  }
});

test("compaction snapshots objects, closed ones included, and deletes covered segments", async () => {
  const directory = await project();
  const bucket = new MemoryBucket();
  const persistDirectory = await temporaryDirectory();
  const first = await engineFor(directory, bucket, { persistDirectory });
  for (let seq = 1; seq <= 10; seq += 1) await first.env.LEDGER.getByName("a").append(seq);
  await first.close();
  const segments = () => [...bucket.objects.keys()].filter((key) => key.endsWith(".seg"));
  assert.ok(segments().length > 0);
  // Restarted on the same disk: object "a" is closed but its log isn't covered by a snapshot yet.
  const second = await engineFor(directory, bucket, { persistDirectory });
  try {
    await second.durable.compact();
    assert.deepEqual(segments(), []);
    assert.ok([...bucket.objects.keys()].some((key) => key.includes("/snapshot-")));
  } finally {
    await second.close();
  }
  const third = await engineFor(directory, bucket);
  try {
    assert.deepEqual(await third.env.LEDGER.getByName("a").read(), { count: 10, last: 10 });
  } finally {
    await third.close();
  }
});

test("when the bucket stays down, the event fails instead of acknowledging, and the write ships later", async () => {
  const directory = await project();
  const bucket = new MemoryBucket();
  const engine = await engineFor(directory, bucket, { tuning: { gateTimeoutMs: 300 } });
  try {
    await engine.env.LEDGER.getByName("a").append(1);
    bucket.failing = true;
    await assert.rejects(engine.env.LEDGER.getByName("a").append(2), /could not be made durable/);
    bucket.failing = false;
    // The committed write wasn't lost: it reaches the bucket once it answers
    // (after the retry back-off, which can outlast this test's short gate).
    const [owned] = [...engine.namespaces[0].hosts()].map((host) => host.backupSource());
    const deadline = Date.now() + 15_000;
    for (;;) {
      const progress = engine.durable.progress(owned.className, owned.id);
      if (progress.captured === progress.shipped) break;
      assert.ok(Date.now() < deadline, "the failed write shipped once the bucket recovered");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await engine.env.LEDGER.getByName("a").append(3);
  } finally {
    await engine.close();
  }
  const restored = await engineFor(directory, bucket);
  try {
    assert.deepEqual(await restored.env.LEDGER.getByName("a").read(), { count: 3, last: 3 });
  } finally {
    await restored.close();
  }
});

// ---- regressions from the adversarial review -------------------------------

const NODE = fileURLToPath(new URL("./fixtures/durable-node.mjs", import.meta.url));

function runNode(directory, persist, bucketFile, step, args = [], env = {}) {
  const output = execFileSync(process.execPath, [NODE, directory, persist, bucketFile, step, ...args.map(String)], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(output.toString());
}

test("power loss: a WAL that lost acknowledged transactions is replaced by the bucket's copy", async () => {
  const directory = await project();
  const persist = await temporaryDirectory();
  const bucketFile = join(await temporaryDirectory(), "bucket.json");
  assert.deepEqual(runNode(directory, persist, bucketFile, "append", ["a", 1, 5]).read, { count: 5, last: 5 });
  // The machine lost power: the object's WAL never reached the disk.
  for (const name of readdirSync(join(persist, "objects", "Ledger"))) if (/-(wal|shm)$/.test(name)) rmSync(join(persist, "objects", "Ledger", name));
  const after = runNode(directory, persist, bucketFile, "append", ["a", 6, 6]);
  assert.deepEqual(after.read, { count: 6, last: 6 });
  assert.ok(after.logs.some((line) => line.includes("lost transactions")));
  assert.deepEqual(runNode(directory, await temporaryDirectory(), bucketFile, "read", ["a"]).read, { count: 6, last: 6 });
});

test("a node that lost its log state keeps numbering past the bucket's transactions", async () => {
  const directory = await project();
  const bucketFile = join(await temporaryDirectory(), "bucket.json");
  const env = { SNAPSHOT_TRANSACTIONS: "10" };
  runNode(directory, await temporaryDirectory(), bucketFile, "append", ["a", 1, 20], env);
  // A fresh disk restores, then loses its log state (a crash at the wrong moment).
  const persist = await temporaryDirectory();
  assert.deepEqual(runNode(directory, persist, bucketFile, "read", ["a"], env).read, { count: 20, last: 20 });
  for (const suffix of ["", "-wal", "-shm"]) rmSync(join(persist, `log-state.sqlite${suffix}`), { force: true });
  assert.deepEqual(runNode(directory, persist, bucketFile, "append", ["a", 21, 40], env).read, { count: 40, last: 40 });
  assert.deepEqual(runNode(directory, await temporaryDirectory(), bucketFile, "read", ["a"], env).read, { count: 40, last: 40 });
});

test("an alarm whose handler was cut off by a crash runs again", async () => {
  const directory = await project();
  const persist = await temporaryDirectory();
  const bucketFile = join(await temporaryDirectory(), "bucket.json");
  runNode(directory, persist, bucketFile, "hang-alarm", ["a"]);
  const after = runNode(directory, persist, bucketFile, "wait-alarm", ["a"]);
  assert.equal(after.fired, true);
  assert.equal(after.runs, 2);
});

test("a lost upload response never drops a later batch or reuses a segment key", async () => {
  const directory = await project();
  const bucket = new MemoryBucket();
  const engine = await engineFor(directory, bucket, { tuning: { gateTimeoutMs: 300 } });
  let segmentPuts = 0;
  // The first segment lands but its response is lost; the bucket then fails for a while.
  bucket.behavior = (key) => {
    if (!key.endsWith(".seg")) return "ok";
    segmentPuts += 1;
    if (segmentPuts === 1) return "ghost";
    return segmentPuts < 6 ? "fail" : "ok";
  };
  const acknowledged = [];
  await engine.env.LEDGER.getByName("a").append(1).then(() => acknowledged.push("a1"), () => {});
  await engine.env.LEDGER.getByName("b").append(1).then(() => acknowledged.push("b1"), () => {});
  for (let attempt = 0; attempt < 40 && acknowledged.length < 3; attempt += 1) {
    await engine.env.LEDGER.getByName("b").append(2 + attempt).then(() => acknowledged.push(`b${2 + attempt}`), () => {});
  }
  await engine.close();
  const restored = await engineFor(directory, bucket);
  try {
    const b = await restored.env.LEDGER.getByName("b").read();
    for (const label of acknowledged.filter((label) => label.startsWith("b"))) assert.ok(b.count >= Number(label.slice(1)), `${label} was acknowledged but b holds ${b.count}`);
    assert.equal((await restored.env.LEDGER.getByName("a").read()).count, 1);
  } finally {
    await restored.close();
  }
});

test("a failing snapshot doesn't stop shipping, and reads work again once the bucket recovers", async () => {
  const directory = await project();
  const bucket = new MemoryBucket();
  const engine = await engineFor(directory, bucket, { tuning: { gateTimeoutMs: 300, snapshotTransactions: 4 } });
  try {
    bucket.behavior = (key) => (key.includes("/snapshot-") ? "fail" : "ok");
    for (let seq = 1; seq <= 10; seq += 1) await engine.env.LEDGER.getByName("a").append(seq);
    bucket.behavior = () => "fail";
    await assert.rejects(engine.env.LEDGER.getByName("a").append(11), /could not be made durable/);
    bucket.behavior = null;
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        assert.equal((await engine.env.LEDGER.getByName("a").read()).count, 11);
        break;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  } finally {
    await engine.close();
  }
});

test("after a crash leaves transactions unshipped, no write is acknowledged until a snapshot covers the gap", async () => {
  const directory = await project();
  const persist = await temporaryDirectory();
  const bucketFile = join(await temporaryDirectory(), "bucket.json");
  const quick = { GATE_TIMEOUT_MS: "300" };
  assert.deepEqual(runNode(directory, persist, bucketFile, "append", ["a", 1, 1]).acked, [1]);
  // The bucket drops log uploads; the node crashes with two transactions unshipped.
  assert.deepEqual(runNode(directory, persist, bucketFile, "append", ["a", 2, 3], { ...quick, FAIL: "seg" }).acked, []);
  // Restarted, but snapshots fail: the gap stays, so a new write must not be acknowledged.
  assert.deepEqual(runNode(directory, persist, bucketFile, "append", ["a", 4, 4], { ...quick, FAIL: "snapshot" }).acked, []);
  // Everything works again: the snapshot covers the gap and writes are acknowledged.
  assert.deepEqual(runNode(directory, persist, bucketFile, "append", ["a", 5, 5]).acked, [5]);
  const restored = runNode(directory, await temporaryDirectory(), bucketFile, "read", ["a"]).read;
  assert.equal(restored.last, 5);
  assert.ok(restored.count >= 2, `restored ${restored.count} entries`);
});

test("durable mode refuses a store that ignores conditional writes", async () => {
  const directory = await project();
  const careless = new MemoryBucket();
  // Accepts every write, conditions or not.
  careless.put = async function (key, body) {
    this.objects.set(key, { body: Buffer.from(body), etag: `"${Math.random()}"` });
    return this.objects.get(key).etag;
  };
  await assert.rejects(engineFor(directory, careless), /doesn't honor conditional writes \(If-None-Match: \* replaced an existing key\)/);
});
