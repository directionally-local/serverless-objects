# Serverless Objects

Run the Cloudflare Workers and Durable Objects programming model on your own hardware, built for agents.

Part of the [Directionally Local](https://directionallylocal.com) family of self-hostable infrastructure for coding agents, alongside [Autopilot](https://github.com/sinameraji/autopilot), [Hotcell](https://github.com/sinameraji/hotcell) and [Camouflage](https://github.com/sinameraji/camouflage).

> **Status: pre-alpha; v0.1 CLI test candidate.** M0 passed its runtime gate with documented config caveats. The CLI installs pinned celld and provides `up`/`down`/`status`/`logs` plus `dev`/`deploy`, a TLS ingress with static certificates, systemd/launchd unit generation, checksum-pinned engine upgrades with rollback, and a loopback dashboard and admin API with Prometheus metrics; ACME, dashboard, hosted-bucket validation, and npm publication are not ready. Vite static-asset build/discovery is implemented and tested with the Cloudflare Vite plugin, but the full Agents SDK example has not yet been run through this CLI.

## What it is

Serverless Objects is the operating layer around a Workers-compatible engine. It turns an engine that runs wrangler bundles into something you can actually run for a team:

- **One-line install and upgrades.** `npm i -g serverless-objects`, then `sobjects up`. The supervisor downloads a pinned engine, writes its config, and manages the service.
- **Ingress.** TLS, hostnames, WebSocket upgrade, access logs.
- **Dashboard and admin API.** List objects per namespace, inspect their storage with a KV and SQL console, see pending alarms and open sockets, browse backups, restore to a point in time.
- **Bindings for agents.** A `Sandbox` binding with the Cloudflare Sandbox SDK call shape, backed by Hotcell. Agents never hold real API keys and every tool call runs in a Docker container, a Firecracker microVM, or an Apple Virtualization microVM with a spend cap.
- **Autopilot as objects.** Each Autopilot run is a durable object with its own SQLite state, a scheduled wakeup, and a resumable event stream rendered by Camouflage.
- **A conformance suite.** One suite, run against Cloudflare, against each supported engine, and published with every release. If something does not work, it shows up red in the table, not in a footnote.

## Engines

Serverless Objects does not implement the Workers runtime itself. It drives an engine through a small, versioned contract (the wrangler bundle, the wrangler config, and a runtime protocol for health, deploy, inspect, alarms and metrics).

| Engine | Status | Notes |
|---|---|---|
| [celld](https://github.com/denoland/celld) | first supported engine | Apache-2.0 runtime from Deno that runs unmodified wrangler bundles with Durable Objects, KV, D1, R2, Queues and Workflows. Exact Workers API surface. |
| native | planned | A Node-native engine exposing the Durable Objects API with full Node APIs inside objects, no isolate, no memory cap. Code that uses Node APIs is marked non-portable by `sobjects build --strict`. |

Both engines share the same per-object SQLite and bucket layout, so the dashboard, backups and migration tooling work with either.

## Early v0.1 CLI

The npm package is not published yet. This is a CLI test candidate, not a production release. Unit and smoke tests cover the counter, Agents scheduler/SQL, and PartyServer WebSocket/SQL, including state persistence across a celld restart. Vite static-asset build/discovery is tested against `@cloudflare/vite-plugin` 1.62.3 with a minimal fixture; the full Agents SDK sample has not yet been run through this CLI. Bucket-backed `sobjects deploy` and `sobjects up --detach` with the TLS ingress have been verified against a local S3-compatible store (SeaweedFS): HTTPS `request.url`, Durable Object state across restarts and from an empty local cache, WebSocket echo, and clean `down`. R2 and other hosted buckets have not been tested yet, The loopback dashboard shows node load and objects, browses an object's key-value entries, and runs read-only SQL against it; the backup browser is not implemented yet. From a checkout, with Node.js 22 or newer:

```sh
npm install
cp sobjects.example.toml sobjects.toml
# Edit celld.bucket in sobjects.toml, then:
npm exec --workspace=serverless-objects -- sobjects up
```

`up` verifies the config, installs pinned celld `v0.6.2` on first use, and runs a single-node celld process in the foreground. Add `--detach` to store a PID record and log under the user state directory; `sobjects status`, `sobjects logs`, and `sobjects down` manage that detached process. Storage credentials come from celld's standard credential chain or environment; keep them out of `sobjects.toml`. The default listener is loopback-only at `127.0.0.1:8080`; do not expose it publicly.

### Ingress

Add an `[ingress]` table to `sobjects.toml` (see [`sobjects.example.toml`](sobjects.example.toml)) and `sobjects up` starts a TLS-terminating proxy in front of celld, in the foreground or with `--detach`. `sobjects ingress` runs it on its own. It:

- terminates TLS with static PEM certificates, with an optional certificate per route chosen by SNI; `SIGHUP` reloads them from disk;
- routes by exact, `*.wildcard`, or `*` hostname and answers `421` for anything else;
- tunnels WebSocket upgrades;
- replaces client-supplied `X-Forwarded-*` and `CF-Connecting-IP` headers with the real peer address;
- optionally redirects plain HTTP to HTTPS with `308`;
- serves `/.well-known/sobjects/health`, which checks the upstream;
- writes JSON access logs without query strings to `access.log` in the state directory, a configured path, or stdout (`"-"`).

Without `[ingress.tls]`, the ingress may only listen on loopback. ACME certificate issuance is not implemented yet. When celld listens on loopback, `up` starts it with `--trust-forwarded-headers`, so `request.url` carries the client's `https://` scheme and host as on Cloudflare. `sobjects dev` does not run the ingress, and `celld dev` keeps its own `http://` URL.

`sobjects dev [project]` runs local development. `sobjects deploy [project]` forwards flags to `celld deploy`; bucket, endpoint, and region can come from explicit flags, environment variables, or the project's `sobjects.toml`. The CLI rejects unknown top-level Wrangler keys, warns while removing celld-incompatible `observability`/`upload_source_maps`, and runs a declared `build.command`. If `assets.directory` is missing and the project declares `@cloudflare/vite-plugin` plus a Vite config, it runs `vite build` and requires a unique generated `index.html` under `.cloudflare/output/v0/workers/*/assets` or `dist` (including one-level subdirectories); otherwise set `assets.directory` explicitly. Ambiguous outputs fail before celld starts. `sobjects service install` generates a systemd or launchd unit that runs `up` under the OS service manager. ACME and the dashboard are not implemented yet.

## Why

Agents need durable state, scheduled wakeups, long-lived connections and sandboxes. The Durable Objects model is a good fit and the Cloudflare Agents SDK is built on it. Some teams cannot run that on Cloudflare's network: regulated industries, air-gapped environments, customer VPCs, or simply cost at scale.

The rule for everything in this family is that **Cloudflare's APIs are the contract and our implementations are the product**. A Workers app that runs here runs on Cloudflare, and the reverse. You can replace one piece at a time in either direction.

## Roadmap

Order is firm. Dates are targets, not promises.

| Milestone | Target | Scope |
|---|---|---|
| **M0 · Compatibility spike** | Oct 2026 | Run Cloudflare Agents SDK and PartyServer samples unmodified on celld. Verify a Hotcell sandbox can be created from an object and reattached after eviction. Publish the findings as the first conformance results. |
| **v0.1 · Operating layer** | 31 Oct 2026 | `sobjects` CLI and supervisor, ingress with TLS, dashboard with storage inspector and backup browser, conformance suite v0 with Cloudflare and celld runners, porting guide. Single host. |
| **v0.2 · Agent layer** | 7 Nov 2026 | Hotcell `Sandbox` binding with per-object egress tokens. Autopilot runs as objects with a registry, alarms and event streams. Showcase: start a run, kill the node, restart, watch it resume from its event log in Camouflage. |
| **v0.3 · Native engine, single node** | 21 Nov 2026 | Node-native engine with the Durable Objects API: IDs, stubs with fetch and RPC, serialized execution with input and output gates, SQLite storage with KV and SQL, durable alarms, WebSockets with the hibernation API. `sobjects build --strict`. Conformance parity target with celld on the Durable Objects suite. Two-week soak under fault injection runs alongside v0.4; the beta label follows the soak. |
| **v0.4 · Multi-node and Teams** | 30 Nov 2026 | Placement and object migration through the bucket, ingress routing by owner, true WebSocket hibernation, rolling deploys, point-in-time recovery. Multiple apps and tenants per cluster, SSO, audit logs, air-gapped install, Helm. |

### Not planned

A V8-embedded runtime of our own. Workers AI, Vectorize or Hyperdrive replacements. Python objects.

## Conformance

Results will be published here per release, as a table of suite areas by target: Cloudflare, celld, native. Areas: IDs, KV storage, SQL storage, transactions, gates, alarms, WebSockets and hibernation, RPC, facets, compat flags, Agents SDK samples, PartyServer samples, Sandbox binding.

The [M0 celld spike results](docs/conformance/m0-celld.md) passed the runtime gate; direct Wrangler config support and idle-eviction coverage remain open.

## How it fits with the rest of the family

| Piece | Role | Cloudflare equivalent |
|---|---|---|
| Serverless Objects | Workers and Durable Objects, self-hosted | Workers, Durable Objects |
| Hotcell | Sandboxes with key-swapping gateway and spend caps | Sandbox SDK, Containers |
| Autopilot | Coding agent and headless SDK | Agents SDK |
| Camouflage | Event-native terminal renderer with replayable event log | none |
| Local coding model | Served through an OpenAI-compatible endpoint | Workers AI |

## Contributing

Issues and discussion are welcome now. Pull requests make sense once v0.1 lands. Contributions are accepted under the Apache-2.0 license with a Developer Certificate of Origin sign-off (`git commit -s`). There is no CLA.

## License

Apache-2.0. See [LICENSE](LICENSE).
