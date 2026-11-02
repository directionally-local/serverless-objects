# Compatibility and support status

This table distinguishes behavior exercised by the project from functionality described by celld upstream. A celld capability is not automatically a Serverless Objects product guarantee. The conformance results are one local run on macOS arm64 using Wrangler 4.150.0, celld 0.6.2 and the native engine, plus one deployment to Cloudflare, and a celld-only containers run on Linux arm64 in Docker Desktop's Linux VM; they are not a cross-platform or Cloudflare production certification. CI runs the Wrangler and native suites on Ubuntu x64 but records no results, so the table is macOS arm64 evidence plus unrecorded Ubuntu x64 CI coverage, with the Containers row from the Linux arm64 run.

## Product and runtime behavior

| Area | Status | Evidence / limitation |
|---|---|---|
| Durable Object IDs | Tested on Wrangler and celld | Deterministic/named IDs, unique IDs, string conversion and validation passed in conformance v0. |
| Durable Object KV storage | Tested on Wrangler and celld | Get/put/list/delete, ranges and structured-clone values passed. This is the DO storage API, not a full test of the separate Workers KV binding. |
| SQLite storage and SQL cursors | Tested on Wrangler and celld | SQL execution, cursors, raw rows, errors and database size passed. SQLite-backed classes require `new_sqlite_classes`. |
| Transactions | Tested on Wrangler and celld | `transactionSync` and async transaction commit/rollback passed. |
| RPC and input gates | Tested on Wrangler and celld | Structured arguments/results, error propagation, serialized increments and `blockConcurrencyWhile` passed in the tested cases. |
| Alarm API and delivery | Tested on Wrangler and celld | Set/delete and alarm delivery passed. |
| Alarm across celld restart | Tested on celld only | A pending alarm fired after restarting the local celld process. This was not tested on Wrangler. |
| `deleteAll()` clears alarm | Tested on Wrangler and celld | Passed with compatibility date `2026-02-24` or later. |
| Basic WebSockets | Tested on Wrangler and celld | Upgrade, echo, attachment, tags and auto-response passed. |
| WebSocket hibernation/eviction | Tested on celld | Same-node hibernation passed on celld 0.6.2: the object was evicted with a socket open, and the next message reached a new instance with tags and attachment intact. Not run on Wrangler (no eviction control). celld documents that sockets may close when a cell moves between nodes; that is not tested. |
| Facets | Tested on Wrangler and celld | `ctx.facets.get` with a class taken from `ctx.exports` passed on Wrangler 4.150.0 and celld 0.6.2: state by name, isolation between facets, storage separate from the parent, and alarms refused. The native engine does not implement `ctx.facets`, so the check is skipped there. |
| Durable Object migrations | Limited upstream support | celld 0.6.2 accepts `tag` and `new_sqlite_classes`; rename/delete/transfer migrations are rejected. |
| Agents SDK | Partial | A minimal `agents` 0.28.1 app was deployed through `sobjects deploy` and served by `sobjects up` behind TLS ingress (celld 0.6.2, SeaweedFS): routing, `setState`, `this.sql`, `schedule()` (including one pending across a node restart), the WebSocket identity/state protocol, and `@callable()` RPC over WebSocket matched `wrangler dev`. `npm run test:product` repeats the state, SQL, schedules, addressing, callable RPC and schedule checks against that deployment (6/6). Chat agents, MCP, Workflows and the official samples have not been run through the CLI. |
| PartyServer | Tested on Wrangler, celld and the native engine | `partyserver` 0.5.10 in its own conformance app: `getServerByName` and `this.name` from `ctx.id.name`, `onStart`, `this.sql`, alarms, `/parties/<namespace>/<room>` routing, `broadcast()` to two connections, connection attachments, and hibernation across idle eviction (celld and native only; Wrangler's local runtime gives the runner no eviction control). Not run on Cloudflare, and not through `sobjects deploy`/`up`. The native engine needed workerd's `READY_STATE_*` ready-state constants on the global `WebSocket` for PartyServer's connection manager. See [results](conformance/results.md). |
| Cloudflare-hosted production behavior | Not tested | Local Wrangler and celld results do not certify production Cloudflare behavior. |

## Bindings and topology

| Capability | Status | Notes |
|---|---|---|
| celld Durable Objects, KV, D1, R2, Queues, Workflows | Upstream-reported | Listed by celld 0.6.2; this conformance suite does not exercise every binding. Check celld's release documentation for exact feature limits. |
| Containers (`ctx.container`) and `@cloudflare/sandbox` 1.0 | Partial, automated on Linux arm64 in Docker Desktop's Linux VM | celld 0.6.2 runs Wrangler `containers` classes on a local Docker or Podman engine. `npm run test:containers` (8/8) verified on Linux arm64 in Docker Desktop 4.75.0's Linux VM, with celld in a privileged container using the host Docker socket: `start()`, `exec()`, `getTcpPort().fetch()`, `enableInternet: false` (egress refused), idle eviction with the container kept alive and reattached, and a node restart destroying the container. `@cloudflare/sandbox` 1.0.1's `S3Mount.mount()` and `DirectoryBackup` are unsupported: both need `interceptOutboundHttp`, which celld rejects with "not implemented in celld"; `inspect()`, `snapshotDirectory()`, `snapshotContainer()` and `container.images` are also unavailable. `exec()` immediately after `start()` fails with "No such container" because celld's `start()` is fire-and-forget, while Cloudflare's `exec()` waits for a starting container; that is celld's behavior, not the CLI's, and the conformance app polls `exec()` for readiness. Not tested: a bare-metal Linux host, Linux x64, `@cloudflare/sandbox`'s `Files` API, and containers on Wrangler or Cloudflare. See [the containers record](conformance/containers.md). |
| Workers AI, Vectorize, Hyperdrive, Browser Rendering, Email Workers | Not provided by celld 0.6.2 | Serverless Objects does not implement replacements. |
| Single-host `sobjects up` | Implemented and smoke-tested | The current product is a single-host operating layer by default. Keep operator/admin listeners on loopback. |
| Multi-node object placement | Native engine only | `--node-name` shares one bucket prefix between nodes, with leases, takeover, drain and call forwarding ([details](native-engine.md#several-nodes)). celld runs one node per bucket prefix. |
| Tenancy, SSO, audit log, fleet control plane | Not provided by this pre-alpha | celld's own multi-node capabilities do not imply these Serverless Objects control-plane features. |
| Point-in-time restore | celld 0.6: no. Native engine: yes, in durable mode | celld: the dashboard can show retained epochs and export logical JSON, but there is no supported restore command in this release. Native engine with `--backup-mode durable`: Cloudflare's API (`getCurrentBookmark`, `getBookmarkForTime`, `onNextSessionRestoreBookmark`, `ctx.abort()`), back `--backup-retention-days` (default 7). |

## Test record

- Full table and exact command: [conformance v0 results](conformance/results.md).
- Runtime spike and sample caveats: [M0 celld findings](conformance/m0-celld.md).
- Each report represents one local run. Repeat the suite on supported Linux architectures and add coverage before making broader compatibility claims.
