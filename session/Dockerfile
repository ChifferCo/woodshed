# syntax=docker/dockerfile:1.7
#
# Woodshed session image: everything one Claude session needs except the
# databases, which it reaches over the network. Build from the repo root:
#
#   bash woodshed/session/stageDeps.sh woodshed-deps    # also writes woodshed-deps.editor and woodshed-deps.installs
#   docker build -f woodshed/session/Dockerfile \
#     --secret id=gh_token,env=GH_TOKEN \
#     --secret id=install_env,src=install.env \
#     --build-arg REPO=owner/name --build-arg REPO_DIR=/work/name \
#     -t woodshed-session .
#
# The repo inside the image is cloned from GitHub, not copied from the build
# context, so it is the same checkout whoever builds it. Only this folder,
# Woodshed's pane classifier and the files the project file's installs depend on (woodshed-deps/) come from the
# context (Dockerfile.dockerignore).
#
# The `runtime` stage is everything that is the same for every repository and changes at most weekly: the system
# packages, the CLIs and Chromium. .github/workflows/sessionRuntime.yml publishes it as ghcr.io/chifferco/woodshed-session-runtime, and
# --build-arg RUNTIME=<that image> builds the repository's part on it instead of building the runtime here, which is
# most of the time and memory a first build takes (install.sh does this). Without RUNTIME the stage is built here.
#
# The deploy workflow's session job builds with a layer cache in ECR. These build args decide
# what it rebuilds: BASE_WEEK the system packages, CLAUDE_DAY the Claude CLI and
# BUILD_SHA the checkout. The repo's installs run again only when their files or the project file's installs change.

ARG RUNTIME=runtime
# Global, so the stages built on a published runtime (the editor's layer, Claude's MCP) get the same pins.
ARG PLAYWRIGHT_MCP_VERSION=0.0.83
ARG OPENVSCODE_VERSION=1.109.5
ARG OPENVSCODE_SHA256_AMD64=b433bf4f0227321a7014d8460d10a8f958adc0f45aa79bd889e84e65e8f88363
ARG OPENVSCODE_SHA256_ARM64=36d9c14036489b63de84ebace837fcacf7e60e669a0dc715802c5443684ea4dc
# Docker's static build and its compose plugin: the CLI, for a session given the machine's Docker through its socket
# (providers/local/dockerLauncher.mjs, hostDocker), and the daemon with containerd and runc, for a session that runs
# its own under Sysbox (ownDocker, session/ownDocker.sh). Docker publishes no checksum for its static builds, so these
# are the sha256 of the files as first downloaded; compose's are its release's checksums.txt.
ARG DOCKER_VERSION=29.9.2
ARG DOCKER_SHA256_AMD64=9ac225999fd5e863f7694c728ef23d480616b1e5639328fa309befd4243d69eb
ARG DOCKER_SHA256_ARM64=873b3e0207857c3b2f28392fb922f3ea6efe37620c16d4d4aaf2fef409c90b73
ARG COMPOSE_VERSION=5.6.1
ARG COMPOSE_SHA256_AMD64=47737f4236e6d3ccea7291995203f8f018058783b4c3a9469119811a0b5db8c0
ARG COMPOSE_SHA256_ARM64=42cfa75f51ad0ccf290bad37899e0038a8c10a0069e85233ecc1d53e3ff1347d
# buildx, which `docker build` and compose's builds need for BuildKit (RUN --mount, cache mounts, this Dockerfile's own
# syntax): without it the CLI falls back to the legacy builder. Its release's checksums.txt.
ARG BUILDX_VERSION=0.38.1
ARG BUILDX_SHA256_AMD64=e25d5cd675092bb5d1d03632fdc46cdf3fede7b514dc5f023a105e00d3ce5ad4
ARG BUILDX_SHA256_ARM64=3b83b3731916ba433feccaaa689fe5bcdc81c641d92c8e6c2ea865dfa141c97a
# psql, for the session's own Postgres databases (the PG* variables, docs/reference.md "Databases"): the client alone,
# from PostgreSQL's apt repository, at the major the installations host (RDS's engine_version in providers/aws, the
# local provider's postgres:16), as the console's is. Debian bookworm's own is 15, older than the servers; a newer one's
# pg_dump would write dumps a 16 server cannot restore.
ARG PG_CLIENT_MAJOR=16

