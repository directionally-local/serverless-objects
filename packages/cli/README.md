# serverless-objects

The `sobjects` CLI package for Serverless Objects.

## Commands in this pre-alpha

- `sobjects up [--config PATH] [--detach]` validates `sobjects.toml`, installs pinned celld `v0.6.2` if needed, and starts a single-node process (foreground by default).
- `sobjects status`, `sobjects logs [--supervisor] [--tail N]`, and `sobjects down` manage the processes started by `up --detach`.
- `sobjects supervise [--config PATH]` runs only the ingress and admin API in the foreground.
- `sobjects service print|install` generates a systemd or launchd unit for `up`.
- `sobjects upgrade [--engine-version V | --rollback | --status]` installs and selects a pinned celld release.
- `sobjects dev [project] [celld dev options]` runs local development with celld.
- `sobjects deploy [project] [celld deploy options]` deploys through celld.
- `sobjects --help` and `sobjects --version` show CLI help and version.

`dev` and `deploy` use the pinned celld install. Set `SOBJECTS_CELLD_BIN` to
use an existing binary or `SOBJECTS_DATA_DIR` to choose the engine install
location. `dev` adds the project's `node_modules/.bin` to the child `PATH`, so
a project-local esbuild can be used.

## `sobjects up` configuration

Copy [`sobjects.example.toml`](https://github.com/sinameraji/serverless-objects/blob/main/sobjects.example.toml) to `sobjects.toml`
and set `celld.bucket` to an S3-, GCS-, or Azure-compatible bucket URI. Credentials
come from celld's standard provider chain / environment; do not put credentials
in this file. The default listener is `127.0.0.1:8080`. Do not expose celld's
HTTP listener directly to the internet; put the ingress in front of it.
Detached mode only manages local PIDs and logs; for a supervised service use
`sobjects service`.

## TLS ingress and ACME HTTP-01

The ingress accepts either static PEM files in `[ingress.tls]` or automatic
certificates in `[ingress.acme]` (not both). ACME requires `email`, explicit
`agree_to_terms = true`, `redirect_http` listening on port 80, DNS records for
each exact route hostname, and public HTTP reachability on port 80. Wildcard
routes cannot use HTTP-01; assign them their own static route certificate.

The default ACME directory is Let's Encrypt production. Set `directory_url` to
the Let's Encrypt staging directory while validating DNS and firewall setup.
ACME account keys and certificates are stored under `SOBJECTS_STATE_DIR/acme`
(or the default user state directory), with private files mode 0600 and
containing directories mode 0700. Valid certificates are reused at startup and
renewed 30 days before expiry; failed renewals retry every six hours while the
current certificate remains valid. The initial issuance completes before HTTPS
starts, so the HTTP-01 listener must be reachable during `sobjects up`.

By enabling ACME and setting `agree_to_terms = true`, the operator agrees to the
configured CA's subscriber terms. ACME directory URLs must use HTTPS; plain HTTP
is allowed only for loopback test servers. Static certificates continue to
support `SIGHUP` reloads.

## Admin API, dashboard, and metrics

An `[admin]` table (loopback only) makes the supervisor serve a dashboard at
`/` (node health and load, objects, per-object storage with a key-value browser
and read-only SQL console, eviction) and:

- `GET /api/v1/health`: celld listener and operator API health
- `GET /api/v1/node`: resident and owned objects, memory, CPU, WebSockets, deployment version, drain state
- `GET /api/v1/objects?class=&limit=&after=`: objects from `celld cell list`, marked resident or not
- `POST /api/v1/objects/<Class:id>/evict`: evict a resident object; requires the `x-sobjects-request: 1` header
- `GET /metrics`: Prometheus text with engine gauges and ingress request counters

It has no authentication, so it refuses non-loopback addresses and requests
whose `Host` header is not a loopback name (DNS rebinding). Mutations need the
custom header, which browsers cannot send cross-origin without a preflight this
server never approves. Enabling it pins celld's unauthenticated operator
listener (`[celld].internal_listen`, default: the celld port + 1) on loopback.
Object storage inspection:

- `GET /api/v1/objects/<Class:id>`: SQL tables with row counts, pending alarm, WebSocket count and tags
- `GET /api/v1/objects/<Class:id>/kv?prefix=&startAfter=&limit=`: key-value entries, with `Date`, `Map`, `Set`, bytes and `bigint` encoded as tagged JSON
- `POST /api/v1/objects/<Class:id>/sql` with `{"query": "..."}`: read-only SELECT/WITH/EXPLAIN/PRAGMA, up to 500 rows

Backups:

- `GET /api/v1/backups?class=&limit=&after=`: superseded LTX epochs and bytes for objects that have GC candidates, from `celld cell gc --dry-run` (read-only; not a complete object inventory)
- `GET /api/v1/objects/<Class:id>/export`: a JSON download of every key-value entry, every app table with its schema, and the pending alarm (up to 10,000 entries or rows each; `truncated` says when the cap was hit)

celld keeps superseded epochs unless `CELLD_LTX_RETENTION_SECS` is set, but
has no tool to restore one, so point-in-time restore is not available in this
version. There is no import for exports yet either.

celld 0.6 has no storage API, so `sobjects deploy` bundles a small generated
entry that re-exports the app and wraps its Durable Object classes and default
handler. A request carrying `x-sobjects-inspect` with this host's token is
answered by the hook; every other request reaches the app unchanged. The token
lives in `$SOBJECTS_DATA_DIR/inspector-token` and only its SHA-256 goes into the
bundle. The ingress strips the header from client requests. Inspection activates
the object. Deploy from the host that runs the supervisor, or copy the token,
or pass `--no-inspector` to deploy the app unwrapped.

## Engine upgrades

Every installable celld version is pinned in the CLI with a SHA-256 for each
release asset (currently 0.6.2, the default, and 0.6.1). `sobjects upgrade`
downloads and verifies the CLI's pinned version (or `--engine-version`),
selects it, and records the previous selection; `--rollback` switches back and
`--status` lists the versions. The selection is stored in
`$SOBJECTS_DATA_DIR/engines/celld.json`, and `up`, `dev`, and `deploy` use it.
A failed download or checksum leaves the current selection in place. Running
nodes keep their version until restarted; `upgrade` does not restart them.

## Service units

`sobjects service print` writes a systemd or launchd unit to stdout (launchd on
macOS, systemd elsewhere; override with `--kind`). `sobjects service install`
writes it to `~/.config/systemd/user/`, `/etc/systemd/system/` (`--system
--user NAME`), or `~/Library/LaunchAgents/`, refuses to overwrite without
`--force`, and prints the commands that enable it; it does not start anything.
The unit runs `sobjects up --config <absolute path>` in the foreground, pins
`SOBJECTS_STATE_DIR` and `SOBJECTS_DATA_DIR`, and restarts on failure. systemd
units read credentials from an optional `sobjects.env` beside the config.
System units run as the named account, use `/var/lib/serverless-objects`, and
get `CAP_NET_BIND_SERVICE` so the ingress can bind ports 80 and 443. On stop,
`up` forwards SIGTERM to celld and waits for it to exit.

## Ingress

An `[ingress]` table makes `up` start a TLS-terminating reverse proxy before
celld. Routes match exact, `*.wildcard`, or `*` hostnames and default to the
`[celld]` listener. Certificates are static PEM files (optionally one per route,
selected by SNI) and reload on `SIGHUP`. The ingress tunnels WebSockets,
rewrites `X-Forwarded-*` and `CF-Connecting-IP`, can redirect HTTP to HTTPS,
answers `/.well-known/sobjects/health`, and writes JSON access logs without
query strings. Plaintext listeners are allowed only on loopback. ACME is not
implemented yet. When `[celld].listen` is loopback, `up` passes
`--trust-forwarded-headers` so a Worker's `request.url` has the client's
scheme and host; with a non-loopback listener it warns and leaves them off,
since clients could reach celld directly and spoof those headers.

## Wrangler config handling

`dev` and `deploy` parse JSONC before invoking celld, reject unknown top-level
keys, and remove `observability` / `upload_source_maps` with warnings. A declared
`build.command` runs before celld; only that build key is supported. If
`assets.directory` is missing in a project with `@cloudflare/vite-plugin` and a
Vite config, `dev`/`deploy` run `vite build` and discover a unique `index.html`
under the Cloudflare Build Output worker assets or conventional `dist` output.
Missing or ambiguous outputs fail safely; other projects must set
`assets.directory` explicitly. The full Agents SDK sample has not yet been tested
end-to-end through this Vite path.

`deploy` forwards its arguments to celld. Missing bucket, endpoint, and region
values are filled from the project's `sobjects.toml`; explicit CLI flags and
standard environment variables take precedence. Credentials continue to come
from celld's normal credential chain.

The CLI is a pre-alpha test candidate, not a production release. Unit and integration checks include loopback service lifecycle and a real build using `@cloudflare/vite-plugin` 1.62.3; the full Agents SDK app has not yet been run end-to-end through the CLI. Bucket-backed `deploy` and `up --detach` with ingress were verified against SeaweedFS and Cloudflare R2; the R2 run used a token scoped to one bucket and showed about 0.7 s single-node write latency from the test Mac. Generated plists pass `plutil -lint`, but units have not yet been loaded into launchd or systemd. The dashboard is implemented; ACME issuance is not. The npm package is not published. See the [project README](../../README.md) for scope and roadmap.
