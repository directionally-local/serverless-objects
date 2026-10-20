import assert from "node:assert/strict";
import { test } from "node:test";
import { RunStore, RunToolBudgetExceededError } from "../src/run-store.js";
import { RUN, clock, ids, memoryDb } from "./helpers.js";

function store(options = {}) {
  const time = clock();
  const announced = [];
  const runs = new RunStore(memoryDb(), { now: time.now, randomId: ids(), onEvent: (stream, event) => announced.push([stream, event]), ...options });
  return { runs, time, announced };
}

test("creates a queued run once and records each state change", () => {
  const { runs, time } = store();
  const created = runs.createRun({ ...RUN, allowedTools: ["bash", "bash", "edit"], maxToolIterations: 5 });
  assert.equal(created.status, "queued");
  assert.deepEqual(created.allowedTools, ["bash", "edit"]);
  assert.equal(runs.createRun(RUN).createdAt, created.createdAt);
  assert.throws(() => runs.createRun({ ...RUN, id: "other" }), /already holds run run-1/);

  time.advance(10);
  const running = runs.transition("running");
  assert.equal(running.startedAt, 1_000_010);
  assert.throws(() => runs.transition("bogus"), /Unknown run status/);
  runs.transition("completed", "done");
  assert.throws(() => runs.transition("running"), /Invalid run transition: completed -> running/);
  assert.equal(runs.getRun().finishedAt, 1_000_010);
  assert.deepEqual(runs.listEvents().map((event) => event.metadata.status), ["queued", "running", "completed"]);
});

test("validates run input and budgets like Autopilot", () => {
  const { runs } = store();
  assert.throws(() => runs.createRun({ ...RUN, task: "  " }), /task must not be empty/);
  assert.throws(() => runs.createRun({ ...RUN, workspace: "" }), /workspace must not be empty/);
  assert.throws(() => runs.createRun({ ...RUN, maxRuntimeMs: 500 }), /maxRuntimeMs/);
  assert.throws(() => runs.createRun({ ...RUN, maxCostUsd: 0 }), /maxCostUsd/);
  assert.throws(() => runs.createRun({ ...RUN, allowedTools: [""] }), /allowedTools/);
});

test("a tool budget pauses the run for input, and resume applies new limits", () => {
  const { runs } = store();
  runs.createRun({ ...RUN, maxToolIterations: 1 });
  runs.transition("running");
  runs.recordToolIntent("c1", "bash", "hash-1");
  runs.recordToolResult("c1", "bash", { ok: true, outputSha256: "h", outputBytes: 2 });
  assert.throws(() => runs.recordToolIntent("c2", "bash", "hash-2"), RunToolBudgetExceededError);
  assert.equal(runs.getRun().status, "needs_input");
  assert.equal(runs.getRun().stopReason, "max_tool_iterations_exceeded");
  assert.throws(() => runs.resumeWithBudgets({}), /At least one run budget/);
  const resumed = runs.resumeWithBudgets({ maxToolIterations: 3 });
  assert.equal(resumed.status, "running");
  assert.equal(resumed.maxToolIterations, 3);
  runs.recordToolIntent("c2", "bash", "hash-2");
  runs.recordToolIntent("c2", "bash", "hash-2");
  assert.equal(runs.countToolIterations(), 2);
});

test("usage accumulates and trips token and cost budgets", () => {
  const { runs } = store();
  runs.createRun({ ...RUN, maxTotalTokens: 100 });
  runs.transition("running");
  assert.equal(runs.recordUsage({ promptTokens: 40, completionTokens: 10, costUsd: 0.5 }).budgetExceededReason, null);
  const tripped = runs.recordUsage({ promptTokens: 40, completionTokens: 10 });
  assert.equal(tripped.budgetExceededReason, "max_total_tokens_exceeded");
  assert.equal(tripped.run.totalCostUsd, 0.5);
  assert.equal(tripped.run.costUnknownResponses, 1);
  assert.throws(() => runs.recordUsage({ promptTokens: 1, completionTokens: 1 }), /not running/);

  const second = store();
  second.runs.createRun({ ...RUN, maxCostUsd: 1 });
  second.runs.transition("running");
  assert.equal(second.runs.recordUsage({ promptTokens: 1, completionTokens: 1 }).budgetExceededReason, "cost_unavailable");
  assert.throws(() => second.runs.recordUsage({ promptTokens: -1, completionTokens: 0 }), /non-negative integer/);
});

