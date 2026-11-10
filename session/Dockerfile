# syntax=docker/dockerfile:1.7
#
# Woodshed Cloud session image: everything one Claude session needs except the
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
# The image workflow builds with a layer cache in ECR. These build args decide
# what it rebuilds: BASE_WEEK the system packages, CLAUDE_DAY the Claude CLI and
# BUILD_SHA the checkout. The repo's installs run again only when their files or the project file's installs change.

FROM node:22.16.0-bookworm-slim AS base

ARG TTYD_VERSION=1.7.7
ARG TTYD_SHA256_AMD64=8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55
ARG TTYD_SHA256_ARM64=b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165
# Set by BuildKit to the platform being built (amd64 or arm64), which is also Debian's name for it.
ARG TARGETARCH
ARG PLAYWRIGHT_MCP_VERSION=0.0.83
ARG CODEX_VERSION=0.167.0
ARG REDIS_COMMANDER_VERSION=0.9.0
# The Editor button's VS Code (startCodeEditor in entrypoint.sh): Gitpod's MIT-licensed build, with its own Node.
ARG OPENVSCODE_VERSION=1.109.5
ARG OPENVSCODE_SHA256_AMD64=b433bf4f0227321a7014d8460d10a8f958adc0f45aa79bd889e84e65e8f88363
ARG OPENVSCODE_SHA256_ARM64=36d9c14036489b63de84ebace837fcacf7e60e669a0dc715802c5443684ea4dc
# AWS's RDS CA bundle, so Postgres connections can verify the server (PGSSLMODE=verify-full in the task
# definition). Pinned: when AWS changes the bundle the build fails here, rather than trusting what it got.
ARG RDS_CA_SHA256=90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b

# Changes once a week in the image workflow, so security updates and a new gh still arrive.
ARG BASE_WEEK=
# The slim base has no compiler: g++, make and python3 are for native modules a repo's install builds from source,
# here and in a session that reinstalls. The rest are tools the full base had that sessions use.
RUN apt-get update \
  && apt-get install -y --no-install-recommends bzip2 ca-certificates curl file g++ git gnupg iproute2 jq make openssh-client patch procps python3 redis-server tmux unzip wget xz-utils \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

RUN case "$TARGETARCH" in \
    amd64) ttyd_arch=x86_64; ttyd_sha="$TTYD_SHA256_AMD64" ;; \
    arm64) ttyd_arch=aarch64; ttyd_sha="$TTYD_SHA256_ARM64" ;; \
    *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
  esac \
  && curl -fsSL -o /usr/local/bin/ttyd "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${ttyd_arch}" \
  && echo "${ttyd_sha}  /usr/local/bin/ttyd" | sha256sum -c - \
  && chmod +x /usr/local/bin/ttyd

RUN curl -fsSL -o /etc/ssl/certs/rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
  && echo "${RDS_CA_SHA256}  /etc/ssl/certs/rds-global-bundle.pem" | sha256sum -c -
# Adds to Node's trusted CAs rather than replacing them.
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem

# A private session's own database viewers (startDbViewers in entrypoint.sh), from their official images, pinned by
# digest. pgweb is one static binary; mongo-express is plain JavaScript with no native module, so it runs on this
# Node. Its npm package pulls a dependency from GitHub, which this copy avoids.
COPY --link --from=sosedoff/pgweb:0.17.0@sha256:a5256d416e2e8b92d69a4459058e3eca33a9f075d8325491644411d0bc3bd70b /usr/bin/pgweb /usr/local/bin/pgweb
COPY --link --from=mongo-express:1.0.2-20-alpine3.19@sha256:1aae0077525133249133d42980ba23998712a1077e02ac0ac295b50a7a79d550 /app /opt/mongo-express

FROM base AS deps

# The repo's checkout folder, /work/<name>.
ARG REPO_DIR
# The project file's installs (session/deps.sh), keyed on their files and the manifest alone: a commit that changes
# neither reuses them from the cache. The image workflow puts each install's files under woodshed-deps/, in the repo's
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

FROM base

RUN npm install -g npm@10.9.0 "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" "redis-commander@${REDIS_COMMANDER_VERSION}" "@openai/codex@${CODEX_VERSION}" \
  && cd "$(npm root -g)/@playwright/mcp" && npx playwright install-deps chromium \
  && npm cache clean --force && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /work && chown node:node /work

# The project file's `editor` (true or false), which stageDeps.sh writes beside woodshed-deps/: false leaves the editor
# out. Mounted, not copied, so the layer is built again only when that one value changes. Its own layer, about 75 MB,
# so SOCI fetches it only in a session whose editor someone opens.
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

# The session should not be root: the node image's own uid 1000 user runs everything below.
USER node
ENV PATH=/home/node/.local/bin:$PATH
# Without a UTF-8 locale, Debian's tmux shows every non-ASCII character as `_`.
ENV LANG=C.UTF-8

# Claude, Chromium, the checkout and each node_modules are separate layers on purpose: BuildKit gzips layers in
# parallel, and gzipping one layer that held them all was most of the image workflow's time.
# --no-shell: the MCP runs the full Chromium even when headless, so the separate headless shell is never used.
RUN cd "$(npm root -g)/@playwright/mcp" && npx playwright install --no-shell chromium

# After Chromium, so a new Claude each day does not download Chromium again.
ARG CLAUDE_DAY=
RUN curl -fsSL https://claude.ai/install.sh | bash \
  && claude mcp add --scope user playwright -- npx "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" --headless --browser chromium

# The clone's own words never change, so without this a cached build would ship an old checkout. The clone is then
# moved to that commit, the one the build context and the image's tag come from, should the default branch have moved since.
# Before the token leaves the URL: the partial clone fetches that commit's files from GitHub.
ARG BUILD_SHA=
# The repo this image is for, owner/name, and where its checkout goes, /work/<name> (checkoutDir in shared/project.mjs).
ARG REPO
ARG REPO_DIR
RUN test -n "$REPO" && test -n "$REPO_DIR" || { echo "build with --build-arg REPO=<owner>/<name> --build-arg REPO_DIR=/work/<name>" >&2; exit 1; }
RUN --mount=type=secret,id=gh_token,uid=1000 \
  git clone --filter=blob:none "https://x-access-token:$(cat /run/secrets/gh_token)@github.com/${REPO}.git" "$REPO_DIR" \
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
# What Woodshed and Woodshed Cloud share, whole: the review feature, whose page and server run in statusd
# (session/reviewShed), the pane classifier, the project file's reader and the rest. Its tests and fixtures stay out
# (Dockerfile.dockerignore).
COPY --chown=node:node woodshed/shared/ /opt/woodshed/shared/
COPY --chown=node:node woodshed/session/tmux.conf /home/node/.tmux.conf
# Ahead of /usr/bin/gh in every PATH, login shells included: gh gets a short-lived token each run.
# No --link: on a one-file copy over the 4 GB tree it cost 17 s of merging.
COPY woodshed/session/gh.sh /usr/local/bin/gh

# The entrypoint and statusd read it: it is where the project file and the app are.
ENV REPO_DIR=${REPO_DIR}
WORKDIR ${REPO_DIR}
EXPOSE 7681 7682 7684
ENTRYPOINT ["/opt/woodshed/session/entrypoint.sh"]
CMD ["session"]
