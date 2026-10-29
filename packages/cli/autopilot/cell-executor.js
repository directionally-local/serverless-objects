// Runs one Autopilot turn for a run inside a Hotcell cell, the way Autopilot's
// server does (src/server/aster-cell-runtime.ts): install autopilot-ai in the
// cell, start its bridge, open a session, send the prompt, then follow the
// bridge's event cursor. Every step is persisted and driven by the object's
// alarm, so a node restart resumes at the saved step and cursor while the
// cell keeps working.
import { redactDeep } from "./redact.js";
import { TurnRecorder, bounded } from "./turn-recorder.js";

export const DEFAULT_MODEL = "moonshotai/kimi-k2.6";
export const DEFAULT_PACKAGE = "autopilot-ai@2.8.0";
export const DEFAULT_IMAGE = "ghcr.io/sinameraji/hotcell-base:latest";

const CELL_STATE_DIR = "/workspace/.aster";
const CELL_CONTROL_DIR = `${CELL_STATE_DIR}/control`;
const CELL_RUNTIME_DIR = "/opt/autopilot/node_modules/autopilot-ai";
const SDK_ENTRY = `${CELL_RUNTIME_DIR}/dist/sdk/index.js`;
const BRIDGE_MARKER = "startAsterCellBridge";
const BRIDGE_RUNNER = `node --input-type=module -e 'import { startAsterCellBridge } from "${SDK_ENTRY}"; void startAsterCellBridge()'`;
const CONTROL_RUNNER =
  `node --input-type=module -e 'import { executeAsterCellControl } from "${SDK_ENTRY}";` +
  `const r = await executeAsterCellControl(process.argv[1]); process.stdout.write(JSON.stringify(r) + "\\n");'`;

const STEPS = ["provision", "install", "bridge", "session", "prompt", "poll"];
// One step runs at a time: it holds a lease, and every write checks the lease,
// so an overlapping or stale invocation (an alarm re-run while the first is
// still awaiting) cannot advance or log.
const STEP_LEASE_MS = 60_000;
const INSTALL_LOG = `${CELL_STATE_DIR}/install.log`;
const INSTALL_EXIT = `${CELL_STATE_DIR}/install.exit`;
const INSTALL_CHECK_MS = 3_000;
const POLL_MS = 1_000;
const MAX_STEP_ATTEMPTS = 6;
// Polling failures are usually transient (daemon restart, network), so allow ~15 minutes.
const MAX_POLL_ATTEMPTS = 30;
const MAX_RETRY_MS = 30_000;
const QUIET_POLLS_BEFORE_STATUS = 20;
const MAX_TASK_BYTES = 24 * 1024;
const PACKAGE_RE = /^autopilot-ai@[0-9A-Za-z.+-]+$/;
const MODEL_RE = /^[A-Za-z0-9._:/-]{1,200}$/;

export class CellExecutor {
  #db;
  #run;
  #connect;
  #now;
  #randomId;

  // run: the RunHost. connect(cellId | undefined, createOptions) -> Hotcell Sandbox.
  constructor({ db, run, connect, now = () => Date.now(), randomId = () => crypto.randomUUID() }) {
    this.#db = db;
    this.#run = run;
    this.#connect = connect;
    this.#now = now;
    this.#randomId = randomId;
    db.exec(`CREATE TABLE IF NOT EXISTS cell_executor (
      run_id TEXT PRIMARY KEY,
      step TEXT NOT NULL,
      cell_id TEXT,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      model TEXT NOT NULL,
      package_spec TEXT NOT NULL,
      create_json TEXT NOT NULL,
      cursor INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      quiet_polls INTEGER NOT NULL DEFAULT 0,
      abort_sent INTEGER NOT NULL DEFAULT 0,
      open_streams_json TEXT NOT NULL DEFAULT '[]',
      pending_text_json TEXT NOT NULL DEFAULT '{}',
      prompt_text TEXT,
      lease_token TEXT,
      lease_until INTEGER,
      last_error TEXT
    )`);
    const columns = new Set(db.exec("SELECT name FROM pragma_table_info('cell_executor')").map((row) => row.name));
    if (!columns.has("open_streams_json")) db.exec("ALTER TABLE cell_executor ADD COLUMN open_streams_json TEXT NOT NULL DEFAULT '[]'");
    if (!columns.has("pending_text_json")) db.exec("ALTER TABLE cell_executor ADD COLUMN pending_text_json TEXT NOT NULL DEFAULT '{}'");
    if (!columns.has("prompt_text")) db.exec("ALTER TABLE cell_executor ADD COLUMN prompt_text TEXT");
    if (!columns.has("lease_token")) db.exec("ALTER TABLE cell_executor ADD COLUMN lease_token TEXT");
    if (!columns.has("lease_until")) db.exec("ALTER TABLE cell_executor ADD COLUMN lease_until INTEGER");
  }

