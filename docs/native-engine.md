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
| Worker-thread isolation, bucket replication | Planned |

## Conformance

The conformance runner has a `native` target: `npm run test:native --workspace=sobjects-conformance`.

It passes all 17 checks, the same set celld passes: the core suite, including the alarm-across-restart and hibernation checks, plus the Agents SDK suite. The runner starts the engine with `--idle-evict-seconds 2`. CI runs it on every change. See [results](conformance/results.md).
