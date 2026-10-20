# Docker Compose

A single-node Serverless Objects host in Docker. The image installs the `serverless-objects` CLI from npm and bakes in the pinned celld release, verified by checksum at build time.

- **Security boundary:** celld, its operator API and the admin dashboard listen on loopback inside the container. Only the TLS ingress is published, on ports 443 and 80.
- **User:** the processes run as the unprivileged `sobjects` user (uid 999). Compose lowers `net.ipv4.ip_unprivileged_port_start` for the container so that user can bind 443 and 80.
- **State:** Durable Object state lives in your bucket. The `sobjects-data` volume keeps local service state: the inspector token, ACME account and certificates, and logs.

The `local-s3` profile adds a SeaweedFS server and creates a bucket, for trying it out on one machine. For real use, point `[celld]` at Cloudflare R2, S3 or another store with conditional writes, and leave the profile off.

## Try it with a local bucket

From this directory:

```sh
cp .env.example .env                    # set a long random AWS_SECRET_ACCESS_KEY
cp sobjects.toml.example sobjects.toml
mkdir -p tls apps

# A self-signed certificate for localhost. Use real certificates or [ingress.acme] in production.
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 30 \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost" \
  -keyout tls/privkey.pem -out tls/fullchain.pem
chmod 644 tls/privkey.pem               # readable by the container user; see Notes

docker compose --profile local-s3 up -d --build
```

Put a Wrangler project in `apps/` and deploy it from inside the container. Running it there means it uses the node's config and inspector token:

```sh
cp -R /path/to/my-worker apps/my-worker
docker compose exec sobjects sobjects deploy /apps/my-worker
curl -k https://localhost/
```

The container reports healthy once the first deployment is being served; until then celld has nothing to listen for.

## Production

1. **Bucket:** in `sobjects.toml`, set `[celld].bucket`, plus `endpoint` and `region` if your store needs them. Put the matching credentials in `.env`, and drop the `LOCAL_BUCKET` line.
2. **Certificates:** either put them in `tls/` (reload with `docker compose kill -s HUP sobjects`), or replace `[ingress.tls]` with `[ingress.acme]`. ACME needs public DNS for each route hostname, and inbound port 80 must reach this host. Test with the Let's Encrypt staging `directory_url` first.
3. **Routes:** set `[[ingress.routes]]` to your hostnames instead of `*`.
4. **Start:** run `docker compose up -d --build`.

Useful commands:

```sh
docker compose logs -f sobjects
docker compose exec sobjects sobjects upgrade --status
docker compose exec sobjects node -e 'fetch("http://127.0.0.1:8790/api/v1/node").then(r => r.json()).then(console.log)'
```

The dashboard and admin API are unauthenticated and stay on loopback inside the container. To view the dashboard, forward the port over SSH or use `docker compose exec`; don't publish port 8790.

## Notes

- **Pinned versions:** the image pins `serverless-objects` with the `SOBJECTS_VERSION` build argument (default `0.1.2`), and that CLI pins celld 0.6.2. To upgrade, change the argument and rebuild.
- **Graceful stop:** on stop, celld drains and releases its lease. `stop_grace_period` is 60 s; a stop took about 17 s in testing.
- **Key permissions:** the private key must be readable by uid 999. Prefer `chown 999 tls/privkey.pem && chmod 600 tls/privkey.pem` on Linux hosts.
- **Platforms:** linux/arm64 and linux/amd64. The full stack has been tested on arm64 (Docker on macOS). CI builds the amd64 image and checks that `sobjects` and `celld` run in it.
- **Tested** with `--profile local-s3` on Docker Desktop for macOS (arm64), Compose v5.1.3:
  - deploy from inside the container
  - HTTPS on 443, and a `308` from port 80 to `https://localhost/...`
  - healthcheck green after the first deploy
  - state kept across `down` and `up`
