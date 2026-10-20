# The soak runner: the published serverless-objects CLI, MinIO as the
# bucket, and soak.js driving load and faults. Build from this folder:
#   docker build --build-arg SOBJECTS_VERSION=0.9.1 -t sobjects-soak .
FROM minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e AS minio

FROM node:22-bookworm-slim
ARG SOBJECTS_VERSION=0.9.1
COPY --from=minio /usr/bin/minio /usr/bin/mc /usr/local/bin/
RUN npm install -g serverless-objects@${SOBJECTS_VERSION} && npm cache clean --force
WORKDIR /soak/runner
COPY journal.js soak.js ./
COPY app ./app
ENV SOAK_DATA=/soak/data SOAK_STATE=/soak/state
CMD ["node", "soak.js"]