# The agents that run on their owner's own sign-in (shared/agents.cjs), installed in the runtime stage. Global, so the
# last stage can add them to a published runtime from before them.
ARG OPENCODE_VERSION=1.19.6
# Grok Build: the raw binary x.ai's installer downloads (https://x.ai/cli/install.sh), which publishes no checksums: these
# are sha256 of the 1.0.92 binaries as downloaded, so a changed file fails the build.
ARG GROK_VERSION=1.0.92
ARG GROK_SHA256_AMD64=add4d201dbf2c0bd6077a36feb55a76939de30bae48dbb06f16b2307d38ceacb
ARG GROK_SHA256_ARM64=8c74f1dc6cdc1befff6b9faada06bec4cf6759d04f2a60cdc28ece5ff696b44f
# Antigravity CLI (`agy`): the tarball Google's installer (https://antigravity.google/cli/install.sh) downloads, at the build
# it names in its release manifest ($base/manifests/linux_<arch>.json, glibc), with that manifest's sha512 checked here as the
# installer checks it. The installer itself is not run: it always takes the latest and then runs the binary's own `install`,
# which sets up shells. A changed file, or a version bump with no new sha512, fails the build.
ARG AGY_VERSION=1.5.18
ARG AGY_BUILD=6386224290725888
ARG AGY_SHA512_AMD64=ef379ec869719112f696e8c7cfddf776618712e58fc38e53df80801d6528abb4677782c7c8778f9c09c9123fa44c2c32675d228c06f2a8f7a8f4214e75f5bb26
ARG AGY_SHA512_ARM64=6c59cbce5a7632083dd4ef594296e52ce0abdc12f8b4ecb55523e093748cf178f8f8383d7e51e9ed7859ea6e46c83a43a7b46364b0e033dd13afb24d6bfbe4c8

FROM node:22.16.0-bookworm-slim AS base

ARG TTYD_VERSION=1.7.7
ARG TTYD_SHA256_AMD64=8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55
ARG TTYD_SHA256_ARM64=b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165
# Herdr's terminal runtime, herdr-core (`hc`), for a private session whose owner picked Herdr on My settings
# (session/agentPane.mjs).
# The sha256 are its release's manifest.json (releases.herdr.dev/core/<version>/manifest.json).
ARG HERDR_CORE_VERSION=0.1.21
ARG HERDR_CORE_SHA256_AMD64=78424755c10a40dde38a0bdb55c20ac19706e9ae05ed68fc2acf1fcff0d941c1
ARG HERDR_CORE_SHA256_ARM64=e844a2bfab48a226097679d076bc83042fe57fccef5387ef802e5b24e78b529a
# Set by BuildKit to the platform being built (amd64 or arm64), which is also Debian's name for it.
ARG TARGETARCH
ARG PLAYWRIGHT_MCP_VERSION
ARG CODEX_VERSION=0.167.0
ARG REDIS_COMMANDER_VERSION=0.9.0
ARG PG_CLIENT_MAJOR
# AWS's RDS CA bundle, so Postgres connections can verify the server (PGSSLMODE=verify-full in the task
# definition). Pinned: when AWS changes the bundle the build fails here, rather than trusting what it got.
ARG RDS_CA_SHA256=90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b

# Changes once a week in the deploy workflow's session job, so security updates and a new gh still arrive.
ARG BASE_WEEK=
# The slim base has no compiler: g++, make and python3 are for native modules a repo's install builds from source,
# here and in a session that reinstalls. The rest are tools the full base had that sessions use.
RUN apt-get update \
  && apt-get install -y --no-install-recommends bzip2 ca-certificates curl file g++ git gnupg iproute2 iptables jq make openssh-client patch procps python3 redis-server tmux unzip wget xz-utils \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/keyrings/pgdg.asc \
  && echo "deb [signed-by=/usr/share/keyrings/pgdg.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh "postgresql-client-${PG_CLIENT_MAJOR}" \
  && rm -rf /var/lib/apt/lists/*

