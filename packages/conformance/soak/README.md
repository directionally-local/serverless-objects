# Soak

A long run of the native engine under steady load and injected faults, before it is called beta. `soak.js` drives the published `serverless-objects` CLI (`sobjects dev --engine native --threads 2 --backup-bucket … --backup-mode durable`) with the app in `app/`, and checks:

- **No acknowledged write is lost.** Each ledger object receives numbered appends. The runner records which were acknowledged and compares them with what the ledger holds after every fault and every 15 minutes. A write the engine never acknowledged may or may not be there. A disk wipe may lose writes acknowledged within the backup window, and those are counted separately as excused.
- **SQLite stays intact:** `PRAGMA quick_check` on every ledger it reads.
- **Alarms keep firing:** five self-rearming alarms, with no gap longer than the period plus a minute, after subtracting planned downtime.
- **WebSockets keep working:** five hibernatable sockets echo every 10 or 90 seconds, so some objects hibernate between messages.
- **Nothing creeps:** engine memory, open files, data size and write latency, sampled every hour.

Faults, one every ~45 minutes on average (weights in `soak.js`):

| Fault | What happens | Expected |
|---|---|---|
| `kill9` | SIGKILL the engine, restart it | No acknowledged write lost |
| `sigterm` | Graceful stop and restart | No acknowledged write lost |
| `crash-thread` | An uncaught error kills one engine thread | The thread is replaced; the engine stays healthy |
| `bucket-outage` | SeaweedFS frozen (SIGSTOP) for 5 minutes | Reads keep working; in durable mode writes fail without being acknowledged until the bucket is back, then ship |
| `disk-full` | Fill the data disk, hold 3 minutes, free it | Writes fail while full, without being acknowledged; nothing is corrupted |
| `wipe-restore` | SIGKILL, delete all local state, restart | Objects are restored from the bucket. Durable mode (the default) may lose nothing acknowledged; interval mode only writes inside the backup window |

`disk-full` runs only when the data directory is its own filesystem of 8 GB or less. It is skipped otherwise, so it can never fill a host's disk.

## Running it

Everything runs in one container: the engine, SeaweedFS as the bucket, and the load. The container needs no network (`--network none`) and publishes no ports.

```sh
# The release under test is required; there is no default, so a soak cannot
# silently run an old CLI.
docker build --build-arg SOBJECTS_VERSION=$(npm view serverless-objects version) -t sobjects-soak packages/conformance/soak
# A small dedicated disk for the engine's data, so disk-full stays inside it:
mkdir -p /opt/sobjects-soak/state /opt/sobjects-soak/data
fallocate -l 2G /opt/sobjects-soak/data.img && mkfs.ext4 -q /opt/sobjects-soak/data.img
mount -o loop /opt/sobjects-soak/data.img /opt/sobjects-soak/data
docker run -d --name sobjects-soak --restart unless-stopped --network none \
  --cpus 1 --memory 1280m --log-opt max-size=20m --log-opt max-file=3 \
  -v /opt/sobjects-soak/data:/soak/data -v /opt/sobjects-soak/state:/soak/state sobjects-soak
```

Read `/opt/sobjects-soak/state/report.json`, or the daily `report-YYYY-MM-DD.md` next to it. The runner saves its journal every minute and picks up where it left off if the container restarts.

Settings (environment): `SOAK_DAYS` (14), `SOAK_RATE` writes/s (20), `SOAK_FAULT_MINUTES` (45), `SOAK_VERIFY_MINUTES` (15), `SOAK_THREADS` (2), `SOAK_BACKUP_MODE` (`durable`, or `interval`), `SOAK_BACKUP_INTERVAL` seconds (10), `SOAK_FAULTS` (comma-separated subset), `SOAK_OUTAGE_SECONDS` (300), `SOAK_DISK_FULL_SECONDS` (180).

To stop it and clean up: `docker rm -f sobjects-soak`, `umount /opt/sobjects-soak/data`, then delete `/opt/sobjects-soak`.
