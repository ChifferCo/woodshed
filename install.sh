#!/usr/bin/env bash
# Sets Woodshed up on this machine with the local provider and starts its console:
#
#   curl -fsSL https://woodshed.run/install | bash
#
# or `bash install.sh` from a checkout. It builds the session image for your repository, starts Postgres and Mongo in
# Docker for each database engine its project file names, so each session gets its own copy, writes the settings to ~/.woodshed and runs the console at http://localhost:7690. Running it again keeps
# what it made and starts the console. The console's first page then makes the GitHub App and asks for your Claude
# token. providers/local/README.md says what each piece is.
#
# Optional settings: WOODSHED_REPO (owner/name, asked otherwise), WOODSHED_HOME (~/.woodshed), WOODSHED_GIT (where the
# code is cloned from), WOODSHED_NETWORK (a docker network sessions join to reach the repository's own services, such
# as its compose file's `<folder>_default`), WOODSHED_PROJECT_FILES_DIR (an absolute path: a folder of project files,
# `<owner>/<name>.yaml`, one for a repository with no .woodshed/project.yaml of its own, which this script and every
# session then read in its place; saved in stack.env), WOODSHED_REBUILD=1 (build the session image again),
# WOODSHED_NO_START=1 (set up only), WOODSHED_SESSION_RUNTIME (the published runtime the session image is built on;
# empty builds it here), WOODSHED_BUILD_ONLY=1 (fetch the repository and build its session image, nothing else: with
# DOCKER_HOST set, on that docker host), WOODSHED_IMAGE (the session image's tag, woodshed-session:<owner>-<name>
# otherwise; the console's Update passes its own WOODSHED_IMAGE).
set -euo pipefail

WOODSHED_GIT_DEFAULT=https://github.com/ChifferCo/woodshed.git
# Everything in the session image that is the same for every repository (session/Dockerfile's `runtime` stage).
SESSION_RUNTIME_DEFAULT=ghcr.io/chifferco/woodshed-session-runtime:latest
CONSOLE_PORT=7690
# Off Postgres's and Mongo's usual ports, so the databases a laptop already runs keep theirs.
PG_PORT=15432
MONGO_PORT=17017

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
fail() { printf 'woodshed install: %s\n' "$*" >&2; exit 1; }

# Reads from the terminal, since with `curl | bash` the script itself is stdin. /dev/tty is readable even where there is
# no terminal (a coding agent's shell, CI), so it is opened to tell: there it fails with what to set, not bash's error.
ask() {
  local prompt=$1 hidden=${2:-} answer
  { : </dev/tty; } 2>/dev/null || fail "no terminal to ask on: set it in the environment instead ($prompt)"
  if [ -n "$hidden" ]; then
    read -r -s -p "$prompt" answer </dev/tty
    printf '\n' >/dev/tty
  else
    read -r -p "$prompt" answer </dev/tty
  fi
  printf '%s' "$answer"
}