RUN case "$TARGETARCH" in \
    amd64) ttyd_arch=x86_64; ttyd_sha="$TTYD_SHA256_AMD64" ;; \
    arm64) ttyd_arch=aarch64; ttyd_sha="$TTYD_SHA256_ARM64" ;; \
    *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
  esac \
  && curl -fsSL -o /usr/local/bin/ttyd "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${ttyd_arch}" \
  && echo "${ttyd_sha}  /usr/local/bin/ttyd" | sha256sum -c - \
  && chmod +x /usr/local/bin/ttyd

# One static binary, and `hc`, the name its CLI and its docs use. A new version comes in by these pins, never `hc update`.
RUN case "$TARGETARCH" in \
    amd64) hc_arch=x86_64; hc_sha="$HERDR_CORE_SHA256_AMD64" ;; \
    arm64) hc_arch=aarch64; hc_sha="$HERDR_CORE_SHA256_ARM64" ;; \
    *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
  esac \
  && curl -fsSL -o /tmp/herdr-core.tar.gz "https://releases.herdr.dev/core/${HERDR_CORE_VERSION}/herdr-core-linux-${hc_arch}.tar.gz" \
  && echo "${hc_sha}  /tmp/herdr-core.tar.gz" | sha256sum -c - \
  && mkdir -p /usr/local/share/herdr-core \
  && tar -xzf /tmp/herdr-core.tar.gz -C /usr/local/share/herdr-core \
  && install -m 755 /usr/local/share/herdr-core/herdr-core /usr/local/bin/herdr-core \
  && rm /tmp/herdr-core.tar.gz /usr/local/share/herdr-core/herdr-core \
  && ln -s herdr-core /usr/local/bin/hc \
  && hc --version

RUN curl -fsSL -o /etc/ssl/certs/rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
  && echo "${RDS_CA_SHA256}  /etc/ssl/certs/rds-global-bundle.pem" | sha256sum -c -
# Adds to Node's trusted CAs rather than replacing them.
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem

# A private session's own database viewers (startDbViewers in entrypoint.sh), from their official images, pinned by
# digest. pgweb is one static binary; mongo-express is plain JavaScript with no native module, so it runs on this
# Node. Its npm package pulls a dependency from GitHub, which this copy avoids.
COPY --link --from=sosedoff/pgweb:0.17.0@sha256:a5256d416e2e8b92d69a4459058e3eca33a9f075d8325491644411d0bc3bd70b /usr/bin/pgweb /usr/local/bin/pgweb
COPY --link --from=mongo-express:1.0.2-20-alpine3.19@sha256:1aae0077525133249133d42980ba23998712a1077e02ac0ac295b50a7a79d550 /app /opt/mongo-express

FROM base AS runtime

RUN npm install -g npm@10.9.0 "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" "redis-commander@${REDIS_COMMANDER_VERSION}" "@openai/codex@${CODEX_VERSION}" \
  && cd "$(npm root -g)/@playwright/mcp" && npx playwright install-deps chromium \
  && npm cache clean --force && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /work && chown node:node /work

