import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs, validateCaseResult } from "../src/run.js";

test("Wrangler is the default target without a restart", () => {
  const options = parseArgs([]);
  assert.equal(options.target, "wrangler");
  assert.equal(options.port, 9876);
  assert.equal(options.timeoutMs, 60_000);
  assert.equal(options.alarmDelayMs, 2_000);
  assert.equal(options.restartAfterAlarm, false);
});

test("celld defaults to checking an alarm across restart", () => {
  const options = parseArgs(["--target", "celld"]);
  assert.equal(options.restartAfterAlarm, true);
  assert.equal(options.alarmDelayMs, 30_000);
});

test("runner options validate target, port, and alarm delay", () => {
  assert.throws(() => parseArgs(["--target", "bogus"]), /must be wrangler, celld or native/);
  assert.throws(() => parseArgs(["--port", "0"]), /--port/);
  assert.throws(() => parseArgs(["--alarm-delay", "5"]), /--alarm-delay/);
});

test("case result validation preserves an explicit engine failure", () => {
  const result = validateCaseResult("ids", { ok: true }, { pass: false, detail: "expected mismatch" });
  assert.deepEqual(result, { name: "ids", pass: false, detail: "expected mismatch" });
  assert.throws(() => validateCaseResult("ids", { ok: true }, {}), /malformed result/);
  assert.throws(() => validateCaseResult("ids", { ok: false, status: 500 }, null), /HTTP 500/);
});

test("runs every suite unless one is selected", () => {
  assert.deepEqual(parseArgs([]).suites, ["core", "agents"]);
  assert.deepEqual(parseArgs(["--suite", "agents"]).suites, ["agents"]);
  assert.deepEqual(parseArgs(["--suite", "all"]).suites, ["core", "agents"]);
  assert.throws(() => parseArgs(["--suite", "partyserver"]), /--suite must be/);
});

test("native runs on this checkout's CLI and checks an alarm across restart", () => {
  const options = parseArgs(["--target", "native"]);
  assert.equal(options.restartAfterAlarm, true);
  assert.equal(options.alarmDelayMs, 30_000);
});
