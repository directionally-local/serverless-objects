// A RunObject that runs its task with Autopilot's SDK inside the object, for
// the native engine (sobjects dev --engine native). Tools run on the host, so
// this is for trusted workspaces; use AutopilotCellRun for a Hotcell cell.
//
//   import { AutopilotNativeRun } from "serverless-objects/autopilot/native";
//   export class Run extends AutopilotNativeRun {}
//
// Needs the autopilot-ai package in the app (npm install autopilot-ai). The
// session reads the user's Autopilot config; an OPENROUTER_API_KEY binding,
// when set, overrides its key.
//
// The session runs in this process. If the process stops mid-turn, the next
// load reconciles the run (requeued from its last checkpoint, or
// interrupted_unknown if a tool may have been cut off) and start() continues
// the same Autopilot session.
import { DEFAULT_MODEL } from "./cell-executor.js";
import { RunObject } from "./index.js";
import { TurnRecorder } from "./turn-recorder.js";

const MODEL_RE = /^[A-Za-z0-9._:/-]{1,200}$/;
const MAX_MESSAGE_BYTES = 24 * 1024;
const CONTINUE_MESSAGE = "Continue the task from where you stopped.";
// Runs with a turn in this process; anything else marked active was cut off.
const LIVE = new Set();

export class AutopilotNativeRun extends RunObject {
  // The autopilot-ai SDK, resolved from the app's project (the native engine
  // provides projectImport) so a linked or hoisted serverless-objects still
  // finds the app's copy.
  static loadSdk = () => (globalThis.__sobjectsNative?.projectImport ?? ((specifier) => import(specifier)))("autopilot-ai/sdk");

  #session;
  #turn;
  #events = Promise.resolve();

  constructor(ctx, env) {
    super(ctx, env);
    this.db.exec(`CREATE TABLE IF NOT EXISTS native_turn (
      run_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      model TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      pending_text_json TEXT NOT NULL DEFAULT '{}',
      open_streams_json TEXT NOT NULL DEFAULT '[]'
    )`);
    ctx.blockConcurrencyWhile(async () => {
      const turn = this.#row();
      if (turn?.active && !LIVE.has(turn.run_id)) {
        this.db.exec("UPDATE native_turn SET active = 0");
        await this.runHost.reconcileInterrupted();
      }
    });
  }

  // Start the run's task, or continue the session of a run requeued after a
  // restart. Options: model, message (the prompt; defaults to the task, or a
  // continuation for a requeued run).
  async start({ model, message } = {}) {
    const run = this.get();
    if (!run) throw new Error("This object has no run; call create first");
    if (run.status !== "queued") throw new Error(`Run ${run.id} is not queued (status: ${run.status})`);
    const existing = this.#row();
    const chosenModel = model ?? existing?.model ?? DEFAULT_MODEL;
    if (!MODEL_RE.test(chosenModel)) throw new Error("model must be an OpenRouter model id");
    const prompt = message ?? (existing ? CONTINUE_MESSAGE : run.task);
    checkMessage(prompt);
    if (!existing) {
      this.db.exec("INSERT INTO native_turn (run_id, session_id, model) VALUES (?, ?, ?)", run.id, crypto.randomUUID(), chosenModel);
    } else if (model) {
      this.db.exec("UPDATE native_turn SET model = ?", chosenModel);
    }
    await this.runHost.transition("running", existing ? "native_continue" : "native_starting");
    await this.#begin(prompt, { first: !existing });
    return this.turnState();
  }

  // Resume a run paused for input with a follow-up turn in the same session.
  async resume(budgets, { message = CONTINUE_MESSAGE } = {}) {
    const turn = this.#row();
    if (!turn) return super.resume(budgets);
    if (turn.active) throw new Error("Cannot resume: the previous turn is still stopping; retry shortly");
    checkMessage(message);
    const run = await super.resume(budgets);
    await this.#begin(message, { first: false });
    return run;
  }

