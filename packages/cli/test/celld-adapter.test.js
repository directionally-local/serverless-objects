import assert from "node:assert/strict";
import { test } from "node:test";
import { createCelldAdapter, loopbackFor, parseScope, summarizeState } from "../src/celld-adapter.js";

const ID = "888f660f0fa89da26a4e205111d46912ee9e2a8c6ad4bb27dc4abb68080dd9fb";
const STATE = {
  deployment: { version: "c881", prefix: "deploy/app/c881", generation: 1 },
  residents: [`Counter:${ID}`],
  owned_cells: 1,
  restoring: 0,
  rss_bytes: 49_250_304,
  ownership: "s3",
  node_load: { resident_cells: 1, host_websockets: 2, cpu_percent_x100: 150, draining: false, pressured: true },
};

function fakeFetch(routes, calls = []) {
  return async (url, init = {}) => {
    calls.push([init.method ?? "GET", url]);
    const handler = routes[`${init.method ?? "GET"} ${new URL(url).pathname}`];
    if (!handler) throw new Error("connect ECONNREFUSED");
    const [status, body] = handler();
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
}

function adapter(overrides = {}) {
  return createCelldAdapter({
    listen: "0.0.0.0:8080",
    internalListen: "127.0.0.1:8081",
    executable: "/opt/celld",
    storageArgs: ["--bucket", "s3://fleet"],
    ...overrides,
  });
}

test("summarizes celld /state into stable fields", () => {
  assert.deepEqual(summarizeState(STATE), {
    deployment: { version: "c881", prefix: "deploy/app/c881", generation: 1 },
    residents: [`Counter:${ID}`],
    ownedCells: 1,
    residentCells: 1,
    restoring: 0,
    activating: undefined,
    evicting: undefined,
    websockets: 2,
    rssBytes: 49_250_304,
    inUseBytes: undefined,
    cpuPercent: 1.5,
    draining: false,
    pressured: true,
    rebalancePaused: false,
    ownership: "s3",
  });
});

test("parses object scopes and rejects anything else", () => {
  assert.deepEqual(parseScope(`Counter:${ID}`), { scope: `Counter:${ID}`, className: "Counter", id: ID, reserved: false });
  assert.equal(parseScope(`__kv:${ID}`).reserved, true);
  for (const bad of ["Counter", `Counter:${ID.slice(1)}`, `../x:${ID}`, `Counter:${ID}/x`]) {
    assert.throws(() => parseScope(bad), RangeError, bad);
  }
});

test("maps wildcard listeners to loopback", () => {
  assert.equal(loopbackFor("0.0.0.0:8080"), "127.0.0.1:8080");
  assert.equal(loopbackFor("[::]:8080"), "[::1]:8080");
  assert.equal(loopbackFor("127.0.0.2:9"), "127.0.0.2:9");
});

test("reads health and state from the public and operator listeners", async () => {
  const calls = [];
  const engine = adapter({
    fetchImpl: fakeFetch({
      "GET /.well-known/celld/health": () => [200, { ok: true }],
      "GET /state": () => [200, STATE],
    }, calls),
  });
  assert.deepEqual(await engine.health(), { ok: true, listener: 200, operator: 200 });
  assert.equal((await engine.state()).websockets, 2);
  assert.ok(calls.some(([, url]) => url === "http://127.0.0.1:8080/.well-known/celld/health"));
  assert.ok(calls.some(([, url]) => url === "http://127.0.0.1:8081/state"));

  const down = adapter({ fetchImpl: fakeFetch({}) });
  assert.deepEqual(await down.health(), { ok: false, listener: "unreachable", operator: "unreachable" });
  await assert.rejects(down.state(), /ECONNREFUSED/);
});

test("lists objects through celld cell list with paging", async () => {
  let invocation;
  const rows = [1, 2, 3].map((n) => JSON.stringify({ scope: `Room:${String(n).repeat(64)}` }));
  const engine = adapter({
    run: async (executable, args) => {
      invocation = { executable, args };
      return `${rows.join("\n")}\n`;
    },
  });
  const page = await engine.listObjects({ className: "Room", after: `Room:${"0".repeat(64)}`, limit: 2 });
  assert.deepEqual(invocation, {
    executable: "/opt/celld",
    args: ["cell", "list", "Room", "--bucket", "s3://fleet", "--json", "--limit", "3", "--after", `Room:${"0".repeat(64)}`],
  });
  assert.deepEqual(page.objects.map((object) => object.id), ["1".repeat(64), "2".repeat(64)]);
  assert.equal(page.next, `Room:${"2".repeat(64)}`);

  await assert.rejects(engine.listObjects({ className: "--all" }), RangeError);
  await assert.rejects(engine.listObjects({ limit: 0 }), RangeError);
});

test("evicts through the operator listener and reports refusals", async () => {
  const calls = [];
  const engine = adapter({
    fetchImpl: fakeFetch({
      [`POST /evict/Counter:${ID}`]: () => [409, { ok: false, error: { kind: "refused", reason: "cell_active" } }],
    }, calls),
  });
  assert.deepEqual(await engine.evict(`Counter:${ID}`), {
    status: 409,
    ok: false,
    error: { kind: "refused", reason: "cell_active" },
  });
  assert.deepEqual(calls, [["POST", `http://127.0.0.1:8081/evict/Counter:${ID}`]]);
  await assert.rejects(engine.evict("Counter:../../shutdown"), RangeError);
});

test("inspects through the app's public listener with the inspector token", async () => {
  const calls = [];
  const engine = adapter({
    inspectorToken: "tok",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ tables: [] }), { status: 200 });
    },
  });
  assert.deepEqual(await engine.inspect(`Counter:${ID}`, { op: "summary" }), { tables: [] });
  assert.equal(calls[0].url, "http://127.0.0.1:8080/");
  assert.equal(calls[0].init.headers["x-sobjects-inspect"], "tok");
  assert.deepEqual(JSON.parse(calls[0].init.body), { op: "summary", className: "Counter", id: ID });

  const rejected = adapter({ inspectorToken: "tok", fetchImpl: async () => new Response("{}", { status: 401 }) });
  await assert.rejects(rejected.inspect(`Counter:${ID}`, { op: "summary" }), /redeploy it/);
  await assert.rejects(adapter().inspect(`Counter:${ID}`, { op: "summary" }), /No inspector token/);
});
