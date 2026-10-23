import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { adminTokenMatches, createIngressMetrics, ensureAdminToken, readAdminToken, startAdmin } from "../src/admin.js";

const ID = "a".repeat(64);
const TOKEN = "t".repeat(43);
const AUTH = { authorization: `Bearer ${TOKEN}` };
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
  const instance = await startAdmin({ listen: "127.0.0.1:0", engine, metrics, version: "0.1.0", token: TOKEN });
  servers.push(instance);
  return instance.address.port;
}

function call(port, path, { method = "GET", headers = AUTH, body } = {}) {
  return new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (response) => {
      let text = "";
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, text, json: () => JSON.parse(text) }));
    }).on("error", reject).end(body);
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
  const result = await call(port, path, { method: "POST", headers: { ...AUTH, "x-sobjects-request": "1" } });
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
  const sql = (query, headers = { ...AUTH, "x-sobjects-request": "1" }) => new Promise((resolve, reject) => {
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
  assert.equal((await sql("SELECT 1", AUTH)).status, 403);
  assert.deepEqual(calls.slice(0, 3), [
    [`Room:${ID}`, { op: "summary" }],
    [`Room:${ID}`, { op: "kv", prefix: "a", startAfter: undefined, limit: 5 }],
    [`Room:${ID}`, { op: "sql", query: "SELECT 1" }],
  ]);
});

test("serves the dashboard with a strict content security policy", async () => {
  const port = await admin();
  const page = await call(port, "/");
  assert.equal(page.status, 200);
  assert.match(page.text, /<script type="module" src="\/dashboard\/app\.js"><\/script>/);
  assert.match(page.text, /Superseded epochs eligible for GC/);
  assert.match(page.text, /not a complete object or backup inventory/);
  const script = await call(port, "/dashboard/app.js");
  assert.equal(script.status, 200);
  assert.match(script.text, /x-sobjects-request/);
  assert.match(script.text, /authorization: `Bearer \$\{adminToken\}`/);
  assert.match(script.text, /sessionStorage/);
  assert.match(script.text, /Only objects with superseded epochs are listed/);
  assert.doesNotMatch(script.text, /innerHTML/);
  assert.equal((await call(port, "/dashboard/app.css")).status, 200);
  const headers = await new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port, path: "/", headers: { host: "localhost" } }, (response) => {
      response.resume();
      resolve(response.headers);
    }).on("error", reject).end();
  });
  assert.match(headers["content-security-policy"], /script-src 'self'/);
  assert.match(headers["content-security-policy"], /frame-ancestors 'none'/);
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.equal((await call(port, "/dashboard/../admin.js")).status, 404);
});

test("lists backups and downloads an object export", async () => {
  const port = await admin(fakeEngine({
    listBackups: async (options) => ({ retentionSeconds: null, objects: [], next: undefined, options }),
    inspect: async (_scope, operation) => {
      assert.deepEqual(operation, { op: "export" });
      return { format: "sobjects-object-export/v1", exportedAt: "2026-10-19T00:00:00.000Z", kv: [], tables: [], truncated: false };
    },
  }));
  const backups = (await call(port, "/api/v1/backups?class=Room&limit=5")).json();
  assert.deepEqual(backups.options, { className: "Room", limit: 5 });
  const exported = await new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port, path: `/api/v1/objects/Room:${ID}/export`, headers: { host: "localhost", ...AUTH } }, (response) => {
      let text = "";
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ headers: response.headers, body: JSON.parse(text) }));
    }).on("error", reject).end();
  });
  assert.match(exported.headers["content-disposition"], new RegExp(`attachment; filename="Room-${ID}-2026-10-19T00-00-00-000Z\\.json"`));
  assert.equal(exported.body.scope, `Room:${ID}`);
});