# Docker and compose (the ARGs above say why): every binary of the static build, the daemon's too, and the docker group
# that owns a session's own daemon's socket, with node in it. The last stage adds them to a published runtime from
# before they were here, until it is published again.
ARG TARGETARCH
ARG DOCKER_VERSION
ARG DOCKER_SHA256_AMD64
ARG DOCKER_SHA256_ARM64
ARG COMPOSE_VERSION
ARG COMPOSE_SHA256_AMD64
ARG COMPOSE_SHA256_ARM64
ARG BUILDX_VERSION
ARG BUILDX_SHA256_AMD64
ARG BUILDX_SHA256_ARM64
RUN case "$TARGETARCH" in \
    amd64) arch=x86_64; docker_sha="$DOCKER_SHA256_AMD64"; compose_sha="$COMPOSE_SHA256_AMD64"; buildx_arch=amd64; buildx_sha="$BUILDX_SHA256_AMD64" ;; \
    arm64) arch=aarch64; docker_sha="$DOCKER_SHA256_ARM64"; compose_sha="$COMPOSE_SHA256_ARM64"; buildx_arch=arm64; buildx_sha="$BUILDX_SHA256_ARM64" ;; \
    *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
  esac \
  && curl -fsSL -o /tmp/docker.tgz "https://download.docker.com/linux/static/stable/${arch}/docker-${DOCKER_VERSION}.tgz" \
  && echo "${docker_sha}  /tmp/docker.tgz" | sha256sum -c - \
  && tar -xzf /tmp/docker.tgz -C /usr/local/bin --strip-components=1 && rm /tmp/docker.tgz \
  && { getent group docker >/dev/null || groupadd --system docker; } && usermod -aG docker node \
  && mkdir -p /usr/local/lib/docker/cli-plugins \
  && curl -fsSL -o /usr/local/lib/docker/cli-plugins/docker-compose "https://github.com/docker/compose/releases/download/v${COMPOSE_VERSION}/docker-compose-linux-${arch}" \
  && echo "${compose_sha}  /usr/local/lib/docker/cli-plugins/docker-compose" | sha256sum -c - \
  && chmod 755 /usr/local/lib/docker/cli-plugins/docker-compose \
  && curl -fsSL -o /usr/local/lib/docker/cli-plugins/docker-buildx "https://github.com/docker/buildx/releases/download/v${BUILDX_VERSION}/buildx-v${BUILDX_VERSION}.linux-${buildx_arch}" \
  && echo "${buildx_sha}  /usr/local/lib/docker/cli-plugins/docker-buildx" | sha256sum -c - \
  && chmod 755 /usr/local/lib/docker/cli-plugins/docker-buildx

# Grok Build as `grok`, the name its own installer gives it, OpenCode from npm, whose postinstall puts the
# platform's binary in place of a stub (so scripts must run), and Antigravity CLI as `agy`. Pinned by the ARGs at the top.
# None updates itself in a session: their wrappers in session/bin and the configs the entrypoint writes turn their updaters off, rather than
# ENV here, which the db-admin task would refuse (dbAdmin.mjs, unexpectedEnv). The last stage installs them again on a
# published runtime built before they were in it.
ARG OPENCODE_VERSION
ARG GROK_VERSION
ARG GROK_SHA256_AMD64
ARG GROK_SHA256_ARM64
ARG AGY_VERSION
ARG AGY_BUILD
ARG AGY_SHA512_AMD64
ARG AGY_SHA512_ARM64
RUN case "$TARGETARCH" in \
    amd64) grok_arch=x86_64; grok_sha="$GROK_SHA256_AMD64"; agy_file=linux-x64/cli_linux_x64.tar.gz; agy_sha="$AGY_SHA512_AMD64" ;; \
    arm64) grok_arch=aarch64; grok_sha="$GROK_SHA256_ARM64"; agy_file=linux-arm/cli_linux_arm64.tar.gz; agy_sha="$AGY_SHA512_ARM64" ;; \
    *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
  esac \
  && { curl -fsSL -o /tmp/grok "https://x.ai/cli/grok-${GROK_VERSION}-linux-${grok_arch}" \
    || curl -fsSL -o /tmp/grok "https://storage.googleapis.com/grok-build-public-artifacts/cli/grok-${GROK_VERSION}-linux-${grok_arch}"; } \
  && echo "${grok_sha}  /tmp/grok" | sha256sum -c - \
  && install -m 755 /tmp/grok /usr/local/bin/grok && rm /tmp/grok \
  && npm install -g "opencode-ai@${OPENCODE_VERSION}" && npm cache clean --force \
  && curl -fsSL -o /tmp/agy.tar.gz "https://storage.googleapis.com/antigravity-public/antigravity-cli/${AGY_VERSION}-${AGY_BUILD}/${agy_file}" \
  && echo "${agy_sha}  /tmp/agy.tar.gz" | sha512sum -c - \
  && tar -xzf /tmp/agy.tar.gz -C /tmp antigravity \
  && install -m 755 /tmp/antigravity /usr/local/bin/agy && rm /tmp/agy.tar.gz /tmp/antigravity \
  && echo "grok ${GROK_VERSION}, opencode ${OPENCODE_VERSION}, agy ${AGY_VERSION}" > /usr/local/share/woodshed-agents

