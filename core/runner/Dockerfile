# Runner image: the measurement tools at fixed versions. The engine code is mounted from the repository.
FROM alpine:3.22.8
ARG TARGETARCH
ARG OHA_VERSION=1.17.0
# Checksums of the release binaries; update both together with OHA_VERSION.
ARG OHA_SHA256_AMD64=85c6eb98066b8c8bd513b2dd96fafd8f9863249ea653606bae1ca2e3a75c43d2
ARG OHA_SHA256_ARM64=0b360c858f6277a5fca691d38adbd2dbc8c344d049ddf1a12fee8a762351ea24
RUN apk add --no-cache python3 wrk docker-cli docker-cli-buildx util-linux procps curl ca-certificates git
RUN set -eu; \
    case "${TARGETARCH}" in \
      amd64) sum="${OHA_SHA256_AMD64}" ;; \
      arm64) sum="${OHA_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/oha "https://github.com/hatoo/oha/releases/download/v${OHA_VERSION}/oha-linux-${TARGETARCH}"; \
    echo "${sum}  /usr/local/bin/oha" | sha256sum -c -; \
    chmod +x /usr/local/bin/oha; \
    oha --version; python3 --version; wrk -v 2>&1 | head -n 1
