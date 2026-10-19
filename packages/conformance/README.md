# Conformance suite (v0)

`app/` is a small Workers application whose Durable Objects run checks and
return `{ pass, detail }` at `/case/<name>`. `/cases` lists the cases.
`agents-app/` does the same for the Agents SDK (pinned `agents` 0.28.1, with
`nodejs_compat`); the runner also drives its WebSocket client protocol. Select
one with `--suite core|agents|all` (default `all`). The
runner launches a disposable copy under the git-ignored `.runs/` directory,
so the Agents app resolves the workspace's `node_modules`, and removes it
afterwards.

Run the reference runner or celld runner from the repository root:

```sh
npm run test:wrangler --workspace=sobjects-conformance
npm run test:celld --workspace=sobjects-conformance
```

Wrangler is pinned to 4.150.0. The celld runner uses
`$HOME/.local/share/serverless-objects/engines/celld-0.6.2/celld` by default;
set `CELLD_BIN` or pass `--celld-bin PATH` to select another binary. Both
runners accept `--port PORT`. The celld run restarts the process while its alarm
is pending, then verifies that the alarm fires after restart. Its default alarm
delay is 30 seconds to allow for celld's graceful shutdown; `--alarm-delay MS`
can override it.

The app uses compatibility date `2026-02-24`, when Cloudflare changed
`deleteAll()` to clear a Durable Object alarm. This keeps the alarm case aligned
with the documented Workers contract.

See [the recorded results](../../docs/conformance/results.md) for tested
versions and coverage boundaries. A green result is evidence for these cases
and versions only; it is not a claim of complete Workers compatibility.
