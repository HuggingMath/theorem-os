FROM oven/bun:1.4.0 AS bun
FROM docker:29-cli AS docker-cli

# Compile against the worker's libc; a binary from the development host may
# require a newer glibc even when the Codex source and architecture match.
FROM rust:1.95.0-bookworm AS codex-backend
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 cmake pkg-config libssl-dev libcap-dev libasound2-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY scripts/build-codex-backend.sh scripts/build-codex-backend.sh
COPY scripts/codex-backend/ scripts/codex-backend/
ARG CODEX_BUILD_JOBS=4
RUN --mount=type=cache,id=theoremos-codex-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=theoremos-codex-git,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,id=theoremos-bookworm-codex-target,target=/build/artifacts/target,sharing=locked \
    bash scripts/build-codex-backend.sh --source /build/upstream --downloads /build/downloads \
      --output /build/artifacts --jobs "$CODEX_BUILD_JOBS"

FROM node:22-bookworm-slim AS base
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git python3 util-linux bubblewrap elan \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/theorem-os
COPY package.json bun.lock tsconfig.json extraction.json ./
RUN bun install --frozen-lockfile

FROM base AS source
COPY bin ./bin
COPY src ./src
COPY scripts ./scripts
COPY skills ./skills
COPY resources ./resources
COPY apps ./apps
COPY docs/assets ./docs/assets
COPY LICENSE ./LICENSE

FROM base AS worker-tools
ENV ELAN_HOME=/opt/elan \
    PATH=/opt/elan/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin \
    HOME=/work/home \
    DEEPSCIENTIST_MATH_SANDBOX_BACKEND=bwrap \
    DEEPSCIENTIST_MATH_TRUSTED_ELAN_ROOTS=/opt/elan
COPY scripts/install-elan.sh ./scripts/install-elan.sh
RUN npm install --global @openai/codex@0.162.0 \
    && sh scripts/install-elan.sh \
    && elan toolchain install leanprover/lean4:v4.33.0 \
    && chmod -R a+rX /opt/elan \
    && mkdir -p /work && chown 10001:10001 /work

FROM worker-tools AS worker-mathlib
RUN apt-get -o Acquire::Retries=3 update && apt-get install -y --no-install-recommends \
    build-essential fuse3 squashfuse squashfs-tools \
    && rm -rf /var/lib/apt/lists/*
COPY resources/mathlib/environment.json ./resources/mathlib/environment.json
COPY scripts/prepare-web-mathlib.ts ./scripts/prepare-web-mathlib.ts
RUN --mount=type=cache,id=theoremos-mathlib-v4.33.0,target=/var/cache/theoremos-mathlib,sharing=locked \
    MATHLIB_CACHE_DIR=/var/cache/theoremos-mathlib bun scripts/prepare-web-mathlib.ts \
    && chmod -R a+rX /opt/theoremos-mathlib \
    && chown 10001:10001 /var/tmp && chmod 0700 /var/tmp
COPY scripts/build-pantograph.ts ./scripts/build-pantograph.ts
RUN bun scripts/build-pantograph.ts /opt/theoremos-pantograph

FROM worker-mathlib AS worker
ENV TMPDIR=/tmp \
    PATH=/opt/elan/toolchains/leanprover--lean4---v4.33.0/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin \
    DEEPSCIENTIST_MATH_TRUSTED_ELAN_ROOTS=/opt/elan/toolchains/leanprover--lean4---v4.33.0 \
    DEEPSCIENTIST_MATH_TRUSTED_CACHE_ROOTS=/opt/theoremos-mathlib/.lake/packages
COPY --from=source /opt/theorem-os /opt/theorem-os
RUN bun scripts/prepare-web-library.ts \
    && chmod -R a+rX /opt/theoremos-library
# Use the installed binaries directly: the verifier mounts the toolchain read-only.
# Agent shells cannot read /opt/theorem-os or /opt/runtime-state; they run the bundled commands instead.
RUN bun scripts/build.ts --state-root /opt/runtime-state > /opt/theoremos-build.json \
    && bun scripts/build-agent-tools.ts --out /opt/theoremos-agent-tools > /dev/null \
    && bun scripts/build-proof-environment-seed.ts --project /opt/theoremos-mathlib \
       --packages /opt/theoremos-mathlib/.lake/packages --out /opt/theoremos-proof-environment-seed \
    && bun scripts/build-proof-environment-seed.ts --project /opt/theoremos-mathlib \
       --packages /opt/theoremos-mathlib/.lake/packages --out /opt/theoremos-proof-source-seed --sources-only \
    && chmod -R a+rX /opt/runtime-state /opt/theoremos-agent-tools \
    && chmod 0555 apps/web/worker-entrypoint.sh
ENV DEEPSCIENTIST_MATH_PROOF_ENVIRONMENT_SEED=/opt/theoremos-proof-environment-seed/manifest.json
ENV DEEPSCIENTIST_MATH_PROOF_ENVIRONMENT_SOURCE_SEED=/opt/theoremos-proof-source-seed/manifest.json
# The source commit this image was built from (scripts/web-deploy-record.sh records it with the image digests).
ARG THEOREMOS_SOURCE_COMMIT=unknown
LABEL org.opencontainers.image.revision=$THEOREMOS_SOURCE_COMMIT
ENV THEOREMOS_SOURCE_COMMIT=$THEOREMOS_SOURCE_COMMIT
COPY --from=codex-backend /build/artifacts/bin/codex /opt/theoremos-codex-backend/codex
ENV THEOREMOS_CODEX_BACKEND_EXECUTABLE=/opt/theoremos-codex-backend/codex
USER 10001:10001
RUN timeout 30s python3 scripts/codex-backend/check-capabilities.py "$THEOREMOS_CODEX_BACKEND_EXECUTABLE"
LABEL org.theoremos.native-agent-control=v1
LABEL org.theoremos.team-profile-preferences=v1
LABEL org.theoremos.team-expert-cards=v1
ENTRYPOINT ["/opt/theorem-os/apps/web/worker-entrypoint.sh"]

FROM source AS web
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY docs/web ./docs/web
COPY docs/archive.html docs/site.css docs/process.css docs/replay.css ./docs/
COPY docs/en/archive.html ./docs/en/archive.html
COPY research/openai-math ./research/openai-math
ARG THEOREMOS_SOURCE_COMMIT=unknown
RUN bun scripts/build-web.ts
LABEL org.opencontainers.image.revision=$THEOREMOS_SOURCE_COMMIT
ENV THEOREMOS_WEB_HOST=0.0.0.0 THEOREMOS_WEB_PORT=8787 THEOREMOS_SOURCE_COMMIT=$THEOREMOS_SOURCE_COMMIT
EXPOSE 8787
CMD ["bun", "apps/web/server.ts"]
