// Runs one Autopilot turn for a run inside a Hotcell cell, the way Autopilot's
// server does (src/server/aster-cell-runtime.ts): install autopilot-ai in the
// cell, start its bridge, open a session, send the prompt, then follow the
// bridge's event cursor. Every step is persisted and driven by the object's
// alarm, so a node restart resumes at the saved step and cursor while the
// cell keeps working.
import { redactDeep } from "./redact.js";

export const DEFAULT_MODEL = "moonshotai/kimi-k2.6";
export const DEFAULT_PACKAGE = "autopilot-ai@1.25.1";
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
const POLL_MS = 1_000;
const MAX_STEP_ATTEMPTS = 6;
// Polling failures are usually transient (daemon restart, network), so allow ~15 minutes.
const MAX_POLL_ATTEMPTS = 30;
const MAX_RETRY_MS = 30_000;
const QUIET_POLLS_BEFORE_STATUS = 20;
const MAX_TASK_BYTES = 24 * 1024;
const MAX_TOOL_OUTPUT_CHARS = 16_000;
const MAX_TOOL_INPUT_CHARS = 2_000;
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
      last_error TEXT
    )`);
    const columns = new Set(db.exec("SELECT name FROM pragma_table_info('cell_executor')").map((row) => row.name));
    if (!columns.has("open_streams_json")) db.exec("ALTER TABLE cell_executor ADD COLUMN open_streams_json TEXT NOT NULL DEFAULT '[]'");
    if (!columns.has("pending_text_json")) db.exec("ALTER TABLE cell_executor ADD COLUMN pending_text_json TEXT NOT NULL DEFAULT '{}'");
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
    return state && STEPS.includes(state.step) ? state.nextAt : null;
  }

  // Ask the cell to stop the turn; the run finishes when the cell reports it.
  async cancel() {
    const state = this.state();
    if (!state || !STEPS.includes(state.step)) throw new Error("No cell turn is in progress");
    if (state.step === "poll") {
      await this.#abort(state);
      return this.state();
    }
    this.#update({ step: "done", next_at: null });
    await this.#finish("cancelled", "cancelled_before_prompt");
    return this.state();
  }

  // Run the due step. Called on every alarm.
  async step() {
    const state = this.state();
    if (!state || !STEPS.includes(state.step) || state.nextAt === null || state.nextAt > this.#now()) return;
    if (this.#run.get()?.status !== "running" && state.step !== "poll") {
      this.#update({ step: "done", next_at: null });
      return;
    }
    try {
      switch (state.step) {
        case "provision": await this.#provision(state); break;
        case "install": await this.#install(state); break;
        case "bridge": await this.#bridge(state); break;
        case "session": await this.#session(state); break;
        case "prompt": await this.#prompt(state); break;
        case "poll": await this.#poll(state); break;
      }
    } catch (error) {
      await this.#failStep(state, error);
    }
  }

  async #provision(state) {
    const cell = await this.#connect(undefined, JSON.parse(state.createJson));
    this.#advance("install", { cell_id: cell.id });
    this.#log("BackgroundTaskUpdate", { task_id: "cell", label: `cell ${cell.id} created`, state: "done" });
  }

  async #install(state) {
    const cell = await this.#cell(state);
    const version = state.packageSpec.slice("autopilot-ai@".length);
    let installed;
    try {
      installed = JSON.parse(await cell.readFile(`${CELL_RUNTIME_DIR}/package.json`)).version;
    } catch {
      // Not installed yet.
    }
    if (installed !== version) {
      const result = await cell.exec(`mkdir -p /opt/autopilot && npm install --prefix /opt/autopilot --no-audit --no-fund ${state.packageSpec}`);
      if (result.exitCode !== 0) throw new Error(`npm install failed: ${tail(result.stderr || result.stdout)}`);
    }
    this.#advance("bridge");
    this.#log("BackgroundTaskUpdate", { task_id: "runtime", label: `${state.packageSpec} installed`, state: "done" });
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
    this.#advance("session");
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
    this.#advance("prompt");
  }

  // The bridge remembers turn ids, so resending the prompt after a crash is safe.
  async #prompt(state) {
    const cell = await this.#cell(state);
    const run = this.#run.get();
    await this.#control(cell, "POST", "/rpc", { id: state.turnId, type: "prompt", message: run.task });
    this.#advance("poll", {}, POLL_MS);
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
        const finished = await this.#apply(entry.event, state);
        this.#update({ cursor });
        if (finished) return;
      }
      this.#update({ cursor });
      if (!page.hasMore) break;
    }
    if (seen > 0) {
      this.#update({ quiet_polls: 0, attempts: 0, next_at: this.#now() + POLL_MS });
      return;
    }
    const quiet = state.quietPolls + 1;
    if (quiet >= QUIET_POLLS_BEFORE_STATUS) {
      const status = await this.#control(cell, "GET", "/status").catch(() => null);
      if (status && !status.activeRunId) {
        this.#update({ step: "done", next_at: null });
        this.#log("RuntimeError", { message: "The cell has no active turn and stopped producing events." });
        await this.#finish("failed", "cell_turn_lost");
        return;
      }
      this.#update({ quiet_polls: 0, attempts: 0, next_at: this.#now() + POLL_MS });
      return;
    }
    this.#update({ quiet_polls: quiet, attempts: 0, next_at: this.#now() + POLL_MS });
  }

  // Returns true once the turn has ended.
  async #apply(event, state) {
    // Keep the log in order: text buffered before a tool call or usage update goes first.
    if (event?.type !== "message.delta" && event?.type !== "message.reasoning" && event?.type !== "message.end") this.#flushText();
    switch (event?.type) {
      case "message.start":
        if (event.role === "assistant") {
          this.#log("AssistantStreamStarted", { stream_id: event.messageId });
          this.#update({ open_streams_json: JSON.stringify([...this.#openStreams(), event.messageId]) });
        }
        return false;
      case "message.delta":
        if (typeof event.text === "string") this.#bufferText("AssistantTokenDelta", event.messageId, event.text);
        return false;
      case "message.reasoning":
        if (typeof event.text === "string") this.#bufferText("AssistantReasoningDelta", event.messageId, event.text);
        return false;
      case "message.end": {
        // Only assistant streams were started; user messages end without a stream.
        this.#flushText(event.messageId);
        const open = this.#openStreams();
        if (!open.includes(event.messageId)) return false;
        this.#log("AssistantMessageCompleted", { stream_id: event.messageId });
        this.#update({ open_streams_json: JSON.stringify(open.filter((id) => id !== event.messageId)) });
        return false;
      }
      case "tool.start":
        this.#log("ToolExecutionStarted", { tool_id: event.toolCallId, tool: event.toolName, command: summarize(event.args) });
        if (this.#run.get()?.status === "running") {
          try {
            await this.#run.recordToolIntent(event.toolCallId, event.toolName, event.args);
          } catch (error) {
            if (error?.reason !== "max_tool_iterations_exceeded") throw error;
            await this.#abort(state);
          }
        }
        return false;
      case "tool.result": {
        const output = typeof event.result === "string" ? event.result : "";
        this.#log("ToolExecutionFinished", { tool_id: event.toolCallId, exit_code: event.isError ? 1 : 0, output: bounded(output, MAX_TOOL_OUTPUT_CHARS) });
        if (this.#run.get()?.status === "running") {
          await this.#run.recordToolResult(event.toolCallId, event.toolName, { ok: !event.isError, content: output });
        }
        return false;
      }
      case "usage": {
        if (this.#run.get()?.status !== "running") return false;
        const cost = finiteOrUndefined(event.cost);
        const { run, budgetExceededReason } = await this.#run.recordUsage({
          promptTokens: wholeTokens(event.inputTokens),
          completionTokens: wholeTokens(event.outputTokens),
          ...(cost === undefined ? {} : { costUsd: cost }),
        });
        this.#log("StatusUpdate", { segments: { tokens: String(run.totalPromptTokens + run.totalCompletionTokens), cost: `$${run.totalCostUsd.toFixed(4)}` } });
        if (budgetExceededReason) await this.#abort(state);
        return false;
      }
      case "tasks.update": {
        const todos = Array.isArray(event.tasks)
          ? event.tasks.filter((task) => typeof task?.title === "string").map((task, index) => ({
            id: String(task.id ?? index),
            title: task.title,
            status: task.status === "completed" ? "completed" : task.status === "in_progress" ? "in_progress" : "pending",
          }))
          : [];
        this.#log("TodoListUpdate", { todos });
        return false;
      }
      case "warning":
        if (typeof event.message === "string") this.#log("ShowToast", { text: bounded(event.message, 500), kind: "warning" });
        return false;
      case "session.end": {
        this.#flushText();
        this.#update({ step: "done", next_at: null });
        if (event.reason === "error") this.#log("RuntimeError", { message: bounded(String(event.error ?? "error"), 500) });
        const status = event.reason === "complete" ? "completed" : event.reason === "aborted" ? "cancelled" : "failed";
        const reason = event.reason === "error" ? bounded(String(event.error ?? "error"), 500) : `cell_session_${event.reason}`;
        await this.#finish(status, reason);
        return true;
      }
      default:
        return false;
    }
  }

  // A budget that paused the run for input stays paused; otherwise the run ends.
  async #finish(status, reason) {
    const run = this.#run.get();
    if (run?.status !== "running") return;
    if (status === "completed") this.#run.recordCheckpoint();
    await this.#run.transition(status, reason);
  }

  async #abort(state) {
    if (state.abortSent) return;
    const cell = await this.#cell(state);
    await this.#control(cell, "POST", "/rpc", { id: this.#randomId(), type: "abort" }).catch(() => null);
    this.#update({ abort_sent: 1 });
  }

  async #failStep(state, error) {
    const message = String(error?.message ?? error).slice(0, 1000);
    const attempts = state.attempts + 1;
    if (attempts >= (state.step === "poll" ? MAX_POLL_ATTEMPTS : MAX_STEP_ATTEMPTS)) {
      this.#update({ step: "done", next_at: null, attempts, last_error: message });
      this.#log("RuntimeError", { message: `cell ${state.step} failed: ${bounded(message, 400)}` });
      await this.#finish("failed", `cell_${state.step}_failed`);
      return;
    }
    const delay = Math.min(MAX_RETRY_MS, 1_000 * 2 ** (attempts - 1));
    this.#update({ attempts, last_error: message, next_at: this.#now() + delay });
  }

  #advance(step, fields = {}, delay = 0) {
    this.#update({ ...fields, step, attempts: 0, last_error: null, next_at: this.#now() + delay });
  }

  #update(fields) {
    const entries = Object.entries(fields);
    if (entries.length === 0) return;
    this.#db.exec(`UPDATE cell_executor SET ${entries.map(([key]) => `${key} = ?`).join(", ")}`, ...entries.map(([, value]) => value));
  }

  // Streamed text is logged a line at a time (a PEM block at once) so that a
  // secret split across deltas is still whole when it is redacted.
  #bufferText(eventType, streamId, text) {
    const pending = this.#pendingText();
    const key = `${eventType}:${streamId}`;
    const buffered = (pending[key] ?? "") + text;
    let cut = buffered.lastIndexOf("\n") + 1;
    const begin = buffered.lastIndexOf("-----BEGIN");
    if (begin !== -1) {
      const end = /-----END [A-Z ]*-----/.exec(buffered.slice(begin));
      if (!end) cut = Math.min(cut, begin);
      else if (cut > begin && cut < begin + end.index + end[0].length) cut = begin + end.index + end[0].length;
    }
    if (cut > 0) this.#log(eventType, { stream_id: streamId, token: buffered.slice(0, cut) });
    pending[key] = buffered.slice(Math.max(cut, 0));
    if (!pending[key]) delete pending[key];
    this.#update({ pending_text_json: JSON.stringify(pending) });
  }

  #flushText(streamId) {
    const pending = this.#pendingText();
    for (const [key, text] of Object.entries(pending)) {
      const [eventType, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
      if (streamId !== undefined && id !== streamId) continue;
      if (text) this.#log(eventType, { stream_id: id, token: text });
      delete pending[key];
    }
    this.#update({ pending_text_json: JSON.stringify(pending) });
  }

  #pendingText() {
    return JSON.parse(this.#db.exec("SELECT pending_text_json FROM cell_executor LIMIT 1")[0]?.pending_text_json ?? "{}");
  }

  #openStreams() {
    return JSON.parse(this.#db.exec("SELECT open_streams_json FROM cell_executor LIMIT 1")[0]?.open_streams_json ?? "[]");
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
    lastError: row.last_error,
  };
}

function summarize(args) {
  if (typeof args === "string") return bounded(args, MAX_TOOL_INPUT_CHARS);
  if (args && typeof args === "object") {
    for (const key of ["command", "path", "file_path", "pattern", "url", "query"]) {
      if (typeof args[key] === "string") return bounded(args[key], MAX_TOOL_INPUT_CHARS);
    }
  }
  try {
    return bounded(JSON.stringify(args) ?? "", MAX_TOOL_INPUT_CHARS);
  } catch {
    return "";
  }
}

function bounded(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function tail(text = "") {
  return bounded(String(text).trim().split("\n").slice(-5).join("\n"), 800);
}

function wholeTokens(value) {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function finiteOrUndefined(value) {
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}
