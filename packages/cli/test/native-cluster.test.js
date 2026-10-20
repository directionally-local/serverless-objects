import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { NativeEngine, loadProjectConfig } from "../src/native/engine.js";
import { decodeSegment } from "../src/native/durable.js";
import { parseNativeDevArgs } from "../src/native/dev.js";

const directories = [];
after(async () => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))));

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "sobjects-cluster-"));
  directories.push(directory);
  return directory;
}

// One bucket shared by several in-process nodes. Each node gets a view that
// can be cut off (a network partition) and healed.
class SharedBucket {
  objects = new Map();
  #version = 0;

  // hooks.get(key) / hooks.put(key) run before each request (to delay or fail it).
  view(hooks = {}) {
    const bucket = this;
    const view = {
      partitioned: false,
      async list(prefix) {
        view.check();
        return [...bucket.objects].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, { etag, body }]) => ({ key, etag, size: body.length }));
      },
      async get(key) {
        view.check();
        if (hooks.get) await hooks.get(key);
        const object = bucket.objects.get(key);
        return object ? { body: Buffer.from(object.body), etag: object.etag } : null;
      },
      async put(key, body, { ifMatch, ifNoneMatch } = {}) {
        view.check();
        if (hooks.put) await hooks.put(key);
        await new Promise((resolve) => setTimeout(resolve, 2));
        const current = bucket.objects.get(key);
        if (ifNoneMatch === "*" && current) return null;
        if (ifMatch && current?.etag !== ifMatch) return null;
        const etag = `"${(bucket.#version += 1)}"`;
        bucket.objects.set(key, { body: Buffer.from(body), etag });
        return etag;
      },
      async delete(key) {
        view.check();
        bucket.objects.delete(key);
      },
      check() {
        if (view.partitioned) throw new Error("S3 request failed: ETIMEDOUT");
      },
    };
    return view;
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
    this.ctx.storage.sql.exec("INSERT INTO entries VALUES (?, ?)", seq, "x".repeat(seq % 300));
    this.ctx.storage.kv.put("last", seq);
    return seq;
  }
  read() {
    return { count: this.ctx.storage.sql.exec("SELECT count(*) AS n FROM entries").one().n, last: this.ctx.storage.kv.get("last") ?? null };
  }
  async later(ms) {
    await this.ctx.storage.setAlarm(Date.now() + ms);
  }
  async alarm() {
    this.ctx.storage.kv.put("runs", (this.ctx.storage.kv.get("runs") ?? 0) + 1);
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
  await writeFile(join(directory, "wrangler.json"), JSON.stringify({ name: "cluster-app", main: "src/index.js", durable_objects: { bindings: [{ name: "LEDGER", class_name: "Ledger" }] } }));
  return directory;
}

async function node(directory, client, name, { ttlMs = 1_500, fences = [], logs = [] } = {}) {
  const engine = new NativeEngine({
    config: await loadProjectConfig(directory),
    persistDirectory: await temporaryDirectory(),
    idleEvictMs: 0,
    backup: { client, prefix: "p", mode: "durable", tuning: { gateTimeoutMs: 1_000 } },
    cluster: { name, ttlMs, wakeMs: 200, onFence: (reason) => fences.push(reason) },
    log: (line) => logs.push(`[${name}] ${line}`),
  });
  await engine.start();
  return engine;
}

