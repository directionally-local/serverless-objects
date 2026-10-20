# Autopilot runs as objects

A small HTTP API over [`@serverless-objects/autopilot`](../../packages/autopilot). Its `Run` class is an `AutopilotCellRun`: `start` runs the task with Autopilot in a Hotcell cell. A wake timer only appends a Camouflage `BackgroundTaskUpdate` event, to show durable wakes on their own.

## Deploy

From the repository root, after `npm ci`:

```sh
cd examples/autopilot-runs
sobjects deploy . --bucket s3://my-bucket/autopilot-runs
sobjects up --config /path/to/sobjects.toml --detach
H=http://127.0.0.1:8080
```

## Run Autopilot in a Hotcell cell

This needs a Hotcell daemon on `127.0.0.1:4750` with an OpenRouter route configured for gateway egress (`hotcell keys import`). It spends real model credit; both `maxCostUsd` and the cell's spend cap limit it.

```sh
curl -X POST -d '{"id":"cell-run-1","task":"Create hello.txt containing hi, then reply done.","maxCostUsd":0.25}' $H/runs
curl -X POST -d '[{"egress":{"spendCapUsd":0.25,"ttlMs":1800000}}]' $H/runs/cell-run-1/start
curl -X POST $H/runs/cell-run-1/executorState                  # step, cell id, cursor
curl "$H/runs/cell-run-1/stream?stream=session" > run.ndjson   # then: camouflage-tui --play run.ndjson
curl $H/registry
```

Stop the node with `sobjects down` mid-run and start it again. The cell keeps working, and the object resumes from its saved cursor.

## Durable wakes, without a cell

```sh
curl -X POST -d '{"id":"run-42","task":"Wait for the build"}' $H/runs
curl -X POST -d '["running"]' $H/runs/run-42/transition
curl -X POST -d "[{\"condition\":\"time\",\"wakeAt\":$(($(date +%s) * 1000 + 30000))}]" $H/runs/run-42/scheduleTimer
curl -X POST -d '["waiting"]' $H/runs/run-42/transition
sobjects down && sleep 35 && sobjects up --config /path/to/sobjects.toml --detach   # the wake fires after restart
curl "$H/runs/run-42/stream?stream=session"
```

## Routes

- `POST /runs` with `{id, task, ...budgets}`
- `POST /runs/:id/<method>` with a JSON array of arguments. Methods: the `RunObject` methods, plus `start`, `cancel` and `executorState`.
- `GET /runs/:id/stream?stream=session|run&after=N`, as NDJSON or a WebSocket
- `GET /registry?status=`
- `POST /registry/reconcile`

The demo has no authentication; keep it on loopback.
