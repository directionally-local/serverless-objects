import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { IdIssuer } from "../src/native/ids.js";
import { DurableObjectStorage, ObjectDatabase } from "../src/native/storage.js";
import { NativeEngine, loadProjectConfig } from "../src/native/engine.js";
import { parseNativeDevArgs, wantsNativeEngine } from "../src/native/dev.js";

const directories = [];
after(async () => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))));

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "sobjects-native-"));
  directories.push(directory);
  return directory;
}

function memoryStorage() {
  const changes = [];
  const storage = new DurableObjectStorage(new ObjectDatabase(":memory:"), {
    onAlarmChange: (at) => changes.push(at),
    holdInputGate: () => {},
  });
  return { storage, changes };
}

test("IDs are deterministic per name, unique otherwise, and forged IDs are rejected", () => {
  const issuer = new IdIssuer("app", "Counter");
  const a = issuer.fromName("alice");
  assert.match(a.toString(), /^[0-9a-f]{64}$/);
  assert.ok(a.equals(new IdIssuer("app", "Counter").fromName("alice")));
  assert.equal(a.name, "alice");
  assert.ok(!a.equals(issuer.fromName("bob")));
  assert.ok(!issuer.unique().equals(issuer.unique()));
  assert.ok(issuer.fromString(a.toString()).equals(a));
  assert.equal(issuer.fromString(a.toString()).name, undefined);
  assert.throws(() => issuer.fromString("0".repeat(64)), /not created by this namespace/);
  assert.throws(() => new IdIssuer("app", "Other").fromString(a.toString()), /not created by this namespace/);
  assert.throws(() => issuer.fromString("nope"), /64 hex/);
});

test("key-value storage keeps structured-clone values and lists in key order", async () => {
  const { storage } = memoryStorage();
  await storage.put({ b: new Map([["k", 1]]), a: new Date(5), "a/1": 1, "a/2": 2, c: new Uint8Array([9]) });
  assert.ok((await storage.get("a")) instanceof Date);
  assert.equal((await storage.get("b")).get("k"), 1);
  assert.deepEqual([...(await storage.list({ prefix: "a/" })).keys()], ["a/1", "a/2"]);
  assert.deepEqual([...(await storage.list({ startAfter: "a", end: "c" })).keys()], ["a/1", "a/2", "b"]);
  assert.deepEqual([...(await storage.list({ reverse: true, limit: 2 })).keys()], ["c", "b"]);
  assert.equal(await storage.delete(["a", "zz"]), 1);
  assert.equal(storage.kv.get("a/1"), 1);
  storage.kv.put("sync", { ok: true });
  assert.deepEqual(await storage.get("sync"), { ok: true });
  assert.deepEqual([...storage.kv.list({ prefix: "a/" })].map(([key]) => key), ["a/1", "a/2"]);
  await assert.rejects(storage.put("x", undefined), /needs a value/);
  await assert.rejects(storage.get(7), /must be strings/);
});

test("SQL cursors, transactions, and deleteAll behave like Durable Object SQLite", async () => {
  const { storage, changes } = memoryStorage();
  const { sql } = storage;
  sql.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, data BLOB, a TEXT, b TEXT)");
  assert.equal(sql.exec("INSERT INTO t (data, a, b) VALUES (?, ?, ?)", new Uint8Array([1, 2]), "x", "y").rowsWritten, 1);
  const cursor = sql.exec("SELECT id, data, a AS v, b AS v FROM t");
  assert.deepEqual(cursor.columnNames, ["id", "data", "v", "v"]);
  const [row] = [...cursor.raw()];
  assert.ok(row[1] instanceof ArrayBuffer);
  assert.deepEqual(row.slice(2), ["x", "y"]);
  assert.throws(() => sql.exec("BEGIN"), /transactionSync/);
  assert.throws(() => sql.exec("SELECT * FROM _cf_KV"), /not authorized/);
  assert.throws(() => sql.exec("SELECT 1 UNION SELECT 2").one(), /multiple results/);

  assert.throws(() => storage.transactionSync(() => {
    sql.exec("INSERT INTO t (a) VALUES ('rolled back')");
    throw new Error("no");
  }), /no/);
  assert.equal(sql.exec("SELECT count(*) AS n FROM t").one().n, 1);
  await storage.transaction(async (txn) => {
    await txn.put("k", 1);
    txn.rollback();
  });
  assert.equal(await storage.get("k"), undefined);

  await storage.setAlarm(new Date(1000));
  assert.equal(await storage.getAlarm(), 1000);
  await storage.put("k", 2);
  await storage.deleteAll();
  assert.equal(await storage.get("k"), undefined);
  assert.equal(await storage.getAlarm(), null);
  assert.equal(sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE name = 't'").one().n, 0);
  assert.deepEqual(changes, [1000, null]);
});

