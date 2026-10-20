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

So the native engine is the right choice when the app is trusted and a few seconds of writes on one machine are an acceptable loss; choose Cloudflare (or celld, once its write durability is confirmed) when every acknowledged write must survive the machine.

## Results, 20 Oct 2026

Client: Apple M1 Pro, Node.js 24.12. Local targets on loopback: serverless-objects 0.5.0 native engine, celld 0.6.2 (`celld dev`), Wrangler 4.150.0. Cloudflare: the same app deployed to a workers.dev subdomain on the free plan, served from Frankfurt (`colo=FRA`), about 130–200 ms of internet away from the client. One run each; treat differences under ~20% as noise.

### Inside the Worker (no client network)

The Worker makes 500 sequential calls to one object (100 for SQL) and reports the mean. On Cloudflare this includes the hop from the Worker to wherever the object lives and, for writes, the wait for durable storage.

| Mean per call, ms | Cloudflare | native | celld | Wrangler |
|---|---:|---:|---:|---:|
| DO read (RPC + KV get) | 10.89 | 0.03 | 0.07 | 0.39 |
| DO write (RPC + KV put) | 19.32 | 0.05 | 9.29 | 0.68 |
| 100-row SQL transaction | 39.08 | 0.35 | 9.90 | 4.86 |

### From the client

| p50 / p99 ms | Cloudflare | native | celld | Wrangler |
|---|---:|---:|---:|---:|
| noop (Worker only) | 202 / 571 | 0.28 / 1.11 | 0.32 / 3.39 | 1.32 / 2.72 |
| DO read | 222 / 482 | 0.25 / 0.91 | 0.41 / 1.11 | 1.60 / 7.27 |
| DO write | 301 / 744 | 0.22 / 1.09 | 8.70 / 24.39 | 1.68 / 3.56 |
| 100-row SQL transaction | 253 / 740 | 0.51 / 1.20 | 9.48 / 21.30 | 4.69 / 21.94 |
| WebSocket echo (hibernatable) | 151 / 373 | 0.08 / 0.17 | 0.13 / 0.19 | 0.30 / 0.89 |

| Writes, 32 in flight, req/s (p99 ms) | Cloudflare | native | celld | Wrangler |
|---|---:|---:|---:|---:|
| 1 object | 136 (871)\* | 4,507 (44.0) | 1,705 (39.5) | 1,437 (48.4) |
| 32 objects | 153 (623)\* | 9,721 (9.9) | 178 (2,780) | 1,207 (92.4) |

\* Limited by the client: 32 requests in flight over a ~200 ms round trip caps out near 160 req/s. These rows say nothing about Cloudflare's capacity; run the client next to the Worker to measure that.

### Findings

- A Cloudflare Durable Object call costs about 11 ms to read and 19 ms to write from the Worker that calls it, in this setup. That is the network hop to the object plus, for writes, confirmation from replicated storage. On one machine, the native engine and celld have no hop at all, which is where most of their advantage comes from. It is the trade-off of running on one node, not a faster implementation of the same guarantees.
- celld's writes (~9 ms) wait for something: its reads are as fast as native's. Its write cost is in the same range as Cloudflare's, so it may be giving similar durability; that needs confirming in celld's source before anyone relies on it.
- With 32 objects writing at once, `celld dev` collapsed to 178 req/s with multi-second tails. This needs investigating on `celld serve` with a real bucket before drawing conclusions about production nodes.
- The native engine is the fastest target by one to two orders of magnitude, and its writes are the least durable: local WAL commits, then the bucket within the backup interval.
