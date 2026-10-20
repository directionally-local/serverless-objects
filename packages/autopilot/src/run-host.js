// Run-object behavior that is independent of the Workers runtime: tool and
// usage recording with hashing, durable wake timers driven by one alarm, and
// registry reports. It follows Autopilot's RunWakeScheduler: a wake is
// delivered at least once, so onWake must be idempotent by timerId.
import { sha256Hex, stableJson } from "./sql.js";
import { RunStore, TERMINAL_STATUSES } from "./run-store.js";

const ACTIVE_JOB_STATUSES = new Set(["starting", "running", "cancelling"]);

export class RunHost {
  #setAlarm;
  #onWake;
  #checkJob;
  #report;
  #now;

  // setAlarm(timestamp | null), onWake(event), checkJob(jobId) -> status, report(run).
  constructor({ db, setAlarm, onWake, checkJob, report, onEvent, now = () => Date.now(), randomId }) {
    this.#setAlarm = setAlarm;
    this.#onWake = onWake;
    this.#checkJob = checkJob;
    this.#report = report;
    this.#now = now;
    this.store = new RunStore(db, { now, randomId, onEvent });
  }

  async create(input) {
    const run = this.store.createRun(input);
    await this.#report(run);
    return run;
  }

  get() {
    return this.store.getRun() ?? null;
  }

  async transition(status, reason) {
    const run = this.store.transition(status, reason);
    await this.#afterChange(run);
    return run;
  }

  async resume(budgets) {
    const run = this.store.resumeWithBudgets(budgets);
    await this.#report(run);
    return run;
  }

  async recordToolIntent(toolCallId, toolName, args) {
    const argumentSha256 = await sha256Hex(stableJson(args));
    try {
      this.store.recordToolIntent(toolCallId, toolName, argumentSha256);
    } catch (error) {
      if (error?.reason === "max_tool_iterations_exceeded") await this.#report(this.store.getRun());
      throw error;
    }
  }

  async recordToolResult(toolCallId, toolName, { ok, content = "", errorCode } = {}) {
    if (typeof content !== "string") throw new TypeError("content must be a string");
    this.store.recordToolResult(toolCallId, toolName, {
      ok,
      outputSha256: await sha256Hex(content),
      outputBytes: new TextEncoder().encode(content).byteLength,
      errorCode,
    });
  }

  recordCheckpoint() {
    this.store.recordCheckpoint();
  }

  async recordUsage(usage) {
    const result = this.store.recordUsage(usage);
    await this.#report(result.run);
    return result;
  }

  appendSessionEvents(events) {
    return this.store.appendSessionEvents(events);
  }

  listEvents(options) {
    return this.store.listEvents(options);
  }

  listSessionEvents(options) {
    return this.store.listSessionEvents(options);
  }

  async scheduleTimer(input) {
    const timer = this.store.scheduleTimer(input);
    await this.syncAlarm();
    return timer;
  }

  async cancelTimer(id) {
    const timer = this.store.cancelTimer(id);
    await this.syncAlarm();
    return timer;
  }

  listTimers() {
    return this.store.listTimers();
  }

  async reconcileInterrupted() {
    const run = this.store.reconcileInterrupted();
    if (run) await this.#afterChange(run);
    return run ?? null;
  }

  // Alarm handler: process every due timer, then arm the next alarm.
  async processDueTimers(now = this.#now()) {
    const timers = this.store.claimDueTimers(now);
    for (const timer of timers) await this.#processTimer(timer, now);
    await this.#failRunForFailedTimers();
    await this.syncAlarm();
    return timers.length;
  }

  async syncAlarm() {
    await this.#setAlarm(this.store.nextTimerAt());
  }

  async #processTimer(timer, now) {
    const run = this.store.getRun();
    if (!run || run.status !== "waiting") {
      this.store.cancelTimer(timer.id);
      return;
    }
    const startedAt = run.startedAt ?? run.createdAt;
    if (run.maxRuntimeMs !== null && now - startedAt >= run.maxRuntimeMs) {
      this.store.cancelTimer(timer.id);
      await this.#report(this.store.transition("needs_input", "max_runtime_exceeded"));
      return;
    }

    let jobStatus;
    if (timer.condition === "job") {
      try {
        jobStatus = (await this.#checkJob(timer.jobId)) ?? "not_found";
      } catch (error) {
        this.store.retryTimer(timer.id, error?.message ?? String(error), now);
        return;
      }
      if (ACTIVE_JOB_STATUSES.has(jobStatus)) {
        this.store.rescheduleTimer(timer.id, now + timer.intervalMs);
        return;
      }
    }

    // Mark the run active before notifying the executor. If the host dies
    // after this, reconcileInterrupted decides the run's fate instead of a
    // blind replay of the wake.
    await this.#report(this.store.transition("running", `wake:${timer.id}`));
    try {
      await this.#onWake({
        runId: run.id,
        timerId: timer.id,
        condition: timer.condition,
        ...(timer.jobId ? { jobId: timer.jobId } : {}),
        ...(jobStatus ? { jobStatus } : {}),
      });
      this.store.completeTimer(timer.id);
    } catch (error) {
      if (this.store.getRun()?.status === "running") this.store.transition("waiting", `wake_retry:${timer.id}`);
      const retried = this.store.retryTimer(timer.id, error?.message ?? String(error), now);
      if (retried.status === "failed" && this.store.getRun()?.status === "waiting") {
        this.store.transition("failed", `timer_wake_failed:${timer.id}`);
      }
      await this.#report(this.store.getRun());
    }
  }

  async #failRunForFailedTimers() {
    const run = this.store.getRun();
    if (run?.status !== "waiting") return;
    const failed = this.store.listTimers().find((timer) => timer.status === "failed");
    if (failed) await this.#report(this.store.transition("failed", `timer_wake_failed:${failed.id}`));
  }

  async #afterChange(run) {
    if (TERMINAL_STATUSES.has(run.status)) await this.syncAlarm();
    await this.#report(run);
  }
}

// The registry row for a run.
export function runSummary(run) {
  return {
    id: run.id,
    workspace: run.workspace,
    task: run.task,
    status: run.status,
    stopReason: run.stopReason,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}