const APP = `
import { DurableObject } from "cloudflare:workers";

export class Counter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      this.ready = true;
    });
  }
  async increment() {
    const value = ((await this.ctx.storage.get("n")) ?? 0) + 1;
    await this.ctx.storage.put("n", value);
    return value;
  }
  async remindIn(ms) {
    await this.ctx.storage.setAlarm(Date.now() + ms);
  }
  async alarm(info) {
    await this.ctx.storage.put("alarm", info.retryCount);
  }
  async read() {
    return { n: (await this.ctx.storage.get("n")) ?? 0, alarm: (await this.ctx.storage.get("alarm")) ?? null, ready: this.ready, name: this.ctx.id.name };
  }
  async fetch(request) {
    return new Response("object " + new URL(request.url).pathname);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const counter = env.COUNTER.getByName("main");
    if (url.pathname === "/burst") {
      await Promise.all(Array.from({ length: 30 }, () => counter.increment()));
      return Response.json(await counter.read());
    }
    if (url.pathname === "/remind") {
      await counter.remindIn(Number(url.searchParams.get("ms")));
      return new Response("ok");
    }
    if (url.pathname === "/read") return Response.json({ ...(await counter.read()), greeting: env.GREETING });
    return counter.fetch(request);
  },
};
`;

async function project() {
  const directory = await temporaryDirectory();
  await mkdir(join(directory, "src"));
  await writeFile(join(directory, "src/index.js"), APP);
  await writeFile(join(directory, "wrangler.jsonc"), `{
    // comments are allowed
    "name": "native-test",
    "main": "src/index.js",
    "vars": { "GREETING": "hi" },
    "durable_objects": { "bindings": [{ "name": "COUNTER", "class_name": "Counter" }] },
  }`);
  return directory;
}

async function startEngine(directory, persistDirectory) {
  const engine = new NativeEngine({ config: await loadProjectConfig(directory), persistDirectory, log: () => {} });
  await engine.start();
  const { port } = await engine.listen({ port: 0 });
  return { engine, base: `http://127.0.0.1:${port}` };
}

test("runs a Worker with Durable Objects: input gates, RPC, fetch, vars, and state across restarts", async () => {
  const directory = await project();
  const persist = join(directory, ".state");
  let { engine, base } = await startEngine(directory, persist);
  try {
    assert.deepEqual(await (await fetch(`${base}/burst`)).json(), { n: 30, alarm: null, ready: true, name: "main" });
    assert.equal(await (await fetch(`${base}/hello`)).text(), "object /hello");
    await fetch(`${base}/remind?ms=300`);
  } finally {
    await engine.close();
  }
  // The alarm was pending when the engine stopped; it fires after the restart.
  ({ engine, base } = await startEngine(directory, persist));
  try {
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.deepEqual(await (await fetch(`${base}/read`)).json(), { n: 30, alarm: 0, ready: true, name: "main", greeting: "hi" });
  } finally {
    await engine.close();
  }
});

test("unsupported Wrangler settings and dev options are refused", async () => {
  const directory = await temporaryDirectory();
  await writeFile(join(directory, "wrangler.json"), JSON.stringify({ name: "x", main: "a.js", kv_namespaces: [{ binding: "KV", id: "1" }] }));
  await assert.rejects(loadProjectConfig(directory), /does not support these Wrangler settings yet: kv_namespaces/);
  assert.equal(wantsNativeEngine(["--engine", "native"]), true);
  assert.equal(wantsNativeEngine(["--engine=native"]), true);
  assert.equal(wantsNativeEngine(["--port", "1"]), false);
  assert.deepEqual(parseNativeDevArgs(["app", "--engine", "native", "--port", "9"], "/work"), {
    project: "/work/app",
    port: 9,
    host: "127.0.0.1",
    persistTo: "/work/app/.sobjects/native",
    backupBucket: undefined,
    backupIntervalSeconds: 10,
    threads: 0,
    threadStallSeconds: 30,
    threadMemoryMb: undefined,
    idleEvictSeconds: 60,
  });
  assert.throws(() => parseNativeDevArgs(["--inspect"], "/work"), /Unknown option/);
});

