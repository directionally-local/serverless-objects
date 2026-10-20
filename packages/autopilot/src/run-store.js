// Storage for one Autopilot run inside its own Durable Object. It is the
// per-run subset of Autopilot's RunStore (src/runs/store.ts): the run record
// and its state machine, tool-boundary events, usage budgets, durable wake
// timers with leases, and an append-only Camouflage session log. The same
// code runs on Durable Object SQLite and, in tests, on node:sqlite.

export const RUN_STATUSES = ["queued", "running", "waiting", "needs_input", "completed", "failed", "cancelled", "interrupted_unknown"];
export const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted_unknown"]);
export const TIMER_CONDITIONS = ["time", "job", "approval"];

const ALLOWED_TRANSITIONS = {
  queued: new Set(["running", "cancelled", "failed"]),
  running: new Set(["queued", "waiting", "needs_input", "completed", "failed", "cancelled", "interrupted_unknown"]),
  waiting: new Set(["running", "needs_input", "failed", "cancelled"]),
  needs_input: new Set(["queued", "running", "cancelled"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  interrupted_unknown: new Set(),
};

export const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60_000;
const MAX_PAGE = 500;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS run (
    id TEXT PRIMARY KEY,
    workspace TEXT NOT NULL,
    session_id TEXT,
    cwd TEXT NOT NULL,
    task TEXT NOT NULL,
    status TEXT NOT NULL,
    stop_reason TEXT,
    allowed_tools_json TEXT NOT NULL DEFAULT '[]',
    max_tool_iterations INTEGER,
    max_runtime_ms INTEGER,
    max_total_tokens INTEGER,
    max_cost_usd REAL,
    total_prompt_tokens INTEGER NOT NULL DEFAULT 0,
    total_completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_cost_usd REAL NOT NULL DEFAULT 0,
    cost_unknown_responses INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS run_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    tool_call_id TEXT,
    tool_name TEXT,
    metadata_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(tool_call_id, event_type)
  );
  CREATE TABLE IF NOT EXISTS run_timers (
    id TEXT PRIMARY KEY,
    condition_type TEXT NOT NULL,
    job_id TEXT,
    wake_at INTEGER NOT NULL,
    interval_ms INTEGER NOT NULL DEFAULT 10000,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    lease_until INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_run_timers_due ON run_timers(status, wake_at);
  CREATE TABLE IF NOT EXISTS session_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    event_json TEXT NOT NULL
  );
`;

export class RunToolBudgetExceededError extends Error {
  constructor() {
    super("max_tool_iterations_exceeded");
    this.name = "RunToolBudgetExceededError";
    this.reason = "max_tool_iterations_exceeded";
  }
}

// `db` is { exec(query, ...bindings) -> rows[], transaction(fn) -> result }.
// `onEvent` receives every appended run event and session event, for streaming.
export class RunStore {
  #db;
  #now;
  #randomId;
  #onEvent;
  #pending = [];

  constructor(db, { now = () => Date.now(), randomId = () => crypto.randomUUID(), onEvent = () => {} } = {}) {
    this.#db = db;
    this.#now = now;
    this.#randomId = randomId;
    this.#onEvent = onEvent;
    for (const statement of SCHEMA.split(";").map((part) => part.trim()).filter(Boolean)) db.exec(statement);
  }

  createRun(input) {
    const task = typeof input.task === "string" ? input.task.trim() : "";
    if (!task) throw new Error("task must not be empty");
    requireNonEmpty(input.id, "id");
    requireNonEmpty(input.workspace, "workspace");
    requireNonEmpty(input.cwd, "cwd");
    const allowedTools = [...new Set(input.allowedTools ?? [])];
    if (allowedTools.some((name) => typeof name !== "string" || !name.trim())) {
      throw new Error("allowedTools must contain non-empty tool names");
    }
    const budgets = validateBudgets({
      maxToolIterations: input.maxToolIterations ?? null,
      maxRuntimeMs: input.maxRuntimeMs ?? null,
      maxTotalTokens: input.maxTotalTokens ?? null,
      maxCostUsd: input.maxCostUsd ?? null,
    });
    return this.#tx(() => {
      const existing = this.getRun();
      if (existing) {
        if (existing.id !== input.id) throw new Error(`This object already holds run ${existing.id}`);
        return existing;
      }
      const now = this.#now();
      this.#db.exec(
        `INSERT INTO run (id, workspace, session_id, cwd, task, status, allowed_tools_json, max_tool_iterations,
          max_runtime_ms, max_total_tokens, max_cost_usd, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
        input.id, input.workspace, input.sessionId ?? null, input.cwd, task, JSON.stringify(allowedTools),
        budgets.maxToolIterations, budgets.maxRuntimeMs, budgets.maxTotalTokens, budgets.maxCostUsd, now, now,
      );
      this.#appendEvent("state", null, null, { status: "queued" }, now);
      return this.getRun();
    });
  }

  getRun() {
    const [row] = this.#db.exec("SELECT * FROM run LIMIT 1");
    return row ? rowToRun(row) : undefined;
  }

  transition(status, reason) {
    if (!RUN_STATUSES.includes(status)) throw new Error(`Unknown run status: ${status}`);
    return this.#tx(() => {
      const current = this.#requireRun();
      if (current.status !== status && !ALLOWED_TRANSITIONS[current.status].has(status)) {
        throw new Error(`Invalid run transition: ${current.status} -> ${status}`);
      }
      const now = this.#now();
      const startedAt = status === "running" ? current.startedAt ?? now : current.startedAt;
      const finishedAt = TERMINAL_STATUSES.has(status) ? now : null;
      this.#db.exec(
        "UPDATE run SET status = ?, stop_reason = ?, updated_at = ?, started_at = ?, finished_at = ?",
        status, reason ?? null, now, startedAt, finishedAt,
      );
      this.#appendEvent("state", null, null, { status, reason: reason ?? null }, now);
      if (TERMINAL_STATUSES.has(status)) this.#cancelActiveTimers();
      return this.getRun();
    });
  }

  // Resume a budget-paused run and atomically apply revised limits.
  resumeWithBudgets(update) {
    if (!isRecord(update) || Object.values(update).every((value) => value === undefined)) {
      throw new Error("At least one run budget must be updated to resume");
    }
    return this.#tx(() => {
      const current = this.#requireRun();
      if (current.status !== "needs_input") throw new Error(`Run ${current.id} is not waiting for input (status: ${current.status})`);
      const budgets = validateBudgets({
        maxToolIterations: update.maxToolIterations === undefined ? current.maxToolIterations : update.maxToolIterations,
        maxRuntimeMs: update.maxRuntimeMs === undefined ? current.maxRuntimeMs : update.maxRuntimeMs,
        maxTotalTokens: update.maxTotalTokens === undefined ? current.maxTotalTokens : update.maxTotalTokens,
        maxCostUsd: update.maxCostUsd === undefined ? current.maxCostUsd : update.maxCostUsd,
      });
      const now = this.#now();
      this.#db.exec(
        `UPDATE run SET status = 'running', stop_reason = NULL, updated_at = ?, finished_at = NULL,
          max_tool_iterations = ?, max_runtime_ms = ?, max_total_tokens = ?, max_cost_usd = ?`,
        now, budgets.maxToolIterations, budgets.maxRuntimeMs, budgets.maxTotalTokens, budgets.maxCostUsd,
      );
      this.#appendEvent("state", null, null, { status: "running", reason: "resumed", budgets }, now);
      return this.getRun();
    });
  }

  // Record a tool intent before execution. Only a hash of the arguments is kept.
  recordToolIntent(toolCallId, toolName, argumentSha256) {
    requireNonEmpty(toolCallId, "toolCallId");
    requireNonEmpty(toolName, "toolName");
    const recorded = this.#tx(() => {
      const run = this.#requireRun();
      if (run.status !== "running") throw new Error(`Run ${run.id} is not running (status: ${run.status})`);
      if (run.maxToolIterations !== null && this.countToolIterations() >= run.maxToolIterations) {
        const now = this.#now();
        this.#db.exec("UPDATE run SET status = 'needs_input', stop_reason = 'max_tool_iterations_exceeded', updated_at = ?, finished_at = NULL", now);
        this.#appendEvent("state", null, null, { status: "needs_input", reason: "max_tool_iterations_exceeded" }, now);
        return false;
      }
      this.#appendEvent("tool_intent", toolCallId, toolName, { argumentSha256 });
      return true;
    });
    if (!recorded) throw new RunToolBudgetExceededError();
  }

  // Record completion metadata after execution, never the output text.
  recordToolResult(toolCallId, toolName, { ok, outputSha256, outputBytes, errorCode }) {
    requireNonEmpty(toolCallId, "toolCallId");
    requireNonEmpty(toolName, "toolName");
    this.#tx(() => {
      const run = this.#requireRun();
      if (run.status !== "running") throw new Error(`Run ${run.id} is not running (status: ${run.status})`);
      this.#appendEvent("tool_result", toolCallId, toolName, {
        ok: Boolean(ok),
        outputSha256,
        outputBytes,
        ...(errorCode ? { errorCode } : {}),
      });
    });
  }

  // Mark that the executor durably saved its session after its last tool results.
  recordCheckpoint() {
    this.#tx(() => {
      const run = this.#requireRun();
      if (run.status !== "running" && run.status !== "needs_input") throw new Error(`Run ${run.id} is not active at a checkpoint`);
      this.#appendEvent("checkpoint", null, null, {});
    });
  }

  countToolIterations() {
    return this.#db.exec("SELECT COUNT(*) AS count FROM run_events WHERE event_type = 'tool_intent'")[0].count;
  }

  recordUsage({ promptTokens, completionTokens, costUsd }) {
    for (const [name, value] of [["promptTokens", promptTokens], ["completionTokens", completionTokens]]) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
    }
    if (costUsd !== undefined && costUsd !== null && (!Number.isFinite(costUsd) || costUsd < 0)) {
      throw new Error("costUsd must be a non-negative finite number");
    }
    const knownCost = costUsd === undefined || costUsd === null ? undefined : costUsd;
    return this.#tx(() => {
      const current = this.#requireRun();
      if (current.status !== "running") throw new Error(`Run ${current.id} is not running (status: ${current.status})`);
      const now = this.#now();
      const totalPromptTokens = current.totalPromptTokens + promptTokens;
      const totalCompletionTokens = current.totalCompletionTokens + completionTokens;
      const totalCostUsd = current.totalCostUsd + (knownCost ?? 0);
      const costUnknownResponses = current.costUnknownResponses + (knownCost === undefined ? 1 : 0);
      this.#db.exec(
        `UPDATE run SET total_prompt_tokens = ?, total_completion_tokens = ?, total_cost_usd = ?,
          cost_unknown_responses = ?, updated_at = ?`,
        totalPromptTokens, totalCompletionTokens, totalCostUsd, costUnknownResponses, now,
      );
      const totalTokens = totalPromptTokens + totalCompletionTokens;
      let budgetExceededReason = null;
      if (current.maxTotalTokens !== null && totalTokens >= current.maxTotalTokens) budgetExceededReason = "max_total_tokens_exceeded";
      else if (current.maxCostUsd !== null && knownCost === undefined) budgetExceededReason = "cost_unavailable";
      else if (current.maxCostUsd !== null && totalCostUsd >= current.maxCostUsd) budgetExceededReason = "max_cost_usd_exceeded";
      this.#appendEvent("usage", null, null, {
        promptTokens,
        completionTokens,
        costUsd: knownCost ?? null,
        totalPromptTokens,
        totalCompletionTokens,
        totalCostUsd,
        costUnknownResponses,
      }, now);
      if (budgetExceededReason) {
        this.#db.exec("UPDATE run SET status = 'needs_input', stop_reason = ?, updated_at = ?, finished_at = NULL", budgetExceededReason, now);
        this.#appendEvent("state", null, null, { status: "needs_input", reason: budgetExceededReason }, now);
      }
      return { run: this.getRun(), budgetExceededReason };
    });
  }

  // After the executor host restarts, requeue a running run that has a saved
  // checkpoint and no unmatched tool intent. Ambiguous tool actions are never
  // replayed: the run becomes interrupted_unknown.
  reconcileInterrupted() {
    return this.#tx(() => {
      const run = this.getRun();
      if (!run || run.status !== "running") return run;
      const [pending] = this.#db.exec(
        `SELECT i.tool_call_id, i.tool_name FROM run_events i
         LEFT JOIN run_events r ON r.tool_call_id = i.tool_call_id AND r.event_type = 'tool_result'
         WHERE i.event_type = 'tool_intent' AND r.sequence IS NULL ORDER BY i.sequence LIMIT 1`,
      );
      const checkpoint = this.#db.exec("SELECT MAX(sequence) AS sequence FROM run_events WHERE event_type = 'checkpoint'")[0].sequence ?? 0;
      const [uncheckpointed] = this.#db.exec(
        "SELECT tool_call_id, tool_name FROM run_events WHERE event_type = 'tool_intent' AND sequence > ? ORDER BY sequence LIMIT 1",
        checkpoint,
      );
      const [activeTimer] = this.#db.exec(
        "SELECT id FROM run_timers WHERE status IN ('scheduled', 'claimed') AND condition_type IN ('time', 'job') LIMIT 1",
      );
      const uncertain = pending ?? uncheckpointed;
      const status = uncertain ? "interrupted_unknown" : activeTimer ? "waiting" : "queued";
      let reason;
      if (pending) reason = `ambiguous_tool:${pending.tool_name}:${pending.tool_call_id}`;
      else if (uncheckpointed) reason = `tool_result_not_checkpointed:${uncheckpointed.tool_name}:${uncheckpointed.tool_call_id}`;
      else reason = activeTimer ? "process_restart_wait_recovered" : "process_restart_recovered";
      const now = this.#now();
      this.#db.exec("UPDATE run SET status = ?, stop_reason = ?, updated_at = ?, finished_at = ?", status, reason, now, uncertain ? now : null);
      this.#appendEvent("state", null, null, { status, reason }, now);
      if (uncertain) this.#cancelActiveTimers();
      return this.getRun();
    });
  }

  listEvents({ after = 0, limit = MAX_PAGE } = {}) {
    return this.#db.exec(
      "SELECT * FROM run_events WHERE sequence > ? ORDER BY sequence LIMIT ?",
      cursor(after), pageSize(limit),
    ).map(rowToEvent);
  }

  // Camouflage events: { event_type, payload, ... }. Camouflage fills id,
  // session_id, seq and timestamp_ms when absent; the object assigns seq,
  // session_id and timestamp_ms so the log replays in order from any node.
  appendSessionEvents(events) {
    if (!Array.isArray(events) || events.length === 0) throw new Error("events must be a non-empty array");
    for (const event of events) {
      if (!isRecord(event) || typeof event.event_type !== "string" || !event.event_type) {
        throw new Error("each session event needs a string event_type");
      }
    }
    return this.#tx(() => {
      const run = this.#requireRun();
      const appended = [];
      for (const event of events) {
        const timestamp = Number.isFinite(event.timestamp_ms) ? event.timestamp_ms : this.#now();
        const { seq: _ignored, ...rest } = event;
        const draft = { ...rest, session_id: run.sessionId ?? run.id, timestamp_ms: timestamp };
        const [{ seq }] = this.#db.exec("INSERT INTO session_events (event_json) VALUES (?) RETURNING seq", JSON.stringify(draft));
        const stored = { ...draft, seq };
        this.#pending.push(["session", stored]);
        appended.push(stored);
      }
      return appended.at(-1).seq;
    });
  }

  listSessionEvents({ after = 0, limit = MAX_PAGE } = {}) {
    return this.#db.exec(
      "SELECT seq, event_json FROM session_events WHERE seq > ? ORDER BY seq LIMIT ?",
      cursor(after), pageSize(limit),
    ).map((row) => ({ ...JSON.parse(row.event_json), seq: row.seq }));
  }

  scheduleTimer({ condition, wakeAt, intervalMs = 10_000, jobId, maxAttempts = 5 }) {
    if (!TIMER_CONDITIONS.includes(condition)) throw new Error(`Unknown timer condition: ${condition}`);
    if (!Number.isFinite(wakeAt)) throw new Error("wakeAt must be a finite timestamp");
    if (condition === "job" && !jobId) throw new Error("job timers require jobId");
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
      throw new Error("maxAttempts must be an integer from 1 through 100");
    }
    if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 7 * 24 * 60 * 60 * 1000) {
      throw new Error("intervalMs must be an integer from 1000 through 604800000");
    }
    return this.#tx(() => {
      const run = this.#requireRun();
      if (TERMINAL_STATUSES.has(run.status)) throw new Error(`Run ${run.id} has finished (status: ${run.status})`);
      const id = this.#randomId();
      this.#db.exec(
        `INSERT INTO run_timers (id, condition_type, job_id, wake_at, interval_ms, status, max_attempts, created_at)
         VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
        id, condition, jobId ?? null, Math.trunc(wakeAt), intervalMs, maxAttempts, this.#now(),
      );
      return this.getTimer(id);
    });
  }

  getTimer(id) {
    const [row] = this.#db.exec("SELECT * FROM run_timers WHERE id = ?", id);
    return row ? rowToTimer(row) : undefined;
  }

  listTimers() {
    return this.#db.exec("SELECT * FROM run_timers ORDER BY wake_at").map(rowToTimer);
  }

  // The earliest moment a timer needs attention: a scheduled wake or an expired lease.
  nextTimerAt() {
    return this.#db.exec(
      `SELECT MIN(CASE WHEN status = 'scheduled' THEN wake_at ELSE lease_until END) AS next_at
       FROM run_timers WHERE status IN ('scheduled', 'claimed') AND condition_type IN ('time', 'job')`,
    )[0].next_at ?? null;
  }

  // Lease due timers; a lease that expires (the object died mid-wake) is retried.
  claimDueTimers(now = this.#now(), leaseMs = DEFAULT_LEASE_MS) {
    return this.#tx(() => {
      this.#db.exec(
        `UPDATE run_timers SET status = 'failed', lease_until = NULL,
          last_error = COALESCE(last_error, 'lease expired after maximum attempts')
         WHERE status = 'claimed' AND lease_until <= ? AND attempts >= max_attempts`,
        now,
      );
      const due = this.#db.exec(
        `SELECT id FROM run_timers
         WHERE ((status = 'scheduled' AND wake_at <= ?) OR (status = 'claimed' AND lease_until <= ?))
           AND condition_type IN ('time', 'job') AND attempts < max_attempts
         ORDER BY wake_at LIMIT ?`,
        now, now, MAX_PAGE,
      );
      for (const { id } of due) {
        this.#db.exec("UPDATE run_timers SET status = 'claimed', attempts = attempts + 1, lease_until = ? WHERE id = ?", now + leaseMs, id);
      }
      return due.map(({ id }) => this.getTimer(id));
    });
  }

  completeTimer(id) {
    return this.#updateClaimed(id, () => {
      this.#db.exec("UPDATE run_timers SET status = 'completed', lease_until = NULL, last_error = NULL WHERE id = ?", id);
    });
  }

  // Reschedule a job-status check that found the job still active, without using retries.
  rescheduleTimer(id, wakeAt) {
    return this.#updateClaimed(id, (timer) => {
      if (timer.condition !== "job") throw new Error(`Timer ${id} is not a job timer`);
      this.#db.exec(
        "UPDATE run_timers SET status = 'scheduled', wake_at = ?, attempts = 0, lease_until = NULL, last_error = NULL WHERE id = ?",
        Math.trunc(wakeAt), id,
      );
    });
  }

  retryTimer(id, error, now = this.#now()) {
    return this.#updateClaimed(id, (timer) => {
      const message = String(error).slice(0, 1000);
      if (timer.attempts >= timer.maxAttempts) {
        this.#db.exec("UPDATE run_timers SET status = 'failed', lease_until = NULL, last_error = ? WHERE id = ?", message, id);
      } else {
        const delay = Math.min(MAX_RETRY_MS, DEFAULT_RETRY_MS * 2 ** Math.max(0, timer.attempts - 1));
        this.#db.exec("UPDATE run_timers SET status = 'scheduled', wake_at = ?, lease_until = NULL, last_error = ? WHERE id = ?", now + delay, message, id);
      }
    });
  }

  cancelTimer(id) {
    return this.#tx(() => {
      const timer = this.getTimer(id);
      if (!timer) throw new Error(`Timer not found: ${id}`);
      if (timer.status === "scheduled" || timer.status === "claimed") {
        this.#db.exec("UPDATE run_timers SET status = 'cancelled', lease_until = NULL WHERE id = ?", id);
      }
      return this.getTimer(id);
    });
  }

  // Events are announced only after the transaction commits.
  #tx(fn) {
    let result;
    try {
      result = this.#db.transaction(fn);
    } catch (error) {
      this.#pending = [];
      throw error;
    }
    const pending = this.#pending;
    this.#pending = [];
    for (const [stream, event] of pending) this.#onEvent(stream, event);
    return result;
  }

  #cancelActiveTimers() {
    this.#db.exec("UPDATE run_timers SET status = 'cancelled', lease_until = NULL WHERE status IN ('scheduled', 'claimed')");
  }

  #updateClaimed(id, update) {
    return this.#tx(() => {
      const timer = this.getTimer(id);
      if (!timer) throw new Error(`Timer not found: ${id}`);
      if (timer.status !== "claimed") throw new Error(`Timer ${id} is not claimed`);
      update(timer);
      return this.getTimer(id);
    });
  }

  #requireRun() {
    const run = this.getRun();
    if (!run) throw new Error("This object has no run; call create first");
    return run;
  }

  #appendEvent(type, toolCallId, toolName, metadata, createdAt = this.#now()) {
    const rows = this.#db.exec(
      `INSERT INTO run_events (event_type, tool_call_id, tool_name, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING sequence`,
      type, toolCallId, toolName, JSON.stringify(metadata), createdAt,
    );
    if (rows.length === 0) return;
    this.#pending.push(["run", { sequence: rows[0].sequence, type, toolCallId, toolName, metadata, createdAt }]);
  }
}

function validateBudgets(budgets) {
  validateOptionalPositiveInteger("maxToolIterations", budgets.maxToolIterations);
  validateOptionalPositiveInteger("maxRuntimeMs", budgets.maxRuntimeMs, 1000);
  validateOptionalPositiveInteger("maxTotalTokens", budgets.maxTotalTokens);
  if (budgets.maxCostUsd !== null && (!Number.isFinite(budgets.maxCostUsd) || budgets.maxCostUsd < 0.01)) {
    throw new Error("maxCostUsd must be null or a finite number greater than or equal to 0.01");
  }
  return budgets;
}

function validateOptionalPositiveInteger(name, value, minimum = 1) {
  if (value !== null && (!Number.isSafeInteger(value) || value < minimum)) {
    throw new Error(`${name} must be null or a safe integer greater than or equal to ${minimum}`);
  }
}

function requireNonEmpty(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
}

function cursor(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("after must be a non-negative integer");
  return number;
}

function pageSize(value) {
  return Math.max(1, Math.min(MAX_PAGE, Math.trunc(Number(value) || MAX_PAGE)));
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rowToRun(row) {
  return {
    id: row.id,
    workspace: row.workspace,
    sessionId: row.session_id,
    cwd: row.cwd,
    task: row.task,
    status: row.status,
    stopReason: row.stop_reason,
    allowedTools: JSON.parse(row.allowed_tools_json),
    maxToolIterations: row.max_tool_iterations,
    maxRuntimeMs: row.max_runtime_ms,
    maxTotalTokens: row.max_total_tokens,
    maxCostUsd: row.max_cost_usd,
    totalPromptTokens: row.total_prompt_tokens,
    totalCompletionTokens: row.total_completion_tokens,
    totalCostUsd: row.total_cost_usd,
    costUnknownResponses: row.cost_unknown_responses,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function rowToEvent(row) {
  return {
    sequence: row.sequence,
    type: row.event_type,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    metadata: JSON.parse(row.metadata_json),
    createdAt: row.created_at,
  };
}

function rowToTimer(row) {
  return {
    id: row.id,
    condition: row.condition_type,
    jobId: row.job_id,
    wakeAt: row.wake_at,
    intervalMs: row.interval_ms,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    leaseUntil: row.lease_until,
    lastError: row.last_error,
    createdAt: row.created_at,
  };
}
