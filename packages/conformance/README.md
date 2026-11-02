# Conformance suite (v0)

`app/` is a small Workers application whose Durable Objects run checks and
return `{ pass, detail }` at `/case/<name>`. `/cases` lists the cases.
`agents-app/` does the same for the Agents SDK (pinned `agents` 0.28.1, with
`nodejs_compat`); the runner also drives its WebSocket client protocol.
`party-app/` does the same for PartyServer (pinned `partyserver` 0.5.10, with
`nodejs_compat`): a `Server` with hibernation enabled, driven over
`/parties/chat/<room>` and its WebSocket protocol. Select one with
`--suite core|agents|party|all` (default `all`). The
runner launches a disposable copy under the git-ignored `.runs/` directory,
so the Agents and PartyServer apps resolve the workspace's `node_modules`, and
removes it afterwards.

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

See [the recorded results](../../docs/conformance/results.md) for tested
versions and coverage boundaries. A green result is evidence for these cases
and versions only; it is not a claim of complete Workers compatibility.

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
