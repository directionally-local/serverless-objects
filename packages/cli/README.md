# serverless-objects

The `sobjects` CLI package for Serverless Objects.

## Commands in this pre-alpha

- `sobjects up [--config PATH] [--detach]` validates `sobjects.toml`, installs pinned celld `v0.6.2` if needed, and starts a single-node process (foreground by default).
- `sobjects status`, `sobjects logs [--ingress] [--tail N]`, and `sobjects down` manage the processes started by `up --detach`.
- `sobjects ingress [--config PATH]` runs only the TLS ingress in the foreground.
- `sobjects service print|install` generates a systemd or launchd unit for `up`.
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
implemented yet. celld still reports `http://` in a Worker's `request.url`;
use `X-Forwarded-Proto` for the client scheme.

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

The CLI is a pre-alpha test candidate, not a production release. Unit and integration checks include loopback service lifecycle and a real build using `@cloudflare/vite-plugin` 1.62.3; the full Agents SDK app has not yet been run end-to-end through the CLI. The ingress was smoke-tested in front of `celld dev` with HTTPS, Durable Object state, and a WebSocket echo. Generated plists pass `plutil -lint`; units have not yet been loaded into launchd or systemd. Bucket-backed `up`, ACME, and dashboard are not ready. The npm package is not published. See the [project README](../../README.md) for scope and roadmap.