test("reconcile requeues a checkpointed run and never replays an ambiguous tool", () => {
  const clean = store();
  clean.runs.createRun(RUN);
  clean.runs.transition("running");
  clean.runs.recordToolIntent("c1", "bash", "h");
  clean.runs.recordToolResult("c1", "bash", { ok: true, outputSha256: "h", outputBytes: 0 });
  clean.runs.recordCheckpoint();
  assert.equal(clean.runs.reconcileInterrupted().status, "queued");
  assert.equal(clean.runs.getRun().stopReason, "process_restart_recovered");

  const ambiguous = store();
  ambiguous.runs.createRun(RUN);
  ambiguous.runs.transition("running");
  ambiguous.runs.scheduleTimer({ condition: "time", wakeAt: 2_000_000 });
  ambiguous.runs.recordToolIntent("c9", "bash", "h");
  const interrupted = ambiguous.runs.reconcileInterrupted();
  assert.equal(interrupted.status, "interrupted_unknown");
  assert.equal(interrupted.stopReason, "ambiguous_tool:bash:c9");
  assert.equal(ambiguous.runs.listTimers()[0].status, "cancelled");

  const uncheckpointed = store();
  uncheckpointed.runs.createRun(RUN);
  uncheckpointed.runs.transition("running");
  uncheckpointed.runs.recordToolIntent("c1", "edit", "h");
  uncheckpointed.runs.recordToolResult("c1", "edit", { ok: true, outputSha256: "h", outputBytes: 0 });
  assert.equal(uncheckpointed.runs.reconcileInterrupted().stopReason, "tool_result_not_checkpointed:edit:c1");

  const waiting = store();
  waiting.runs.createRun(RUN);
  waiting.runs.transition("running");
  waiting.runs.scheduleTimer({ condition: "time", wakeAt: 2_000_000 });
  assert.equal(waiting.runs.reconcileInterrupted().status, "waiting");
  assert.equal(waiting.runs.reconcileInterrupted().status, "waiting");
});

test("timers lease, retry with backoff, and fail after their attempts", () => {
  const { runs, time } = store();
  runs.createRun(RUN);
  const timer = runs.scheduleTimer({ condition: "time", wakeAt: time.now() + 1000, maxAttempts: 2 });
  assert.equal(runs.nextTimerAt(), time.now() + 1000);
  assert.deepEqual(runs.claimDueTimers(time.now()), []);

  time.advance(1000);
  const [claimed] = runs.claimDueTimers(time.now(), 5000);
  assert.equal(claimed.status, "claimed");
  assert.equal(runs.nextTimerAt(), time.now() + 5000);
  const retried = runs.retryTimer(timer.id, "boom", time.now());
  assert.equal(retried.status, "scheduled");
  assert.equal(retried.wakeAt, time.now() + 1000);

  time.advance(1000);
  runs.claimDueTimers(time.now(), 5000);
  // The object died mid-wake: the lease expires with no attempts left.
  time.advance(5000);
  assert.deepEqual(runs.claimDueTimers(time.now()), []);
  assert.equal(runs.getTimer(timer.id).status, "failed");
  assert.equal(runs.getTimer(timer.id).lastError, "boom");
  assert.equal(runs.nextTimerAt(), null);
  assert.throws(() => runs.scheduleTimer({ condition: "job", wakeAt: 1 }), /job timers require jobId/);
  assert.throws(() => runs.scheduleTimer({ condition: "time", wakeAt: 1, intervalMs: 5 }), /intervalMs/);
});

test("session events get seq, session id, and timestamps, and page by cursor", () => {
  const { runs, announced } = store();
  runs.createRun({ ...RUN, sessionId: "sess-1" });
  announced.length = 0;
  const last = runs.appendSessionEvents([
    { event_type: "UserMessageCreated", payload: { text: "hi" }, seq: 99 },
    { event_type: "AssistantTokenDelta", payload: { stream_id: "s1", token: "ok" }, timestamp_ms: 5 },
  ]);
  assert.equal(last, 2);
  assert.deepEqual(runs.listSessionEvents(), [
    { event_type: "UserMessageCreated", payload: { text: "hi" }, session_id: "sess-1", timestamp_ms: 1_000_000, seq: 1 },
    { event_type: "AssistantTokenDelta", payload: { stream_id: "s1", token: "ok" }, session_id: "sess-1", timestamp_ms: 5, seq: 2 },
  ]);
  assert.deepEqual(runs.listSessionEvents({ after: 1 }).map((event) => event.seq), [2]);
  assert.deepEqual(announced.map(([stream, event]) => [stream, event.seq]), [["session", 1], ["session", 2]]);
  assert.throws(() => runs.appendSessionEvents([{ payload: {} }]), /event_type/);
  assert.throws(() => runs.listSessionEvents({ after: -1 }), /after must be/);
});

test("events are announced only after their transaction commits", () => {
  const db = memoryDb();
  let failCommit = false;
  const flaky = {
    exec: db.exec,
    transaction: (fn) => db.transaction(() => {
      const result = fn();
      if (failCommit) throw new Error("commit failed");
      return result;
    }),
  };
  const announced = [];
  const runs = new RunStore(flaky, { onEvent: (stream, event) => announced.push([stream, event.type]) });
  runs.createRun(RUN);
  assert.deepEqual(announced, [["run", "state"]]);

  failCommit = true;
  assert.throws(() => runs.transition("running"), /commit failed/);
  assert.equal(runs.getRun().status, "queued");
  assert.deepEqual(announced, [["run", "state"]]);

  failCommit = false;
  runs.transition("running");
  runs.recordToolIntent("c1", "bash", "h");
  runs.recordToolIntent("c1", "bash", "h");
  assert.deepEqual(announced, [["run", "state"], ["run", "state"], ["run", "tool_intent"]]);
});
