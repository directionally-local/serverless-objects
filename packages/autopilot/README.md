# @serverless-objects/autopilot

Autopilot runs as Durable Objects. Each run is a `RunObject` that holds the run record and its state machine, tool-boundary events, usage budgets, durable wake timers and a Camouflage session log. A `RunRegistry` per workspace answers the cross-run queries: list by status, and reconcile after a restart.

It ports the per-run part of Autopilot's `RunStore` and `RunWakeScheduler` (`src/runs/store.ts`, `src/runs/wake-scheduler.ts`) to Durable Object SQLite, with the same statuses, transitions, budgets, lease and retry rules. A pending wake is a durable alarm, so it fires after the node restarts.

> **Status:** pre-alpha, not yet published to npm. This is the object layer only: running Autopilot itself inside a Hotcell cell (the executor) is the next step.

## Use

```js
import { RunObject, RunRegistry } from "@serverless-objects/autopilot";

export { RunRegistry };

// Subclass to connect your executor. onWake runs when a wake timer fires.
export class Run extends RunObject {
  async onWake(event) {
    // Start or resume the executor for event.runId. Delivery is at least once:
    // be idempotent by event.timerId. Throwing retries with backoff.
  }
}
```

```jsonc
{
  "durable_objects": {
    "bindings": [
      { "name": "RUNS", "class_name": "Run" },
      { "name": "RUN_REGISTRY", "class_name": "RunRegistry" }
    ]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Run", "RunRegistry"] }]
}
```

To use other binding names, set the static `registryBinding` on your `RunObject` subclass and `runBinding` on a `RunRegistry` subclass.

```js
const run = env.RUNS.getByName(runId);           // the object name is the run id
await run.create({ id: runId, workspace: "acme", cwd: "/workspace", task: "Fix the flaky test", maxCostUsd: 2 });
await run.transition("running");
await run.recordToolIntent("call-1", "bash", { command: "npm test" });   // stores a SHA-256 of the arguments
await run.recordToolResult("call-1", "bash", { ok: true, content: output }); // stores a hash and byte count
await run.recordCheckpoint();
await run.recordUsage({ promptTokens: 1200, completionTokens: 300, costUsd: 0.01 });
await run.scheduleTimer({ condition: "time", wakeAt: Date.now() + 60_000 });
await run.transition("waiting");

await env.RUN_REGISTRY.getByName("acme").list({ status: "waiting" });
```

## RunObject methods

| Method | Notes |
|---|---|
| `create(input)` | `id` (must equal the object name), `workspace`, `cwd`, `task`; optional `sessionId`, `allowedTools`, `maxToolIterations`, `maxRuntimeMs`, `maxTotalTokens`, `maxCostUsd`. Idempotent for the same id. |
| `get()` | The run record, or `null`. |
| `transition(status, reason?)` | Autopilot's transition table. Finishing a run cancels its timers. |
| `resume(budgets)` | Leaves `needs_input`, applying new budgets atomically. |
| `recordToolIntent(id, name, args)` / `recordToolResult(id, name, {ok, content, errorCode})` | Hashes only, never raw arguments or output. A tool budget throws `RunToolBudgetExceededError` and moves the run to `needs_input`. |
| `recordCheckpoint()` | The executor saved its session after its last tool results. |
| `recordUsage({promptTokens, completionTokens, costUsd?})` | Token and cost budgets move the run to `needs_input`. |
| `scheduleTimer({condition, wakeAt, intervalMs?, jobId?, maxAttempts?})` / `cancelTimer(id)` / `listTimers()` | `time` and `job` timers drive the alarm. `job` timers call your `checkJob(jobId)` override. `approval` timers are stored but never fire. |
| `reconcileInterrupted()` | After an executor restart: requeue from a checkpoint, or mark `interrupted_unknown` if a tool action may have been cut off. Usually called through `RunRegistry.reconcile()`. |
| `appendSessionEvents(events)` / `listSessionEvents({after, limit})` | The Camouflage session log; see below. |
| `listEvents({after, limit})` | Control events: `state`, `tool_intent`, `tool_result`, `usage`, `checkpoint`. |

## Event streams

`fetch()` on a run object serves either log from a cursor. `?stream=session` (the default) or `?stream=run`, with `&after=N`:

- With `Upgrade: websocket`, it sends the backlog after `N`, then every new event as it is committed. Sockets use the hibernation API.
- A plain GET returns the same events as NDJSON.

The session log holds [Camouflage](https://github.com/sinameraji/camouflage) events (`{ event_type, payload }`). The object assigns `seq`, `session_id` (the run's `sessionId`, or its id) and `timestamp_ms`, so the log replays in order from any node:

```sh
curl -s "https://agents.example.com/runs/run-42/stream" > run-42.ndjson
camouflage-validate run-42.ndjson
camouflage-tui --play run-42.ndjson
```

The object doesn't check `event_type` against Camouflage's schema. Run `camouflage-validate` in your tests.

## RunRegistry methods

| Method | Notes |
|---|---|
| `list({status?, limit?})` | Newest first. |
| `get(id)` | One summary. |
| `reconcile()` | Calls `reconcileInterrupted()` on every run the registry has as `running`. Call it once when the executor host starts, as Autopilot's supervisor does. |
| `refresh(id)` | Re-reads a run from its object. Reports are best-effort, and the run object is the source of truth. |

## Tested

Unit tests run the SQL against `node:sqlite`. They cover transitions, budgets, hashing, reconcile, leases, retry and backoff, job polling, runtime limits, cursors, and announcing events only after commit.

[`examples/autopilot-runs`](../../examples/autopilot-runs) was run on celld 0.6.2 through `sobjects deploy`/`up` with a SeaweedFS bucket:
- A wake fell due while the node was stopped, and fired after `up`.
- A WebSocket opened at a cursor received the backlog, then live events.
- Reconcile marked a run with an unmatched tool intent `interrupted_unknown`.
- The registry tracked every change.
- `camouflage-validate` accepted the session log.