validRepo() { [[ $1 =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; }

checkTools() {
  local tool
  for tool in docker git node curl; do
    command -v "$tool" >/dev/null || fail "$tool is not installed"
  done
  # The console makes every GitHub call through gh, the App's included.
  command -v gh >/dev/null || fail 'gh is not installed: https://cli.github.com'
  docker info >/dev/null 2>&1 || fail 'Docker is installed but not running: start it and run this again'
  docker compose version >/dev/null 2>&1 || fail 'Docker has no compose plugin (docker compose)'
  local major
  major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 22 ] || fail "Woodshed needs Node 22 or later, and this is $(node -v)"
}

# The folder holding providers/console.mjs: this script's own, when it runs from a checkout, or a clone in
# $home/src. A clone of a repository that has Woodshed in a woodshed/ folder works too.
findSource() {
  local home=$1 script=${BASH_SOURCE[0]:-} dir
  if [ -n "$script" ] && [ -f "$script" ]; then
    dir=$(cd "$(dirname "$script")" && pwd)
    if [ -f "$dir/providers/console.mjs" ]; then printf '%s' "$dir"; return; fi
  fi
  local src=$home/src
  if [ -d "$src/.git" ]; then
    git -C "$src" pull --ff-only --quiet >&2 || say "Could not update $src; using it as it is" >&2
  else
    say "Getting Woodshed from ${WOODSHED_GIT:-$WOODSHED_GIT_DEFAULT}" >&2
    git clone --depth 1 --quiet "${WOODSHED_GIT:-$WOODSHED_GIT_DEFAULT}" "$src" >&2
  fi
  if [ -f "$src/providers/console.mjs" ]; then printf '%s' "$src"
  elif [ -f "$src/woodshed/providers/console.mjs" ]; then printf '%s' "$src/woodshed"
  else fail "$src has no providers/console.mjs"
  fi
}

# A value already written in the settings file, so a second run asks nothing again.
savedSetting() {
  local file=$1 name=$2
  [ -f "$file" ] || return 0
  sed -n "s/^$name=//p" "$file" | tail -1
}

# A console setting (shared/envNames.mjs) saved in stack.env, by its name without the prefix: WOODSHED_<NAME>, or else
# the WOODSHED_CLOUD_<NAME> a stack.env written before the rename holds (warnOldNames says which).
savedConsoleSetting() {
  local file=$1 name=$2
  [ -f "$file" ] || return 0
  if grep -q "^WOODSHED_$name=" "$file"; then savedSetting "$file" "WOODSHED_$name"; else savedSetting "$file" "WOODSHED_CLOUD_$name"; fi
}

# The same once stack.env is sourced.
consoleSetting() {
  local current="WOODSHED_$1" old="WOODSHED_CLOUD_$1"
  if [ -n "${!current+set}" ]; then printf '%s' "${!current}"; else printf '%s' "${!old:-}"; fi
}

# Once a run, each old name stack.env still has. The file is not rewritten: it may hold changes of its owner's. Only
# names are said, never a value.
warnOldNames() {
  local file=$1 name current
  [ -f "$file" ] || return 0
  for name in $(sed -n 's/^WOODSHED_CLOUD_\([A-Z0-9_]*\)=.*/\1/p' "$file" | sort -u); do
    case $name in
      INSTALL_SECRETS) current=WOODSHED_INSTALL_SECRET_PAIRS ;;
      *) current=WOODSHED_$name ;;
    esac
    printf 'woodshed install: deprecated variable, use %s (%s has WOODSHED_CLOUD_%s)\n' "$current" "$file" "$name" >&2
  done
}

githubToken() {
  if [ -n "${GH_TOKEN:-}" ]; then printf '%s' "$GH_TOKEN"; return; fi
  if command -v gh >/dev/null && gh auth token >/dev/null 2>&1; then gh auth token; return; fi
  ask 'A GitHub token that can read the repository (it is not saved): ' hidden
}

# A shallow clone of the repository, to read its project file and lockfiles. The token goes in git's environment, never
# on a command line.
fetchRepo() {
  local repo=$1 dir=$2 token=$3 auth
  auth=$(printf 'x-access-token:%s' "$token" | base64 | tr -d '\n')
  export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.https://github.com/.extraheader GIT_CONFIG_VALUE_0="Authorization: Basic $auth"
  if [ -d "$dir/.git" ]; then
    git -C "$dir" fetch --depth 1 --quiet origin HEAD && git -C "$dir" reset --hard --quiet FETCH_HEAD
  else
    rm -rf "$dir"
    git clone --depth 1 --quiet "https://github.com/$repo.git" "$dir"
  fi
  unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0
}

# What the repository's project file decides here, one per line: its env files and the seed's secrets, as
# WOODSHED_ENV_FILES and WOODSHED_DB_ENV_SECRETS want them (either may be empty), and the engines its
# databases are on, space-separated, or `none`.
projectSettings() {
  local src=$1 repoDir=$2 projectFilesDir=${3:-}
  # The paths go in the environment: as arguments, project.mjs would take argv[1] for itself and run as a command.
  # shellcheck disable=SC2016 # JavaScript, not shell, expands these
  PROJECT_MJS=$src/shared/project.mjs REPO_DIR_TO_READ=$repoDir WOODSHED_PROJECT_FILES_DIR=$projectFilesDir node --input-type=module -e '
    const { loadProject } = await import(process.env.PROJECT_MJS);
    const project = loadProject(process.env.REPO_DIR_TO_READ);
    console.error(`woodshed install: project file from ${project.from}`);
    console.log(project.envFiles.map((f) => `${f.secret}=${f.path}`).join(","));
    console.log([...new Set(project.databases.flatMap((d) => d.envFiles))].join(","));
    console.log(project.databases.map((d) => d.engine).join(" ") || "none");
  '
}

