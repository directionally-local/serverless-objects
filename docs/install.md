# Install Serverless Objects

> **Status:** pre-alpha. `serverless-objects` is published on npm as a 0.13.x test release; do not treat it as a production-ready service.

## Requirements

- Node.js 22.23.4+, 24.22.1+ or 26.12.1+, and npm. Older versions have the Brotli decoder bug CVE-2026-111497; the CLI warns when it runs on one.
- A supported celld binary platform: macOS arm64 or Linux arm64/x64. celld does not currently provide a Windows binary.
- An S3-compatible bucket supported by celld, with conditional writes enabled. The bucket is the durable home for Durable Object state; local service state is separate.

## Install from npm

```sh
npm install --global serverless-objects
curl -fsSL -o sobjects.toml https://raw.githubusercontent.com/directionally-local/serverless-objects/main/sobjects.example.toml
```

The examples below run `sobjects` directly.

## Install from source

```sh
git clone https://github.com/directionally-local/serverless-objects.git
cd serverless-objects
npm ci
cp sobjects.example.toml sobjects.toml
```

From a checkout, run the CLI as `npm exec --workspace=serverless-objects -- sobjects` instead of `sobjects`.

Edit `sobjects.toml` and replace the example `[celld].bucket` URI with a bucket you control. For an S3-compatible provider, configure `endpoint` and `region` when required. Keep credentials in the provider's standard credential chain or environment; never put them in TOML or commit them.

Start a single-node service:

```sh
sobjects up
```

The first start downloads the pinned celld release and verifies its checksum. The default celld listener is `127.0.0.1:8080`. Keep it on loopback; do not expose celld's unauthenticated HTTP or operator listener to the network.

## Run with Docker Compose

[`deploy/compose`](../deploy/compose) runs a node in Docker. The image installs this package from npm and bakes in the checksum-verified celld. celld and the admin API stay on loopback inside the container, and only the TLS ingress is published on 443 and 80. Its README covers a local trial with a bundled SeaweedFS bucket and the production settings.

## Add ingress

For production-facing traffic, configure TLS ingress in the same `sobjects.toml`. Choose one certificate mode:

- **Static certificate:** set `[ingress.tls]` to PEM certificate and private-key paths. Paths are relative to the config file when not absolute. `SIGHUP` reloads static certificates.
- **ACME HTTP-01:** configure `[ingress.acme]` with an email and `agree_to_terms = true`; configure `redirect_http` on port 80 and exact hostnames in `[[ingress.routes]]`. Public DNS and inbound port 80 must reach that listener. Wildcard hostnames require static certificates. Start with Let's Encrypt's staging `directory_url`; the default directory is production.

The ACME account key and certificate are kept in the service state directory with restrictive file and directory permissions. Pebble issuance has been exercised locally; production CA issuance and renewal have not.

## Run detached and inspect

```sh
sobjects up --detach
sobjects status
sobjects logs
sobjects down
```

Detached mode records local process and log metadata; it is not an OS service manager. To generate a systemd or launchd unit, use `sobjects service print` or `sobjects service install` and review the result before enabling it.

The optional `[admin]` API/dashboard must stay on loopback. It provides local health, object and storage inspection; it is not a public control plane. Apart from its health and metrics routes, it requires the admin token that the supervisor creates in the state directory: run `sobjects dashboard`, as the same user and with the same environment as `sobjects up`, to print a dashboard URL that carries it. Service state and logs default to the user's state directory (`$XDG_STATE_HOME/serverless-objects` or `~/.local/state/serverless-objects`); set `SOBJECTS_STATE_DIR` to relocate it. Engine binaries are managed under the user data directory; `SOBJECTS_DATA_DIR` can relocate that directory.

## Development and deployment

Use `sobjects dev [project]` for local celld development and `sobjects deploy [project]` to deploy a Wrangler-compatible project. The CLI accepts `wrangler.json` and `wrangler.jsonc`; review [Cloudflare porting notes](porting-from-cloudflare.md) before deploying an existing project. `sobjects dev` does not run ingress.

## Data and operational limits

- Use a bucket dedicated to the service. Do not point test commands at a bucket containing unrelated data.
- Single-node writes wait on the object store. One R2 smoke run from a Mac measured approximately 0.63–0.78 seconds per request; this is an environment-specific observation, not a latency guarantee.
- The dashboard's read-only GC-candidate view lists objects with superseded epochs; it is not a complete object-history inventory. celld 0.6 does not provide a supported point-in-time restore command, so this version cannot restore an older epoch.
- The current product is a single-host operating layer by default. The native engine can share one bucket across several named nodes (`--node-name`), but there is no multi-tenant isolation, SSO, audit log or fleet control plane.

See the [compatibility table](compatibility.md) for tested behavior and known gaps.
