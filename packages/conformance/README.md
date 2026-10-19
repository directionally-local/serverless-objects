# Conformance suite (work in progress)

One Workers app (`app/`) whose Durable Objects run each check server-side and
answer `{pass, detail}` at `/case/<name>`; `/cases` lists them. The same bundle
is meant to run on Wrangler (workerd, the Cloudflare reference) and on celld,
so a different result is a difference between engines.

Status: the app is written but has not been run yet. Still to build: the
driver and runners (`wrangler dev` pinned to 4.150.0, `celld dev`), the
alarm-durability and WebSocket hibernation checks driven over HTTP/WebSocket
(`/alarm/arm`, `/alarm/status`, `/socket`), and the published results table.
