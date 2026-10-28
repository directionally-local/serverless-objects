# serverless-objects

[![npm](https://img.shields.io/npm/v/serverless-objects)](https://www.npmjs.com/package/serverless-objects)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/directionally-local/serverless-objects/blob/main/LICENSE)

`sobjects` runs Cloudflare Workers and Durable Objects apps on your own hardware. Deploy an ordinary Wrangler project and it runs on a host you control, with Durable Object state in your own S3-compatible bucket, plus TLS ingress, a local dashboard, engine upgrades and service units. The runtime underneath is [celld](https://github.com/denoland/celld) 0.6.2, which the CLI downloads and verifies by checksum.

> **Status: pre-alpha (0.1.x).** For evaluation and testing, not production. Single host; macOS arm64 or Linux arm64/x64; Node.js 22 or newer. See the [compatibility table](https://github.com/directionally-local/serverless-objects/blob/main/docs/compatibility.md).

Project home, roadmap and conformance results: [github.com/directionally-local/serverless-objects](https://github.com/directionally-local/serverless-objects).

## Install

```sh
npm install --global serverless-objects
sobjects --help
```

## Quick start

In a Wrangler project (`wrangler.json` or `wrangler.jsonc`):

```sh
sobjects dev . --port 8787     # local development, no bucket needed
```

To run it as a node, create `sobjects.toml` next to the project:

```toml
[celld]
bucket = "s3://my-bucket/serverless-objects"
```

Then, with bucket credentials in the environment (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, ...):

```sh
sobjects deploy .
sobjects up --detach           # serves on 127.0.0.1:8080
sobjects status
sobjects logs
sobjects down
```

The [project README](https://github.com/directionally-local/serverless-objects#quick-start) walks through a complete Durable Object example.

## Modules for Worker code

The package also ships two Durable Object modules, imported from your Worker:

- [`serverless-objects/hotcell`](https://github.com/directionally-local/serverless-objects/blob/main/docs/hotcell-binding.md): a `Sandbox` Durable Object and `getSandbox()` with the Cloudflare Sandbox SDK 0.x call shape, backed by a Hotcell daemon.
- [`serverless-objects/autopilot`](https://github.com/directionally-local/serverless-objects/blob/main/docs/autopilot.md): Autopilot runs as Durable Objects (`RunObject`, `RunRegistry`). `serverless-objects/autopilot/cell` runs a task with Autopilot in a Hotcell cell (`AutopilotCellRun`), and `serverless-objects/autopilot/native` runs it in-process on the native engine (`AutopilotNativeRun`).

```sh
npm install serverless-objects
```

## Commands

| Command | What it does |
|---|---|
| `sobjects dev [project] [celld dev options]` | Local development with celld. It doesn't run the ingress. With `--engine native`, it runs the app in Node instead ([native engine](https://github.com/directionally-local/serverless-objects/blob/main/docs/native-engine.md)). |
| `sobjects deploy [project] [celld deploy options]` | Preflights the Wrangler config, bundles the app and uploads it to the bucket. Running nodes pick up the new version on their next poll. |
| `sobjects up [--config PATH] [--detach]` | Starts celld plus the configured ingress and admin API from `./sobjects.toml`, in the foreground or in the background. |
| `sobjects status` / `logs [--supervisor] [--tail N]` / `down` | Inspect or stop a node started with `--detach`. `down` waits for celld to drain and release its lease. |
| `sobjects supervise [--config PATH]` | Runs only the ingress and admin API in the foreground. |
| `sobjects dashboard [--config PATH]` | Prints the admin dashboard URL, which carries the admin token. |
| `sobjects build [project] [--strict]` | Bundles the app and checks every Node.js built-in it imports against Cloudflare's `nodejs_compat` support. Reports the app as portable or native-only; `--strict` exits 1 for native-only. |
| `sobjects upgrade [--engine-version V \| --rollback \| --status]` | Installs and selects a pinned celld release. |
| `sobjects service print\|install [opts]` | Generates a systemd or launchd unit for `up`. |
| `sobjects --help`, `--version` | Help and version. Every command takes `--help`; for `dev` and `deploy` it shows celld's own options. |

## Configuration: `sobjects.toml`

Unknown keys are rejected, so a typo fails loudly instead of being ignored. A full annotated example lives at [`sobjects.example.toml`](https://github.com/directionally-local/serverless-objects/blob/main/sobjects.example.toml).

```toml
[celld]
bucket = "s3://my-bucket/prefix"      # required: s3://, gs:// or az://
endpoint = "https://..."              # S3-compatible endpoint (or S3_ENDPOINT)
region = "auto"                       # or AWS_REGION
listen = "127.0.0.1:8080"             # keep on loopback behind the ingress
# internal_listen = "127.0.0.1:8081"  # celld operator API, loopback only

[ingress]
listen = "0.0.0.0:443"
redirect_http = "0.0.0.0:80"          # HTTP→HTTPS redirect; also serves ACME challenges
access_log = "-"                      # "-" for stdout; default is the state directory

[ingress.tls]                         # static certificates...
cert = "/etc/serverless-objects/tls/fullchain.pem"
key = "/etc/serverless-objects/tls/privkey.pem"

# [ingress.acme]                      # ...or ACME HTTP-01, not both
# email = "ops@example.com"
# agree_to_terms = true
# directory_url = "https://acme-staging-v02.api.letsencrypt.org/directory"

[[ingress.routes]]
hostname = "agents.example.com"       # exact, *.wildcard or *
# upstream = "http://127.0.0.1:8080"  # defaults to [celld].listen
# tls = { cert = "...", key = "..." } # per-route certificate, chosen by SNI

[admin]
listen = "127.0.0.1:8790"             # loopback-only dashboard and API
```

Credentials never go in this file. celld reads them from its standard credential chain or the environment. Relative certificate paths resolve from the config file's directory.

## Ingress

With an `[ingress]` table, `up` starts a TLS-terminating reverse proxy in front of celld. It:

- routes by exact, `*.wildcard` or `*` hostname and answers `421` for anything else;
- tunnels WebSocket upgrades;
- replaces client-supplied `X-Forwarded-*` and `CF-Connecting-IP` with the real peer address;
- optionally redirects HTTP to HTTPS with `308`;
- serves `/.well-known/sobjects/health`, which checks the upstreams at most once a second. Remote clients get only `{"status":"ok"}` or `"degraded"` (with `503`); loopback clients also see each upstream's address and state;
- writes JSON access logs without query strings.

Plaintext ingress is allowed only on loopback. When `[celld].listen` is loopback, `up` starts celld with `--trust-forwarded-headers`, so a Worker's `request.url` has the client's `https://` scheme and host, as on Cloudflare.

**Static certificates** reload on `SIGHUP`.

**ACME HTTP-01** needs:
- an `email` and an explicit `agree_to_terms = true`, which records your agreement to the CA's subscriber terms;
- `redirect_http` on port 80, with public DNS and inbound HTTP reaching it;
- exact hostnames only. Wildcard routes need static certificates.

The default directory is Let's Encrypt production, so test with the staging `directory_url` first. Keys and certificates are stored under the state directory with mode 0600 files in 0700 directories. Valid certificates are reused at startup and renewed 30 days before expiry. A failed renewal is retried every six hours while the current certificate is still valid. Issuance has been tested against Pebble; public Let's Encrypt issuance and renewal have not been exercised yet.

## Dashboard and admin API

An `[admin]` table makes the supervisor serve a dashboard at `/` and a JSON API. The dashboard shows node health and load, objects, per-object storage with a key-value browser and read-only SQL console, and eviction. The API listens on loopback only and refuses non-loopback `Host` headers (DNS rebinding). Mutations require the `x-sobjects-request: 1` header.

Loopback is reachable by every local process, including the apps you deploy, so the API also requires an admin token. The supervisor creates it on first start as `admin-token` in the state directory (a 256-bit random value, mode 0600 in a 0700 directory). Send it as `Authorization: Bearer <token>`. Only the dashboard's static files, `GET /api/v1/health` and `GET /metrics` work without it, for health checks and Prometheus scrapers. To open the dashboard, run `sobjects dashboard` as the same user and with the same `SOBJECTS_STATE_DIR` as `sobjects up`, and open the URL it prints:

```sh
sobjects dashboard
# http://127.0.0.1:8790/#token=...
```

The token travels in the URL fragment, which browsers don't send to the server. The dashboard keeps it in the tab's session storage and removes it from the address bar. Treat the URL like a password. To rotate the token, stop the supervisor, delete `admin-token` and start it again.

From a script:

```sh
curl -H "Authorization: Bearer $(cat "${SOBJECTS_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/serverless-objects}/admin-token")" \
  http://127.0.0.1:8790/api/v1/node
```

| Endpoint | Returns |
|---|---|
| `GET /api/v1/health` | celld listener and operator API health |
| `GET /api/v1/node` | Resident and owned objects, memory, CPU, WebSockets, deployment version, drain state |
| `GET /api/v1/objects?class=&limit=&after=` | Objects, marked resident or not |
| `GET /api/v1/objects/<Class:id>` | SQL tables with row counts, pending alarm, WebSocket count and tags |
| `GET /api/v1/objects/<Class:id>/kv?prefix=&startAfter=&limit=` | Key-value entries (`Date`, `Map`, `Set`, bytes and `bigint` as tagged JSON) |
| `POST /api/v1/objects/<Class:id>/sql` | Read-only `SELECT`/`WITH`/`EXPLAIN`/`PRAGMA`, up to 500 rows |
| `GET /api/v1/objects/<Class:id>/export` | JSON download of every KV entry, app table and pending alarm (10,000 each) |
| `POST /api/v1/objects/<Class:id>/evict` | Evicts a resident object |
| `GET /api/v1/backups?class=&limit=&after=` | Superseded LTX epochs eligible for GC (not a full history) |
| `GET /metrics` | Prometheus text: engine gauges and ingress counters |

celld 0.6 has no storage API, so `sobjects deploy` wraps the app's Durable Object classes in a small inspection hook. Requests carrying `x-sobjects-inspect` with this host's token are answered by the hook, and everything else reaches the app unchanged. Only the token's SHA-256 goes into the bundle, and the ingress strips the header from client requests. Pass `--no-inspector` to deploy the app unwrapped. Point-in-time restore isn't available, because celld has no tool to restore an older epoch.

## Engine upgrades

Every installable celld version is pinned with a SHA-256 for each release asset; currently 0.6.2 (the default) and 0.6.1. `sobjects upgrade` downloads and verifies a version, selects it, and records the previous one. `--rollback` switches back and `--status` lists versions. A failed download or checksum leaves the current selection in place. Running nodes keep their version until restarted. Set `SOBJECTS_CELLD_BIN` to use a binary you manage yourself.

## Service units

`sobjects service print` writes a systemd unit (Linux) or launchd plist (macOS) to stdout; `--kind` overrides the choice. `sobjects service install` writes it to:
- `~/.config/systemd/user/`, or `/etc/systemd/system/` with `--system --user NAME`
- `~/Library/LaunchAgents/` on macOS

It refuses to overwrite without `--force` and prints the enable commands; it doesn't start anything. The unit runs `sobjects up` in the foreground and restarts it on failure. systemd units read credentials from an optional `sobjects.env` beside the config. System units get `CAP_NET_BIND_SERVICE` so the ingress can bind ports 80 and 443.

## Wrangler config handling

`dev` and `deploy` parse `wrangler.json`/`wrangler.jsonc` before calling celld:

- Unknown top-level keys are rejected.
- `observability` and `upload_source_maps` are removed, with a warning.
- A declared `build.command` runs first.
- If `assets.directory` is missing in a project that uses `@cloudflare/vite-plugin`, `vite build` runs and the generated `index.html` is located. Ambiguous output fails before celld starts.

`deploy` fills a missing bucket, endpoint and region from the project's `sobjects.toml`; explicit flags and environment variables win. celld bundles with esbuild: a project-local copy comes first, then one on `PATH`, then the copy installed with this package.

## Environment variables

| Variable | Purpose |
|---|---|
| `SOBJECTS_STATE_DIR` | Detached PIDs, logs and ACME state (default `$XDG_STATE_HOME/serverless-objects` or `~/.local/state/serverless-objects`) |
| `SOBJECTS_DATA_DIR` | Engine installs and the inspector token (default `$XDG_DATA_HOME/serverless-objects` or `~/.local/share/serverless-objects`) |
| `SOBJECTS_CELLD_BIN` | Use this celld binary instead of the pinned download |
| `SOBJECTS_CONFIG` | Default `sobjects.toml` for `up` and `supervise`, and for `deploy` when the project has none |
| `CELLD_SHUTDOWN_TOTAL_MS` | celld's graceful-shutdown bound; `down` waits slightly longer |

## Security notes

- Keep celld's listener, its operator listener and the admin API on loopback. Only the ingress should face the network, and it requires TLS to do so. The admin token guards the admin API against other local processes; it is not a reason to expose it.
- Keep object-store credentials in the environment or credential chain, never in `sobjects.toml`.
- Use a bucket dedicated to Serverless Objects.

## License

Apache-2.0. Report issues at [github.com/directionally-local/serverless-objects/issues](https://github.com/directionally-local/serverless-objects/issues).
