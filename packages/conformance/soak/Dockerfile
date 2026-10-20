# The soak runner: the published serverless-objects CLI, SeaweedFS as the
# backup bucket, and soak.js driving load and faults. Build from this folder:
#   docker build --build-arg SOBJECTS_VERSION=0.6.2 -t sobjects-soak .
FROM chrislusf/seaweedfs@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d AS seaweedfs

FROM node:22-bookworm-slim
ARG SOBJECTS_VERSION=0.6.2
COPY --from=seaweedfs /usr/bin/weed /usr/local/bin/weed
RUN npm install -g serverless-objects@${SOBJECTS_VERSION} && npm cache clean --force
WORKDIR /soak/runner
COPY journal.js soak.js ./
COPY app ./app
ENV SOAK_DATA=/soak/data SOAK_STATE=/soak/state
CMD ["node", "soak.js"]