test("requires the admin token for object data and mutations", async () => {
  const evicted = [];
  const port = await admin(fakeEngine({
    inspect: async (_scope, operation) => ({ format: "x", exportedAt: "2026-10-19T00:00:00.000Z", ok: operation.op }),
    listBackups: async () => ({ retentionSeconds: null, objects: [], next: undefined }),
    evict: async (scope) => { evicted.push(scope); return { status: 200, ok: true, scope }; },
  }));
  const object = `/api/v1/objects/Room:${ID}`;
  const routes = [
    ["GET", "/api/v1/node"],
    ["GET", "/api/v1/objects"],
    ["GET", "/api/v1/backups"],
    ["GET", object],
    ["GET", `${object}/kv`],
    ["GET", `${object}/export`],
    ["POST", `${object}/sql`],
    ["POST", `${object}/evict`],
    ["GET", "/nope"],
  ];
  const wrong = [
    {},
    { authorization: `Bearer ${"u".repeat(43)}` },
    { authorization: `Bearer ${TOKEN.slice(0, -1)}` },
    { authorization: `Bearer ${TOKEN}x` },
    { authorization: TOKEN },
    { authorization: `Basic ${TOKEN}` },
  ];
  for (const [method, path] of routes) {
    const body = method === "POST" ? JSON.stringify({ query: "SELECT 1" }) : undefined;
    for (const headers of wrong) {
      const response = await call(port, path, { method, headers: { ...headers, "x-sobjects-request": "1" }, body });
      assert.equal(response.status, 401, `${method} ${path} ${JSON.stringify(headers)}`);
      assert.equal(response.headers["www-authenticate"], 'Bearer realm="sobjects-admin"');
      assert.match(response.json().error, /sobjects dashboard/);
    }
    const allowed = await call(port, path, { method, headers: { ...AUTH, "x-sobjects-request": "1" }, body });
    assert.equal(allowed.status, path === "/nope" ? 404 : 200, `${method} ${path}`);
  }
  assert.deepEqual(evicted, [`Room:${ID}`]);
});

test("serves the dashboard files, health and metrics without the token", async () => {
  const port = await admin(fakeEngine(), createIngressMetrics());
  for (const path of ["/", "/dashboard/app.js", "/dashboard/app.css", "/api/v1/health", "/metrics"]) {
    assert.equal((await call(port, path, { headers: {} })).status, 200, path);
  }
  // Public paths are public only for GET.
  assert.equal((await call(port, "/metrics", { method: "POST", headers: { "x-sobjects-request": "1" } })).status, 401);
  // The Host and custom-header checks still come first.
  assert.equal((await call(port, "/api/v1/node", { headers: { ...AUTH, host: "attacker.example" } })).status, 421);
});

test("refuses to start without an admin token", async () => {
  await assert.rejects(startAdmin({ listen: "127.0.0.1:0", engine: fakeEngine(), version: "0.1.0" }), /admin token/);
  await assert.rejects(startAdmin({ listen: "127.0.0.1:0", engine: fakeEngine(), version: "0.1.0", token: "short" }), /admin token/);
});

test("compares admin tokens by digest, whatever their length", () => {
  assert.equal(adminTokenMatches(TOKEN, TOKEN), true);
  assert.equal(adminTokenMatches(`${TOKEN}`.replace(/t$/, "u"), TOKEN), false);
  assert.equal(adminTokenMatches(TOKEN.slice(0, 10), TOKEN), false);
  assert.equal(adminTokenMatches(`${TOKEN}${TOKEN}`, TOKEN), false);
  assert.equal(adminTokenMatches("", TOKEN), false);
  assert.equal(adminTokenMatches(undefined, TOKEN), false);
  assert.equal(adminTokenMatches(TOKEN, undefined), false);
  assert.equal(adminTokenMatches(TOKEN, ""), false);
});

test("creates one 256-bit admin token, readable only by its owner", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "sobjects-admin-token-"));
  try {
    const stateDirectory = join(root, "state");
    assert.equal(await readAdminToken(stateDirectory), undefined);
    const [first, second] = await Promise.all([ensureAdminToken(stateDirectory), ensureAdminToken(stateDirectory)]);
    assert.equal(first, second);
    assert.match(first, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(first, "base64url").length, 32);
    assert.equal(await ensureAdminToken(stateDirectory), first);
    assert.equal(await readAdminToken(stateDirectory), first);
    assert.equal((await stat(join(stateDirectory, "admin-token"))).mode & 0o777, 0o600);
    assert.equal((await stat(stateDirectory)).mode & 0o777, 0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