# The session image is built for one repository: it holds a checkout and that checkout's node_modules.
buildImage() {
  local src=$1 repo=$2 repoDir=$3 image=$4 token=$5 context=$6 projectFilesDir=${7:-}
  rm -rf "$context"
  mkdir -p "$context/woodshed"
  cp -R "$src/session" "$src/shared" "$context/woodshed/"
  (cd "$repoDir" && WOODSHED_PROJECT_FILES_DIR=$projectFilesDir bash "$src/session/stageDeps.sh" "$context/woodshed-deps")
  local runtime
  runtime=$(sessionRuntime)
  say "Building the session image $image (the first build takes several minutes)"
  GH_TOKEN=$token docker build -f "$context/woodshed/session/Dockerfile" --secret id=gh_token,env=GH_TOKEN \
    --build-arg RUNTIME="$runtime" --build-arg REPO="$repo" --build-arg REPO_DIR="/work/${repo#*/}" -t "$image" "$context"
}

# What the session image is built on: the published runtime when it can be pulled, which saves building Chromium, the
# CLIs and the system packages here, or `runtime`, the Dockerfile's own stage, which builds them.
sessionRuntime() {
  local runtime=${WOODSHED_SESSION_RUNTIME-$SESSION_RUNTIME_DEFAULT}
  if [ -n "$runtime" ] && docker pull --quiet "$runtime" >/dev/null 2>&1; then
    say "Building on $runtime" >&2
    printf '%s' "$runtime"
  else
    [ -z "$runtime" ] || say "Could not pull $runtime; building the whole image here" >&2
    printf runtime
  fi
}

randomSecret() { node -p 'require("node:crypto").randomBytes(24).toString("hex")'; }

# Each engine the project's databases are on is a server of its own: with none there is no database stack, and the
# console makes no databases for sessions: the db-admin run refuses a project file with no databases, and every shared
# session would wait on it.
writeStackEnv() {
  local file=$1 home=$2 repo=$3 image=$4 envFiles=$5 dbEnvSecrets=$6 engines=$7 network=$8
  [ -f "$file" ] && return 0
  (
    umask 077
    {
      printf '# Written by install.sh. The compose files read the database block; the console reads all of it.\n'
      if anyEngine "$engines"; then printf 'WOODSHED_LOCAL_DATA_DIR=%s\n' "$home/data"; fi
      if hasEngine "$engines" postgres; then
        cat <<EOF
WOODSHED_LOCAL_PG_ROOT_PASSWORD=$(randomSecret)
WOODSHED_LOCAL_PG_PORT=$PG_PORT
WOODSHED_LOCAL_DB_POSTGRES_HOST=postgres
WOODSHED_LOCAL_DB_POSTGRES_ROOT_USER=postgres
EOF
      fi
      if hasEngine "$engines" mongo; then
        cat <<EOF
WOODSHED_LOCAL_MONGO_ROOT_PASSWORD=$(randomSecret)
WOODSHED_LOCAL_MONGO_PORT=$MONGO_PORT
WOODSHED_LOCAL_DB_MONGO_HOST=mongo:27017
EOF
      fi
      if anyEngine "$engines"; then echo; fi
      cat <<EOF
WOODSHED_PROVIDER=local
WOODSHED_REPO=$repo
WOODSHED_ENV_FILES=$envFiles
WOODSHED_DB_ENV_SECRETS=$dbEnvSecrets
WOODSHED_PORT=$CONSOLE_PORT
WOODSHED_PUBLIC_URL=http://localhost:$CONSOLE_PORT
WOODSHED_STATE_DIR=$home/console
WOODSHED_IMAGE=$image
WOODSHED_SESSION_ENV_FILE=$home/session-env.json
# bin/woodshed starts the console again when the GitHub App setup page restarts it.
WOODSHED_SUPERVISED=1
WOODSHED_LOCAL_SECRETS_DIR=$home/secrets
WOODSHED_LOCAL_SECRETS_KEY_FILE=$home/secrets.key
WOODSHED_LOCAL_HOMES_DIR=$home/homes
EOF
      if [ -n "$network" ]; then printf 'WOODSHED_LOCAL_DOCKER_NETWORK=%s\n' "$network"; fi
    } >"$file"
  )
}

