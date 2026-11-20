# Base of every ts-compilers image: glibc (the tsrs binary is linked against it), a pinned Node.js (tsc 6 runs on
# it, the other tools ship Node launchers), Python for the in-container timer (images/tool adds it) and git to
# fetch the workloads. The harness passes NODE from `[defaults] node` of domain.toml and records it with
# every result.
ARG NODE
FROM node:${NODE}-trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 \
 && rm -rf /var/lib/apt/lists/*
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
COPY fetch.sh /bench/
