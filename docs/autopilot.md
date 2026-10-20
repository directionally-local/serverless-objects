# Autopilot run objects (`serverless-objects/autopilot`)

Autopilot runs as Durable Objects. Each run is a `RunObject` that holds the run record and its state machine, tool-boundary events, usage budgets, durable wake timers and a Camouflage session log. A `RunRegistry` per workspace answers the cross-run queries: list by status, and reconcile after a restart.

It ports the per-run part of Autopilot's `RunStore` and `RunWakeScheduler` (`src/runs/store.ts`, `src/runs/wake-scheduler.ts`) to Durable Object SQLite, with the same statuses, transitions, budgets, lease and retry rules. A pending wake is a durable alarm, so it fires after the node restarts.

> **Status:** pre-alpha (0.x). Ships in the `serverless-objects` npm package: `npm install serverless-objects`. `serverless-objects/autopilot/cell` runs a run's task with Autopilot in a Hotcell cell.

## Use

```js
import { RunObject, RunRegistry } from "serverless-objects/autopilot";

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

## Running Autopilot in a Hotcell cell

`AutopilotCellRun` is a `RunObject` that runs its task with Autopilot inside a [Hotcell](https://github.com/sinameraji/hotcell) cell, following Autopilot's own cell runtime (`src/server/aster-cell-runtime.ts`):

1. Create the cell with gateway egress, so the cell gets a short-lived token for model calls, never a provider key.
2. Install `autopilot-ai` in the cell and start its bridge.
3. Open a session and send the task as one prompt.
4. Follow the bridge's event cursor.

Control requests go through `exec`, so microVM cells without a network interface work too.

```js
import { RunRegistry } from "serverless-objects/autopilot";
import { AutopilotCellRun } from "serverless-objects/autopilot/cell";

export { RunRegistry };
export class Run extends AutopilotCellRun {}

await env.RUNS.getByName(id).create({ id, workspace: "acme", cwd: "/workspace", task, maxCostUsd: 1 });
await env.RUNS.getByName(id).start({ model: "moonshotai/kimi-k2.6", egress: { spendCapUsd: 1, ttlMs: 3_600_000 } });
```

- **Steps:** each step (provision, install, bridge, session, prompt, poll) runs on the object's alarm and is persisted with the cursor. If the node or object restarts, it resumes where it stopped while the cell keeps working. The bridge de-duplicates the prompt, so a retried prompt never runs twice.
- **Retries:** a failed setup step is retried 6 times with backoff; polling is retried for about 15 minutes. The run then fails as `cell_<step>_failed`.
- **What gets recorded:** cell events become run records: tool intent and result hashes, usage against the token and cost budgets, and the final state. They also become Camouflage events: assistant and reasoning streams, tool start and finish, usage, todos, warnings and errors.
- **Budgets:** a tripped tool, token or cost budget aborts the cell's turn, and the run waits in `needs_input`. The object sees tool calls as the cell reports them, so the call that tripped a budget may already have run.
- **Resuming:** `resume(budgets, { message? })` applies the new budgets and starts a follow-up turn in the same cell session, which still has the conversation. It polls from the saved cursor and ignores the aborted turn's late events. It is refused until the cell has finished stopping the previous turn.
- **Turn lost:** if the cell reports no active turn and stops producing events, the run fails as `cell_turn_lost`.
- **Options for `start()`:** `model` (OpenRouter id, default `moonshotai/kimi-k2.6`), `packageSpec` (`autopilot-ai@<version>`, default `autopilot-ai@1.25.1`), `image` (default `ghcr.io/sinameraji/hotcell-base:latest`, which has Node 20 and git), and `egress` (a Hotcell egress policy, default a $1 spend cap and 1-hour TTL).
- **Daemon:** set `HOTCELL_ENDPOINT` and `HOTCELL_API_KEY` in the Worker's vars and secrets.
- **Other methods:** `cancel()` aborts the turn; `executorState()` returns the step, cell id, cursor and last error.
- **Concurrency:** each step runs under a lease, and every executor write checks it, so an overlapping or stale invocation can't advance the run. `npm install` runs in the background in the cell, so no alarm handler waits on it.

The cell is kept after the run so its workspace can be inspected; destroy it through Hotcell when you're done. The session log includes the task, assistant text, tool commands and up to 16,000 characters of each tool's output. Likely secrets are redacted before an event is stored:
- provider keys (`sk-…`, OpenRouter), GitHub and Slack tokens, AWS access key IDs, JWTs and PEM private keys
- `NAME=value` and `"name": "value"` pairs whose name contains SECRET, TOKEN, PASSWORD or API_KEY

Streamed assistant text is logged a line at a time (and a PEM block whole), so a secret split across deltas is redacted whole. The control log (`stream=run`) keeps only hashes, which are taken over the original content. Redaction is pattern-based: treat the session log as sensitive anyway.

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
| `scheduleTimer({condition, wakeAt, intervalMs?, jobId?, maxAttempts?})` / `cancelTimer(id)` / `listTimers()` | `time` and `job` timers drive the alarm. `job` timers call your `checkJob(jobId)` override. `approval` timers take an optional `expiresAt` instead of `wakeAt`. |
| `approve(timerId, {decision, reason?})` | Resolves an approval timer of a waiting run exactly once, with `decision` either `"approved"` or `"denied"`. It records an `approval` run event (whose `toolCallId` holds the timer id), then delivers a wake with `condition: "approval"`, `decision` and `reason` under the usual rules: running before notify, retry and backoff. An approval left past `expiresAt` fails the timer and the waiting run. |
| `reconcileInterrupted()` | After an executor restart: requeue from a checkpoint, or mark `interrupted_unknown` if a tool action may have been cut off. Usually called through `RunRegistry.reconcile()`. |
| `appendSessionEvents(events)` / `listSessionEvents({after, limit})` | The Camouflage session log; see below. |
| `listEvents({after, limit})` | Control events: `state`, `tool_intent`, `tool_result`, `usage`, `checkpoint`, `approval`. |

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

Unit tests run the SQL against `node:sqlite`. They cover transitions, budgets, hashing, reconcile, leases, retry and backoff, job polling, runtime limits, cursors, and announcing events only after commit. The cell executor is tested against a fake bridge: setup steps, event mapping, resuming after a restart without re-prompting, budget aborts, errors and backoff, failed setup, lost turns, and schema migration.

A real Autopilot run (celld 0.6.2, Hotcell 0.1.19 container driver, `autopilot-ai` 1.25.1, `moonshotai/kimi-k2.6` through the Hotcell gateway) went from provision to completion in about 30 seconds. It wrote the requested file for $0.0084, and `camouflage-validate` accepted all 99 session events. In a second run, the node was stopped for about 45 seconds during a 40-second bash tool call. After `up`, the object resumed from its saved cursor (36 → 48) and the run completed ($0.0114). Its tool intent and result stayed paired, and all 48 session events were valid. A third run with `maxToolIterations: 1` paused at its second tool call. `resume({ maxToolIterations: 5 }, { message })` then finished the task in the same session ($0.0145), and all 33 session events were valid.

Separately, [`examples/autopilot-runs`](https://github.com/sinameraji/serverless-objects/tree/main/examples/autopilot-runs) was run on celld 0.6.2 through `sobjects deploy`/`up` with a SeaweedFS bucket:
- A wake fell due while the node was stopped, and fired after `up`.
- A WebSocket opened at a cursor received the backlog, then live events.
- Reconcile marked a run with an unmatched tool intent `interrupted_unknown`.
- The registry tracked every change.
- `camouflage-validate` accepted the session log.
