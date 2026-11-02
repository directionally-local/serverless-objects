# Containers conformance — celld 0.6.2

Recorded 2 Nov 2026 on Linux arm64 in Docker Desktop 4.75.0's Linux VM, with
celld 0.6.2 and `@cloudflare/sandbox` 1.0.1. celld ran in a privileged
`node:22-bookworm` container with the host Docker socket and host network, so
the containers it created ran on the Docker Desktop Linux VM. That is a Linux
kernel and userspace, not a bare-metal Linux host; a bare-metal Linux host and
Linux x64 were not tested.

Command:

```sh
npm run test:containers --workspace=sobjects-conformance
```

The runner starts `celld dev` with `CELLD_IDLE_EVICT_S=2`, copies
`containers-app/` into a disposable `.runs/` directory, and drives the app over
HTTP. The image is `python:3.12-alpine` plus `fuse3`, `s3fs-fuse` and the
`sandbox-shim` copied from `cloudflare/sandbox:1.0.1` (a tools-only image with
no command). The shim is an x86-64 static binary; it ran under the host's
binfmt emulation.

| Check | Result | Notes |
|---|---|---|
| `start()`, `exec()`, `getTcpPort().fetch()` | Pass | `exec()` ran `uname -s` (`Linux`) and read a marker file; `getTcpPort(8080).fetch()` returned the container's HTTP response. |
| `enableInternet: false` | Pass | A container started with `enableInternet: false` could not connect to `1.1.1.1:443` (`OSError: [Errno 101] Network unreachable`); a container started with `enableInternet: true` connected. |
| `exec()` immediately after `start()` | Divergence recorded | `exec()` failed with `create exec failed with [404] No such container: ...` while the container was still being created. See below. |
| `container.images` | Undefined | `ctx.container.images` is `undefined`. |
| `interceptOutboundHttp`, `interceptAllOutboundHttp` | Rejected | Both reject with `... is not implemented in celld`. |
| `inspect`, `snapshotDirectory`, `snapshotContainer` | Rejected | All three reject with `... is not implemented in celld`. |
| `S3Mount.mount()` | Unsupported | `@cloudflare/sandbox` 1.0.1's `S3Mount.mount()` failed with `interceptOutboundHttp() is not implemented in celld`. |
| `DirectoryBackup.intercept()` / `backup()` | Unsupported | `intercept()` failed with `interceptOutboundHttp() is not implemented in celld`; `backup()` then failed with `env.BACKUPS is not an R2 bucket binding` because the app has no R2 binding. |
| Sleep (idle eviction) | Pass | With `CELLD_IDLE_EVICT_S=2`, the object was evicted while idle. The next request reached a new object instance, and the same running container answered with its marker file and hostname intact. |
| Restart | Pass | Stopping and starting celld destroyed the container: the next request found `running` false and no marker file, and a new `start()` created a container with a different hostname. |

## The `exec()`-after-`start()` race

Cloudflare's `exec()` documentation says it "waits for a container that is
still starting". celld's `start()` is fire-and-forget: it returns before the
engine has created the container, and `exec()` rejects with
`create exec failed with [404] No such container: ...` until the container
exists. `container.running` is not a readiness signal either: celld sets it
when the run begins, before the engine has created the container, and the
value observed immediately after `start()` differed between the macOS and
Linux runs.

This is celld's behavior, not the CLI's: the CLI does not wrap `ctx.container`.
The conformance app polls `exec()` for readiness, which is the workaround an
application needs on celld 0.6.2. Upstream celld would need to make `exec()`
wait for a starting container, as Cloudflare documents; the CLI cannot fix it
without replacing the runtime's `ctx.container`.

## What remains unsupported

- `S3Mount` and `DirectoryBackup` need `interceptOutboundHttp`, which celld
  0.6.2 rejects. `S3Mount` also needs FUSE and `s3fs` in the image; celld's
  default runtime drops all Linux capabilities and does not pass `/dev/fuse`,
  so a mount would not work even if the intercept existed.
- `inspect()`, `snapshotDirectory()`, `snapshotContainer()` and
  `container.images` are not implemented.
- `enableInternet: false` is enforced on Linux; celld documents that it has no
  effect on macOS, where the node reaches a container through a published port.
- A bare-metal Linux host, Linux x64, and containers on Wrangler or Cloudflare
  were not tested.
- The earlier manual macOS run exercised `@cloudflare/sandbox`'s
  `Files.writeFile`/`readFile`; this suite does not repeat that check.
