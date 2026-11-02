# Soak

The M3 gate is conformance parity with celld on the Durable Objects suite, then
a two-week fault-injection soak before beta. Parity is recorded in
[results.md](results.md); this page is the soak's record.

The harness lives in [`packages/conformance/soak/`](../../packages/conformance/soak/README.md).
It drives the published CLI (`sobjects dev --engine native --threads 2
--backup-bucket … --backup-mode durable`) with SeaweedFS as the bucket, so it
needs no network and no external bucket. It checks that no acknowledged write is
lost, that every ledger passes `PRAGMA quick_check`, that five self-rearming
alarms keep firing, that five hibernatable WebSockets keep echoing, and that
engine memory, open files, data size and write latency stay flat. Faults are
injected about every 45 minutes: `kill9`, `sigterm`, `crash-thread`,
`bucket-outage`, `disk-full` and `wipe-restore`.

## Running it

Use a Linux host that stays up, with a small dedicated filesystem for the
engine's data so `disk-full` runs instead of being skipped. Build the image with
the release under test; there is no default, so a soak cannot silently test an
old CLI.

```sh
docker build --build-arg SOBJECTS_VERSION=$(npm view serverless-objects version) \
  -t sobjects-soak packages/conformance/soak
mkdir -p /opt/sobjects-soak/state /opt/sobjects-soak/data
fallocate -l 2G /opt/sobjects-soak/data.img && mkfs.ext4 -q /opt/sobjects-soak/data.img
mount -o loop /opt/sobjects-soak/data.img /opt/sobjects-soak/data
docker run -d --name sobjects-soak --restart unless-stopped --network none \
  --cpus 1 --memory 1280m --log-opt max-size=20m --log-opt max-file=3 \
  -v /opt/sobjects-soak/data:/soak/data -v /opt/sobjects-soak/state:/soak/state sobjects-soak
```

The runner saves its journal every minute and resumes if the container restarts.
When the run reaches `SOAK_DAYS` it writes the final report, stops the engine and
the bucket, and exits 0, so a finished soak does not look like a container that
is still running.

## Recording the outcome

Copy `report.json` and the last `report-YYYY-MM-DD.md` from the state directory
into this folder, and record alongside them:

- the host (OS, architecture, CPU and memory, and whether the data directory was
  its own small filesystem so `disk-full` ran)
- the CLI version under test and the image digest
- the settings (`SOAK_DAYS`, `SOAK_RATE`, `SOAK_FAULT_MINUTES`,
  `SOAK_VERIFY_MINUTES`, `SOAK_THREADS`, `SOAK_BACKUP_MODE`, `SOAK_FAULTS`)
- the verdict: violations by kind, and any fault that was skipped

Any violation becomes its own issue.

## Status

**The 14-day run has not been completed.** The gate is open.

The harness itself was validated on 2 Nov 2026 with two 0.5-hour runs
(`SOAK_DAYS=0.02`, faults every 2 minutes) on macOS arm64 under Docker Desktop,
against `serverless-objects` 0.13.6. The second run's
[report.json](soak-validation-2026-11-02.json) and
[daily report](soak-validation-2026-11-02.md) are recorded here:

- 0 violations, 24 verifications, 31,802 acknowledged writes and 62 failed
  (not acknowledged) writes
- 497 socket echoes and no missed echo outside a fault
- faults: `kill9` 3, `sigterm` 3, `wipe-restore` 2, `crash-thread` 2; the first
  run also injected `bucket-outage`
- both `wipe-restore` faults lost nothing acknowledged and excused nothing, as
  durable mode should
- engine RSS 203 MB and 225 open files at both ends of the run; write p99 29 ms
- `disk-full` was skipped in both runs: the data directory was not its own small
  disk, which is why the 14-day run wants a Linux host

That run also found and fixed a harness defect: the runner kept its timers and
sockets alive after the final report, so a completed soak never exited. It now
clears them, stops the engine and the bucket, and exits 0.

A short run is not the gate. It shows the harness drives the engine, injects
every fault it can on that host, and reports honestly; it says nothing about
two weeks of drift.
