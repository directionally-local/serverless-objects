# Design: native engine across several nodes (M4)

Status: proposed, 20 Oct 2026. Nothing here is implemented yet.

## Goal

Several native-engine nodes share one S3-compatible bucket. Each Durable Object runs on exactly one node at a time. Any node accepts any request and forwards object calls to the owner. When a node dies, another takes over its objects within about one lease period, **without losing a write it acknowledged**.

Non-goals for M4: placing objects near users, objects moving to balance load (beyond takeover and drain), sharing celld's bucket layout, and running untrusted code.

## Why durability comes first

Today a node acknowledges a write once it is in the local SQLite file, and `--backup-bucket` copies it within the backup interval. That is fine for one machine. With failover, though, "the node died" becomes routine, and every death would lose up to an interval of acknowledged writes. Cloudflare and celld both hold a response until its writes are durable off the machine. The native engine has to do the same before failover is safe.

## 1. Durable writes: WAL shipping with an output gate

- Each object's SQLite file stays in WAL mode, with automatic checkpoints off. The engine owns checkpointing.
- After each event (RPC call, fetch, alarm, socket message), the engine reads the WAL frames the event committed. A prototype rebuilt a database byte-for-byte from a snapshot plus captured frames, across inserts, deletes, DDL and checkpoints, at about 1.1 pages per small write.
- A per-node **log shipper** collects frames from every object and uploads them as one **segment** object per flush. A flush starts when the previous one finishes, so batches grow under load.
- **Output gate:** an event's response, and any outgoing fetch or WebSocket message it made after writing, is held until the segment holding its frames is in the bucket. Reads and events that write nothing aren't held. This is Cloudflare's model.
- **Snapshots** (`VACUUM INTO`, as today) are taken per object after enough log, and older segments are then compacted away.

Bucket layout, all under `<prefix>/native/<script>/`:

| Key | Content |
|---|---|
| `nodes/<node>.json` | Node lease: `{node, addr, epoch, ttlMs, renewedAt}` |
| `owners/<class>/<id>.json` | Owner record: `{node, epoch}`, no expiry |
| `objects/<class>/<id>/e<epoch>/snapshot-<txid>.sqlite` | Snapshots |
| `log/<node>/<session>/<seq>.seg` | Segments: frames for many objects, each tagged `(class, id, epoch, txid)` |
| `log/<node>/<session>/index-<seq>.json` | Which objects each range of segments touches, so a takeover reads only what it needs |

The current single-node `--backup-bucket` layout stays as is. Multi-node is a new mode.

## 2. Ownership and fencing

Copied from celld in a simplified form:

- **Node lease:** one record per node, renewed every TTL/3 (TTL 10 s by default) with `If-Match`. It carries the node's peer address.
- **Owner record per object:** acquired with `If-None-Match: *` for a new object, or `If-Match` on the etag after the previous owner's lease has expired. **Every acquisition increments the epoch.** Activating an object costs one conditional write, and renewal is per node, not per object.
- **Expiry without comparing clocks:** a node treats another's lease as expired only after seeing the same etag unchanged for TTL plus a margin on its own monotonic clock. A holder stops serving at (when its last successful renewal was sent) + TTL − margin, using both monotonic and wall time, so a suspended VM fences itself. Then it exits and the supervisor restarts it.
- **Fencing:**
  1. Data keys include the epoch, so a stale owner can only write where restores no longer look.
  2. Before releasing the output gate, the shipper checks that its node lease is still live. A write isn't acknowledged by a node that may have lost its objects.
  3. A takeover reads the old owner's segments only up to the point its lease expired. Anything uploaded after that is fenced by epoch.
- **Takeover is lazy:** the next call or alarm for the object triggers it, as in celld. The new owner restores the latest snapshot for the object's epoch chain, applies that object's frames from the old node's segments, bumps the epoch and serves.
- **Startup probe:** a node refuses to start in multi-node mode unless the store passes a conditional-write probe (create, reject-create, replace, reject-stale). Backblaze B2, Garage, DigitalOcean Spaces and some Ceph and Hetzner setups don't support conditional writes reliably. AWS S3, R2, MinIO (recent), SeaweedFS (slow) and Tigris do. GCS needs generation preconditions and Azure needs its own API; both come later.

## 3. Forwarding calls to the owner

The ingress can't route by object, because object IDs exist only inside Worker code. So forwarding happens at the stub, reusing the `--threads` relay:

- `DurableObjectNamespace.host(id)` asks an **owner resolver** (local thread, other thread, or other node) instead of `shardOf`.
- A `RemoteNodeHost` speaks the same `call` / `fetch` interface as the cross-thread `RemoteHost`, over HTTP to the owner's **peer listener**. Arguments, results and errors use `v8.serialize`; bodies stream; WebSockets are relayed with the existing `RemoteEnd` / `relayEnd` protocol over an inter-node WebSocket.
- The peer listener is separate from the public ingress. Requests are HMAC-signed with a cluster secret, which lives in the environment like other credentials, with a short clock window. Its traffic should stay on a private network or be wrapped in TLS. The ingress strips any peer header. Client addresses travel inside the encoded request, so the owner never trusts headers from the network.
- A call is never replayed after it may have reached an old owner. A caller that loses the owner mid-call gets an error, as on Cloudflare.

## 4. Operations

- `sobjects up` gains a native-engine mode (`[native]` in `sobjects.toml`: bucket, peer listen and advertise addresses, threads), with the cluster secret and bucket credentials in the environment.
- **Drain:** on SIGTERM a node stops taking new objects, flushes its log, releases its owner records (epoch kept), stops renewing its lease and exits, so peers take over at once instead of after a TTL. Rolling deploys are a drain per node.
- **Point-in-time restore:** keep snapshots and segments for a retention window, and restore an object or a whole namespace to a time by replaying segments up to it.
- The dashboard and admin API show nodes, leases and which node owns which objects.

## Build order

1. **Durable writes on one node:** WAL capture, shipper, output gate, snapshot plus log restore. Even with one node, losing the disk then loses nothing acknowledged. This replaces interval backups as the default with a bucket.
2. **Leases, owner records and takeover**, with a two-process test harness and fault injection (kill, partition, pause).
3. **Forwarding between nodes:** RPC, fetch, WebSockets; peer auth.
4. **Drain and rolling deploys; `sobjects up` integration.**
5. **Point-in-time restore**, and dashboard and admin views.
6. **Multi-node soak:** the soak harness with three nodes and node-level faults.

## Costs and open questions

- Each write waits for one bucket PUT, batched across the node: about 10–40 ms on R2 or S3 in-region. The bench will show whether batching keeps throughput flat as the object count grows, where celld's single-node mode didn't (denoland/celld#286).
- PUT request pricing: one segment per flush, and at most one or two segments in flight per node.
- Large objects: snapshot size and restore time. A paged restore like celld's may be needed later.
- In-memory-only state (non-storage globals) is lost on takeover, as on Cloudflare.