async function until(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch {}
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("an object runs on one node at a time, and a clean shutdown hands it over at once", async () => {
  const directory = await project();
  const bucket = new SharedBucket();
  const a = await node(directory, bucket.view(), "a");
  const b = await node(directory, bucket.view(), "b");
  try {
    for (let seq = 1; seq <= 5; seq += 1) await a.env.LEDGER.getByName("x").append(seq);
    await assert.rejects(b.env.LEDGER.getByName("x").read(), /running on node a/);
    // Each node runs objects nobody else runs.
    await b.env.LEDGER.getByName("y").append(1);
    await assert.rejects(a.env.LEDGER.getByName("y").read(), /running on node b/);
    await a.close();
    const started = Date.now();
    assert.deepEqual(await b.env.LEDGER.getByName("x").read(), { count: 5, last: 5 });
    assert.ok(Date.now() - started < 1_000, "a released object is taken without waiting for the lease");
    await b.env.LEDGER.getByName("x").append(6);
    const owner = JSON.parse(bucket.objects.get([...bucket.objects.keys()].find((key) => key.includes("/owners/Ledger/"))).body);
    assert.ok(owner.epoch >= 1);
  } finally {
    await b.close();
  }
});

test("a node partitioned from the bucket stops acknowledging; its objects move, and its late writes are ignored", async () => {
  const directory = await project();
  const bucket = new SharedBucket();
  const aView = bucket.view();
  const fences = [];
  const a = await node(directory, aView, "a", { fences });
  const b = await node(directory, bucket.view(), "b");
  try {
    for (let seq = 1; seq <= 3; seq += 1) await a.env.LEDGER.getByName("x").append(seq);
    aView.partitioned = true;
    // a can't reach the bucket: its write is not acknowledged.
    await assert.rejects(a.env.LEDGER.getByName("x").append(4));
    // b takes the object over once a's lease runs out, with every acknowledged write.
    assert.deepEqual(await until(() => b.env.LEDGER.getByName("x").read(), 10_000), { count: 3, last: 3 });
    await until(() => fences.length > 0);
    // The partition heals: a's queued upload of seq 4 lands, under its old epoch.
    aView.partitioned = false;
    await until(() => [...bucket.objects.keys()].some((key) => key.includes("/log/a/") && decodeSegment(bucket.objects.get(key).body).some((entry) => entry.txid > 0 && entry.epoch === 1 && entry.pages.length > 0 && key)), 5_000).catch(() => {});
    await b.env.LEDGER.getByName("x").append(5);
    await b.close();
    // A third node takes over from b: seq 4 never appears.
    const c = await node(directory, bucket.view(), "c");
    try {
      assert.deepEqual(await c.env.LEDGER.getByName("x").read(), { count: 4, last: 5 });
    } finally {
      await c.close();
    }
  } finally {
    await a.close().catch(() => {});
  }
});

test("a dead node's objects and alarms are taken over by another node", async () => {
  const directory = await project();
  const bucketFile = join(await temporaryDirectory(), "bucket.json");
  const run = (name, step, args = []) => JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL("./fixtures/durable-node.mjs", import.meta.url)), directory, join(directory, `state-${name}`), bucketFile, step, ...args.map(String)], { env: { ...process.env, NODE_NAME: name, TTL_MS: "1500" }, stdio: ["ignore", "pipe", "ignore"] }).toString());
  // Node a writes, sets an alarm and dies without releasing anything.
  assert.deepEqual(run("a", "append", ["x", 1, 4]).acked, [1, 2, 3, 4]);
  run("a", "set-alarm", ["x", 300]);
  // Node b, touching nothing, takes the object over after a's lease expires,
  // because its alarm is due; the alarm fires there.
  assert.equal(run("b", "idle", [4_000]).owned.length, 1);
  const b = run("b", "wait-alarm", ["x"]);
  assert.equal(b.fired, true);
  assert.equal(b.runs, 1);
  assert.deepEqual(run("b", "read", ["x"]).read, { count: 4, last: 4 });
});

