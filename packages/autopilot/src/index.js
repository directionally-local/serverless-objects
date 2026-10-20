// Autopilot runs as Durable Objects: one RunObject per run, one RunRegistry
// per workspace.
//
//   import { RunObject, RunRegistry } from "@serverless-objects/autopilot";
//   export { RunObject, RunRegistry };
//
//   const run = env.RUNS.getByName(runId);
//   await run.create({ id: runId, workspace: "acme", cwd: "/workspace", task: "Fix the flaky test" });
//
// Bind the classes as RUNS and RUN_REGISTRY, or subclass and set the static
// binding names. Subclass RunObject and override onWake() to start or resume
// the executor; override checkJob() to support "job" timers.
import { DurableObject } from "cloudflare:workers";
import { RegistryStore } from "./registry-store.js";
import { RunHost, runSummary } from "./run-host.js";
import { durableObjectSql } from "./sql.js";

export { RunStore, RunToolBudgetExceededError, RUN_STATUSES } from "./run-store.js";

const STREAMS = new Set(["run", "session"]);
const PAGE = 500;

export class RunObject extends DurableObject {
  static registryBinding = "RUN_REGISTRY";

  #host;

  constructor(ctx, env) {
    super(ctx, env);
    // Subclasses may keep their own tables here; storage reads are synchronous.
    this.db = durableObjectSql(ctx.storage);
    this.#host = new RunHost({
      db: this.db,
      extraAlarmAt: () => this.alarmAt(),
      setAlarm: (at) => (at === null ? ctx.storage.deleteAlarm() : ctx.storage.setAlarm(at)),
      onWake: (event) => this.onWake(event),
      checkJob: (jobId) => this.checkJob(jobId),
      report: (run) => this.#report(run),
      onEvent: (stream, event) => this.#broadcast(stream, event),
    });
  }

  // Called when a wake timer fires and the run moves to running. Delivery is
  // at least once: make it idempotent by timerId. Throwing retries with backoff.
  async onWake(_event) {}

  // A subclass that needs its own alarm returns its next due time here; onAlarm()
  // runs on every alarm after the timers. Call syncAlarm() after changing it.
  alarmAt() {
    return null;
  }

  async onAlarm() {}

  syncAlarm() {
    return this.#host.syncAlarm();
  }

  // The run host, for subclasses that drive the run themselves.
  get runHost() {
    return this.#host;
  }

  // Returns a job's status ("starting", "running", "cancelling", "completed",
  // "failed", ...) for "job" timers.
  async checkJob(_jobId) {
    throw new Error("job timers need a RunObject subclass that implements checkJob()");
  }

  async create(input) {
    const name = this.ctx.id.name;
    if (name !== undefined && input?.id !== name) throw new Error(`Run id ${input?.id} must equal the object name ${name}`);
    return this.#host.create(input);
  }

  get() { return this.#host.get(); }
  transition(status, reason) { return this.#host.transition(status, reason); }
  resume(budgets) { return this.#host.resume(budgets); }
  recordToolIntent(toolCallId, toolName, args) { return this.#host.recordToolIntent(toolCallId, toolName, args); }
  recordToolResult(toolCallId, toolName, result) { return this.#host.recordToolResult(toolCallId, toolName, result); }
  recordCheckpoint() { return this.#host.recordCheckpoint(); }
  recordUsage(usage) { return this.#host.recordUsage(usage); }
  appendSessionEvents(events) { return this.#host.appendSessionEvents(events); }
  listEvents(options) { return this.#host.listEvents(options); }
  listSessionEvents(options) { return this.#host.listSessionEvents(options); }
  scheduleTimer(input) { return this.#host.scheduleTimer(input); }
  cancelTimer(id) { return this.#host.cancelTimer(id); }
  listTimers() { return this.#host.listTimers(); }
  approve(timerId, decision) { return this.#host.approve(timerId, decision); }
  reconcileInterrupted() { return this.#host.reconcileInterrupted(); }

  async alarm() {
    await this.#host.processDueTimers(Date.now(), { sync: false });
    try {
      await this.onAlarm();
    } finally {
      await this.#host.syncAlarm();
    }
  }

  // GET with `Upgrade: websocket` streams events from `after`, then live:
  // ?stream=run|session&after=N. A plain GET returns the same events as NDJSON,
  // so `curl .../session | camouflage-tui --stdin-events` replays a run.
  async fetch(request) {
    const url = new URL(request.url);
    const stream = url.searchParams.get("stream") ?? "session";
    if (!STREAMS.has(stream)) return Response.json({ error: "stream must be run or session" }, { status: 400 });
    let after;
    try {
      after = parseCursor(url.searchParams.get("after"));
    } catch (error) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (!this.#host.get()) return Response.json({ error: "run not found" }, { status: 404 });

    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, [stream]);
      // Storage reads are synchronous, so no event lands between the backlog and live delivery.
      for (const event of this.#backlog(stream, after)) server.send(JSON.stringify(event));
      return new Response(null, { status: 101, webSocket: client });
    }

    const lines = [...this.#backlog(stream, after)].map((event) => `${JSON.stringify(event)}\n`).join("");
    return new Response(lines, { headers: { "content-type": "application/x-ndjson" } });
  }

  webSocketMessage(socket, message) {
    if (message === "ping") socket.send("pong");
  }

  webSocketClose(socket, code, reason) {
    socket.close(code, reason);
  }

  *#backlog(stream, after) {
    let cursor = after;
    for (;;) {
      const page = stream === "run"
        ? this.#host.listEvents({ after: cursor, limit: PAGE })
        : this.#host.listSessionEvents({ after: cursor, limit: PAGE });
      yield* page;
      if (page.length < PAGE) return;
      cursor = stream === "run" ? page.at(-1).sequence : page.at(-1).seq;
    }
  }

  #broadcast(stream, event) {
    const text = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets(stream)) {
      try {
        socket.send(text);
      } catch {
        // A closing socket is cleaned up by the runtime.
      }
    }
  }

  // The run object is the source of truth, so a failed report only leaves the
  // registry stale until RunRegistry.refresh() or the next change.
  async #report(run) {
    const binding = this.env[this.constructor.registryBinding];
    if (!binding || !run) return;
    try {
      await registryStub(binding, run.workspace).upsert(runSummary(run));
    } catch (error) {
      console.error(`Could not report run ${run.id} to its registry: ${error?.message ?? error}`);
    }
  }
}

export class RunRegistry extends DurableObject {
  static runBinding = "RUNS";

  #store;

  constructor(ctx, env) {
    super(ctx, env);
    this.#store = new RegistryStore(durableObjectSql(ctx.storage));
  }

  upsert(summary) { this.#store.upsert(summary); }
  get(id) { return this.#store.get(id); }
  list(options) { return this.#store.list(options); }

  // Re-read one run from its object, repairing a stale or missing row.
  async refresh(id) {
    const run = await this.#runs().getByName(id).get();
    if (run) this.#store.upsert(runSummary(run));
    return run ? runSummary(run) : null;
  }

  // Call once when the executor host starts, as Autopilot's supervisor does:
  // every run still marked running is requeued from its checkpoint, or marked
  // interrupted_unknown if a tool action may have been cut off.
  async reconcile() {
    const results = [];
    for (const id of this.#store.idsWithStatus("running")) {
      const run = await this.#runs().getByName(id).reconcileInterrupted();
      if (run) {
        this.#store.upsert(runSummary(run));
        results.push(runSummary(run));
      }
    }
    return results;
  }

  #runs() {
    const binding = this.env[this.constructor.runBinding];
    if (!binding) throw new Error(`RunRegistry needs the ${this.constructor.runBinding} Durable Object binding`);
    return binding;
  }
}

function registryStub(namespace, workspace) {
  return typeof namespace.getByName === "function" ? namespace.getByName(workspace) : namespace.get(namespace.idFromName(workspace));
}

function parseCursor(value) {
  if (value === null || value === "") return 0;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("after must be a non-negative integer");
  return number;
}