# Where session containers reach the console's session API. Docker Desktop and OrbStack run containers in a VM that
# reaches the machine's loopback as host.docker.internal; on Linux it is the gateway of the sessions' network, or of
# docker's default bridge when they join none.
sessionApiHost() {
  local os=$1 network=${2:-bridge}
  if [ "$os" = Darwin ] || docker info --format '{{.OperatingSystem}}' 2>/dev/null | grep -qE 'Docker Desktop|OrbStack'; then
    printf '127.0.0.1 host.docker.internal'
  else
    local gateway
    gateway=$(docker network inspect "$network" --format '{{(index .IPAM.Config 0).Gateway}}')
    printf '%s %s' "$gateway" "$gateway"
  fi
}

hasEngine() { [[ " $1 " == *" $2 "* ]]; }
anyEngine() { [ -n "$1" ] && [ "$1" != none ]; }

# The engines this install hosts: the ones stack.env gives a server.
hostedEngines() {
  local engines=()
  if [ -n "${WOODSHED_LOCAL_DB_POSTGRES_HOST:-}" ]; then engines+=(postgres); fi
  if [ -n "${WOODSHED_LOCAL_DB_MONGO_HOST:-}" ]; then engines+=(mongo); fi
  printf '%s' "${engines[*]:-none}"
}

# Written once; a later run only moves WOODSHED_CONSOLE_URL, so a shared service added to the file stays. Each engine's
# server, in the names its engine reads (shared/databases/).
writeSessionEnv() {
  local file=$1 consoleHost=$2 engines=$3
  local url=http://$consoleHost:7691
  if [ -f "$file" ]; then
    # shellcheck disable=SC2016 # JavaScript, not shell, expands these
    SESSION_ENV_FILE=$file CONSOLE_URL=$url node -e '
      const fs = require("node:fs");
      const file = process.env.SESSION_ENV_FILE;
      const env = JSON.parse(fs.readFileSync(file, "utf8"));
      env.WOODSHED_CONSOLE_URL = process.env.CONSOLE_URL;
      fs.writeFileSync(file, `${JSON.stringify(env, null, 2)}\n`);
    '
    return
  fi
  (
    umask 077
    {
      printf '{\n'
      if hasEngine "$engines" postgres; then printf '  "PGHOST": "postgres",\n  "PGPORT": "5432",\n  "PGSSLMODE": "disable",\n'; fi
      if hasEngine "$engines" mongo; then printf '  "WOODSHED_MONGO_HOST": "mongo:27017",\n'; fi
      printf '  "WOODSHED_CONSOLE_URL": "%s"\n}\n' "$url"
    } >"$file"
  )
}

# The installation's folder of project files, in stack.env for the console and, through it, each session. Moved when a
# later run names another, so the rest of the file stays as the first run wrote it.
saveProjectFilesDir() {
  local file=$1 dir=$2 kept
  [ -n "$dir" ] || return 0
  [ "$(savedConsoleSetting "$file" PROJECT_FILES_DIR)" != "$dir" ] || return 0
  kept=$(grep -v '^WOODSHED_\(CLOUD_\)\{0,1\}PROJECT_FILES_DIR=' "$file" || true)
  (
    umask 077
    printf '%s\nWOODSHED_PROJECT_FILES_DIR=%s\n' "$kept" "$dir" >"$file"
  )
}

