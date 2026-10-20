# Serverless Objects

[![npm](https://img.shields.io/npm/v/serverless-objects)](https://www.npmjs.com/package/serverless-objects)
[![CI](https://github.com/sinameraji/serverless-objects/actions/workflows/ci.yml/badge.svg)](https://github.com/sinameraji/serverless-objects/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Run Cloudflare Workers and Durable Objects apps on your own hardware, built for agents.

Serverless Objects is the operating layer around a Workers-compatible engine. You deploy an ordinary Wrangler project, and `sobjects` runs it on a host you control with TLS ingress, a local dashboard, engine upgrades and service units. Durable Object state lives in your own S3-compatible bucket. Today the engine is [celld](https://github.com/denoland/celld), Deno's Apache-2.0 runtime for Wrangler bundles.

> **Status: pre-alpha (0.1.x).** Good for evaluation and testing, not for production. It runs on a single host on macOS arm64 or Linux arm64/x64. Read [what is and isn't supported](docs/compatibility.md) before you port an app.

Part of the [Directionally Local](https://directionallylocal.com) family of self-hostable infrastructure for coding agents, alongside [Autopilot](https://github.com/sinameraji/autopilot), [Hotcell](https://github.com/sinameraji/hotcell) and [Camouflage](https://github.com/sinameraji/camouflage).

## Quick start

Requires Node.js 22 or newer.

```sh
npm install --global serverless-objects
```

A Durable Object counter, written exactly as it would be for Cloudflare:

```jsonc
// wrangler.jsonc
{
  "name": "hello",
  "main": "src/index.js",
  "compatibility_date": "2026-02-24",
  "durable_objects": { "bindings": [{ "name": "COUNTER", "class_name": "Counter" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Counter"] }]
}
```

```js
// src/index.js
import { DurableObject } from "cloudflare:workers";

export class Counter extends DurableObject {
  async increment() {
    const count = ((await this.ctx.storage.get("count")) ?? 0) + 1;
    await this.ctx.storage.put("count", count);
    return count;
  }
}

export default {
  async fetch(request, env) {
    const name = new URL(request.url).pathname.slice(1) || "default";
    const count = await env.COUNTER.getByName(name).increment();
    return new Response(`${name}: ${count}\n`);
  },
};
```

Run it locally. No bucket is needed, and the first run downloads and verifies the pinned celld release:

```sh
sobjects dev . --port 8787
curl http://127.0.0.1:8787/alice   # alice: 1
```

To run it as a node, add a `sobjects.toml` next to the project that points at a bucket you control. The bucket must support conditional writes; Cloudflare R2 and SeaweedFS have been tested.

```toml
[celld]
bucket = "s3://my-bucket/serverless-objects"
# endpoint = "https://<account>.r2.cloudflarestorage.com"   # for S3-compatible stores
# region = "auto"
```

Keep credentials out of the file. celld reads the standard environment and credential chain (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, ...).

```sh
sobjects deploy .            # bundle the app and upload it to the bucket
sobjects up --detach         # start the node on 127.0.0.1:8080
curl http://127.0.0.1:8080/alice
sobjects status
sobjects down
```

State survives `down` and `up` because it lives in the bucket. The [install guide](docs/install.md) adds TLS ingress, the dashboard and an OS service.

## What you get

- **The `sobjects` CLI.** `dev`, `deploy`, `up`/`down`/`status`/`logs`, `upgrade` with checksum-pinned engine versions and rollback, and `service` to generate systemd or launchd units. The [CLI reference](packages/cli/README.md) covers every command and setting.
- **Wrangler config preflight.** Unknown keys are rejected with a readable error, keys celld can't use are removed with a warning, and `build.command` and Vite asset builds run before deploy.
- **TLS ingress.** Static certificates or ACME HTTP-01, hostname routing, WebSocket tunnelling, HTTP→HTTPS redirect, a health endpoint and JSON access logs. Client `X-Forwarded-*` and `CF-Connecting-IP` headers are replaced with the real peer address.
- **A loopback dashboard and admin API.** Node load, the objects in each namespace, a key-value browser and read-only SQL console per object, eviction, logical JSON export, and Prometheus `/metrics`.
- **A Hotcell `Sandbox` binding** ([`@serverless-objects/hotcell`](packages/hotcell), not yet on npm). It has the Cloudflare Sandbox SDK 0.x call shape and reattaches to its sandbox after the object is evicted. With egress enabled, sandboxes get gateway tokens, never real provider keys.
- **Autopilot runs as objects** ([`@serverless-objects/autopilot`](packages/autopilot), not yet on npm). One Durable Object per run holds its state machine, budgets, hash-only tool records, durable wake timers and a Camouflage session log that streams from a cursor. A registry per workspace lists and reconciles runs. `AutopilotCellRun` executes the task with Autopilot in a Hotcell cell. Stop the node mid-run, and after restart the object resumes from its saved cursor while the cell keeps working.
- **A conformance suite** ([`packages/conformance`](packages/conformance)) that runs the same apps under `wrangler dev` and celld, so engine differences show up as failing checks.

## Compatibility

Cloudflare's APIs are the contract. The current [conformance results](docs/conformance/results.md) are 16/16 on both Wrangler 4.150.0 and celld 0.6.2. They cover Durable Object IDs, KV and SQL storage, transactions, input gates, RPC, alarms (including across a restart), WebSockets, and an Agents SDK suite: state, SQL, schedules, addressing and `@callable()` RPC.

Not covered yet: WebSocket hibernation, facets, PartyServer, Agents SDK chat, MCP and Workflows, and Cloudflare-hosted production behavior. Point-in-time restore isn't available on celld 0.6. The [compatibility table](docs/compatibility.md) has the details, including Containers and `@cloudflare/sandbox` 1.0 on celld. The [porting guide](docs/porting-from-cloudflare.md) covers moving an existing project.

## Repository layout

| Path | What |
|---|---|
| [`packages/cli`](packages/cli) | The `serverless-objects` npm package (`sobjects` binary). Its README is the CLI reference. |
| [`packages/hotcell`](packages/hotcell) | `@serverless-objects/hotcell`, the Sandbox binding backed by Hotcell. |
| [`packages/autopilot`](packages/autopilot) | `@serverless-objects/autopilot`, Autopilot run objects and the per-workspace registry. |
| [`examples/autopilot-runs`](examples/autopilot-runs) | An HTTP demo of run objects: wake after restart, event streams, reconcile. |
| [`packages/conformance`](packages/conformance) | Conformance apps and the Wrangler and celld runners. |
| [`docs/`](docs) | Install, porting and compatibility guides, and recorded conformance results. |

## Engines

Serverless Objects doesn't implement the Workers runtime itself. It drives an engine through a small contract: the Wrangler bundle, the Wrangler config, and a runtime protocol for health, deploy, inspection, alarms and metrics.

| Engine | Status | Notes |
|---|---|---|
| [celld](https://github.com/denoland/celld) | Supported (0.6.2, pinned) | Runs Wrangler bundles with Durable Objects, KV, D1, R2, Queues, Workflows and Containers. |
| native | Planned | A Node-native engine with the Durable Objects API and full Node APIs inside objects. `sobjects build --strict` will flag code that isn't portable back to Cloudflare. |

## Why

Agents need durable state, scheduled wakeups, long-lived connections and sandboxes. The Durable Objects model fits that well, and the Cloudflare Agents SDK is built on it. Some teams can't run on Cloudflare's network: regulated industries, air-gapped environments, customer VPCs, or anyone for whom cost at scale matters.

The rule across this family is that **Cloudflare's APIs are the contract and our implementations are the product**. A Workers app that runs here runs on Cloudflare, and the reverse, so you can replace one piece at a time in either direction.

## Roadmap

Dates are targets, not promises.

| Milestone | Target | Scope |
|---|---|---|
| **M0 · Compatibility spike** | Done, Oct 2026 | Agents SDK and PartyServer samples on celld; Hotcell sandbox reattachment from an object. [Findings](docs/conformance/m0-celld.md). |
| **v0.1 · Operating layer** | Released 19 Oct 2026 | `sobjects` CLI and supervisor, TLS ingress with ACME, dashboard and storage inspector, conformance suite with Wrangler and celld runners, install and porting guides. Single host. |
| **v0.2 · Agent layer** | 7 Nov 2026 | Hotcell `Sandbox` binding, and Autopilot run objects with a registry, alarms, event streams and a Hotcell cell executor (first versions merged). The showcase now runs end to end: start a run, kill the node mid-tool, restart, and watch it resume from its event log. Showcase: start a run, kill the node, restart, and watch it resume from its event log in Camouflage. |
| **v0.3 · Native engine, single node** | 21 Nov 2026 | Node-native engine with the Durable Objects API, SQLite storage, durable alarms and WebSocket hibernation. `sobjects build --strict`. Conformance parity with celld on the Durable Objects suite, then a two-week fault-injection soak before beta. |
| **v0.4 · Multi-node and Teams** | 30 Nov 2026 | Placement and migration through the bucket, owner-aware ingress, rolling deploys, point-in-time recovery. Multiple apps and tenants, SSO, audit logs, air-gapped install, Helm. |

Not planned: a V8 runtime of our own; replacements for Workers AI, Vectorize or Hyperdrive; Python objects.

## How it fits with the rest of the family

| Piece | Role | Cloudflare equivalent |
|---|---|---|
| Serverless Objects | Workers and Durable Objects, self-hosted | Workers, Durable Objects |
| Hotcell | Sandboxes with a key-swapping gateway and spend caps | Sandbox SDK, Containers |
| Autopilot | Coding agent and headless SDK | Agents SDK |
| Camouflage | Event-native terminal renderer with a replayable event log | none |
| Local coding model | Served through an OpenAI-compatible endpoint | Workers AI |

## Contributing

Issues and pull requests are welcome. Run `npm ci && npm test` before opening a PR, and use [Conventional Commits](https://www.conventionalcommits.org/) (`feat(cli): ...`, `fix(cli): ...`, `docs: ...`). Release notes and versions are generated from them. Contributions are accepted under Apache-2.0 with a Developer Certificate of Origin sign-off (`git commit -s`). There is no CLA. [AGENTS.md](AGENTS.md) describes the layout and conventions for coding agents and humans alike.

## License

Apache-2.0. See [LICENSE](LICENSE).