  // Queue a run for execution. The work happens on the next alarms.
  async start({ model = DEFAULT_MODEL, packageSpec = DEFAULT_PACKAGE, image = DEFAULT_IMAGE, egress = { spendCapUsd: 1, ttlMs: 3_600_000 } } = {}) {
    if (!MODEL_RE.test(model)) throw new Error("model must be an OpenRouter model id");
    if (!PACKAGE_RE.test(packageSpec)) throw new Error("packageSpec must be autopilot-ai@<version>");
    const run = this.#run.get();
    if (!run) throw new Error("This object has no run; call create first");
    if (new TextEncoder().encode(run.task).byteLength > MAX_TASK_BYTES) throw new Error(`task must be at most ${MAX_TASK_BYTES} bytes`);
    if (this.state()) throw new Error(`Run ${run.id} has already been started`);
    if (run.status !== "queued") throw new Error(`Run ${run.id} is not queued (status: ${run.status})`);
    await this.#run.transition("running", "cell_starting");
    const createOptions = { image, egress, labels: { "serverless-objects.run": run.id } };
    this.#db.exec(
      `INSERT INTO cell_executor (run_id, step, session_id, turn_id, model, package_spec, create_json, next_at)
       VALUES (?, 'provision', ?, ?, ?, ?, ?, ?)`,
      run.id, this.#randomId(), this.#randomId(), model, packageSpec, JSON.stringify(createOptions), this.#now(),
    );
    this.#run.appendSessionEvents([
      { event_type: "SessionStarted", payload: { title: `Autopilot run ${run.id}`, detail: [model] } },
      { event_type: "UserMessageCreated", payload: redactDeep({ text: run.task }) },
    ]);
    return this.state();
  }

  state() {
    const [row] = this.#db.exec("SELECT * FROM cell_executor LIMIT 1");
    return row ? rowToState(row) : null;
  }

  nextAt() {
    const state = this.state();
    if (!state || !STEPS.includes(state.step) || state.nextAt === null) return null;
    // While a step holds the lease, look again when it would expire.
    return state.leaseUntil !== null && state.leaseUntil > this.#now() ? Math.max(state.nextAt, state.leaseUntil) : state.nextAt;
  }

  // Whether resume() can start a follow-up turn: the run is paused for input
  // and the cell has finished stopping the previous turn.
  resumable() {
    const state = this.state();
    if (!state) return { ok: false, reason: "this run was never started in a cell" };
    if (state.step !== "done") return { ok: false, reason: "the cell is still stopping the previous turn; retry shortly" };
    if (!state.cellId) return { ok: false, reason: "the run has no cell" };
    if (this.#run.get()?.status !== "needs_input") return { ok: false, reason: `the run is not waiting for input (status: ${this.#run.get()?.status})` };
    return { ok: true };
  }

  // Start a follow-up turn in the same cell session after the run resumed.
  // The cell keeps the conversation, so the agent continues from where it stopped.
  continueTurn({ message = "Continue the task from where you stopped." } = {}) {
    if (typeof message !== "string" || !message.trim()) throw new Error("message must be a non-empty string");
    if (new TextEncoder().encode(message).byteLength > MAX_TASK_BYTES) throw new Error(`message must be at most ${MAX_TASK_BYTES} bytes`);
    if (this.#run.get()?.status !== "running") throw new Error("resume the run before continuing its turn");
    this.#update({
      step: "bridge",
      turn_id: this.#randomId(),
      prompt_text: message,
      abort_sent: 0,
      attempts: 0,
      quiet_polls: 0,
      last_error: null,
      lease_token: null,
      lease_until: null,
      next_at: this.#now(),
    });
    this.#log("UserMessageCreated", { text: message });
    return this.state();
  }

  // Ask the cell to stop the turn; the run finishes when the cell reports it.
  async cancel() {
    const state = this.state();
    if (!state || !STEPS.includes(state.step)) throw new Error("No cell turn is in progress");
    if (state.step === "poll") {
      await this.#abort(state);
      return this.state();
    }
    this.#update({ step: "done", next_at: null, lease_token: null, lease_until: null });
    await this.#finish("cancelled", "cancelled_before_prompt");
    return this.state();
  }

  // Run the due step under a lease. Called on every alarm.
  async step() {
    const now = this.#now();
    const due = this.state();
    if (!due || !STEPS.includes(due.step) || due.nextAt === null || due.nextAt > now) return;
    const token = this.#randomId();
    const leased = this.#db.exec(
      "UPDATE cell_executor SET lease_token = ?, lease_until = ? WHERE lease_until IS NULL OR lease_until <= ? RETURNING run_id",
      token, now + STEP_LEASE_MS, now,
    );
    if (leased.length === 0) return;
    const state = { ...this.state(), lease: token };
    try {
      if (this.#run.get()?.status !== "running" && state.step !== "poll") {
        this.#update({ step: "done", next_at: null }, state.lease);
        return;
      }
      switch (state.step) {
        case "provision": await this.#provision(state); break;
        case "install": await this.#install(state); break;
        case "bridge": await this.#bridge(state); break;
        case "session": await this.#session(state); break;
        case "prompt": await this.#prompt(state); break;
        case "poll": await this.#poll(state); break;
      }
    } catch (error) {
      if (!(error instanceof StaleStepError)) await this.#failStep(state, error).catch((failure) => {
        if (!(failure instanceof StaleStepError)) throw failure;
      });
    } finally {
      this.#db.exec("UPDATE cell_executor SET lease_token = NULL, lease_until = NULL WHERE lease_token = ?", token);
    }
  }

  async #provision(state) {
    const cell = await this.#connect(undefined, JSON.parse(state.createJson));
    this.#advance(state, "install", { cell_id: cell.id });
    this.#log("BackgroundTaskUpdate", { task_id: "cell", label: `cell ${cell.id} created`, state: "done" });
  }

  // npm install runs as a background process in the cell, so no alarm waits on it.
  async #install(state) {
    const cell = await this.#cell(state);
    const version = state.packageSpec.slice("autopilot-ai@".length);
    if ((await installedVersion(cell)) === version) {
      this.#advance(state, "bridge");
      this.#log("BackgroundTaskUpdate", { task_id: "runtime", label: `${state.packageSpec} installed`, state: "done" });
      return;
    }
    const exit = await cell.readFile(INSTALL_EXIT).catch(() => null);
    if (exit !== null) {
      const log = await cell.readFile(INSTALL_LOG).catch(() => "");
      await cell.exec(`rm -f ${INSTALL_EXIT}`);
      throw new Error(`npm install exited ${exit.trim()}: ${tail(log)}`);
    }
    const processes = await cell.listProcesses().catch(() => []);
    if (!processes.some((process) => process.status === "running" && process.command.includes("npm install --prefix /opt/autopilot"))) {
      await cell.mkdir(CELL_STATE_DIR, { parents: true });
      await cell.startProcess(
        `sh -c 'mkdir -p /opt/autopilot && npm install --prefix /opt/autopilot --no-audit --no-fund ${state.packageSpec} > ${INSTALL_LOG} 2>&1; echo $? > ${INSTALL_EXIT}'`,
      );
    }
    this.#update({ next_at: this.#now() + INSTALL_CHECK_MS }, state.lease);
  }

  async #bridge(state) {
    const cell = await this.#cell(state);
    const processes = await cell.listProcesses().catch(() => []);
    if (!processes.some((process) => process.status === "running" && process.command.includes(BRIDGE_MARKER))) {
      await cell.mkdir(CELL_CONTROL_DIR, { parents: true });
      await cell.startProcess(BRIDGE_RUNNER, { cwd: "/opt/autopilot", env: { HOME: `${CELL_STATE_DIR}/home` } });
    }
    const health = await this.#control(cell, "GET", "/health").catch(() => null);
    if (health?.ok !== true || (health.sessionId && health.initialized !== true)) throw new Error("bridge not ready");
    this.#advance(state, "session");
  }

  async #session(state) {
    const cell = await this.#cell(state);
    const health = await this.#control(cell, "GET", "/health");
    if (health.sessionId !== state.sessionId || health.initialized !== true) {
      await this.#control(cell, "POST", "/rpc", {
        id: this.#randomId(),
        type: "new_session",
        sessionId: state.sessionId,
        config: { model: state.model },
      });
    }
    this.#advance(state, "prompt");
  }

  // The bridge remembers turn ids, so resending the prompt after a crash is safe.
  async #prompt(state) {
    const cell = await this.#cell(state);
    const message = state.promptText ?? this.#run.get().task;
    await this.#control(cell, "POST", "/rpc", { id: state.turnId, type: "prompt", message });
    this.#advance(state, "poll", {}, POLL_MS);
  }

  async #poll(state) {
    const cell = await this.#cell(state);
    let cursor = state.cursor;
    let seen = 0;
    for (;;) {
      const page = await this.#control(cell, "GET", `/events?after=${cursor}`);
      const entries = Array.isArray(page.events) ? page.events : [];
      for (const entry of entries) {
        cursor = Math.max(cursor, entry.cursor);
        seen += 1;
        // Events from earlier turns in a reused cell are not this run's.
        if (entry.runId !== null && entry.runId !== state.turnId) continue;
        this.#assertLease(state);
        const finished = await this.#recorder(state).apply(entry.event);
        this.#update({ cursor }, state.lease);
        if (finished) return;
      }
      this.#update({ cursor }, state.lease);
      if (!page.hasMore) break;
    }
    if (seen > 0) {
      this.#update({ quiet_polls: 0, attempts: 0, next_at: this.#now() + POLL_MS }, state.lease);
      return;
    }
    const quiet = state.quietPolls + 1;
    if (quiet >= QUIET_POLLS_BEFORE_STATUS) {
      const status = await this.#control(cell, "GET", "/status").catch(() => null);
      if (status && !status.activeRunId) {
        this.#update({ step: "done", next_at: null }, state.lease);
        this.#log("RuntimeError", { message: "The cell has no active turn and stopped producing events." });
        await this.#finish("failed", "cell_turn_lost");
        return;
      }
      this.#update({ quiet_polls: 0, attempts: 0, next_at: this.#now() + POLL_MS }, state.lease);
      return;
    }
    this.#update({ quiet_polls: quiet, attempts: 0, next_at: this.#now() + POLL_MS }, state.lease);
  }

  // A budget that paused the run for input stays paused; otherwise the run ends.
  async #finish(status, reason) {
    const run = this.#run.get();
    if (run?.status !== "running") return;
    if (status === "completed") this.#run.recordCheckpoint();
    await this.#run.transition(status, reason);
  }

  async #abort(state) {
    if (state.abortSent || this.state()?.abortSent) return;
    const cell = await this.#cell(state);
    await this.#control(cell, "POST", "/rpc", { id: this.#randomId(), type: "abort" }).catch(() => null);
    this.#update({ abort_sent: 1 });
  }

  async #failStep(state, error) {
    const message = String(error?.message ?? error).slice(0, 1000);
    const attempts = state.attempts + 1;
    if (attempts >= (state.step === "poll" ? MAX_POLL_ATTEMPTS : MAX_STEP_ATTEMPTS)) {
      this.#update({ step: "done", next_at: null, attempts, last_error: message }, state.lease);
      this.#log("RuntimeError", { message: `cell ${state.step} failed: ${bounded(message, 400)}` });
      await this.#finish("failed", `cell_${state.step}_failed`);
      return;
    }
    const delay = Math.min(MAX_RETRY_MS, 1_000 * 2 ** (attempts - 1));
    this.#update({ attempts, last_error: message, next_at: this.#now() + delay }, state.lease);
  }

  #advance(state, step, fields = {}, delay = 0) {
    this.#update({ ...fields, step, attempts: 0, last_error: null, next_at: this.#now() + delay }, state.lease);
  }

  // With a lease, the write applies only while that lease is current; a stale
  // step stops here.
  #update(fields, lease) {
    const entries = Object.entries(fields);
    if (entries.length === 0) return;
    const assignments = entries.map(([key]) => `${key} = ?`).join(", ");
    const values = entries.map(([, value]) => value);
    if (lease === undefined) {
      this.#db.exec(`UPDATE cell_executor SET ${assignments}`, ...values);
      return;
    }
    const changed = this.#db.exec(`UPDATE cell_executor SET ${assignments} WHERE lease_token = ? RETURNING run_id`, ...values, lease);
    if (changed.length === 0) throw new StaleStepError();
  }

  #assertLease(state) {
    if (this.#db.exec("SELECT run_id FROM cell_executor WHERE lease_token = ?", state.lease).length === 0) throw new StaleStepError();
  }

  #recorder(state) {
    return new TurnRecorder({
      run: this.#run,
      state: {
        get: () => {
          const [row] = this.#db.exec("SELECT pending_text_json, open_streams_json FROM cell_executor LIMIT 1");
          return { pending: JSON.parse(row.pending_text_json), openStreams: JSON.parse(row.open_streams_json) };
        },
        set: ({ pending, openStreams }) => this.#update({
          ...(pending === undefined ? {} : { pending_text_json: JSON.stringify(pending) }),
          ...(openStreams === undefined ? {} : { open_streams_json: JSON.stringify(openStreams) }),
        }, state.lease),
      },
      finish: (status, reason) => this.#finish(status, reason),
      abort: () => this.#abort(state),
      onEnd: () => this.#update({ step: "done", next_at: null }, state.lease),
      reasonPrefix: "cell",
    });
  }

  // Session events are readable by anyone with the stream; redact likely secrets.
  #log(event_type, payload) {
    this.#run.appendSessionEvents([{ event_type, payload: redactDeep(payload) }]);
  }

  async #cell(state) {
    if (!state.cellId) throw new Error("no cell yet");
    return this.#connect(state.cellId);
  }

  // Control requests go through exec, so they work for cells without a network interface.
  async #control(cell, method, path, body) {
    const requestId = this.#randomId();
    await cell.mkdir(CELL_CONTROL_DIR, { parents: true });
    await cell.writeFile(`${CELL_CONTROL_DIR}/${requestId}.json`, JSON.stringify({ method, path, body }), { mode: "0600" });
    const result = await cell.exec(`${CONTROL_RUNNER} ${requestId}`);
    if (result.exitCode !== 0) throw new Error(`cell control ${method} ${path.split("?")[0]} failed: ${tail(result.stderr)}`);
    const parsed = JSON.parse(result.stdout.trim().split("\n").pop() || "{}");
    if (parsed.error) throw new Error(`cell control ${method} ${path.split("?")[0]}: ${parsed.error}`);
    return parsed;
  }
}

class StaleStepError extends Error {
  constructor() {
    super("another invocation took over this step");
  }
}

async function installedVersion(cell) {
  try {
    return JSON.parse(await cell.readFile(`${CELL_RUNTIME_DIR}/package.json`)).version;
  } catch {
    return undefined;
  }
}

function rowToState(row) {
  return {
    runId: row.run_id,
    step: row.step,
    cellId: row.cell_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    model: row.model,
    packageSpec: row.package_spec,
    createJson: row.create_json,
    cursor: row.cursor,
    nextAt: row.next_at,
    attempts: row.attempts,
    quietPolls: row.quiet_polls,
    abortSent: row.abort_sent === 1,
    promptText: row.prompt_text ?? null,
    leaseUntil: row.lease_until ?? null,
    lastError: row.last_error,
  };
}

function tail(text = "") {
  return bounded(String(text).trim().split("\n").slice(-5).join("\n"), 800);
}
