import assert from "node:assert/strict";
import { test } from "node:test";
import { RegistryStore } from "../src/registry-store.js";
import { RunHost, runSummary } from "../src/run-host.js";
import { RUN, clock, ids, memoryDb } from "./helpers.js";

function host({ onWake = async () => {}, checkJob } = {}) {
  const time = clock();
  const alarms = [];
  const reports = [];
  const wakes = [];
  const runHost = new RunHost({
    db: memoryDb(),
    now: time.now,
    randomId: ids(),
    setAlarm: (at) => { alarms.push(at); },
    onWake: async (event) => { wakes.push(event); await onWake(event); },
    checkJob: checkJob ?? (async () => { throw new Error("no jobs"); }),
    report: async (run) => { reports.push(run.status); },
    onEvent: () => {},
  });
  return { runHost, time, alarms, reports, wakes };
}

async function waitingRun(state, timer = {}) {
  await state.runHost.create(RUN);
  await state.runHost.transition("running");
  const scheduled = await state.runHost.scheduleTimer({ condition: "time", wakeAt: state.time.now() + 1000, ...timer });
  await state.runHost.transition("waiting", "sleeping");
  return scheduled;
}

test("an alarm wakes a waiting run once, then clears itself", async () => {
  const state = host();
  const timer = await waitingRun(state);
  assert.equal(state.alarms.at(-1), state.time.now() + 1000);

  assert.equal(await state.runHost.processDueTimers(), 0);
  assert.deepEqual(state.wakes, []);

  state.time.advance(1000);
  assert.equal(await state.runHost.processDueTimers(), 1);
  assert.deepEqual(state.wakes, [{ runId: "run-1", timerId: timer.id, condition: "time" }]);
  assert.equal(state.runHost.get().status, "running");
  assert.equal(state.runHost.get().stopReason, `wake:${timer.id}`);
  assert.equal(state.runHost.listTimers()[0].status, "completed");
  assert.equal(state.alarms.at(-1), null);
  assert.deepEqual(state.reports, ["queued", "running", "waiting", "running"]);
});

test("a failing wake goes back to waiting, retries with backoff, then fails the run", async () => {
  const state = host({ onWake: async () => { throw new Error("executor down"); } });
  await waitingRun(state, { maxAttempts: 2 });

  state.time.advance(1000);
  await state.runHost.processDueTimers();
  const [first] = state.runHost.listTimers();
  assert.equal(first.status, "scheduled");
  assert.equal(first.lastError, "executor down");
  assert.equal(state.runHost.get().status, "waiting");
  assert.equal(state.alarms.at(-1), state.time.now() + 1000);

  state.time.advance(1000);
  await state.runHost.processDueTimers();
  assert.equal(state.runHost.listTimers()[0].status, "failed");
  assert.equal(state.runHost.get().status, "failed");
  assert.match(state.runHost.get().stopReason, /^timer_wake_failed:/);
  assert.equal(state.wakes.length, 2);
});

test("job timers poll until the job leaves an active status", async () => {
  let status = "running";
  const state = host({ checkJob: async () => status });
  await state.runHost.create(RUN);
  await state.runHost.transition("running");
  await state.runHost.scheduleTimer({ condition: "job", jobId: "job-7", wakeAt: state.time.now(), intervalMs: 2000 });
  await state.runHost.transition("waiting");

  await state.runHost.processDueTimers();
  assert.equal(state.wakes.length, 0);
  assert.equal(state.runHost.listTimers()[0].wakeAt, state.time.now() + 2000);

  status = "completed";
  state.time.advance(2000);
  await state.runHost.processDueTimers();
  assert.deepEqual(state.wakes.map((wake) => [wake.jobId, wake.jobStatus]), [["job-7", "completed"]]);
});

test("a wake past the runtime budget asks for input instead", async () => {
  const state = host();
  await state.runHost.create({ ...RUN, maxRuntimeMs: 1000 });
  await state.runHost.transition("running");
  await state.runHost.scheduleTimer({ condition: "time", wakeAt: state.time.now() + 5000 });
  await state.runHost.transition("waiting");
  state.time.advance(5000);
  await state.runHost.processDueTimers();
  assert.equal(state.wakes.length, 0);
  assert.equal(state.runHost.get().status, "needs_input");
  assert.equal(state.runHost.get().stopReason, "max_runtime_exceeded");
});

test("finishing a run cancels its timers and its alarm", async () => {
  const state = host();
  await waitingRun(state);
  await state.runHost.transition("cancelled", "user");
  assert.equal(state.runHost.listTimers()[0].status, "cancelled");
  assert.equal(state.alarms.at(-1), null);
});

