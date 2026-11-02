# Conformance suite (v0)

`app/` is a small Workers application whose Durable Objects run checks and
return `{ pass, detail }` at `/case/<name>`. `/cases` lists the cases.
`agents-app/` does the same for the Agents SDK (pinned `agents` 0.28.1, with
`nodejs_compat`); the runner also drives its WebSocket client protocol.
`party-app/` does the same for PartyServer (pinned `partyserver` 0.5.10, with
`nodejs_compat`): a `Server` with hibernation enabled, driven over
`/parties/chat/<room>` and its WebSocket protocol. `containers-app/` is a
celld-only suite for `ctx.container` and `@cloudflare/sandbox` 1.0.1: it starts
a container, runs `exec()` and `getTcpPort().fetch()`, checks
`enableInternet: false`, records the `exec()`-after-`start()` race, attempts
`S3Mount` and `DirectoryBackup`, and drives sleep and restart checks. Select
one with `--suite core|agents|party|containers|all` (default `all`; `all`
excludes `containers`, which needs Docker and celld). The
runner launches a disposable copy under the git-ignored `.runs/` directory,
so the Agents, PartyServer and containers apps resolve the workspace's
`node_modules`, and removes it afterwards.

Run the reference runner or celld runner from the repository root:

```sh
npm run test:wrangler --workspace=sobjects-conformance
npm run test:celld --workspace=sobjects-conformance
```

Wrangler is pinned to 4.150.0. The celld runner uses
`$HOME/.local/share/serverless-objects/engines/celld-0.6.2/celld` by default;
set `CELLD_BIN` or pass `--celld-bin PATH` to select another binary. Both
runners accept `--port PORT`. The celld run restarts the process while its alarm
is pending, then verifies that the alarm fires after restart. It also sets
`CELLD_IDLE_EVICT_S=2` so it can check WebSocket hibernation: the object is
evicted with a socket open, and the next message must reach a new instance. Its default alarm
delay is 30 seconds to allow for celld's graceful shutdown; `--alarm-delay MS`
can override it.

The app uses compatibility date `2026-02-24`, when Cloudflare changed
`deleteAll()` to clear a Durable Object alarm. This keeps the alarm case aligned
with the documented Workers contract.

The containers suite is celld-only and needs a Docker or Podman engine on a
Linux host. Run it with:

```sh
npm run test:containers --workspace=sobjects-conformance
```

It builds `containers-app/Dockerfile` (Python plus `fuse3`, `s3fs-fuse` and the
`sandbox-shim` from `cloudflare/sandbox:1.0.1`) and starts `celld dev` with
`CELLD_IDLE_EVICT_S=2`. On macOS celld reaches a container through a published
port, and the suite's `getTcpPort()` check fails; use a Linux host or a Linux
VM. The suite is not part of `--suite all` because it needs Docker and is
celld-only.

See [the recorded results](../../docs/conformance/results.md) for tested
versions, hosts and coverage boundaries. A green result is evidence for these
cases and versions only; it is not a claim of complete Workers compatibility.

## Product path

The runners above start `wrangler dev` or `celld dev` directly. `src/product.js`
instead exercises the product path for the Agents app: it copies `agents-app/`,
writes an `sobjects.toml` with a self-signed TLS certificate, deploys with
`sobjects deploy`, starts the node with `sobjects up --detach`, and runs the
state, SQL, schedules, addressing, callable RPC and schedule checks against the
TLS ingress.

```sh
npm run test:product --workspace=sobjects-conformance -- --local-s3
```

`--local-s3` starts a disposable SeaweedFS container and creates the bucket;
without it, pass `--bucket`, `--endpoint` and credentials in the environment.
The ingress listens on `--port` (default 18443), with celld, its operator
listener and the admin API on the next three ports. `--keep` leaves the node,
bucket and scratch directory running. It is not in CI because it needs Docker,
a bucket and celld.

## Other platforms

The suites are host-agnostic. To repeat them on Linux, run them in a
`node:22-bookworm` container with the repository mounted, then `npm ci` and
install the pinned celld for that architecture:

```sh
node --input-type=module -e 'import { installCelld } from "./packages/cli/src/engine.js"; console.log(await installCelld())'
```

The runner finds celld at `$HOME/.local/share/serverless-objects/engines/celld-0.6.2/celld`
unless `CELLD_BIN` or `--celld-bin` says otherwise. CI runs the Wrangler, celld
and native suites on `ubuntu-latest` x64; the recorded Linux arm64 and x64 runs
are described under [Platforms](../../docs/conformance/results.md#platforms).
