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

| Area | Wrangler 4.150.0 | celld 0.6.2 | Notes |
|---|---:|---:|---|
| Durable Object IDs | Pass | Pass | Deterministic/named IDs, unique IDs, string conversion and validation |
| KV storage | Pass | Pass | Get/put/list/delete, ranges, structured-clone values |
| SQLite storage | Pass | Pass | SQL execution, cursors, raw rows, errors and database size |
| Transactions | Pass | Pass | `transactionSync` and async transaction commit/rollback |
| RPC and input gates | Pass | Pass | Structured arguments/results, error propagation, serialized increments and `blockConcurrencyWhile` |
| Alarm API and delivery | Pass | Pass | Set/delete and alarm delivery |
| Alarm across process restart | Not run | Pass | celld was restarted with an alarm pending; alarm fired afterward |
| `deleteAll()` clears alarm | Pass | Pass | Requires the tested compatibility date, `2026-02-24` or later |
| WebSocket behavior | Pass | Pass | Upgrade, echo, attachment, tags and auto-response |
| WebSocket hibernation | Not run | Pass | With `CELLD_IDLE_EVICT_S=2`, celld evicted the object while a socket stayed open; the next message reached a new instance with the socket's tags and attachment. Wrangler's local runtime gives the runner no eviction control. |
| Agents SDK state and SQL | Pass | Pass | `setState`/`this.state` and the `this.sql` tagged template |
| Agents SDK schedules | Pass | Pass | Delayed and cron schedules, list, cancel; a delayed schedule runs its callback |
| Agents SDK addressing | Pass | Pass | `getAgentByName`, `this.name`, class name, `/agents/<class>/<name>` routing |
| Agents SDK client protocol | Pass | Pass | Identity and state frames, `@callable()` RPC over WebSocket, state broadcast, non-callable methods refused |

## Not covered

This v0 run does not test hibernation on Wrangler, sockets across a cell move between nodes, facets, all
compatibility flags, Cloudflare-hosted production behavior, PartyServer, or
Agents SDK chat agents, MCP, Workflows, streaming RPC and schedules across a
restart. These runners use `wrangler dev` and `celld dev` directly; they do not
go through `sobjects deploy`. Those remain separate
conformance and product-level gates. The results are from one local run per
target on one macOS arm64 host; repeat them on supported Linux platforms before
making broader platform claims.
