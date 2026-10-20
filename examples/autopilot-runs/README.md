# Autopilot runs as objects

A small HTTP API over [`@serverless-objects/autopilot`](../../packages/autopilot). Its `Run` class appends a Camouflage `BackgroundTaskUpdate` event when a wake fires. A real executor would start or resume Autopilot there.

From the repository root, after `npm ci`:

```sh
cd examples/autopilot-runs
sobjects deploy . --bucket s3://my-bucket/autopilot-runs
sobjects up --config /path/to/sobjects.toml --detach
H=http://127.0.0.1:8080

curl -X POST -d '{"id":"run-42","task":"Fix the flaky test"}' $H/runs
curl -X POST -d '["running"]' $H/runs/run-42/transition
curl -X POST -d '[[{"event_type":"UserMessageCreated","payload":{"text":"fix it"}}]]' $H/runs/run-42/appendSessionEvents
curl -X POST -d "[{\"condition\":\"time\",\"wakeAt\":$(($(date +%s) * 1000 + 30000))}]" $H/runs/run-42/scheduleTimer
curl -X POST -d '["waiting"]' $H/runs/run-42/transition

sobjects down && sleep 35 && sobjects up --config /path/to/sobjects.toml --detach   # the wake fires after restart
curl "$H/runs/run-42/stream?stream=session"     # NDJSON for camouflage-tui --play
curl $H/registry
```

Routes:
- `POST /runs`
- `POST /runs/:id/<RunObject method>` with a JSON array of arguments
- `GET /runs/:id/stream?stream=session|run&after=N`, as NDJSON or a WebSocket
- `GET /registry?status=`
- `POST /registry/reconcile`

The demo has no authentication; keep it on loopback.
