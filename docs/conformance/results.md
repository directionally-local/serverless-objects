# Conformance v0 results

Recorded 19 Oct 2026 on macOS arm64 with Node.js 24.12.0, using the local
Wrangler runner as the reference and celld's local development server. Each
runner completed all of its checks in one run: 16 on Wrangler (10 core, 6 Agents SDK) and 17 on celld (adding hibernation).

- Wrangler: 4.150.0 (`wrangler dev --local`)
- celld: 0.6.2 (`celld dev`)
- Agents SDK: `agents` 0.28.1 (separate app with `nodejs_compat`)
- Worker compatibility date: `2026-02-24`
- Command: `npm run test:wrangler --workspace=sobjects-conformance` and
  `npm run test:celld --workspace=sobjects-conformance`

| Area | Cloudflare | Wrangler 4.150.0 | celld 0.6.2 | native (in progress) | Notes |
|---|---:|---:|---:|---:|---|
| Durable Object IDs | Pass | Pass | Pass | Pass | Deterministic/named IDs, unique IDs, string conversion and validation |
| KV storage | Pass | Pass | Pass | Pass | Get/put/list/delete, ranges, structured-clone values |
| SQLite storage | Pass | Pass | Pass | Pass | SQL execution, cursors, raw rows, errors and database size |
| Transactions | Pass | Pass | Pass | Pass | `transactionSync` and async transaction commit/rollback |
| RPC and input gates | Pass | Pass | Pass | Pass | Structured arguments/results, error propagation, serialized increments and `blockConcurrencyWhile` |
| Alarm API and delivery | Pass | Pass | Pass | Pass | Set/delete and alarm delivery |
| Alarm across process restart | Not run | Not run | Pass | Pass | celld was restarted with an alarm pending; alarm fired afterward |
| `deleteAll()` clears alarm | Pass | Pass | Pass | Pass | Requires the tested compatibility date, `2026-02-24` or later |
| WebSocket behavior | Pass | Pass | Pass | Pass | Upgrade, echo, attachment, tags and auto-response |
| WebSocket hibernation | Pass | Not run | Pass | Pass | With `CELLD_IDLE_EVICT_S=2`, celld evicted the object while a socket stayed open; the next message reached a new instance with the socket's tags and attachment. Wrangler's local runtime gives the runner no eviction control. |
| Agents SDK state and SQL | Pass | Pass | Pass | Pass | `setState`/`this.state` and the `this.sql` tagged template |
| Agents SDK schedules | Pass | Pass | Pass | Pass | Delayed and cron schedules, list, cancel; a delayed schedule runs its callback |
| Agents SDK addressing | Pass | Pass | Pass | Pass | `getAgentByName`, `this.name`, class name, `/agents/<class>/<name>` routing |
| Agents SDK client protocol | Pass | Pass | Pass | Pass | Identity and state frames, `@callable()` RPC over WebSocket, state broadcast, non-callable methods refused |

The Cloudflare column is from `npm run test:cloudflare` (20 Oct 2026): 17/17. The runner deployed both apps unchanged with `wrangler deploy` to a workers.dev subdomain on the free plan, ran every check against the deployment, and deleted the Workers. Cloudflare hibernated the object on its own during a 30-second idle period. There is no process to restart, so the alarm-across-restart check runs as plain alarm delivery there.

The native engine column is from `npm run test:native` on the same host (20 Oct 2026): 17/17, with `--idle-evict-seconds 2` for the hibernation check; see [the native engine](../native-engine.md).

## Not covered

This v0 run does not test hibernation on Wrangler, the alarm-across-restart check on Cloudflare or Wrangler, sockets across a cell move between nodes, facets, all
compatibility flags, PartyServer, or
Agents SDK chat agents, MCP, Workflows, streaming RPC and schedules across a
restart. These runners use `wrangler dev` and `celld dev` directly; they do not
go through `sobjects deploy`. Those remain separate
conformance and product-level gates. The results are from one local run per
target on one macOS arm64 host; repeat them on supported Linux platforms before
making broader platform claims.
