# @serverless-objects/hotcell

A `Sandbox` Durable Object and `getSandbox()` in the shape of the
`@cloudflare/sandbox` **0.x** API, backed by a [Hotcell](https://github.com/sinameraji/hotcell)
daemon instead of Cloudflare Containers. The object stores its Hotcell sandbox
id in Durable Object storage, so after the object is evicted or the node
restarts it reattaches to the same sandbox and workspace.

> **Status:** pre-alpha, not yet published to npm. `@cloudflare/sandbox` 1.0
> (a different, Containers-based API) is not implemented here; see
> [compatibility](../../docs/compatibility.md).

```js
import { getSandbox, proxyToSandbox, Sandbox } from "@serverless-objects/hotcell";

export { Sandbox };

export default {
  async fetch(request, env) {
    const sandbox = getSandbox(env.Sandbox, "user-123");
    const result = await sandbox.exec("python3 -c 'print(2 + 2)'");
    return Response.json(result);
  },
};
```

```jsonc
{
  "durable_objects": { "bindings": [{ "name": "Sandbox", "class_name": "Sandbox" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Sandbox"] }]
}
```

No `containers` entry is needed: Hotcell runs the sandbox. The object reaches
the daemon at `HOTCELL_ENDPOINT` (default `http://127.0.0.1:4750`) and sends
`HOTCELL_API_KEY` when set; both come from the Worker's `vars`/secrets.

## Supported methods

| Method | Notes |
|---|---|
| `exec(command, { cwd, env })` | Buffered; returns `success`, `exitCode`, `stdout`, `stderr`, `command`, `duration`, `timestamp`. |
| `writeFile`, `readFile` | UTF-8 strings only. |
| `mkdir`, `deleteFile`, `renameFile`, `moveFile`, `exists`, `listFiles` | `listFiles` is not recursive; entries omit `mode` and `permissions`. |
| `startProcess`, `listProcesses`, `getProcess`, `killProcess`, `killAllProcesses`, `getProcessLogs` | Processes are plain objects, without `kill()`/`getLogs()` methods; Hotcell's combined log is returned as `stdout`. |
| `setEnvVars` | |
| `exposePort`, `unexposePort`, `getExposedPorts` | URLs come from Hotcell's preview proxy (port 4751); `hostname` is accepted and ignored. |
| `destroy` | Destroys the Hotcell sandbox and forgets its id. |
| `hotcellSandboxId()` | Not in the Cloudflare API: the Hotcell id, for operators. |

Not implemented: `execStream`, `streamProcessLogs`, sessions, code contexts
(`runCode`), `gitCheckout`, bucket mounts, backups, `watch`, terminals and
`wsConnect`. Options the binding cannot honour, such as `exec`'s `timeout` or
binary encodings, throw a `TypeError` instead of being silently ignored.

## Options

`getSandbox(ns, id, options)` accepts `sleepAfter` (seconds or `"30s"`, `"5m"`,
`"1h"`), `keepAlive`, `labels` and `normalizeId`, and ignores Cloudflare
transport settings (`transport`, `containerTimeouts`, `enableDefaultSession`).
Hotcell settings go in a `hotcell` block: `image`, `env`, `egress`,
`networked`, `persist`, `setup`, `memoryMb`, `cpus`. For example,
`{ hotcell: { egress: { spendCapUsd: 5, ttlMs: 3_600_000 } } }` mints a
per-sandbox gateway token, so the object never holds a real provider key.

Options apply when the object creates its Hotcell sandbox; an existing sandbox
keeps the settings it was created with.

## Tested

Unit tests cover the mapping with a fake daemon. One run on macOS arm64
(celld 0.6.2 through `sobjects deploy`/`up`, Hotcell 0.1.19 with the container
driver) exercised files, `exec`, processes and logs, `exposePort` with a
preview fetch, reattachment after celld idle-evicted the object, and `destroy`.
With `{ hotcell: { egress: { spendCapUsd: 1, ttlMs: 600000 } } }`, the sandbox
received `OPENROUTER_API_KEY` and `OPENROUTER_BASE_URL` pointing at Hotcell's
gateway, and the key did not have a provider key's shape. A sandbox created
without `egress` had neither variable. Spend-cap enforcement and API-key
authentication to the daemon have not been exercised.
