# Conformance v0 results

Recorded 19–29 Oct 2026 on macOS arm64 with Node.js 24.12.0, using the local
Wrangler runner as the reference and celld's local development server. Each
runner completed all of its checks in one run: 21 on Wrangler (11 core, 6 Agents SDK, 4 PartyServer), 24 on celld (adding hibernation and facets, plus a PartyServer hibernation check) and 23 on the native engine (adding hibernation and a schedule across restart, without facets).

- Wrangler: 4.150.0 (`wrangler dev --local`)
- celld: 0.6.2 (`celld dev`)
- Agents SDK: `agents` 0.28.1 (separate app with `nodejs_compat`)
- PartyServer: `partyserver` 0.5.10 (separate app with `nodejs_compat`)
- Worker compatibility date: `2026-02-24`
- Command: `npm run test:wrangler --workspace=sobjects-conformance` and
  `npm run test:celld --workspace=sobjects-conformance`

| Area | Cloudflare | Wrangler 4.150.0 | celld 0.6.2 | native | Notes |
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
| Facets | Not run | Pass | Pass | Not run | `ctx.facets.get` with a class from `ctx.exports`: state by name, isolation between facets, storage separate from the parent, and alarms refused. workerd and celld 0.6.2 pass; the native engine has no `ctx.facets`. |
| Agents SDK state and SQL | Pass | Pass | Pass | Pass | `setState`/`this.state` and the `this.sql` tagged template |
| Agents SDK schedules | Pass | Pass | Pass | Pass | Delayed and cron schedules, list, cancel; a delayed schedule runs its callback |
| Agents SDK schedule across restart | Not run | Not run | Pass | Pass | A delayed schedule armed before a process restart was still pending afterwards and fired |
| Agents SDK addressing | Pass | Pass | Pass | Pass | `getAgentByName`, `this.name`, class name, `/agents/<class>/<name>` routing |
| Agents SDK client protocol | Pass | Pass | Pass | Pass | Identity and state frames, `@callable()` RPC over WebSocket, state broadcast, non-callable methods refused |
| PartyServer storage and addressing | Not run | Pass | Pass | Pass | `getServerByName`, `this.name` from `ctx.id.name`, `onStart`, and `this.sql` create/insert/ordered select |
| PartyServer alarm | Not run | Pass | Pass | Pass | `setAlarm`, `onAlarm` and `getAlarm` through PartyServer's `alarm()` |
| PartyServer WebSocket broadcast | Not run | Pass | Pass | Pass | `/parties/chat/<room>` routing, welcome frames, `broadcast()` to both connections, connection count, attachment, and `this.sql` from a socket message |
| PartyServer WebSocket hibernation | Not run | Not run | Pass | Pass | Evicted with the socket open; the next message reached a new instance with the connection attachment rehydrated from the socket |

The Cloudflare column is from `npm run test:cloudflare` (20 Oct 2026): 17/17. The runner deployed both apps unchanged with `wrangler deploy` to a workers.dev subdomain on the free plan, ran every check against the deployment, and deleted the Workers. Cloudflare hibernated the object on its own during a 30-second idle period. There is no process to restart, so the alarm-across-restart check runs as plain alarm delivery there. The facets, schedule-across-restart and PartyServer checks were added after that run and have not been run on Cloudflare.

The native engine column is from `npm run test:native` on the same host (29 Oct 2026): 23/23, with `--idle-evict-seconds 2` for the hibernation checks; see [the native engine](../native-engine.md). The PartyServer suite needed one engine fix: the global `WebSocket` now exposes workerd's `READY_STATE_*` ready-state constants, which PartyServer reads when it filters hibernatable sockets.

## Containers

`npm run test:containers --workspace=sobjects-conformance` (2 Nov 2026) ran 8/8 checks on Linux arm64 in Docker Desktop 4.75.0's Linux VM with celld 0.6.2 and `@cloudflare/sandbox` 1.0.1. It covers `start()`, `exec()`, `getTcpPort().fetch()`, `enableInternet: false` (egress refused), idle eviction with the container kept alive and reattached, and a node restart destroying the container. `S3Mount` and `DirectoryBackup` are unsupported because celld rejects `interceptOutboundHttp`; `inspect()`, `snapshotDirectory()`, `snapshotContainer()` and `container.images` are also unavailable. The `exec()`-after-`start()` race is celld's fire-and-forget `start()`, not the CLI's. See [the containers record](containers.md).

## Platforms

Every column in the table above is one local run on macOS arm64. CI runs the Wrangler and native suites on Ubuntu x64 (Node 22) on every change, and builds the linux/amd64 Docker image and checks that `sobjects` and `celld` start in it; it does not run `test:celld`, `test:containers` or `test:cloudflare`, and it records no results. Linux arm64 has containers evidence from the containers suite on Docker Desktop's Linux VM; no bare-metal Linux host or Linux x64 run is recorded. Treat the table as macOS arm64 evidence plus unrecorded Ubuntu x64 CI coverage, not as a cross-platform claim.

## Product path

`npm run test:product --workspace=sobjects-conformance` deploys `agents-app` with `sobjects deploy` and serves it with `sobjects up --detach` behind TLS ingress, then runs the Agents SDK checks against the ingress rather than a runner's local server. One run on 2 Nov 2026 (macOS arm64, celld 0.6.2, SeaweedFS started with `--local-s3`) passed 6/6: state, SQL, schedules, addressing, the WebSocket client protocol with `@callable()` RPC, and a delayed schedule. It is not in CI because it needs Docker, a bucket and celld.

## Not covered

This v0 run does not test hibernation on Wrangler, the alarm-across-restart check on Cloudflare or Wrangler, sockets across a cell move between nodes, all
compatibility flags, or
Agents SDK chat agents, MCP, Workflows and streaming RPC. PartyServer is covered
by its own suite on Wrangler, celld and the native engine, but not on Cloudflare,
and not through `sobjects deploy`. The Wrangler, celld and native runners use
`wrangler dev` and `celld dev` directly; only `test:product` goes through
`sobjects deploy`/`up`, and only for the Agents app. Those remain separate
conformance and product-level gates.