test("tool results keep only a hash and byte count", async () => {
  const state = host();
  await state.runHost.create(RUN);
  await state.runHost.transition("running");
  await state.runHost.recordToolIntent("c1", "bash", { command: "cat secrets.txt" });
  await state.runHost.recordToolResult("c1", "bash", { ok: true, content: "héllo" });
  const [, , intent, result] = state.runHost.listEvents();
  assert.match(intent.metadata.argumentSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(result.metadata), ["ok", "outputSha256", "outputBytes"]);
  assert.equal(result.metadata.outputBytes, 6);
  assert.equal(JSON.stringify(state.runHost.listEvents()).includes("secrets"), false);
});

test("the registry keeps the newest report and lists by status", () => {
  const registry = new RegistryStore(memoryDb());
  const base = { id: "run-1", workspace: "acme", task: "t", createdAt: 1 };
  registry.upsert(runSummary({ ...base, status: "running", stopReason: null, updatedAt: 10 }));
  registry.upsert(runSummary({ ...base, status: "queued", stopReason: null, updatedAt: 5 }));
  assert.equal(registry.get("run-1").status, "running");
  registry.upsert({ id: "run-2", task: "u", status: "completed", createdAt: 2, updatedAt: 20 });
  assert.deepEqual(registry.list().map((run) => run.id), ["run-2", "run-1"]);
  assert.deepEqual(registry.list({ status: "running" }).map((run) => run.id), ["run-1"]);
  assert.deepEqual(registry.idsWithStatus("running"), ["run-1"]);
  assert.throws(() => registry.list({ status: "nope" }), /Unknown run status/);
  assert.throws(() => registry.upsert({ id: "x", status: "weird" }), /invalid run summary/);
});

async function waitingForApproval(state, timer = {}) {
  await state.runHost.create(RUN);
  await state.runHost.transition("running");
  const approval = await state.runHost.scheduleTimer({ condition: "approval", ...timer });
  await state.runHost.transition("waiting", "needs approval");
  return approval;
}

test("an approval wakes the run once with the decision", async () => {
  const state = host();
  const approval = await waitingForApproval(state);
  assert.equal(approval.expiresAt, null);
  assert.equal(state.alarms.at(-1), null);
  assert.equal(await state.runHost.processDueTimers(), 0);

  const resolved = await state.runHost.approve(approval.id, { decision: "approved", reason: "looks safe" });
  assert.equal(resolved.status, "completed");
  assert.deepEqual(state.wakes, [{ runId: "run-1", timerId: approval.id, condition: "approval", decision: "approved", reason: "looks safe" }]);
  assert.equal(state.runHost.get().status, "running");
  const recorded = state.runHost.listEvents().find((event) => event.type === "approval");
  assert.deepEqual(recorded.metadata, { decision: "approved", reason: "looks safe" });

  await assert.rejects(state.runHost.approve(approval.id, { decision: "denied" }), /not waiting/);
  await state.runHost.transition("waiting");
  await assert.rejects(state.runHost.approve(approval.id, { decision: "denied" }), /already approved/);
  await assert.rejects(state.runHost.approve("missing", { decision: "approved" }), /not found/);
  await assert.rejects(state.runHost.approve(approval.id, { decision: "maybe" }), /approved or denied/);
});

test("a denied approval is delivered too, and a failing wake retries", async () => {
  let fail = true;
  const state = host({ onWake: async () => { if (fail) throw new Error("executor down"); } });
  const approval = await waitingForApproval(state);
  const after = await state.runHost.approve(approval.id, { decision: "denied" });
  assert.equal(after.status, "scheduled");
  assert.equal(state.runHost.get().status, "waiting");
  fail = false;
  state.time.advance(1000);
  await state.runHost.processDueTimers();
  assert.equal(state.runHost.listTimers()[0].status, "completed");
  assert.deepEqual(state.wakes.map((wake) => wake.decision), ["denied", "denied"]);
});

test("an unanswered approval expires and fails the waiting run", async () => {
  const state = host();
  const approval = await waitingForApproval(state, { expiresAt: 1_000_000 + 60_000 });
  assert.equal(approval.expiresAt, 1_060_000);
  assert.equal(state.alarms.at(-1), 1_060_000);
  state.time.advance(60_000);
  await state.runHost.processDueTimers();
  assert.equal(state.runHost.listTimers()[0].status, "failed");
  assert.equal(state.runHost.listTimers()[0].lastError, "approval expired");
  assert.equal(state.runHost.get().status, "failed");
  assert.equal(state.wakes.length, 0);
  await assert.rejects(state.runHost.scheduleTimer({ condition: "approval", wakeAt: 5 }), /expiresAt, not wakeAt/);
});
