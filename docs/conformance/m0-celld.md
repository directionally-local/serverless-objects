# M0 compatibility spike — preliminary celld results

**Date:** 17 Oct 2026  
**Status:** Partial. The M0 go/no-go gate is still open; these checks do not establish Agents SDK or PartyServer compatibility.

## Verified

- **Pinned celld binary starts on Apple Silicon.** Downloaded the official `v0.6.2` release binary and confirmed it reports `celld 0.6.2`. `celld dev` is available and accepts a project directory or Wrangler config.
- **Basic SQLite Durable Object state survives a celld restart.** Ran celld's unmodified [`examples/counter`](https://github.com/denoland/celld/tree/v0.6.2/examples/counter) example. Consecutive requests returned counter values `1` and `2`; after stopping and restarting celld against the same project directory, the next request returned `3`.
- **A Durable Object can reach Hotcell on host loopback in local development.** A temporary Worker/DO fixture running under `celld dev` fetched `http://127.0.0.1:4750/healthz` and received HTTP 200 from Hotcell `0.1.19` (`{"ok":true,"driver":"container","version":"0.1.19"}`). This establishes loopback reachability in this local setup only; it does not validate API-key handling or the Sandbox binding.
- **Hotcell workspace data survives a daemon restart and explicit sandbox resume.** Created an isolated, named test sandbox, wrote a marker in `/workspace`, stopped the sandbox and Hotcell daemon, restarted the daemon, explicitly resumed the same sandbox, and read the marker back. The test sandbox was then destroyed. This is not yet an object-eviction/reattachment test.

## Operational note

`celld dev` requires `esbuild` on `PATH`; the counter example has no package manifest, so `esbuild` was made available from a disposable temporary directory for the check. The project CLI will need to account for this rather than assume it is installed globally.

## Still required before the gate

- Run two unmodified Cloudflare Agents SDK samples, including coverage for scheduling, SQL, and WebSockets.
- Run an unmodified PartyServer chat sample and exercise a WebSocket session across a celld restart.
- Create a Hotcell sandbox through a Durable Object, evict the object, restart `hotcelld`, and verify reattachment by stored sandbox id.
- Classify each failure as an above-runtime fix, a small celld patch, or a deep runtime change.

No decision to proceed or stop has been made yet.
