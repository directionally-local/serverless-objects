# Native engine (in progress)

`sobjects dev --engine native` runs a Wrangler project's Worker and Durable Objects inside the Node process, with no celld. Each object's storage is its own SQLite file (`node:sqlite`) under `--persist-to`, which defaults to `<project>/.sobjects/native`.

```sh
sobjects dev ./my-worker --engine native --port 8787
```

It is for **trusted code**: there's no isolate between the app and the engine, and objects get full Node APIs. Use celld for apps you don't control.

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
| Hibernation API | Yes: `acceptWebSocket` with tags, `getWebSockets`, `getTags`, `setWebSocketAutoResponse` (answered without waking the object), and `webSocketMessage`/`webSocketClose`/`webSocketError` delivered through the object's input-gated queue. Sockets belong to the object's host, but objects aren't evicted yet, so there's no real hibernation. |
| Agents SDK | Yes: the conformance Agents suite passes (state, SQL, schedules, addressing, `@callable()` RPC over WebSocket) |
| KV, D1, R2, Queues, Workflows, service bindings, assets | Not yet. The engine refuses a config that declares them. |
| Idle eviction (true hibernation), worker-thread isolation, bucket replication, `sobjects build --strict` | Planned |

## Conformance

The conformance runner has a `native` target: `npm run test:native --workspace=sobjects-conformance`.

It passes all 16 checks, the same set Wrangler runs: the core suite with the alarm-across-restart check, and the Agents SDK suite. CI runs it on every change. The hibernation check (the object evicted while a socket stays open) isn't run on native yet, because the engine doesn't evict objects. See [results](conformance/results.md).
