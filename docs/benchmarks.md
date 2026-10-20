# Benchmarks

`packages/conformance/bench-app` is one Worker with one Durable Object class. The same code runs on Cloudflare, Wrangler, celld and the native engine. `src/bench.js` starts a local target, or takes the URL of a deployment, and measures each operation from the client:

```sh
npm run bench --workspace=sobjects-conformance -- --target native     # or celld, wrangler
npm run bench --workspace=sobjects-conformance -- --url https://sobjects-bench.<you>.workers.dev
```

To benchmark Cloudflare itself, deploy the app with `npx wrangler deploy --config packages/conformance/bench-app/wrangler.json` and pass its URL. Remote numbers include the network round trip; the `noop` row (Worker only, no object) is the baseline to subtract.

| Row | What it measures |
|---|---|
| noop | One request to the Worker, no Durable Object |
| DO read / write | Worker → object RPC with one synchronous KV get / put |
| 100-row SQL transaction | 100 inserts in `transactionSync`, then a count |
| WebSocket echo | Round trip on a hibernatable socket accepted with `acceptWebSocket` |
| writes, 1 object | Throughput with 32 requests in flight to a single object (all serialized by its input gate) |
| writes, 32 objects | Throughput with 32 requests in flight spread over 32 objects |

## Read this before comparing numbers

Writes are **not equally durable** across targets, and that dominates the write rows:

- **Cloudflare** holds a response until its writes are confirmed by storage replicated across machines (the output gate). A write that returned is durable.
- **celld** writes take about 8 ms longer than its reads, which is consistent with it waiting for a commit before responding (not yet confirmed in celld's source).
- **The native engine** commits to a local SQLite file in WAL mode with `synchronous = NORMAL`. A committed write survives the process crashing, but not the machine losing power or the disk, and there is no output gate. With `--backup-bucket`, it reaches the bucket within the backup interval. Its write numbers are local-SQLite numbers, not replicated-storage numbers.
- **Wrangler** (`wrangler dev --local`) runs workerd with local SQLite. It is a development server, not a production runtime.

So the native engine is the right choice when the app is trusted and a few seconds of writes on one machine are an acceptable loss; Cloudflare and celld are the choice when every acknowledged write must survive the machine.

## Results, 20 Oct 2026

Apple M1 Pro, Node.js 24.12, all targets on loopback, `--requests 300 --duration 3000`, serverless-objects 0.5.0, celld 0.6.2 (`celld dev`), Wrangler 4.150.0. One run each; treat differences under ~20% as noise.

| Operation | native p50 / p99 ms | celld p50 / p99 ms | Wrangler p50 / p99 ms |
|---|---:|---:|---:|
| noop (Worker only) | 0.34 / 1.09 | 0.26 / 0.68 | 1.20 / 2.57 |
| DO read (RPC + KV get) | 0.28 / 0.75 | 0.29 / 1.08 | 1.35 / 2.84 |
| DO write (RPC + KV put) | 0.28 / 1.13 | 8.00 / 14.35 | 1.48 / 3.54 |
| DO 100-row SQL transaction | 0.65 / 1.76 | 8.22 / 16.98 | 4.25 / 7.00 |
| WebSocket echo (hibernatable) | 0.13 / 0.88 | 0.14 / 0.22 | 0.23 / 0.62 |

| Throughput, 32 in flight | native req/s (p99 ms) | celld req/s (p99 ms) | Wrangler req/s (p99 ms) |
|---|---:|---:|---:|
| writes, 1 object | 9,187 (7.6) | 1,883 (31.2) | 1,561 (45.9) |
| writes, 32 objects | 11,743 (8.4) | 180 (2,611.6) | 1,406 (65.7) |

Findings:

- Reads and WebSocket round trips are sub-millisecond on both native and celld; the per-request engine overhead is not where the differences are.
- celld's write latency is ~8 ms against ~0.3 ms reads. With 32 objects writing at once its throughput collapsed to 180 req/s with multi-second tails in `celld dev`; this needs investigating on `celld serve` with a real bucket before drawing conclusions about production nodes.
- Cloudflare results are not recorded yet: they need a deployment to a Cloudflare account.