const EVICTION_APP = `
import { DurableObject } from "cloudflare:workers";

export class Thing extends DurableObject {
  instance = crypto.randomUUID();
  async who() {
    return { instance: this.instance, count: await this.bump() };
  }
  async bump() {
    const count = ((await this.ctx.storage.get("count")) ?? 0) + 1;
    await this.ctx.storage.put("count", count);
    return count;
  }
  async fetch() {
    const [client, server] = new WebSocketPair();
    server.accept();
    server.addEventListener("message", (event) => server.send(this.instance + ":" + event.data));
    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request, env) {
    const thing = env.THING.getByName(new URL(request.url).searchParams.get("name") ?? "a");
    if (request.headers.get("upgrade") === "websocket") return thing.fetch(request);
    return Response.json(await thing.who());
  },
};
`;

test("idle objects are evicted and rebuilt with their state; an accept()ed socket keeps one in memory", async () => {
  const directory = await temporaryDirectory();
  await mkdir(join(directory, "src"));
  await writeFile(join(directory, "src/index.js"), EVICTION_APP);
  await writeFile(join(directory, "wrangler.json"), JSON.stringify({ name: "evict", main: "src/index.js", durable_objects: { bindings: [{ name: "THING", class_name: "Thing" }] } }));
  const engine = new NativeEngine({ config: await loadProjectConfig(directory), persistDirectory: join(directory, ".state"), idleEvictMs: 100, log: () => {} });
  await engine.start();
  const { port } = await engine.listen({ port: 0 });
  const get = async (name) => (await fetch(`http://127.0.0.1:${port}/?name=${name}`)).json();
  try {
    const first = await get("a");
    assert.equal((await get("a")).instance, first.instance);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const rebuilt = await get("a");
    assert.notEqual(rebuilt.instance, first.instance);
    assert.equal(rebuilt.count, 3);
    assert.ok(engine.evictions >= 1);

    // A socket accepted with accept() and listeners pins its object.
    const socket = new WebSocket(`ws://127.0.0.1:${port}/?name=b`);
    await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
    const reply = () => new Promise((resolve) => socket.addEventListener("message", (event) => resolve(event.data.split(":")[0]), { once: true }));
    const before = reply();
    socket.send("x");
    const pinnedInstance = await before;
    await new Promise((resolve) => setTimeout(resolve, 250));
    const after = reply();
    socket.send("y");
    assert.equal(await after, pinnedInstance);
    socket.close();
  } finally {
    await engine.close();
  }
});

test("packages load from node_modules, with their own files and cloudflare:* imports", async () => {
  const directory = await temporaryDirectory();
  const pkg = join(directory, "node_modules", "greeter");
  await mkdir(pkg, { recursive: true });
  await mkdir(join(directory, "src"));
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "greeter", type: "module", exports: "./index.js" }));
  await writeFile(join(pkg, "greeting.txt"), "hello from a package file");
  // Bundling would break this: the file is read relative to the package at run time.
  await writeFile(join(pkg, "index.js"), 'import { readFileSync } from "node:fs";\nimport { DurableObject } from "cloudflare:workers";\nexport const greeting = () => readFileSync(new URL("./greeting.txt", import.meta.url), "utf8");\nexport class Base extends DurableObject {}\n');
  await writeFile(join(directory, "src/index.js"), 'import { Base, greeting } from "greeter";\nexport class Greeter extends Base { hi() { return greeting(); } }\nexport default { fetch: async (request, env) => new Response(await env.GREETER.getByName("x").hi()) };\n');
  await writeFile(join(directory, "wrangler.json"), JSON.stringify({ name: "pkg", main: "src/index.js", durable_objects: { bindings: [{ name: "GREETER", class_name: "Greeter" }] } }));
  const { engine, base } = await startEngine(directory, join(directory, ".state"));
  try {
    assert.equal(await (await fetch(base)).text(), "hello from a package file");
  } finally {
    await engine.close();
  }
});
