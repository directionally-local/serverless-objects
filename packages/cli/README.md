# serverless-objects

The `sobjects` CLI package for Serverless Objects.

## Commands in this pre-alpha

- `sobjects up [--config PATH] [--detach]` validates `sobjects.toml`, installs pinned celld `v0.6.2` if needed, and starts a single-node process (foreground by default).
- `sobjects status`, `sobjects logs [--tail N]`, and `sobjects down` manage an `up --detach` process.
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
HTTP listener directly to the internet; TLS ingress and systemd/launchd unit
generation are not implemented yet. Detached mode only manages a local PID and log.

## Wrangler config handling

`dev` and `deploy` parse JSONC before invoking celld, reject unknown top-level
keys, and remove `observability` / `upload_source_maps` with warnings. A declared
`build.command` runs before celld; only that build key is supported. `assets`
requires an explicit `assets.directory`; Vite-plugin-generated asset directories
are not inferred. Other config differences remain celld limitations.

`deploy` forwards its arguments to celld. Missing bucket, endpoint, and region
values are filled from the project's `sobjects.toml`; explicit CLI flags and
standard environment variables take precedence. Credentials continue to come
from celld's normal credential chain.

Requires Node.js 22 or newer. The npm package is not published. See the
[project README](../../README.md) for scope and roadmap.
