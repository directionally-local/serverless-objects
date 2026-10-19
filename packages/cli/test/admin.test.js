import assert from "node:assert/strict";
import { request } from "node:http";
import { afterEach, test } from "node:test";
import { createIngressMetrics, startAdmin } from "../src/admin.js";

const ID = "a".repeat(64);
const servers = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function fakeEngine(overrides = {}) {
  return {
    health: async () => ({ ok: true, listener: 200, operator: 200 }),
    state: async () => ({ residents: [`Room:${ID}`], residentCells: 1, ownedCells: 2, websockets: 3, draining: false, pressured: false }),
    listObjects: async () => ({
      objects: [
        { scope: `Room:${ID}`, className: "Room", id: ID, reserved: false },
        { scope: `Room:${"b".repeat(64)}`, className: "Room", id: "b".repeat(64), reserved: false },
      ],
      next: undefined,
    }),
    evict: async (scope) => ({ status: 200, ok: true, scope }),
    ...overrides,
  };
}

async function admin(engine = fakeEngine(), metrics) {
  const instance = await startAdmin({ listen: "127.0.0.1:0", engine, metrics, version: "0.1.0" });
  servers.push(instance);
  return instance.address.port;
}

function call(port, path, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (response) => {
      let text = "";
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, text, json: () => JSON.parse(text) }));
    }).on("error", reject).end();
  });
}

test("serves health, node state, and objects marked resident", async () => {
  const port = await admin();
  const health = await call(port, "/api/v1/health");
  assert.equal(health.status, 200);
  assert.deepEqual(health.json(), { ok: true, version: "0.1.0", engine: { ok: true, listener: 200, operator: 200 } });
  assert.equal((await call(port, "/api/v1/node")).json().websockets, 3);
  const objects = (await call(port, "/api/v1/objects?class=Room&limit=5")).json();
  assert.deepEqual(objects.objects.map((object) => object.resident), [true, false]);
  assert.equal((await call(port, "/nope")).status, 404);
});

test("reports an unhealthy engine and bad list parameters", async () => {
  const port = await admin(fakeEngine({
    health: async () => ({ ok: false, listener: "unreachable", operator: "unreachable" }),
    listObjects: async () => { throw new RangeError("limit must be from 1 to 1000."); },
  }));
  assert.equal((await call(port, "/api/v1/health")).status, 503);
  const bad = await call(port, "/api/v1/objects?limit=0");
  assert.equal(bad.status, 400);
  assert.match(bad.json().error, /limit/);
});

test("requires the admin header for evictions and passes the engine status through", async () => {
  let evicted;
  const port = await admin(fakeEngine({
    evict: async (scope) => {
      evicted = scope;
      return { status: 409, ok: false, error: { kind: "refused", reason: "alarm_imminent" } };
    },
  }));
  const path = `/api/v1/objects/${encodeURIComponent(`Room:${ID}`)}/evict`;
  assert.equal((await call(port, path, { method: "POST" })).status, 403);
  assert.equal(evicted, undefined);
  const result = await call(port, path, { method: "POST", headers: { "x-sobjects-request": "1" } });
  assert.equal(result.status, 409);
  assert.equal(result.json().error.reason, "alarm_imminent");
  assert.equal(evicted, `Room:${ID}`);
});

test("rejects requests with a foreign Host header", async () => {
  const port = await admin();
  const response = await call(port, "/api/v1/node", { headers: { host: "attacker.example" } });
  assert.equal(response.status, 421);
});

test("renders Prometheus metrics from engine state and ingress counters", async () => {
  const metrics = createIngressMetrics();
  metrics.observe({ route: "app.test", status: 200, bytes: 10 });
  metrics.observe({ route: "app.test", status: 204, bytes: 0 });
  metrics.observe({ status: 421, bytes: 28 });
  metrics.observe({ route: "app.test", status: 101, bytes: 5, upgrade: true });
  const port = await admin(fakeEngine(), metrics);
  const text = (await call(port, "/metrics")).text;
  assert.match(text, /^sobjects_engine_up 1$/m);
  assert.match(text, /^sobjects_engine_resident_objects 1$/m);
  assert.match(text, /^sobjects_engine_websockets 3$/m);
  assert.match(text, /^sobjects_ingress_requests_total\{route="app\.test",code="2xx"\} 2$/m);
  assert.match(text, /^sobjects_ingress_requests_total\{route="",code="4xx"\} 1$/m);
  assert.match(text, /^sobjects_ingress_response_bytes_total 43$/m);
  assert.match(text, /^sobjects_ingress_websocket_upgrades_total 1$/m);

  const downPort = await admin(fakeEngine({ state: async () => { throw new Error("down"); } }));
  const down = (await call(downPort, "/metrics")).text;
  assert.match(down, /^sobjects_engine_up 0$/m);
  assert.doesNotMatch(down, /resident_objects/);
});

test("inspects object storage through the engine", async () => {
  const calls = [];
  const port = await admin(fakeEngine({
    inspect: async (scope, operation) => {
      calls.push([scope, operation]);
      if (operation.op === "sql" && operation.query === "DELETE FROM t") throw new RangeError("read-only");
      return { ok: operation.op };
    },
  }));
  const base = `/api/v1/objects/Room:${ID}`;
  assert.deepEqual((await call(port, base)).json(), { ok: "summary" });
  assert.deepEqual((await call(port, `${base}/kv?prefix=a&limit=5`)).json(), { ok: "kv" });
  const sql = (query, headers = { "x-sobjects-request": "1" }) => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: `${base}/sql`, method: "POST", headers: { host: "localhost", ...headers } }, (response) => {
      let text = "";
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, json: () => JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end(JSON.stringify({ query }));
  });
  assert.deepEqual((await sql("SELECT 1")).json(), { ok: "sql" });
  assert.equal((await sql("DELETE FROM t")).status, 400);
  assert.equal((await sql("SELECT 1", {})).status, 403);
  assert.deepEqual(calls.slice(0, 3), [
    [`Room:${ID}`, { op: "summary" }],
    [`Room:${ID}`, { op: "kv", prefix: "a", startAfter: undefined, limit: 5 }],
    [`Room:${ID}`, { op: "sql", query: "SELECT 1" }],
  ]);
});