  async cancel() {
    if (!this.#session || !this.#row()?.active) throw new Error("No turn is in progress");
    await this.#session.abort();
    return this.turnState();
  }

  turnState() {
    const turn = this.#row();
    return turn ? { sessionId: turn.session_id, model: turn.model, active: turn.active === 1 } : null;
  }

  async #begin(message, { first }) {
    const run = this.get();
    const turn = this.#row();
    let sdk;
    try {
      sdk = await this.constructor.loadSdk();
    } catch (error) {
      await this.runHost.transition("failed", "autopilot_sdk_missing");
      throw new Error(`AutopilotNativeRun needs the autopilot-ai package (npm install autopilot-ai): ${error?.message ?? error}`);
    }
    const recorder = this.#recorder();
    if (first) recorder.log("SessionStarted", { title: `Autopilot run ${run.id}`, detail: [turn.model, "in process"] });
    recorder.log("UserMessageCreated", { text: message });

    if (!this.#session) {
      const { session } = await sdk.createAgentSession({
        cwd: run.cwd,
        sessionId: turn.session_id,
        config: {
          model: turn.model,
          mode: "edit",
          ...(this.env.OPENROUTER_API_KEY ? { openrouterApiKey: this.env.OPENROUTER_API_KEY } : {}),
        },
        memoryEnabled: false,
        lspEnabled: false,
        costAttribution: false,
      });
      this.#session = session;
      // Events are applied one at a time, in order.
      session.subscribe((event) => {
        this.#events = this.#events.then(() => this.#onEvent(event)).catch((error) => console.error(`Autopilot event failed: ${error?.stack ?? error}`));
      });
    }
    this.#session.setMode?.("edit");

    this.db.exec("UPDATE native_turn SET active = 1");
    LIVE.add(run.id);
    const session = this.#session;
    this.#turn = (async () => {
      let ended;
      try {
        await session.prompt(message);
        ended = { type: "session.end", reason: "complete" };
      } catch (error) {
        ended = { type: "session.end", reason: "error", error: String(error?.message ?? error) };
      }
      await this.#events;
      // A turn that ended itself (aborted, failed) already applied its session.end.
      if (this.#row()?.active) await this.#recorder().apply(ended);
      LIVE.delete(run.id);
    })();
    this.ctx.waitUntil(this.#turn);
  }

  async #onEvent(event) {
    if (event?.type === "permission.request") return this.#decide(event);
    if (event?.type === "permission.resolved") return;
    if (!this.#row()?.active) return;
    await this.#recorder().apply(event);
  }

  // Edit mode asks before each mutating tool: enforce allowedTools and the
  // tool budget before the tool runs.
  async #decide(event) {
    const run = this.get();
    let decision = "allow";
    if (run?.status !== "running") decision = "deny";
    else if (run.allowedTools.length > 0 && !run.allowedTools.includes(event.toolName)) decision = "deny";
    else if (run.maxToolIterations !== null && this.runHost.store.countToolIterations() >= run.maxToolIterations) {
      decision = "deny";
      await this.runHost.transition("needs_input", "max_tool_iterations_exceeded");
      this.#session?.abort().catch(() => {});
    }
    this.#session.resolvePermission(event.requestId, decision);
  }

  #recorder() {
    return new TurnRecorder({
      run: this.runHost,
      state: {
        get: () => {
          const turn = this.#row();
          return { pending: JSON.parse(turn.pending_text_json), openStreams: JSON.parse(turn.open_streams_json) };
        },
        set: ({ pending, openStreams }) => {
          if (pending !== undefined) this.db.exec("UPDATE native_turn SET pending_text_json = ?", JSON.stringify(pending));
          if (openStreams !== undefined) this.db.exec("UPDATE native_turn SET open_streams_json = ?", JSON.stringify(openStreams));
        },
      },
      finish: async (status, reason) => {
        const run = this.get();
        if (run?.status !== "running") return;
        if (status === "completed") this.runHost.recordCheckpoint();
        await this.runHost.transition(status, reason);
      },
      abort: () => this.#session?.abort().catch(() => {}),
      onEnd: () => this.db.exec("UPDATE native_turn SET active = 0"),
      reasonPrefix: "native",
    });
  }

  #row() {
    return this.db.exec("SELECT * FROM native_turn LIMIT 1")[0];
  }
}

function checkMessage(message) {
  if (typeof message !== "string" || !message.trim()) throw new Error("message must be a non-empty string");
  if (new TextEncoder().encode(message).byteLength > MAX_MESSAGE_BYTES) throw new Error(`message must be at most ${MAX_MESSAGE_BYTES} bytes`);
}
