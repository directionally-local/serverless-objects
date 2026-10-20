# Native engine (in progress)

`sobjects dev --engine native` runs a Wrangler project's Worker and Durable Objects inside the Node process, with no celld. Each object's storage is its own SQLite file (`node:sqlite`) under `--persist-to`, which defaults to `<project>/.sobjects/native`.

```sh
sobjects dev ./my-worker --engine native --port 8787
```

It is for **trusted code**: there's no isolate between the app and the engine, and objects get full Node APIs. Use celld for apps you don't control. It needs Node.js 22.16 or newer.

The app's own code is bundled with esbuild, which handles TypeScript and `define`. Its npm packages load from `node_modules` as in any Node program, so packages with native addons (for example `better-sqlite3`) and packages that read their own files work. `cloudflare:workers` and `cloudflare:email` resolve to the engine's shims, both for the app and for packages that import them.

## What works

| Area | Status |
|---|---|
| Worker `fetch` handler, object or `WorkerEntrypoint` default export | Yes |
| Durable Object IDs | Yes: `idFromName`, `newUniqueId`, `idFromString` (forged or foreign IDs are rejected), `getByName`, `id.name` (kept across restarts) |
| Stubs | Yes: `fetch()` and RPC calls with structured-clone arguments, results and errors |
| Input gates | Yes: each event starts in its own macrotask and storage resolves as microtasks, so storage-only read-modify-write is never interleaved. `blockConcurrencyWhile` and async `transaction()` hold events back. |
| Storage | Yes: async and synchronous (`ctx.storage.kv`) KV with V8 structured clone, ordered `list`, `sql.exec` cursors (`toArray`, `one`, `raw`, `columnNames`, `rowsRead`, `rowsWritten`, `databaseSize`), `transactionSync`, `transaction`, `deleteAll` (also clears the alarm) |
| Alarms | Yes: `setAlarm`/`getAlarm`/`deleteAlarm`, delivered after a restart, and retried with backoff (up to 6 retries) when the handler throws |
| `vars`, `cloudflare:workers` (`DurableObject`, `WorkerEntrypoint`, `WorkflowEntrypoint`, `RpcTarget`, `env`, `exports`), `cloudflare:email` (`EmailMessage` only) | Yes |
| WebSockets | Yes: `WebSocketPair`, `accept()`, event listeners, attachments, and a built-in RFC 6455 server (handshake, masking, fragmentation, ping/pong, close handshake) |
| Hibernation API | Yes: `acceptWebSocket` with tags, `getWebSockets`, `getTags`, `setWebSocketAutoResponse` (answered without waking the object), and `webSocketMessage`/`webSocketClose`/`webSocketError` delivered through the object's input-gated queue. Sockets belong to the object's host, so an evicted object's hibernatable sockets stay open, and the next message wakes a new instance. |
| Agents SDK | Yes: the conformance Agents suite passes (state, SQL, schedules, addressing, `@callable()` RPC over WebSocket) |
| KV, D1, R2, Queues, Workflows, service bindings, assets | Not yet. The engine refuses a config that declares them. |
| Idle eviction | Yes: an object idle for `--idle-evict-seconds` (default 60; 0 never) loses its instance. Sockets accepted with `accept()` and listeners keep it in memory. An object with no sockets and no pending alarm also closes its database. |
| Portability check | Yes: `sobjects build [--strict]` lists each Node.js built-in the app imports, with the files that import it, and marks it as supported on Cloudflare, a non-functional stub there, or blocked by a missing `nodejs_compat` flag or compatibility date. It also flags packages that ship compiled native addons. A portable app runs on Cloudflare, celld and the native engine; a native-only app runs only here. |
| Autopilot in-process | Yes: `serverless-objects/autopilot/native` runs Autopilot's SDK inside an object, with tool budgets enforced before tools run ([details](autopilot.md#running-autopilot-in-process-native-engine)) |
| `ctx.waitUntil` | Yes: keeps the object in memory until the promise settles |
| Bucket backups | Yes: `--backup-bucket s3://bucket/prefix` copies each object to an S3-compatible bucket and restores it onto an empty disk ([details](#bucket-backups)) |
| Worker threads | Yes: `--threads N` runs objects on N threads, each object on one thread, with stalled or crashed threads replaced ([details](#worker-threads)) |
| Continuous replication, multi-node | Planned |

## Bucket backups

```sh
export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...
export S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com   # omit for AWS S3; set AWS_REGION there
sobjects dev ./my-worker --engine native --backup-bucket s3://my-bucket/node-a
```

With `--backup-bucket`, the engine copies each object's SQLite file (a consistent `VACUUM INTO` snapshot) to `<prefix>/native/<script>/<class>/<id>.sqlite` within `--backup-interval-seconds` (default 10) of a change, and again when the object closes or the engine stops. On start, every object in the bucket that has no local file is downloaded, and its pending alarm is scheduled. Credentials come from `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and optionally `AWS_SESSION_TOKEN`, never from a file in the project. Tested against Cloudflare R2 and SeaweedFS.

What this gives you, and what it doesn't:

- The local file is the source of truth while the node runs. If the machine's disk is lost, writes made after the last upload are lost too: the recovery point is up to the backup interval plus the upload time. On Cloudflare, a write is durable once its output gate opens; here it isn't, until the next upload.
- Each upload sends the whole file, so very large objects cost more per change.
- One node per prefix. Uploads are conditional on the version this node last saw, so a node that finds a copy another node wrote stops backing that object up and logs it, instead of overwriting it.
- Restores happen only for objects missing locally. There is no point-in-time restore; enable bucket versioning if you need history.

## Worker threads

```sh
sobjects dev ./my-worker --engine native --threads 4
```

With `--threads N`, the main thread serves HTTP and hands each request's Worker `fetch` to the threads in turn. Each Durable Object lives on exactly one thread, chosen from its ID, so its input gate and storage work as in one process. A stub for an object on another thread relays the call there: arguments, results and errors cross as structured clones, as for any RPC call; request and response bodies are streamed across, and WebSockets are relayed. Without `--threads`, everything runs on the main thread as before.

What threads give you:

- **A stuck or crashing object doesn't take the app down.** The main thread pings each thread every second. A thread that doesn't answer for `--thread-stall-seconds` (default 30), throws an uncaught error, or exceeds `--thread-memory-mb` is replaced. Its objects reload from their SQLite files on the next call; calls in flight on that thread fail, and hibernatable WebSockets held by it close. A thread that keeps failing is restarted with a back-off.
- **More cores for CPU-heavy objects.** A test with 16 objects each hashing for ~10 ms per request went from 89 req/s on one thread to 169 req/s on 4 and 182 on 8 (M1 Pro, load generator on the same machine).

What they don't:

- They are not a security boundary. Every thread runs the same trusted code in one process with full Node APIs.
- Cheap operations get slower, not faster: a call that crosses threads costs roughly 0.3–0.5 ms more, and the main thread's HTTP handling limits throughput as it does with one thread.
- A Worker that receives a WebSocket from an object on another thread can return it as a 101 response, but can't add its own event listeners to it.

The conformance suite passes 17/17 on three threads, and CI runs it that way too.

## Performance

See [benchmarks](benchmarks.md) for latency and throughput next to celld and Wrangler, and what the write numbers do and don't mean for durability.

## Conformance

The conformance runner has a `native` target: `npm run test:native --workspace=sobjects-conformance`.

It passes all 17 checks, the same set celld passes: the core suite, including the alarm-across-restart and hibernation checks, plus the Agents SDK suite. The runner starts the engine with `--idle-evict-seconds 2`. CI runs it on every change. See [results](conformance/results.md).
