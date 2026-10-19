# Conformance v0 results

Recorded 19 Oct 2026 on macOS arm64 with Node.js 24.12.0, using the local
Wrangler runner as the reference and celld's local development server. Each
runner completed all 10 checks in one run.

- Wrangler: 4.150.0 (`wrangler dev --local`)
- celld: 0.6.2 (`celld dev`)
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

## Not covered

This v0 run does not test WebSocket hibernation/eviction, facets, all
compatibility flags, Cloudflare-hosted production behavior, or full Agents SDK
and PartyServer applications through the `sobjects` CLI. Those remain separate
conformance and product-level gates. The results are from one local run per
target on one macOS arm64 host; repeat them on supported Linux platforms before
making broader platform claims.
