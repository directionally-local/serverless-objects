# M0 compatibility spike — celld results

**Date:** 17 Oct 2026  
**Result:** Proceed to M1. No tested application code required a deep celld runtime change. The samples did require test-only Wrangler config normalization because celld rejects several otherwise valid or tooling-specific config keys; direct, unmodified config support is not established.

## Environment

- Apple Silicon macOS
- celld `v0.6.2`
- Hotcell `0.1.19`, container driver
- `@hotcell/sdk` `0.1.19`
- Cloudflare Agents npm package resolved to `0.28.1`

## Results

| Check | Result | Notes |
|---|---|---|
| celld `dev` + Durable Object persistence | Pass | celld's unmodified [`examples/counter`](https://github.com/denoland/celld/tree/v0.6.2/examples/counter) returned `1`, then `2`; after restarting celld against the same project, it returned `3`. |
| Agents SDK scheduler + SQL | Pass | Unmodified [`next/schedules` source](https://github.com/cloudflare/agents/tree/7dd51c518c517b0f9f92ec7e2c3ad1004222955e/examples/next/schedules) created a one-second reminder; the callback ran and its result appeared in the sample's SQL table. The temporary config omitted only `observability`, which celld rejected. |
| Agents SDK WebSockets + SQL | Pass | Unmodified [`next/websockets` source](https://github.com/cloudflare/agents/tree/7dd51c518c517b0f9f92ec7e2c3ad1004222955e/examples/next/websockets) completed a real WebSocket handshake, sent a chat frame, and stored it in SQL. The temporary config omitted `observability` and the empty `assets: {}` entry, which celld could not parse. |
| PartyServer chat + SQL | Pass | Unmodified [`durable-chat-template`](https://github.com/cloudflare/durable-chat-template/tree/8237ee7c8deafce97c24f28369f63fcb506c088a) opened a socket, accepted and stored a chat message, then served that message after celld restarted and the socket reconnected. The temporary config omitted `build`, `observability`, and `upload_source_maps`, which celld rejected. |
| DO → Hotcell loopback | Pass | A DO fetched `http://127.0.0.1:4750/healthz` and received HTTP 200 from Hotcell. This establishes reachability in this local setup, not API-key policy. |
| Sandbox id persistence and reattachment | Pass, with a test-scope caveat | A temporary DO used `@hotcell/sdk` to create a sandbox and save its id in DO storage. After restarting both celld and `hotcelld`, a newly constructed DO loaded the id, reattached, and read a marker from the same workspace. The test sandbox was destroyed afterward. The test used process restart to force object reconstruction, not idle-time eviction, and checked `readFile` rather than `exec`. |

## Config compatibility findings

The sample source code above was not modified, but `celld dev` rejected these config entries before loading the app:

- `observability` — unsupported by celld.
- `assets: {}` — celld requires `assets.directory` to be a string.
- `build` and `upload_source_maps` — unsupported config keys.

Removing only those entries from temporary config copies allowed the Worker/DO code paths to run. Classify this as an **above-runtime config adapter/validation issue**, not a deep runtime issue. The v0.1 CLI must report or normalize such keys intentionally; it must not silently imply full Wrangler config compatibility.

## Gate and next work

**M0 gate: proceed to M1.** The tested Agents and PartyServer code paths needed no celld runtime patch. Before claiming full compatibility, add a repeatable idle-eviction test that calls `exec` after reattachment, and implement or document the celld config-key policy.

**First v0.1 slice:** bootstrap the `sobjects` npm workspace/CLI with `--help` and `--version`, Node 22+ metadata, tests, and a GitHub Actions CI check. Release Please, npm publishing, and Homebrew distribution follow once the CLI and release metadata are stable.