# stack.env is written once, so what a project file names after the first run (the repo's own, changed, or a file the
# installation supplies only now) does not reach it. Said rather than mended: the file may hold changes of its owner's.
warnStaleStackEnv() {
  local file=$1 settings=$2 engines=$3 hosted=$4 wanted
  wanted=$(tr ' ' '\n' <<<"$engines" | sed '/^none$/d' | sort | paste -sd ' ' -)
  [ "$(savedConsoleSetting "$file" ENV_FILES)" != "$(sed -n 1p <<<"$settings")" ] \
    || [ "$(savedConsoleSetting "$file" DB_ENV_SECRETS)" != "$(sed -n 2p <<<"$settings")" ] \
    || [ "$wanted" != "$(tr ' ' '\n' <<<"$hosted" | sed '/^none$/d' | sort | paste -sd ' ' -)" ] || return 0
  say "$file was written for another project file: its env files, seed secrets or database engines are not the ones it names now. providers/local/README.md, \"Project files the installation supplies\", says what to change"
}

# An install works on one repository: its stack.env, image and databases are that repository's.
refuseOtherRepo() {
  local file=$1 repo=$2 saved
  saved=$(savedConsoleSetting "$file" REPO)
  [ -z "$saved" ] || [ "$saved" = "$repo" ] || fail "this install works on $saved: set WOODSHED_HOME to another folder for $repo"
}

writeLauncher() {
  local file=$1 home=$2 src=$3
  mkdir -p "$(dirname "$file")"
  cat >"$file" <<EOF
#!/usr/bin/env bash
# Starts the Woodshed console with $home/stack.env. Written by install.sh.
set -a
. "$home/stack.env"
set +a
# 75 is the console asking to be started again, after the GitHub App setup page saved the App.
while :; do
  code=0
  node "$src/providers/console.mjs" || code=\$?
  [ "\$code" = 75 ] || exit "\$code"
done
EOF
  chmod 755 "$file"
}

openWhenReady() {
  local url=$1 opener=""
  command -v open >/dev/null && opener=open
  command -v xdg-open >/dev/null && opener=xdg-open
  (
    for _ in $(seq 60); do
      if curl -fsS -o /dev/null "$url"; then
        if [ -n "$opener" ]; then "$opener" "$url" >/dev/null 2>&1 || true; fi
        exit 0
      fi
      sleep 1
    done
  ) &
}

