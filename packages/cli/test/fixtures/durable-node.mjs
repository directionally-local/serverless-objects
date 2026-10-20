// A native-engine node in durable mode for crash tests: runs one step of a
// scenario, saves its bucket to a JSON file, and exits without closing
// anything (a crash). Usage: node durable-node.mjs <project> <persist> <bucket.json> <step> [args...]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { NativeEngine, loadProjectConfig } from "../../src/native/engine.js";

const [, , project, persistDirectory, bucketFile, step, ...args] = process.argv;

class FileBucket {
  objects = new Map();
  #version = 0;

  constructor() {
    if (!existsSync(bucketFile)) return;
    for (const [key, body] of Object.entries(JSON.parse(readFileSync(bucketFile, "utf8")))) this.objects.set(key, { body: Buffer.from(body, "base64"), etag: `"${(this.#version += 1)}"` });
  }

  async list(prefix) {
    return [...this.objects].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, { etag, body }]) => ({ key, etag, size: body.length }));
  }

  async get(key) {
    const object = this.objects.get(key);
    return object ? { body: Buffer.from(object.body), etag: object.etag } : null;
  }

  async put(key, body, { ifMatch, ifNoneMatch } = {}) {
    // FAIL=seg or FAIL=snapshot makes those uploads fail.
    if (process.env.FAIL === "seg" && key.endsWith(".seg")) throw new Error("S3 PUT failed: ECONNRESET");
    if (process.env.FAIL === "snapshot" && key.includes("/snapshot-")) throw new Error("S3 PUT failed: ECONNRESET");
    const current = this.objects.get(key);
    if (ifNoneMatch === "*" && current) return null;
    if (ifMatch && current?.etag !== ifMatch) return null;
    const etag = `"${(this.#version += 1)}"`;
    this.objects.set(key, { body: Buffer.from(body), etag });
    this.save();
    return etag;
  }

  async delete(key) {
    this.objects.delete(key);
    this.save();
  }

  save() {
    writeFileSync(bucketFile, JSON.stringify(Object.fromEntries([...this.objects].map(([key, { body }]) => [key, body.toString("base64")]))));
  }
}

// The engine's timers don't keep a process alive (a real node has its HTTP server).
setInterval(() => {}, 1_000);
const logs = [];
const engine = new NativeEngine({
  config: await loadProjectConfig(project),
  persistDirectory,
  idleEvictMs: 0,
  backup: { client: new FileBucket(), prefix: "p", mode: "durable", tuning: { snapshotTransactions: Number(process.env.SNAPSHOT_TRANSACTIONS ?? 2000), gateTimeoutMs: Number(process.env.GATE_TIMEOUT_MS ?? 30000), closeTimeoutMs: 0 } },
  log: (line) => logs.push(line),
  // NODE_NAME makes this one of several nodes sharing the bucket.
  cluster: process.env.NODE_NAME ? { name: process.env.NODE_NAME, ttlMs: Number(process.env.TTL_MS ?? 3000), wakeMs: 200 } : undefined,
});
await engine.start();
const ledger = (name) => engine.env.LEDGER.getByName(name);
const output = { logs };
if (step === "append") {
  const [name, from, to] = args;
  output.acked = [];
  for (let seq = Number(from); seq <= Number(to); seq += 1) {
    await ledger(name).append(seq).then(() => output.acked.push(seq), () => {});
  }
  output.read = await ledger(name).read().catch(() => null);
} else if (step === "read") {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      output.read = await ledger(args[0]).read();
      break;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
} else if (step === "hang-alarm") {
  await ledger(args[0]).later(100, true);
  // The handler starts and never finishes; the node dies meanwhile.
  await new Promise((resolve) => setTimeout(resolve, 600));
} else if (step === "idle") {
  // Touches nothing; reports which objects this node took over by itself.
  await new Promise((resolve) => setTimeout(resolve, Number(args[0])));
  output.owned = [...engine.owned.keys()];
} else if (step === "set-alarm") {
  await ledger(args[0]).later(Number(args[1]));
} else if (step === "wait-alarm") {
  // Another node may still hold the object until its lease runs out.
  const deadline = Date.now() + 20_000;
  while (!(await ledger(args[0]).fired().catch(() => false)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  output.fired = await ledger(args[0]).fired();
  output.runs = await ledger(args[0]).runs();
}
process.stdout.write(JSON.stringify(output));
process.exit(0);
