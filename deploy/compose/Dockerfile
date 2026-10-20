# Serverless Objects node: the sobjects CLI from npm plus the pinned celld
# release, verified by checksum at build time. celld, its operator listener
# and the admin API stay on loopback inside the container; only the TLS
# ingress is published.
FROM node:22-bookworm-slim

# x-release-please-start-version
ARG SOBJECTS_VERSION=0.1.2
# x-release-please-end

RUN npm install --global --no-audit --no-fund "serverless-objects@${SOBJECTS_VERSION}" \
  && SOBJECTS_DATA_DIR=/tmp/engine sobjects upgrade \
  && install -m 0755 /tmp/engine/engines/celld-*/celld /usr/local/bin/celld \
  && rm -rf /tmp/engine /root/.npm \
  && useradd --system --create-home --home-dir /var/lib/serverless-objects --shell /usr/sbin/nologin sobjects

ENV SOBJECTS_CELLD_BIN=/usr/local/bin/celld \
    SOBJECTS_CONFIG=/etc/serverless-objects/sobjects.toml \
    SOBJECTS_DATA_DIR=/var/lib/serverless-objects/data \
    SOBJECTS_STATE_DIR=/var/lib/serverless-objects/state

USER sobjects
WORKDIR /var/lib/serverless-objects
VOLUME /var/lib/serverless-objects
# The ingress binds 443 and 80 as this user; compose.yaml lowers
# net.ipv4.ip_unprivileged_port_start inside the container's network namespace.
EXPOSE 443 80

# Needs [admin] listen = "127.0.0.1:8790" in sobjects.toml.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8790/api/v1/health').then((r) => r.json()).then((b) => process.exit(b.ok ? 0 : 1), () => process.exit(1))"]

ENTRYPOINT ["sobjects"]
CMD ["up"]