# The session should not be root: the node image's own uid 1000 user runs everything below.
USER node
ENV PATH=/home/node/.local/bin:$PATH
# Without a UTF-8 locale, Debian's tmux shows every non-ASCII character as `_`.
ENV LANG=C.UTF-8

# Claude, Chromium, the checkout and each node_modules are separate layers on purpose: BuildKit gzips layers in
# parallel, and gzipping one layer that held them all was most of the session job's build time.
# --no-shell: the MCP runs the full Chromium even when headless, so the separate headless shell is never used.
RUN cd "$(npm root -g)/@playwright/mcp" && npx playwright install --no-shell chromium

# On the runtime rather than base, so a build on a published runtime builds none of Woodshed's own layers.
FROM ${RUNTIME} AS deps

USER root

# The repo's checkout folder, /work/<name>.
ARG REPO_DIR
# The project file's installs (session/deps.sh), keyed on their files and the manifest alone: a commit that changes
# neither reuses them from the cache. The deploy workflow's session job puts each install's files under woodshed-deps/, in the repo's
# own layout, so what is installed here is what the checkout will hold.
RUN test -n "$REPO_DIR" || { echo "REPO_DIR is not set: build with --build-arg REPO_DIR=/work/<repo name>" >&2; exit 1; } \
  && mkdir -p "$REPO_DIR" /woodshed-out && chown node:node "$REPO_DIR" /woodshed-out
COPY --chown=node:node woodshed-deps/ ${REPO_DIR}/
USER node
# Installed where the checkout will be, so what an install keeps works at the same path in the final stage. A home of
# its own, deleted after: what the installs keep under ~/ is moved out first, and their caches go with it. The
# optional install_env secret is `NAME=value` lines, the installation's install secrets under the variables its
# installs read: deps.sh exports them before the first install.
RUN --mount=type=secret,id=install_env,uid=1000,required=false \
  --mount=type=bind,source=woodshed-deps.installs,target=/tmp/woodshed-installs \
  --mount=type=bind,source=woodshed/session/deps.sh,target=/tmp/woodshed-deps.sh \
  cd "$REPO_DIR" && export HOME=/tmp/woodshed-home && mkdir -p "$HOME" \
  && INSTALL_ENV_FILE=/run/secrets/install_env bash /tmp/woodshed-deps.sh install /tmp/woodshed-installs /woodshed-out \
  && rm -rf "$HOME"

FROM ${RUNTIME}

# The runtime ends as node; the editor goes under /opt.
USER root
# The Editor button's VS Code (startCodeEditor in entrypoint.sh): Gitpod's MIT-licensed build, with its own Node.
# The project file's `editor` (true or false), which stageDeps.sh writes beside woodshed-deps/: false leaves the editor
# out. Mounted, not copied, so the layer is built again only when that one value changes. Its own layer, about 75 MB,
# so SOCI fetches it only in a session whose editor someone opens.
ARG TARGETARCH
ARG OPENVSCODE_VERSION
ARG OPENVSCODE_SHA256_AMD64
ARG OPENVSCODE_SHA256_ARM64
RUN --mount=type=bind,source=woodshed-deps.editor,target=/tmp/woodshed-editor \
  editor=$(cat /tmp/woodshed-editor) \
  && if [ "$editor" != true ]; then echo "editor left out: the project file's editor is ${editor:-empty}"; exit 0; fi \
  && case "$TARGETARCH" in \
    amd64) ovs_arch=x64; ovs_sha="$OPENVSCODE_SHA256_AMD64" ;; \
    arm64) ovs_arch=arm64; ovs_sha="$OPENVSCODE_SHA256_ARM64" ;; \
    *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
  esac \
  && curl -fsSL -o /tmp/openvscode.tgz "https://github.com/gitpod-io/openvscode-server/releases/download/openvscode-server-v${OPENVSCODE_VERSION}/openvscode-server-v${OPENVSCODE_VERSION}-linux-${ovs_arch}.tar.gz" \
  && echo "${ovs_sha}  /tmp/openvscode.tgz" | sha256sum -c - \
  && mkdir -p /opt/openvscode-server && tar -xzf /tmp/openvscode.tgz -C /opt/openvscode-server --strip-components=1 \
  && rm /tmp/openvscode.tgz

