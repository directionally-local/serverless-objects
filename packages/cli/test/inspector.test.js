import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { ensureInspectorToken, inspectorClasses, readInspectorToken, renderInspectorEntry, tokenHash } from "../src/inspector.js";
import { encodeValue, inspectStorage, isReadOnly, sha256Hex, wrapDefault, wrapObjectClass } from "../src/inspector-runtime.js";
import { prepareWranglerProject } from "../src/wrangler.js";

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "sobjects-inspector-"));
  directories.push(directory);
  return directory;
}

const TOKEN = "secret-token";
const HASH = tokenHash(TOKEN);
const ID = "c".repeat(64);

function fakeState({ kv = new Map(), tables = {}, alarm = null } = {}) {
  return {
    storage: {
      async list({ prefix = "", startAfter, limit }) {
        return new Map([...kv].filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter)).sort().slice(0, limit));
      },
      async getAlarm() { return alarm; },
      sql: {
        exec(query) {
          if (query.includes("sqlite_master")) {
            const rows = Object.keys(tables).map((name) => ({ name }));
            return { toArray: () => rows };
          }
          const count = /count\(\*\) AS n FROM "(\w+)"/.exec(query);
          if (count) return { one: () => ({ n: tables[count[1]].length }) };
          const rows = tables[/FROM "?(\w+)/.exec(query)[1]];
          return Object.assign(rows[Symbol.iterator].call(rows), { columnNames: Object.keys(rows[0] ?? {}) });
        },
      },
    },
    getWebSockets: () => ["a", "b"],
    getTags: (socket) => [`room-${socket}`],
  };
}

test("hashes tokens the same way in Node and in the bundled runtime", async () => {
  assert.equal(await sha256Hex(TOKEN), HASH);
});

test("creates one private token per data directory", async () => {
  const directory = await temporaryDirectory();
  assert.equal(await readInspectorToken(directory), undefined);
  const token = await ensureInspectorToken(directory);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await ensureInspectorToken(directory), token);
  assert.equal((await stat(join(directory, "inspector-token"))).mode & 0o777, 0o600);
});

test("finds local Durable Object classes and renders a re-exporting entry", () => {
  const classes = inspectorClasses({
    durable_objects: {
      bindings: [
        { name: "COUNTER", class_name: "Counter" },
        { name: "COUNTER_TWO", class_name: "Counter" },
        { name: "REMOTE", class_name: "Remote", script_name: "other" },
      ],
    },
  });
  assert.deepEqual(classes, { Counter: "COUNTER" });
  const entry = renderInspectorEntry({ main: "/app/src/index.js", classes, tokenHash: HASH, runtime: "/rt.js" });
  assert.match(entry, /export \* from "\/app\/src\/index\.js";/);
  assert.match(entry, /export default wrapDefault\(app\.default, options\);/);
  assert.match(entry, /export const Counter = wrapObjectClass\(app\.Counter, options\);/);
  assert.doesNotMatch(entry, new RegExp(TOKEN));
  assert.throws(() => renderInspectorEntry({ main: "/a", classes: { "x-y": "B" }, tokenHash: HASH }), /not a JavaScript identifier/);
});

test("deploy preparation points the config at a generated entry and cleans it up", async () => {
  const directory = await temporaryDirectory();
  await writeFile(join(directory, "wrangler.json"), JSON.stringify({
    name: "app",
    main: "src/index.js",
    durable_objects: { bindings: [{ name: "COUNTER", class_name: "Counter" }] },
  }));
  const prepared = await prepareWranglerProject([directory], { cwd: directory, inspectorTokenHash: HASH });
  const config = JSON.parse(await readFile(prepared.args[0], "utf8"));
  assert.match(config.main, /^\.\/\.sobjects-entry-.*\.mjs$/);
  const entry = await readFile(join(directory, config.main), "utf8");
  assert.match(entry, new RegExp(`import \\* as app from "${join(directory, "src/index.js").replace(/[/.]/g, "\\$&")}"`));
  await prepared.cleanup();
  assert.deepEqual((await readdir(directory)).sort(), ["wrangler.json"]);

  const plain = await prepareWranglerProject([directory], { cwd: directory });
  assert.equal(plain.args[0], directory);
});

test("summarizes, lists, and queries object storage", async () => {
  const state = fakeState({
    kv: new Map([["a", 1], ["b", new Date(0)], ["c", new Uint8Array([1, 2])]]),
    tables: { hits: [{ n: 1, path: "/" }, { n: 2, path: "/x" }] },
    alarm: 0,
  });
  assert.deepEqual(await inspectStorage(state, { op: "summary" }), {
    tables: [{ name: "hits", rows: 2 }],
    alarm: "1970-01-01T00:00:00.000Z",
    websockets: { count: 2, tags: ["room-a", "room-b"] },
  });
  assert.deepEqual(await inspectStorage(state, { op: "kv", limit: 2 }), {
    entries: [{ key: "a", value: 1 }, { key: "b", value: { $type: "Date", value: "1970-01-01T00:00:00.000Z" } }],
    next: "b",
  });
  assert.deepEqual((await inspectStorage(state, { op: "kv", startAfter: "b" })).entries[0].value, {
    $type: "bytes", length: 2, base64: "AQI=", truncated: false,
  });
  const result = await inspectStorage(state, { op: "sql", query: "SELECT * FROM hits" });
  assert.deepEqual(result, { columns: ["n", "path"], rows: [{ n: 1, path: "/" }, { n: 2, path: "/x" }], truncated: false });
  await assert.rejects(inspectStorage(state, { op: "sql", query: "DELETE FROM hits" }), RangeError);
  await assert.rejects(inspectStorage(state, { op: "kv", limit: 0 }), RangeError);
  await assert.rejects(inspectStorage(state, { op: "nope" }), RangeError);
});

