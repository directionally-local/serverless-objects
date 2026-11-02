# A tiny HTTP server plus the sandbox tools that @cloudflare/sandbox 1.0.1
# expects. The shim is copied from Cloudflare's tools-only image; it is an
# x86-64 static binary, so it runs under the host's binfmt emulation on arm64.
FROM python:3.12-alpine

RUN apk add --no-cache fuse3 s3fs-fuse
COPY --from=cloudflare/sandbox:1.0.1 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN chmod +x /usr/local/bin/sandbox-shim

WORKDIR /app
COPY server.py .
ENV PORT=8080
EXPOSE 8080
CMD ["python3", "server.py"]