# The runtime stage's Docker and compose, for a published runtime built before they were in it (or with others, or with
# the CLI alone): the same install, skipped when the runtime has these versions, the daemon and the docker group.
ARG DOCKER_VERSION
ARG DOCKER_SHA256_AMD64
ARG DOCKER_SHA256_ARM64
ARG COMPOSE_VERSION
ARG COMPOSE_SHA256_AMD64
ARG COMPOSE_SHA256_ARM64
ARG BUILDX_VERSION
ARG BUILDX_SHA256_AMD64
ARG BUILDX_SHA256_ARM64
RUN if docker --version 2>/dev/null | grep -qF "version ${DOCKER_VERSION}," \
    && [ "$(docker compose version --short 2>/dev/null)" = "${COMPOSE_VERSION}" ] \
    && docker buildx version 2>/dev/null | grep -qF " v${BUILDX_VERSION} " \
    && command -v dockerd >/dev/null && command -v iptables >/dev/null && id -nG node | grep -qw docker; then echo "docker ${DOCKER_VERSION}, compose ${COMPOSE_VERSION} and buildx ${BUILDX_VERSION} from the runtime"; exit 0; fi \
  && if ! command -v iptables >/dev/null; then apt-get update && apt-get install -y --no-install-recommends iptables && rm -rf /var/lib/apt/lists/*; fi \
  && case "$TARGETARCH" in \
    amd64) arch=x86_64; docker_sha="$DOCKER_SHA256_AMD64"; compose_sha="$COMPOSE_SHA256_AMD64"; buildx_arch=amd64; buildx_sha="$BUILDX_SHA256_AMD64" ;; \
    arm64) arch=aarch64; docker_sha="$DOCKER_SHA256_ARM64"; compose_sha="$COMPOSE_SHA256_ARM64"; buildx_arch=arm64; buildx_sha="$BUILDX_SHA256_ARM64" ;; \
    *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
  esac \
  && curl -fsSL -o /tmp/docker.tgz "https://download.docker.com/linux/static/stable/${arch}/docker-${DOCKER_VERSION}.tgz" \
  && echo "${docker_sha}  /tmp/docker.tgz" | sha256sum -c - \
  && tar -xzf /tmp/docker.tgz -C /usr/local/bin --strip-components=1 && rm /tmp/docker.tgz \
  && { getent group docker >/dev/null || groupadd --system docker; } && usermod -aG docker node \
  && mkdir -p /usr/local/lib/docker/cli-plugins \
  && curl -fsSL -o /usr/local/lib/docker/cli-plugins/docker-compose "https://github.com/docker/compose/releases/download/v${COMPOSE_VERSION}/docker-compose-linux-${arch}" \
  && echo "${compose_sha}  /usr/local/lib/docker/cli-plugins/docker-compose" | sha256sum -c - \
  && chmod 755 /usr/local/lib/docker/cli-plugins/docker-compose \
  && curl -fsSL -o /usr/local/lib/docker/cli-plugins/docker-buildx "https://github.com/docker/buildx/releases/download/v${BUILDX_VERSION}/buildx-v${BUILDX_VERSION}.linux-${buildx_arch}" \
  && echo "${buildx_sha}  /usr/local/lib/docker/cli-plugins/docker-buildx" | sha256sum -c - \
  && chmod 755 /usr/local/lib/docker/cli-plugins/docker-buildx

# The runtime stage's agents, for a published runtime built before they were in it: the same install, skipped when the
# runtime has these versions.
ARG OPENCODE_VERSION
ARG GROK_VERSION
ARG GROK_SHA256_AMD64
ARG GROK_SHA256_ARM64
ARG AGY_VERSION
ARG AGY_BUILD
ARG AGY_SHA512_AMD64
ARG AGY_SHA512_ARM64
RUN if [ "$(cat /usr/local/share/woodshed-agents 2>/dev/null)" = "grok ${GROK_VERSION}, opencode ${OPENCODE_VERSION}, agy ${AGY_VERSION}" ]; then echo "agents from the runtime"; exit 0; fi \
  && case "$TARGETARCH" in \
    amd64) grok_arch=x86_64; grok_sha="$GROK_SHA256_AMD64"; agy_file=linux-x64/cli_linux_x64.tar.gz; agy_sha="$AGY_SHA512_AMD64" ;; \
    arm64) grok_arch=aarch64; grok_sha="$GROK_SHA256_ARM64"; agy_file=linux-arm/cli_linux_arm64.tar.gz; agy_sha="$AGY_SHA512_ARM64" ;; \
    *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
  esac \
  && { curl -fsSL -o /tmp/grok "https://x.ai/cli/grok-${GROK_VERSION}-linux-${grok_arch}" \
    || curl -fsSL -o /tmp/grok "https://storage.googleapis.com/grok-build-public-artifacts/cli/grok-${GROK_VERSION}-linux-${grok_arch}"; } \
  && echo "${grok_sha}  /tmp/grok" | sha256sum -c - \
  && install -m 755 /tmp/grok /usr/local/bin/grok && rm /tmp/grok \
  && npm install -g "opencode-ai@${OPENCODE_VERSION}" && npm cache clean --force \
  && curl -fsSL -o /tmp/agy.tar.gz "https://storage.googleapis.com/antigravity-public/antigravity-cli/${AGY_VERSION}-${AGY_BUILD}/${agy_file}" \
  && echo "${agy_sha}  /tmp/agy.tar.gz" | sha512sum -c - \
  && tar -xzf /tmp/agy.tar.gz -C /tmp antigravity \
  && install -m 755 /tmp/antigravity /usr/local/bin/agy && rm /tmp/agy.tar.gz /tmp/antigravity \
  && echo "grok ${GROK_VERSION}, opencode ${OPENCODE_VERSION}, agy ${AGY_VERSION}" > /usr/local/share/woodshed-agents

# The base stage's psql, for a published runtime built before it was there: the same install, skipped when the runtime
# has that major.
ARG PG_CLIENT_MAJOR
RUN if psql --version 2>/dev/null | grep -qE "^psql \(PostgreSQL\) ${PG_CLIENT_MAJOR}\."; then echo "psql ${PG_CLIENT_MAJOR} from the runtime"; exit 0; fi \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/keyrings/pgdg.asc \
  && echo "deb [signed-by=/usr/share/keyrings/pgdg.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends "postgresql-client-${PG_CLIENT_MAJOR}" \
  && rm -rf /var/lib/apt/lists/*

# Grok Build's policy folder, made here as root and readable by node: copying its file below into a folder that is not
# there yet would give the folder the file's mode, 644, which node cannot open, and grok refuses to start (fail closed).
RUN install -d -m 755 /etc/grok

USER node

# Claude changes every day, so it is here rather than in the runtime: on the runtime, the installs built on it would run
# again each day too. After the editor, which changes less often.
ARG PLAYWRIGHT_MCP_VERSION
ARG CLAUDE_DAY=
RUN curl -fsSL https://claude.ai/install.sh | bash \
  && claude mcp add --scope user playwright -- npx "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" --headless --browser chromium

# The clone's own words never change, so without this a cached build would ship an old checkout. The clone is then
# moved to that commit, the one the build context and the image's tag come from, should the default branch have moved since.
# Before the token leaves the URL: the partial clone fetches that commit's files from GitHub.
ARG BUILD_SHA=
# The repo this image is for, owner/name, and where its checkout goes, /work/<name> (checkoutDir in shared/project.mjs).
# With REPO empty the image holds no checkout, only an empty REPO_DIR (install.sh's /work/.no-checkout), and needs no
# gh_token: every session clones its project's repo at start instead (PROJECT_REPO, useProjectRepo in entrypoint.sh)
# and runs that repo's installs there. install.sh builds it for a local install that names no repository.
ARG REPO
ARG REPO_DIR
RUN test -n "$REPO_DIR" || { echo "build with --build-arg REPO=<owner>/<name> --build-arg REPO_DIR=/work/<name>, or REPO= for no checkout" >&2; exit 1; }
RUN --mount=type=secret,id=gh_token,uid=1000 \
  if [ -z "$REPO" ]; then mkdir -p "$REPO_DIR"; echo "no checkout: each session clones its project's repo at start"; exit 0; fi \
  && git clone --filter=blob:none "https://x-access-token:$(cat /run/secrets/gh_token)@github.com/${REPO}.git" "$REPO_DIR" \
  && if [ -n "$BUILD_SHA" ]; then git -C "$REPO_DIR" reset --quiet --hard "$BUILD_SHA"; fi \
  && git -C "$REPO_DIR" remote set-url origin "https://github.com/${REPO}.git" \
  # A repo with submodules (such as a repo that pins Woodshed itself as one) gets them at the built commit's pins. Public
  # ones need no token; a repo without .gitmodules skips this.
  && if [ -f "$REPO_DIR/.gitmodules" ]; then git -C "$REPO_DIR" submodule update --quiet --init --recursive; fi \
  && git -C "$REPO_DIR" rev-parse HEAD > /work/build-sha \
  # Every container sees new inodes and ctimes, so git's default checks would re-read the whole work tree on
  # its first status or checkout: through SOCI's lazy loading, file by file. mtime and size still catch edits.
  && git -C "$REPO_DIR" config core.checkStat minimal \
  && git -C "$REPO_DIR" config core.trustctime false

# --link: each copy is cached on its own, whatever the checkout below it, so unchanged installs ship the same layers.
# --chown: a --link layer carries its own parent folders, root's without it, over the checkout's. By number: a --link layer cannot read /etc/passwd.
# What the installs keep in their dirs, where the checkout has them; what they keep under ~/ (merging with what is
# there, such as the MCP's browser), in a layer of its own so SOCI fetches it only when a session uses it; and the
# record of the files each was built from, which refreshDeps (entrypoint.sh) reads.
COPY --link --chown=1000:1000 --from=deps /woodshed-out/checkout/ ${REPO_DIR}/
COPY --link --chown=1000:1000 --from=deps /woodshed-out/home/ /home/node/
COPY --link --chown=1000:1000 --from=deps /woodshed-out/records/ /work/.woodshed-deps/
# The context's files must be the checkout's: otherwise refreshDeps would trust installs made from other ones.
RUN --mount=type=bind,source=woodshed-deps.installs,target=/tmp/woodshed-installs \
  --mount=type=bind,source=woodshed/session/deps.sh,target=/tmp/woodshed-deps.sh \
  cd "$REPO_DIR" && bash /tmp/woodshed-deps.sh check /tmp/woodshed-installs

# Copied under the repo's own layout so the session's relative imports of woodshed/shared/ resolve the same way here
# as they do in a checkout.
COPY --chown=node:node woodshed/session/ /opt/woodshed/session/
# What the shed and Woodshed's sessions share, whole: the review feature, whose page and server run in statusd
# (session/reviewShed), the pane classifier, the project file's reader and the rest. Its tests and fixtures stay out
# (Dockerfile.dockerignore).
COPY --chown=node:node woodshed/shared/ /opt/woodshed/shared/
COPY --chown=node:node woodshed/session/tmux.conf /home/node/.tmux.conf
# Ahead of /usr/bin/gh in every PATH, login shells included: gh gets a short-lived token each run.
# No --link: on a one-file copy over the 4 GB tree it cost 17 s of merging.
COPY woodshed/session/gh.sh /usr/local/bin/gh
# Grok Build's machine policy, root-owned: no repo-defined MCP server starts in a Grok session (the file says why).
COPY --chmod=644 woodshed/session/grokRequirements.toml /etc/grok/requirements.toml

# The entrypoint and statusd read it: it is where the project file and the app are.
ENV REPO_DIR=${REPO_DIR}
WORKDIR ${REPO_DIR}
EXPOSE 7681 7682 7684
ENTRYPOINT ["/opt/woodshed/session/entrypoint.sh"]
CMD ["session"]