test("native dev parses the cluster options", () => {
  const options = parseNativeDevArgs(["--backup-bucket", "s3://b/x", "--backup-mode", "durable", "--node-name", "n1", "--lease-seconds", "5"], "/tmp");
  assert.equal(options.nodeName, "n1");
  assert.equal(options.leaseSeconds, 5);
  assert.throws(() => parseNativeDevArgs(["--node-name", "n1"], "/tmp"), /needs --backup-bucket with --backup-mode durable/);
  assert.throws(() => parseNativeDevArgs(["--backup-bucket", "s3://b", "--backup-mode", "durable", "--node-name", "n1", "--threads", "2"], "/tmp"), /can't be combined with --threads/);
});

// ---- regressions from the adversarial review --------------------------------

test("a second process with a node's name waits until the first is gone", async () => {
  const directory = await project();
  const bucket = new SharedBucket();
  const first = await node(directory, bucket.view(), "a");
  await first.env.LEDGER.getByName("x").append(1);
  let secondStarted = false;
  const secondPromise = node(directory, bucket.view(), "a").then((engine) => {
    secondStarted = true;
    return engine;
  });
  await new Promise((resolve) => setTimeout(resolve, 4_000));
  assert.equal(secondStarted, false, "the name stays with the running process");
  await first.env.LEDGER.getByName("x").append(2);
  await first.close();
  const second = await secondPromise;
  try {
    assert.deepEqual(await second.env.LEDGER.getByName("x").read(), { count: 2, last: 2 });
  } finally {
    await second.close();
  }
});

test("a node whose renewals stall loses its lease to a revocation and fences when they resume", async () => {
  const directory = await project();
  const bucket = new SharedBucket();
  let stall = null;
  const fences = [];
  const a = await node(directory, bucket.view({ put: async (key) => key.includes("/nodes/a.json") && stall && (await stall) }), "a", { fences });
  const b = await node(directory, bucket.view(), "b");
  try {
    await a.env.LEDGER.getByName("x").append(1);
    let resume;
    stall = new Promise((resolve) => (resume = resolve));
    // b sees a's lease unchanged, revokes it and takes the object over.
    assert.deepEqual(await until(() => b.env.LEDGER.getByName("x").read(), 15_000), { count: 1, last: 1 });
    // a's stalled renewal lands now and fails: a learns it was revoked.
    stall = null;
    resume();
    await until(() => fences.length > 0);
    assert.match(fences[0], /took over|could not be renewed/);
    await assert.rejects(async () => a.env.LEDGER.getByName("x").read(), /stopped serving/);
  } finally {
    await b.close();
    await a.close().catch(() => {});
  }
});

test("one slow renewal doesn't fence a healthy node", async () => {
  const directory = await project();
  const bucket = new SharedBucket();
  // The first renewal after the lease was taken is slow.
  let leasePuts = 0;
  const fences = [];
  const a = await node(directory, bucket.view({
    put: async (key) => {
      if (key.includes("/nodes/a.json") && (leasePuts += 1) === 2) await new Promise((resolve) => setTimeout(resolve, 700));
    },
  }), "a", { fences });
  try {
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    assert.deepEqual(fences, []);
    await a.env.LEDGER.getByName("x").append(1);
  } finally {
    await a.close();
  }
});

test("a takeover that fails half-way is prepared again on the next call", async () => {
  const directory = await project();
  const bucket = new SharedBucket();
  const a = await node(directory, bucket.view(), "a");
  for (let seq = 1; seq <= 3; seq += 1) await a.env.LEDGER.getByName("x").append(seq);
  await a.close();
  let failOnce = true;
  const b = await node(directory, bucket.view({
    get: async (key) => {
      if (failOnce && key.endsWith(".seg")) {
        failOnce = false;
        throw new Error("S3 GET failed: ECONNRESET");
      }
    },
  }), "b");
  try {
    await assert.rejects(b.env.LEDGER.getByName("x").read(), /ECONNRESET/);
    assert.deepEqual(await b.env.LEDGER.getByName("x").read(), { count: 3, last: 3 });
    await b.env.LEDGER.getByName("x").append(4);
  } finally {
    await b.close();
  }
  const c = await node(directory, bucket.view(), "c");
  try {
    assert.deepEqual(await c.env.LEDGER.getByName("x").read(), { count: 4, last: 4 });
  } finally {
    await c.close();
  }
});

test("a node whose claim never finished releases nothing it didn't hold", async () => {
  const directory = await project();
  const bucket = new SharedBucket();
  const a = await node(directory, bucket.view(), "a");
  for (let seq = 1; seq <= 3; seq += 1) await a.env.LEDGER.getByName("x").append(seq);
  await a.close();
  // b claims the object, but can never read its log; then shuts down cleanly.
  const b = await node(directory, bucket.view({ get: async (key) => key.endsWith(".seg") && Promise.reject(new Error("S3 GET failed: ECONNRESET")) }), "b");
  await assert.rejects(b.env.LEDGER.getByName("x").read(), /ECONNRESET/);
  await assert.rejects(b.env.LEDGER.getByName("x").read(), /ECONNRESET/);
  await b.close();
  const c = await node(directory, bucket.view(), "c");
  try {
    assert.deepEqual(await c.env.LEDGER.getByName("x").read(), { count: 3, last: 3 });
  } finally {
    await c.close();
  }
});
