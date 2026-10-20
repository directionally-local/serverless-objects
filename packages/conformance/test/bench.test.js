import test from "node:test";
import assert from "node:assert/strict";
import { formatTable, parseBenchArgs, summarize } from "../src/bench.js";

test("bench options default to the native engine and a URL selects a remote target", () => {
  assert.equal(parseBenchArgs([]).target, "native");
  const remote = parseBenchArgs(["--url", "https://bench.example.workers.dev/", "--requests", "50"]);
  assert.equal(remote.target, "url");
  assert.equal(remote.url, "https://bench.example.workers.dev");
  assert.equal(remote.requests, 50);
  assert.throws(() => parseBenchArgs(["--target", "lambda"]), /--target must be/);
  assert.throws(() => parseBenchArgs(["--concurrency", "0"]), /--concurrency must be a positive integer/);
});

test("latency summaries report percentiles and the table renders every row", () => {
  const summary = summarize(Array.from({ length: 100 }, (_, index) => index + 1));
  assert.deepEqual(summary, { count: 100, p50: 51, p95: 96, p99: 100, max: 100 });
  const table = formatTable("native", [{ name: "noop", ...summary }, { name: "writes", ...summary, rps: 900, failed: 2 }]);
  assert.match(table, /\| noop \| 51\.00 \| 96\.00 \| 100\.00 \|  \|/);
  assert.match(table, /\| writes \| .* \| 900 \(2 failed\) \|/);
});