test("allows only read-only SQL in the console", () => {
  for (const query of ["SELECT 1", "select * from t;", "WITH x AS (SELECT 1) SELECT * FROM x", "EXPLAIN SELECT 1", "PRAGMA table_info(t)"]) {
    assert.equal(isReadOnly(query), true, query);
  }
  for (const query of ["DELETE FROM t", "SELECT 1; DROP TABLE t", "PRAGMA foreign_keys = OFF", "WITH x AS (SELECT 1) DELETE FROM t", "INSERT INTO t VALUES (1)"]) {
    assert.equal(isReadOnly(query), false, query);
  }
});

test("encodes structured-clone values as JSON", () => {
  assert.deepEqual(encodeValue({ m: new Map([["k", 1n]]), s: new Set([undefined]) }), {
    m: { $type: "Map", value: [["k", { $type: "bigint", value: "1" }]] },
    s: { $type: "Set", value: [{ $type: "undefined" }] },
  });
});

test("wrapped objects answer inspection only with the right token and otherwise run the app", async () => {
  class Counter {
    constructor(state, env) { this.ctx = state; this.env = env; }
    fetch() { return new Response("app"); }
  }
  const Wrapped = wrapObjectClass(Counter, { tokenHash: HASH });
  const object = new Wrapped(fakeState({ kv: new Map([["n", 5]]) }), {});
  const inspect = (token) => object.fetch(new Request("https://x/", {
    method: "POST",
    headers: { "x-sobjects-inspect": token },
    body: JSON.stringify({ op: "kv" }),
  }));
  assert.deepEqual(await (await inspect(TOKEN)).json(), { entries: [{ key: "n", value: 5 }] });
  assert.equal((await inspect("wrong")).status, 401);
  assert.equal(await (await object.fetch(new Request("https://x/"))).text(), "app");
  assert.ok(object instanceof Counter);
  assert.equal(object.constructor.name, "Counter");
});

test("the wrapped default handler routes inspection to the object and passes other requests through", async () => {
  const forwarded = [];
  const env = {
    COUNTER: {
      idFromString: (id) => `id:${id}`,
      get: (id) => ({ fetch: async (_url, init) => { forwarded.push([id, JSON.parse(init.body)]); return new Response("{}"); } }),
    },
  };
  const app = { fetch: () => new Response("app"), scheduled: () => "cron" };
  const handler = wrapDefault(app, { tokenHash: HASH, classes: { Counter: "COUNTER" } });
  class Entrypoint { fetch() { return new Response("entry"); } }
  assert.equal(wrapDefault(Entrypoint, { tokenHash: HASH, classes: {} }).name, "Entrypoint");
  assert.equal(handler.scheduled(), "cron");
  assert.equal(await (await handler.fetch(new Request("https://x/"), env, {})).text(), "app");

  const send = (token, body) => handler.fetch(new Request("https://x/", {
    method: "POST",
    headers: { "x-sobjects-inspect": token },
    body: JSON.stringify(body),
  }), env, {});
  assert.equal((await send(TOKEN, { className: "Counter", id: ID, op: "summary" })).status, 200);
  assert.deepEqual(forwarded, [[`id:${ID}`, { className: "Counter", id: ID, op: "summary" }]]);
  assert.equal((await send("wrong", { className: "Counter", id: ID })).status, 401);
  assert.equal((await send(TOKEN, { className: "Missing", id: ID })).status, 404);
  assert.equal((await send(TOKEN, { className: "Counter", id: "x" })).status, 400);
  assert.equal(forwarded.length, 1);
});

test("exports every key-value entry and app table as a logical backup", async () => {
  const state = fakeState({ kv: new Map([["n", 3], ["when", new Date(0)]]), tables: { hits: [{ n: 1 }, { n: 2 }] } });
  const originalExec = state.storage.sql.exec;
  state.storage.sql.exec = (query) => query.includes("SELECT name, sql")
    ? { toArray: () => [{ name: "hits", sql: "CREATE TABLE hits (n INTEGER)" }] }
    : originalExec(query);
  const exported = await inspectStorage(state, { op: "export" });
  assert.equal(exported.format, "sobjects-object-export/v1");
  assert.deepEqual(exported.kv, [{ key: "n", value: 3 }, { key: "when", value: { $type: "Date", value: "1970-01-01T00:00:00.000Z" } }]);
  assert.deepEqual(exported.tables, [{ name: "hits", schema: "CREATE TABLE hits (n INTEGER)", columns: ["n"], rows: [{ n: 1 }, { n: 2 }] }]);
  assert.equal(exported.truncated, false);
});
