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
| Bucket backups | Yes: `--backup-bucket s3://bucket/prefix` copies each object to an S3-compatible bucket and restores it onto an empty disk ([details](#bucket-backups)). With `--backup-mode durable`, every write is in the bucket before it is acknowledged ([details](#durable-mode)) |
| Worker threads | Yes: `--threads N` runs objects on N threads, each object on one thread, with stalled or crashed threads replaced ([details](#worker-threads)) |
| Several nodes | Yes: `--node-name` shares one bucket prefix between nodes, with leases, takeover and call forwarding ([details](#several-nodes)) |
| Running as a service | Yes: a `[native]` table in `sobjects.toml` makes `sobjects up` run the engine, with `--detach`, `status`, `logs`, `down` and `service install` ([details](#running-as-a-service)) |

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
- If the bucket can't be reached at start, a node that has local state starts from it and logs a warning; a node with an empty disk waits for the bucket, because starting empty would fork its objects' data.
- Restores happen only for objects missing locally. There is no point-in-time restore; enable bucket versioning if you need history.

### Durable mode

```sh
sobjects dev ./my-worker --engine native --backup-bucket s3://my-bucket/node-a --backup-mode durable
```

In durable mode, nothing the engine acknowledges is lost if the disk is:

- **Output gate:** after each event (an RPC call, fetch, alarm or socket message), the engine reads the transactions the object committed from its SQLite WAL, and holds the event's result until they are in the bucket. A later event's result waits too, since it may show those writes. Reads don't wait when nothing is pending.
- **Batching:** transactions from every object on a thread go up together, one gzipped segment per flush. A flush starts as soon as the previous one ends, so under load many writes share one PUT. On a local MinIO, throughput stayed at 1,200–1,600 writes/s whether one object or 32 were writing ([benchmarks](benchmarks.md)).
- **Power loss:** object databases run with `synchronous = FULL` in this mode, so a captured transaction is on disk. At start, a copy whose WAL no longer holds what the engine recorded is dropped and restored from the bucket.
- **Snapshots:** each object gets an exact copy of its database file every 2,000 transactions or 16 MB of log. A lost disk is rebuilt from the latest snapshot plus the transactions logged after it. Compaction then deletes segments whose transactions are all covered by snapshots.
- **If the bucket stays down** for 30 seconds, the waiting events fail instead of being acknowledged. Their writes are committed locally and ship once the bucket answers, so a failed write may still appear later, as on Cloudflare.

Limits:

- A write costs one bucket round trip, batched: a few ms to a local MinIO, typically 10–40 ms to S3 or R2 in the same region.
- Fetches and WebSocket messages an object sends while its writes are pending aren't held back. Cloudflare holds those too.
- Writes from timers or `waitUntil` outside an event ship within 200 ms, with no gate.
- A node in durable mode doesn't start until it can reach its bucket.
- It needs conditional writes (`If-None-Match`). AWS S3, Cloudflare R2 and SeaweedFS support them, and so does MinIO from RELEASE.2025-09-07 (MinIO no longer publishes free builds or images). Backblaze B2, Garage and DigitalOcean Spaces don't. At start, a node in durable mode checks that the store refuses a conditional write that doesn't hold, and won't run on one that accepts it. SeaweedFS's default volumes (8 of 64 MB) are too small for this workload; size them, for example `-master.volumeSizeLimitMB=256 -volume.max=50`.
- One node per prefix, unless the nodes are named ([several nodes](#several-nodes)).

### Several nodes

```sh
# on each node, with a unique, stable name and the same secret
export SOBJECTS_CLUSTER_SECRET=...   # 32+ characters, identical on every node
sobjects dev ./my-worker --engine native --backup-bucket s3://my-bucket/app --backup-mode durable \
  --node-name node-a --peer-listen 10.0.0.5:9790
```

With `--node-name`, nodes in durable mode share one bucket prefix and each object runs on one node at a time ([design](design/multi-node.md)):

- **Leases:** each node renews `nodes/<name>.json` every third of `--lease-seconds` (default 10). A node that can't renew in time stops acknowledging writes and exits, so another node can take its objects.
- **Owners:** a node claims an object the first time it serves it, by writing `owners/<class>/<id>.json` with a conditional PUT. The record names the node and an epoch, which grows with every change of owner.
- **Takeover:** when an object's owner released it (a clean shutdown) or its lease ran out, another node claims it. It records where the old owner's history ends (the cut), rebuilds the object from the bucket up to that point, and continues from there. Transactions and snapshots carry their epoch, so anything a stale owner uploads after the cut is ignored by every later restore.
- **Alarms:** owners mirror pending alarms to `alarms/<class>/<id>.json`. Every node checks for due alarms whose owner is gone, and claims those objects so the alarm runs.
- **Draining:** on SIGINT or SIGTERM a node drains before it exits. It stops taking connections and lets requests in progress finish, for up to `--drain-seconds` (default 30). Clients' WebSockets close with 1001 (going away), so they reconnect, through a load balancer, to another node. Objects finish their events and upload their writes. Then the node releases its objects. Calls other nodes forward to it meanwhile wait for the release and then go to whichever node claims the object, so a rolling deploy doesn't fail calls or wait out a lease. A call to the node after it stopped listening is routed again too. Two exceptions fail instead: a forwarded fetch with a request body, and anything still running at the deadline. A second signal stops the node at once.
- **Restarts:** a node restarted under the same name reclaims its objects at once. A second process started with a name that's in use waits until the first is gone.
- **Forwarding:** with `--peer-listen`, any node accepts any request. When the Worker calls an object another node runs, the stub forwards the call to that node's peer listener, whose address is advertised in its lease (`--peer-advertise` overrides it). RPC arguments, results and errors travel with V8 serialization, fetch bodies stream, and WebSockets are relayed node to node. A node routes to an owner it found for half a lease period. If the other node no longer runs the object, the call is routed once more; a call that may have reached a node is never sent twice.
- **Peer security:** peer requests are signed with `SOBJECTS_CLUSTER_SECRET`. The HMAC-SHA256 covers the kind of request, a timestamp (30-second window), a single-use nonce, the target object, the method, and the call's arguments or the fetch's URL and headers. Replies are signed over the request's nonce, so a node that doesn't hold the secret can't answer in another's place, even if it rewrote the address in the bucket. A node refuses an unsigned request before reading its body. Nothing is encrypted, and fetch bodies, fetch responses and relayed WebSocket messages aren't signed; someone who can watch the network could race a request they sniffed with a body of their own (the nonce then rejects the real one). Bind the peer listener to a private network (VPC, WireGuard, Tailscale), never the public internet, and never publish it through the ingress.

Not yet:

- **Needs `--peer-listen` to forward:** without it, a call for an object another live node runs fails, naming that node.
- **No TLS between nodes.**
- **No threads:** `--node-name` can't be combined with `--threads`.
- **No cross-node compaction:** compaction only deletes segments that every object they touch has snapshotted on this node. Segments of objects that moved away are kept.

## Running as a service

`sobjects up` runs the native engine when `sobjects.toml` has a `[native]` table instead of `[celld]`:

```toml
[native]
project = "./my-worker"          # the Wrangler project to run; relative to this file
listen = "127.0.0.1:8787"        # default
# data_dir = "/var/lib/serverless-objects/native"  # default: $SOBJECTS_DATA_DIR/native
# idle_evict_seconds = 60
# drain_seconds = 30             # how long shutdown waits for requests in progress
# threads = 2

[native.backup]
bucket = "s3://my-bucket/app"
mode = "durable"                 # default here; "interval" is the other choice
# endpoint = "https://<account>.r2.cloudflarestorage.com"
# region = "auto"

# [native.cluster]
# node_name = "node-a"
# lease_seconds = 10
# peer_listen = "10.0.0.5:9790"
# peer_advertise = "http://10.0.0.5:9790"
```

Each key matches a `sobjects dev --engine native` flag, and `up` runs the engine as that command in a child process. Bucket credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`) and `SOBJECTS_CLUSTER_SECRET` come from the environment, never the file; for a systemd unit, put them in `sobjects.env` beside the config. The rest works as with celld:

- `sobjects up --detach`, `sobjects status`, `sobjects logs` and `sobjects down` manage a background node. `down` waits up to a minute for the engine to upload what's left and release its objects.
- `sobjects service install` writes a systemd or launchd unit that restarts the node if it exits, including after it stops for losing its lease.
- `[ingress]` puts the TLS ingress in front of the engine and routes to `[native].listen` by default. With a loopback listener, the engine trusts the ingress's `X-Forwarded-Proto` and `X-Forwarded-Host`, so `request.url` has the scheme and host the client used.
- `[admin]` and the dashboard aren't available with `[native]` yet, and `sobjects deploy` is for celld: to run new code, restart the node.

Without `[native.backup]`, the node's objects exist only in `data_dir`.

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
