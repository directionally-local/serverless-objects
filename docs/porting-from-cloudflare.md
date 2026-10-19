# Porting a Cloudflare Workers project

Serverless Objects runs applications through celld; it does not implement the Workers runtime. Treat Cloudflare's API as the compatibility contract, but verify each project's bindings and APIs against the [recorded compatibility results](compatibility.md).

## 1. Use a supported Wrangler config

The current CLI preflight reads `wrangler.json` or `wrangler.jsonc`. celld's deploy path does not read `wrangler.toml`. Keep the config in the project root and declare the bindings and Durable Object migrations the Worker actually uses.

The CLI validates top-level keys instead of passing unknown settings through. Current behavior:

- `observability` and `upload_source_maps` are removed with a warning; celld does not implement these Wrangler features.
- `build.command` is run before celld starts. Other `build` options are rejected.
- `assets.directory` must be explicit, except that a project using `@cloudflare/vite-plugin` may use the limited generated-output discovery path. Discovery requires exactly one candidate containing `index.html`.
- Unknown or unsupported keys fail preflight. Remove or translate them deliberately; do not assume a Wrangler setting has a celld equivalent.

`wrangler.jsonc` example:

```jsonc
{
  "name": "my-worker",
  "main": "src/index.js",
  "compatibility_date": "2026-02-24",
  "durable_objects": {
    "bindings": [{ "name": "COUNTER", "class_name": "Counter" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Counter"] }]
}
```

SQLite-backed Durable Object classes require `new_sqlite_classes`. celld 0.6 supports only the `tag` and `new_sqlite_classes` migration fields; class rename, deletion, and transfer migrations are rejected. Set a compatibility date appropriate for the APIs your app uses. In particular, `deleteAll()` clearing a pending alarm was tested with `2026-02-24` or later.

## 2. Configure bindings and storage

Use celld-supported bindings and provide provider credentials through the documented environment or credential chain. The upstream celld compatibility list includes Durable Objects, KV, D1, R2, Queues, and Workflows, but this repository's conformance run does not cover every binding. Workers AI, Vectorize, Hyperdrive, Browser Rendering, and Email Workers are not provided by celld 0.6.2.

For state that must survive a node restart, configure the S3-compatible object-store bucket in `sobjects.toml`; this is separate from project bindings. Do not place credentials in either Wrangler or `sobjects.toml` files.

## 3. Run and test

```sh
npm exec --workspace=serverless-objects -- sobjects dev ./my-worker
npm exec --workspace=serverless-objects -- sobjects deploy ./my-worker
```

`dev` delegates to celld's local development server and does not start the Serverless Objects ingress. `deploy` uses the configured celld bucket/endpoint or explicit flags. For externally reachable traffic, run the service with ingress and TLS; keep celld and the unauthenticated admin/operator APIs on loopback.

Use Wrangler's local runtime as a reference and run the same app against celld. The [conformance v0 report](conformance/results.md) records one local run on each target. Passing this suite is useful evidence, not a claim of complete Workers parity.

## 4. Review application assumptions

Before switching traffic, check for:

- APIs or bindings that celld does not implement, or features not exercised by the current suite.
- Cloudflare-only configuration fields, deployment hooks, observability and source-map upload behavior.
- Assumptions about production networking, service bindings, outbound connections, Cache, or global coordination.
- Durable Object migration operations beyond adding SQLite classes.
- WebSocket hibernation, facets, cross-isolate RPC, or behavior across a cell move. These need separate verification; the current conformance run covers only basic WebSocket behavior.
- Whether the app has been run through the actual `sobjects` CLI. A minimal Agents SDK app (state, SQL, schedules, WebSocket protocol) has run through `sobjects deploy` and `sobjects up`; the official samples, callable RPC, chat agents, MCP and Workflows have not.

Do not infer production Cloudflare behavior from local Wrangler results, or infer full celld compatibility from one passing sample. Record any mismatch as a conformance case and keep unsupported behavior visible.
