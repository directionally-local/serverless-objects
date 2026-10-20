# Compatibility and support status

This table distinguishes behavior exercised by the project from functionality described by celld upstream. A celld capability is not automatically a Serverless Objects product guarantee. The conformance results are one local run on macOS arm64 using Wrangler 4.150.0 and celld 0.6.2; they are not a cross-platform or Cloudflare production certification.

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
| Facets | Not tested in conformance v0 | Not covered by the current app or results. |
| Durable Object migrations | Limited upstream support | celld 0.6.2 accepts `tag` and `new_sqlite_classes`; rename/delete/transfer migrations are rejected. |
| Agents SDK / PartyServer | Partial | A minimal `agents` 0.28.1 app was deployed through `sobjects deploy` and served by `sobjects up` behind TLS ingress (celld 0.6.2, SeaweedFS): routing, `setState`, `this.sql`, `schedule()` (including one pending across a node restart), and the WebSocket identity/state protocol matched `wrangler dev`. Callable RPC, chat agents, MCP, Workflows and the official samples have not been run through the CLI. PartyServer chat was tested only directly on celld in M0. See [M0 findings](conformance/m0-celld.md). |
| Cloudflare-hosted production behavior | Not tested | Local Wrangler and celld results do not certify production Cloudflare behavior. |

## Bindings and topology

| Capability | Status | Notes |
|---|---|---|
| celld Durable Objects, KV, D1, R2, Queues, Workflows | Upstream-reported | Listed by celld 0.6.2; this conformance suite does not exercise every binding. Check celld's release documentation for exact feature limits. |
| Containers (`ctx.container`) and `@cloudflare/sandbox` 1.0 | Partial, tested once on celld with Docker | celld 0.6.2 runs Wrangler `containers` classes on a local Docker or Podman engine. A DO using stock `@cloudflare/sandbox` 1.0.1 (`Files.writeFile`/`readFile`, `ctx.container.exec`) worked with an image built `FROM alpine` plus `sandbox-shim` copied from `cloudflare/sandbox:1.0.1`, which is a tools-only image with no command. Gaps seen on macOS: `exec()` straight after `start()` fails with "No such container" while the container is still being created, where Cloudflare's own example calls them back to back; `enableInternet: false` is not enforced (celld logs a warning); `container.images` is undefined. Not tested: Linux, `S3Mount`, `DirectoryBackup`, sleep and restart. |
| Workers AI, Vectorize, Hyperdrive, Browser Rendering, Email Workers | Not provided by celld 0.6.2 | Serverless Objects does not implement replacements. |
| Single-host `sobjects up` | Implemented and smoke-tested | The current product is a single-host operating layer. Keep operator/admin listeners on loopback. |
| Multi-node product operations, tenancy, SSO, audit log | Not provided by this pre-alpha | celld's own multi-node capabilities do not imply these Serverless Objects control-plane features. |
| Point-in-time restore | Not available with celld 0.6 | The dashboard can show retained epochs and export logical JSON, but there is no supported restore command in this release. |

## Test record

- Full table and exact command: [conformance v0 results](conformance/results.md).
- Runtime spike and sample caveats: [M0 celld findings](conformance/m0-celld.md).
- Each report represents one local run. Repeat the suite on supported Linux architectures and add coverage before making broader compatibility claims.
