import assert from "node:assert/strict";
import { test } from "node:test";
import { CellExecutor, DEFAULT_PACKAGE } from "../autopilot/cell-executor.js";
import { RunHost } from "../autopilot/run-host.js";
import { RUN, clock, memoryDb, uuids } from "./autopilot-helpers.js";

// autopilot-ai 3.0.2's bridge (src/sdk/aster-cell.ts): UUID request ids, a
// 250-event page, prompt de-duplication by turn id, and a session.end journaled
// when the prompt's RPC reply arrives (a successful turn emits none itself).
const MAX_EVENTS = 250;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_COMMANDS = new Set(["new_session", "prompt", "abort", "get_state", "resolve_permission", "set_model", "set_mode"]);

// The bridge registers the server's catalog entry for the model, and ignores
// anything that isn't one for that model.
function acceptModelInfo(value, model) {
  if (!value || typeof value !== "object") return undefined;
  const window = value.contextWindow;
  if (value.id !== model || !Number.isInteger(window) || window < 1_000 || window > 100_000_000) return undefined;
  if (!value.pricing || typeof value.pricing !== "object" || !value.supports || typeof value.supports !== "object") return undefined;
  return value;
}

// A cell running the Autopilot bridge: control requests arrive as a JSON file
// plus an exec of the control runner, as in autopilot's aster-cell.ts.
function fakeCell() {
  const cell = {
    id: "cell-1",
    files: new Map(),
    processes: [],
    installs: 0,
    bridge: { sessionId: null, model: null, modelInfo: undefined, initialized: false, activeRunId: null, seen: new Set(), events: [], cursor: 0 },
    prompts: [],
    aborts: 0,
    failNext: 0,
    async mkdir() {},
    async writeFile(path, content) { this.files.set(path, content); },
    async readFile(path) {
      if (!this.files.has(path)) throw new Error("hotcell -> 404: missing");
      return this.files.get(path);
    },
    async listProcesses() { return this.processes; },
    installExit: "0",
    async startProcess(command) {
      if (command.includes("npm install")) {
        // The install runs in the background; it has finished by the next check.
        this.installs += 1;
        if (this.installExit === "0") this.files.set("/opt/autopilot/node_modules/autopilot-ai/package.json", JSON.stringify({ version: DEFAULT_PACKAGE.slice("autopilot-ai@".length) }));
        this.files.set("/workspace/.aster/install.log", "npm ERR! network");
        this.files.set("/workspace/.aster/install.exit", `${this.installExit}\n`);
        return;
      }
      this.processes.push({ procId: "p1", command, status: "running" });
    },
    async exec(command) {
      if (command.startsWith("rm -f ")) {
        this.files.delete(command.slice("rm -f ".length));
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      const requestId = command.trim().split(" ").pop();
      const request = JSON.parse(this.files.get(`/workspace/.aster/control/${requestId}.json`));
      if (this.failNext > 0) {
        this.failNext -= 1;
        return { exitCode: 1, stdout: "", stderr: "Error: cell_control_failed" };
      }
      try {
        return { exitCode: 0, stdout: `${JSON.stringify(this.handle(request))}\n`, stderr: "" };
      } catch (error) {
        // The control runner exits non-zero and prints the bridge's error.
        return { exitCode: 1, stdout: "", stderr: `Error: ${error.message}` };
      }
    },
    handle({ method, path, body }) {
      const bridge = this.bridge;
      if (!this.processes.length) throw new Error("bridge is not running");
      if (path === "/health") return { ok: true, initialized: bridge.initialized, sessionId: bridge.sessionId };
      if (path === "/status") return { initialized: bridge.initialized, sessionId: bridge.sessionId, activeRunId: bridge.activeRunId, cursor: bridge.cursor };
      if (path.startsWith("/events?after=")) {
        const after = Number(path.slice("/events?after=".length));
        if (!Number.isSafeInteger(after) || after < 0) throw new Error("invalid_cursor");
        const events = bridge.events.filter((event) => event.cursor > after).slice(0, MAX_EVENTS);
        return { events, cursor: bridge.cursor, hasMore: events.length === MAX_EVENTS };
      }
      if (method === "POST" && path === "/rpc") {
        if (!UUID_RE.test(body.id) || !ALLOWED_COMMANDS.has(body.type)) throw new Error("unsupported_command");
        if (body.type === "new_session") {
          if (!UUID_RE.test(body.sessionId)) throw new Error("invalid_session_id");
          if (bridge.initialized && bridge.sessionId !== body.sessionId) throw new Error("session_already_initialized");
          if (!bridge.initialized) {
            bridge.sessionId = body.sessionId;
            bridge.model = body.config?.model;
            bridge.modelInfo = acceptModelInfo(body.modelInfo, bridge.model);
            bridge.initialized = true;
          }
          return { type: "ok" };
        }
        if (body.type === "prompt") {
          if (bridge.seen.has(body.id)) return { accepted: true, runId: body.id, replay: true };
          if (bridge.activeRunId) throw new Error("session_busy");
          if (!bridge.initialized || typeof body.message !== "string" || !body.message.trim()) throw new Error("session_not_ready");
          bridge.seen.add(body.id);
          bridge.activeRunId = body.id;
          this.prompts.push(body);
          return { accepted: true, runId: body.id };
        }
        if (body.type === "abort") {
          this.aborts += 1;
          return { type: "ok" };
        }
      }
      throw new Error(`unexpected control request ${method} ${path}`);
    },
    emit(event, runId = this.bridge.activeRunId) {
      this.bridge.cursor += 1;
      this.bridge.events.push({ cursor: this.bridge.cursor, runId, event });
      if (event.type === "session.end") this.bridge.activeRunId = null;
    },
    // The prompt's RPC reply: the bridge journals the turn's terminal event.
    reply(runId = this.bridge.activeRunId, { type = "ok", error } = {}) {
      if (runId !== this.bridge.activeRunId) return;
      this.emit(type === "error"
        ? { type: "session.end", reason: "error", error: error ?? "prompt_failed" }
        : { type: "session.end", reason: "complete" }, runId);
    },
    // A bridge restart: the interrupted turn is journaled as an error.
    restart() {
      const interrupted = this.bridge.activeRunId;
      this.bridge.activeRunId = null;
      this.bridge.initialized = false;
      if (interrupted) this.emit({ type: "session.end", reason: "error", error: "cell_runtime_restarted" }, interrupted);
    },
  };
  return cell;
}

async function setup({ run = {} } = {}) {
  const time = clock();
  const db = memoryDb();
  const randomId = uuids();
  const cell = fakeCell();
  const created = [];
  const host = new RunHost({ db, now: time.now, randomId, setAlarm: () => {}, onWake: async () => {}, checkJob: async () => "completed", report: async () => {}, onEvent: () => {} });
  const executor = new CellExecutor({
    db,
    run: host,
    now: time.now,
    randomId,
    connect: async (cellId, options) => {
      if (!cellId) created.push(options);
      return cell;
    },
  });
  await host.create({ ...RUN, ...run });
  return { time, db, randomId, host, executor, cell, created };
}

// One alarm at the executor's next due time.
async function tick(state) {
  const { nextAt } = state.executor.state();
  if (nextAt !== null && nextAt > state.time.now()) state.time.set(nextAt);
  await state.executor.step();
}

// Run alarms until the executor reaches `step`, advancing the clock as it asks.
async function drive(state, until, max = 50) {
  for (let index = 0; index < max; index += 1) {
    const current = state.executor.state();
    if (until(current)) return current;
    if (current.nextAt !== null && current.nextAt > state.time.now()) state.time.set(current.nextAt);
    await state.executor.step();
  }
  throw new Error(`did not converge: ${JSON.stringify(state.executor.state())}`);
}

test("provisions, installs, starts the bridge, opens a session, and prompts once", async () => {
  const state = await setup();
  await state.executor.start({ model: "moonshotai/kimi-k2.6" });
  assert.equal(state.host.get().status, "running");
  const polling = await drive(state, (current) => current.step === "poll");
  assert.equal(polling.cellId, "cell-1");
  assert.deepEqual(state.created, [{
    image: "ghcr.io/sinameraji/hotcell-base:latest",
    egress: { spendCapUsd: 1, ttlMs: 3_600_000 },
    labels: { "serverless-objects.run": "run-1" },
  }]);
  assert.equal(state.cell.installs, 1);
  assert.match(state.cell.processes[0].command, /startAsterCellBridge/);
  assert.equal(state.cell.bridge.sessionId, polling.sessionId);
  assert.deepEqual(state.cell.prompts.map((prompt) => [prompt.id, prompt.message]), [[polling.turnId, "Fix the flaky test"]]);
  await assert.rejects(state.executor.start(), /already been started/);
});

test("maps the cell's events onto the run and its Camouflage log, then completes", async () => {
  const state = await setup();
  await state.executor.start();
  await drive(state, (current) => current.step === "poll");
  const { cell } = state;
  cell.emit({ type: "message.start", messageId: "u1", role: "user" });
  cell.emit({ type: "message.end", messageId: "u1" });
  cell.emit({ type: "message.start", messageId: "m1", role: "assistant" });
  cell.emit({ type: "message.delta", messageId: "m1", text: "Running the tests." });
  cell.emit({ type: "tool.start", toolCallId: "t1", toolName: "bash", args: { command: "npm test" } });
  cell.emit({ type: "tool.result", toolCallId: "t1", toolName: "bash", result: "1 passing", isError: false });
  cell.emit({ type: "usage", inputTokens: 1200, outputTokens: 80.6, cost: 0.002 });
  cell.emit({ type: "tasks.update", tasks: [{ id: "a", title: "Fix it", status: "in_progress" }] });
  cell.emit({ type: "message.end", messageId: "m1" });
  cell.emit({ type: "session.end", reason: "complete" });
  const done = await drive(state, (current) => current.step === "done");
  assert.equal(done.cursor, 10);

  const run = state.host.get();
  assert.equal(run.status, "completed");
  assert.equal(run.totalPromptTokens, 1200);
  assert.equal(run.totalCompletionTokens, 80);
  assert.deepEqual(state.host.listEvents().map((event) => event.type), ["state", "state", "tool_intent", "tool_result", "usage", "checkpoint", "state"]);

  const session = state.host.listSessionEvents().map((event) => event.event_type);
  assert.deepEqual(session, [
    "SessionStarted", "UserMessageCreated", "BackgroundTaskUpdate", "BackgroundTaskUpdate",
    "AssistantStreamStarted", "AssistantTokenDelta", "ToolExecutionStarted", "ToolExecutionFinished",
    "StatusUpdate", "TodoListUpdate", "AssistantMessageCompleted",
  ]);
  const started = state.host.listSessionEvents().find((event) => event.event_type === "ToolExecutionStarted");
  assert.deepEqual(started.payload, { tool_id: "t1", tool: "bash", command: "npm test" });
});

test("records the 3.x session event set and ignores the events it does not map", async () => {
  const state = await setup();
  await state.executor.start();
  const polling = await drive(state, (current) => current.step === "poll");
  const { cell } = state;
  cell.emit({ type: "session.start", sessionId: polling.sessionId, cwd: "/workspace" });
  cell.emit({ type: "message.start", messageId: "u1", role: "user" });
  cell.emit({ type: "message.end", messageId: "u1" });
  cell.emit({ type: "status", status: "streaming" });
  cell.emit({ type: "message.start", messageId: "m1", role: "assistant" });
  cell.emit({ type: "message.delta", messageId: "m1", text: "Checking.\n" });
  cell.emit({ type: "message.reasoning", messageId: "m1", text: "Think.\n" });
  cell.emit({ type: "permission.request", requestId: "p1", toolName: "bash", args: { command: "ls" } });
  cell.emit({ type: "permission.resolved", requestId: "p1", decision: "allow" });
  cell.emit({ type: "tool.start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
  cell.emit({ type: "tool.result", toolCallId: "t1", toolName: "bash", result: "a.txt", isError: false });
  cell.emit({ type: "usage", inputTokens: 900, outputTokens: 40, reasoningTokens: 12, cost: 0.001 });
  cell.emit({ type: "tasks.update", tasks: [{ id: "a", title: "Check", status: "completed" }] });
  cell.emit({ type: "hook.failed", hookId: "h1", event: "tool.before", failure: "timeout", reason: "slow", allowed: true, failClosed: false, count: 1, message: "hook timed out" });
  cell.emit({ type: "context.compacted", tokensBefore: 90_000, tokensAfter: 40_000, turnsRemoved: 3, artifactsArchived: 1 });
  cell.emit({ type: "worker.finished", workerId: "w1", index: 0, task: "scan", status: "completed", costUsd: 0.0002 });
  cell.emit({ type: "warning", message: "model is slow" });
  cell.emit({ type: "message.end", messageId: "m1" });
  cell.reply(polling.turnId);
  const done = await drive(state, (current) => current.step === "done");
  assert.equal(done.cursor, 19);

  const run = state.host.get();
  assert.equal(run.status, "completed");
  assert.equal(run.totalPromptTokens, 900);
  assert.equal(run.totalCompletionTokens, 40);
  assert.deepEqual(state.host.listEvents().map((event) => event.type), ["state", "state", "tool_intent", "tool_result", "usage", "checkpoint", "state"]);
  assert.deepEqual(state.host.listSessionEvents().map((event) => event.event_type), [
    "SessionStarted", "UserMessageCreated", "BackgroundTaskUpdate", "BackgroundTaskUpdate",
    "AssistantStreamStarted", "AssistantTokenDelta", "AssistantReasoningDelta",
    "ToolExecutionStarted", "ToolExecutionFinished", "StatusUpdate", "TodoListUpdate", "ShowToast",
    "AssistantMessageCompleted",
  ]);
});

test("a successful turn ends when the bridge journals the prompt reply", async () => {
  const state = await setup();
  await state.executor.start();
  const polling = await drive(state, (current) => current.step === "poll");
  state.cell.emit({ type: "message.start", messageId: "m1", role: "assistant" });
  state.cell.emit({ type: "message.delta", messageId: "m1", text: "Done.\n" });
  state.cell.emit({ type: "message.end", messageId: "m1" });
  await tick(state);
  assert.equal(state.host.get().status, "running");

  state.cell.reply(polling.turnId);
  await drive(state, (current) => current.step === "done");
  assert.equal(state.host.get().status, "completed");
  assert.equal(state.host.get().stopReason, "cell_session_complete");
});

test("pages through more than one page of events", async () => {
  const state = await setup();
  await state.executor.start();
  const polling = await drive(state, (current) => current.step === "poll");
  for (let index = 0; index < 260; index += 1) state.cell.emit({ type: "status", status: "streaming" });
  state.cell.reply(polling.turnId);
  const done = await drive(state, (current) => current.step === "done");
  assert.equal(done.cursor, 261);
  assert.equal(state.host.get().status, "completed");
});

test("a bridge restart ends the interrupted turn with its reason", async () => {
  const state = await setup();
  await state.executor.start();
  await drive(state, (current) => current.step === "poll");
  state.cell.emit({ type: "tool.start", toolCallId: "t1", toolName: "bash", args: "ls" });
  await tick(state);
  state.cell.restart();
  await drive(state, (current) => current.step === "done");
  assert.equal(state.host.get().status, "failed");
  assert.equal(state.host.get().stopReason, "cell_runtime_restarted");
});

test("a restart resumes polling from the saved cursor without re-prompting", async () => {
  const state = await setup();
  await state.executor.start();
  await drive(state, (current) => current.step === "poll");
  state.cell.emit({ type: "tool.start", toolCallId: "t1", toolName: "bash", args: "ls" });
  await tick(state);
  assert.equal(state.executor.state().cursor, 1);

  // The object was evicted or the node restarted: new instances over the same storage.
  const host = new RunHost({ db: state.db, now: state.time.now, setAlarm: () => {}, onWake: async () => {}, checkJob: async () => "completed", report: async () => {}, onEvent: () => {} });
  const executor = new CellExecutor({ db: state.db, run: host, now: state.time.now, randomId: state.randomId, connect: async () => state.cell });
  state.cell.emit({ type: "tool.result", toolCallId: "t1", toolName: "bash", result: "ok", isError: false });
  state.cell.emit({ type: "session.end", reason: "complete" });
  await drive({ ...state, host, executor }, (current) => current.step === "done");
  assert.equal(state.cell.prompts.length, 1);
  assert.equal(host.get().status, "completed");
  assert.deepEqual(host.listEvents().filter((event) => event.toolCallId === "t1").map((event) => event.type), ["tool_intent", "tool_result"]);
});

test("a budget aborts the cell turn and leaves the run waiting for input", async () => {
  const state = await setup({ run: { maxToolIterations: 1 } });
  await state.executor.start();
  await drive(state, (current) => current.step === "poll");
  state.cell.emit({ type: "tool.start", toolCallId: "t1", toolName: "bash", args: "a" });
  state.cell.emit({ type: "tool.result", toolCallId: "t1", toolName: "bash", result: "", isError: false });
  state.cell.emit({ type: "tool.start", toolCallId: "t2", toolName: "bash", args: "b" });
  await tick(state);
  await tick(state);
  assert.equal(state.cell.aborts, 1);
  assert.equal(state.host.get().status, "needs_input");
  state.cell.emit({ type: "session.end", reason: "aborted" });
  await drive(state, (current) => current.step === "done");
  assert.equal(state.host.get().status, "needs_input");
  assert.equal(state.host.get().stopReason, "max_tool_iterations_exceeded");
});

test("errors end the run as failed and retries back off before giving up", async () => {
  const state = await setup();
  await state.executor.start();
  await drive(state, (current) => current.step === "poll");
  state.cell.failNext = 2;
  await tick(state);
  assert.equal(state.executor.state().attempts, 1);
  assert.equal(state.executor.state().nextAt, state.time.now() + 1000);
  await tick(state);
  assert.equal(state.executor.state().attempts, 2);
  assert.equal(state.executor.state().nextAt, state.time.now() + 2000);
  state.cell.emit({ type: "session.end", reason: "error", error: "model unavailable" });
  await drive(state, (current) => current.step === "done");
  assert.equal(state.host.get().status, "failed");
  assert.equal(state.host.get().stopReason, "model unavailable");
  assert.equal(state.host.listSessionEvents().at(-1).event_type, "RuntimeError");
});

test("a setup step that keeps failing fails the run", async () => {
  const state = await setup();
  await state.executor.start();
  await drive(state, (current) => current.step === "bridge");
  state.cell.processes = [];
  state.cell.startProcess = async () => {};
  await drive(state, (current) => current.step === "done");
  assert.equal(state.host.get().status, "failed");
  assert.equal(state.host.get().stopReason, "cell_bridge_failed");
});

test("a turn the cell lost is detected by its liveness check", async () => {
  const state = await setup();
  await state.executor.start();
  await drive(state, (current) => current.step === "poll");
  state.cell.bridge.activeRunId = null;
  await drive(state, (current) => current.step === "done", 40);
  assert.equal(state.host.get().stopReason, "cell_turn_lost");
});

test("start validates its options and the run", async () => {
  const state = await setup();
  await assert.rejects(state.executor.start({ packageSpec: "evil; rm -rf /" }), /packageSpec/);
  await assert.rejects(state.executor.start({ model: "bad model" }), /model/);
  await state.host.transition("cancelled");
  await assert.rejects(state.executor.start(), /not queued/);
});

test("adds columns to a table created by an older version", () => {
  const db = memoryDb();
  db.exec("CREATE TABLE cell_executor (run_id TEXT PRIMARY KEY, step TEXT NOT NULL, cell_id TEXT, session_id TEXT NOT NULL, turn_id TEXT NOT NULL, model TEXT NOT NULL, package_spec TEXT NOT NULL, create_json TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0, next_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0, quiet_polls INTEGER NOT NULL DEFAULT 0, abort_sent INTEGER NOT NULL DEFAULT 0, last_error TEXT)");
  new CellExecutor({ db, run: {}, connect: async () => ({}) });
  new CellExecutor({ db, run: {}, connect: async () => ({}) });
  assert.ok(db.exec("SELECT name FROM pragma_table_info('cell_executor')").some((row) => row.name === "open_streams_json"));
});

test("the session log is redacted, and streamed text is redacted whole", async () => {
  const state = await setup();
  await state.executor.start();
  await drive(state, (current) => current.step === "poll");
  const secret = "ghp_0123456789abcdefABCDEF0123456789";
  state.cell.emit({ type: "message.start", messageId: "m1", role: "assistant" });
  state.cell.emit({ type: "message.delta", messageId: "m1", text: "Your token is ghp_0123456789" });
  state.cell.emit({ type: "message.delta", messageId: "m1", text: "abcdefABCDEF0123456789\nand a key:\n-----BEGIN RSA PRIVATE KEY-----\n" });
  state.cell.emit({ type: "message.delta", messageId: "m1", text: "MIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----" });
  state.cell.emit({ type: "message.end", messageId: "m1" });
  state.cell.emit({ type: "tool.start", toolCallId: "t1", toolName: "bash", args: { command: `echo ${secret}` } });
  state.cell.emit({ type: "tool.result", toolCallId: "t1", toolName: "bash", result: `GITHUB_TOKEN=${secret}`, isError: false });
  state.cell.emit({ type: "session.end", reason: "complete" });
  await drive(state, (current) => current.step === "done");

  const log = JSON.stringify(state.host.listSessionEvents());
  assert.equal(log.includes("0123456789abcdefABCDEF"), false);
  assert.equal(log.includes("MIIEpAIBAAKCAQEA"), false);
  const text = state.host.listSessionEvents().filter((event) => event.event_type === "AssistantTokenDelta").map((event) => event.payload.token).join("");
  assert.equal(text, "Your token is [REDACTED_SECRET]\nand a key:\n[REDACTED_SECRET]");
  // The run log hashes the original output.
  const result = state.host.listEvents().find((event) => event.type === "tool_result");
  assert.equal(result.metadata.outputBytes, `GITHUB_TOKEN=${secret}`.length);
});

test("a failed background install is retried, then fails the run", async () => {
  const state = await setup();
  state.cell.installExit = "1";
  await state.executor.start();
  await drive(state, (current) => current.step === "done", 80);
  assert.equal(state.host.get().status, "failed");
  assert.equal(state.host.get().stopReason, "cell_install_failed");
  assert.match(state.executor.state().lastError, /npm install exited 1: npm ERR! network/);
  assert.equal(state.cell.installs, 6);
});

test("only one step runs at a time, and a step overtaken by cancel stops", async () => {
  const state = await setup();
  await state.executor.start();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slowConnect = new CellExecutor({
    db: state.db,
    run: state.host,
    now: state.time.now,
    randomId: state.randomId,
    connect: async () => { await gate; return state.cell; },
  });
  const first = slowConnect.step();
  await slowConnect.step();
  assert.equal(state.executor.state().step, "provision");
  assert.ok(state.executor.state().leaseUntil > state.time.now());
  assert.equal(slowConnect.nextAt(), state.executor.state().leaseUntil);

  await state.executor.cancel();
  release();
  await first;
  assert.equal(state.executor.state().step, "done");
  assert.equal(state.executor.state().cellId, null);
  assert.equal(state.host.get().status, "cancelled");
  assert.equal(state.host.listSessionEvents().some((event) => event.payload?.label?.includes("created")), false);
});

test("a budget-paused cell run resumes in the same session with a follow-up prompt", async () => {
  const state = await setup({ run: { maxToolIterations: 1 } });
  await state.executor.start();
  const first = await drive(state, (current) => current.step === "poll");
  state.cell.emit({ type: "tool.start", toolCallId: "t1", toolName: "bash", args: "a" });
  state.cell.emit({ type: "tool.result", toolCallId: "t1", toolName: "bash", result: "", isError: false });
  state.cell.emit({ type: "tool.start", toolCallId: "t2", toolName: "bash", args: "b" });
  await tick(state);
  assert.equal(state.host.get().status, "needs_input");
  assert.deepEqual(state.executor.resumable(), { ok: false, reason: "the cell is still stopping the previous turn; retry shortly" });

  state.cell.emit({ type: "session.end", reason: "aborted" });
  state.cell.bridge.activeRunId = null;
  await drive(state, (current) => current.step === "done");
  assert.deepEqual(state.executor.resumable(), { ok: true });
  assert.throws(() => state.executor.continueTurn(), /resume the run before/);

  await state.host.resume({ maxToolIterations: 5 });
  state.executor.continueTurn({ message: "Budget raised; carry on." });
  const second = await drive(state, (current) => current.step === "poll");
  assert.notEqual(second.turnId, first.turnId);
  assert.equal(second.sessionId, first.sessionId);
  assert.deepEqual(state.cell.prompts.map((prompt) => prompt.message), ["Fix the flaky test", "Budget raised; carry on."]);

  // A late event from the aborted turn is ignored; the new turn completes the run.
  state.cell.emit({ type: "tool.start", toolCallId: "late", toolName: "bash", args: "x" }, first.turnId);
  state.cell.emit({ type: "tool.start", toolCallId: "t3", toolName: "bash", args: "c" });
  state.cell.emit({ type: "tool.result", toolCallId: "t3", toolName: "bash", result: "ok", isError: false });
  state.cell.emit({ type: "session.end", reason: "complete" });
  await drive(state, (current) => current.step === "done");
  assert.equal(state.host.get().status, "completed");
  assert.deepEqual(state.host.listEvents().filter((event) => event.type === "tool_intent").map((event) => event.toolCallId), ["t1", "t3"]);
  assert.equal(state.host.listSessionEvents().filter((event) => event.event_type === "UserMessageCreated").at(-1).payload.text, "Budget raised; carry on.");
});

test("resume refuses runs that are not paused", async () => {
  const state = await setup();
  assert.equal(state.executor.resumable().ok, false);
  await state.executor.start();
  await drive(state, (current) => current.step === "poll");
  state.cell.emit({ type: "session.end", reason: "complete" });
  await drive(state, (current) => current.step === "done");
  assert.match(state.executor.resumable().reason, /not waiting for input \(status: completed\)/);
});