main() {
  checkTools
  local home=${WOODSHED_HOME:-$HOME/.woodshed}
  mkdir -p "$home"
  chmod 700 "$home"
  local stackEnv=$home/stack.env
  warnOldNames "$stackEnv"
  local src
  src=$(findSource "$home")

  local repo=${WOODSHED_REPO:-$(savedConsoleSetting "$stackEnv" REPO)}
  [ -n "$repo" ] || repo=$(ask 'Which GitHub repository should sessions work on? (owner/name): ')
  validRepo "$repo" || fail "not a repository, owner/name: $repo"
  refuseOtherRepo "$stackEnv" "$repo"
  local slug
  slug=$(printf '%s' "$repo" | tr '/[:upper:]' '-[:lower:]')
  local image=${WOODSHED_IMAGE:-woodshed-session:$slug} repoDir=$home/repos/$slug

  local projectFilesDir=${WOODSHED_PROJECT_FILES_DIR:-$(savedConsoleSetting "$stackEnv" PROJECT_FILES_DIR)}
  [ -z "$projectFilesDir" ] || [[ $projectFilesDir = /* ]] || fail "WOODSHED_PROJECT_FILES_DIR must be an absolute path: $projectFilesDir"

  local token
  token=$(githubToken)
  [ -n "$token" ] || fail 'a GitHub token is needed to read the repository'
  say "Fetching $repo"
  fetchRepo "$repo" "$repoDir" "$token"

  # Every docker call goes where DOCKER_HOST points, so with it set this builds the session image on that machine.
  if [ -n "${WOODSHED_BUILD_ONLY:-}" ]; then
    buildImage "$src" "$repo" "$repoDir" "$image" "$token" "$home/build" "$projectFilesDir"
    say "Built the session image $image${DOCKER_HOST:+ on $DOCKER_HOST}"
    return 0
  fi

  if [ -n "${WOODSHED_REBUILD:-}" ] || ! docker image inspect "$image" >/dev/null 2>&1; then
    buildImage "$src" "$repo" "$repoDir" "$image" "$token" "$home/build" "$projectFilesDir"
  else
    say "Using the session image $image (WOODSHED_REBUILD=1 builds it again)"
  fi

  local settings engines network
  settings=$(projectSettings "$src" "$repoDir" "$projectFilesDir")
  engines=$(sed -n 3p <<<"$settings")
  network=${WOODSHED_NETWORK:-}
  [ -n "$network" ] || ! anyEngine "$engines" || network=woodshed
  writeStackEnv "$stackEnv" "$home" "$repo" "$image" "$(sed -n 1p <<<"$settings")" "$(sed -n 2p <<<"$settings")" "$engines" "$network"
  saveProjectFilesDir "$stackEnv" "$projectFilesDir"
  set -a
  # shellcheck source=/dev/null
  . "$stackEnv"
  set +a

  mkdir -p "$WOODSHED_LOCAL_SECRETS_DIR" "$WOODSHED_LOCAL_HOMES_DIR" "$(consoleSetting STATE_DIR)"
  local hosted engine files=()
  hosted=$(hostedEngines)
  warnStaleStackEnv "$stackEnv" "$settings" "$engines" "$hosted"
  if [ "$hosted" != none ]; then
    say "Starting $hosted, for a copy of the databases in each session"
    mkdir -p "$WOODSHED_LOCAL_DATA_DIR"
    # Each engine is a compose file of its own, added to the network's (providers/local/README.md).
    for engine in $hosted; do files+=(-f "$src/providers/local/$engine.yml"); done
    docker compose -f "$src/providers/local/compose.yml" "${files[@]}" --env-file "$stackEnv" up -d --quiet-pull
  else
    say 'The project file has no databases: sessions get none of their own'
  fi
  network=${WOODSHED_LOCAL_DOCKER_NETWORK:-}
  if [ -n "$network" ] && ! docker network inspect "$network" >/dev/null 2>&1; then
    fail "sessions join the docker network $network, which does not exist yet: start the repository's services, then run this again"
  fi

  local api apiHost consoleHost
  api=$(sessionApiHost "$(uname -s)" "${network:-bridge}")
  apiHost=${api% *}
  consoleHost=${api#* }
  if [ -z "$(savedConsoleSetting "$stackEnv" SESSION_API_HOST)" ]; then
    printf 'WOODSHED_SESSION_API_HOST=%s\n' "$apiHost" >>"$stackEnv"
  fi
  writeSessionEnv "$(consoleSetting SESSION_ENV_FILE)" "$consoleHost" "$hosted"

  local secretCli=$src/providers/local/bin/secret.mjs
  [ -f "$WOODSHED_LOCAL_SECRETS_KEY_FILE" ] || node "$secretCli" new-key "$WOODSHED_LOCAL_SECRETS_KEY_FILE" >/dev/null
  if [ -n "${WOODSHED_LOCAL_DB_POSTGRES_HOST:-}" ]; then
    printf %s "$WOODSHED_LOCAL_PG_ROOT_PASSWORD" | node "$secretCli" put db-root/postgres >/dev/null
  fi
  if [ -n "${WOODSHED_LOCAL_DB_MONGO_HOST:-}" ]; then
    printf %s "$WOODSHED_LOCAL_MONGO_ROOT_PASSWORD" | node "$secretCli" put db-root/mongo >/dev/null
  fi

  writeLauncher "$home/bin/woodshed" "$home" "$src"
  say "Set up in $home. Start the console again any time with $home/bin/woodshed"
  say "Back up $WOODSHED_LOCAL_SECRETS_KEY_FILE somewhere else: losing it loses every secret"
  [ -z "${WOODSHED_NO_START:-}" ] || return 0

  local url=http://localhost:$CONSOLE_PORT
  say "Starting the console at $url"
  openWhenReady "$url"
  exec "$home/bin/woodshed"
}

# Called last, so a download cut short runs nothing. The test sources the functions with WOODSHED_INSTALL_LIB=1.
if [ -z "${WOODSHED_INSTALL_LIB:-}" ]; then main "$@"; fi
