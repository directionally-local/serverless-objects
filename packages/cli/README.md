# serverless-objects

The `sobjects` CLI package for Serverless Objects.

## Commands in this pre-alpha

- `sobjects up [--config PATH]` validates a local `sobjects.toml`, installs the pinned celld `v0.6.2` release if needed, and starts a single-node celld process in the foreground.
- `sobjects dev [project] [celld dev options]` runs local development with celld.
- `sobjects deploy [project] [celld deploy options]` forwards a deployment to celld.
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
HTTP listener directly to the internet; TLS ingress and service supervision are
not implemented yet.

`deploy` currently forwards its arguments to celld; provide `--bucket` or
`CELLD_BUCKET` and the normal storage credentials. It does not yet consume
`sobjects.toml`. Wrangler config normalization is also pending, so celld may
reject optional Wrangler keys before loading a project.

Requires Node.js 22 or newer. The npm package is not published. See the
[project README](../../README.md) for scope and roadmap.
