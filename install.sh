#!/usr/bin/env bash
# Sets Woodshed up on this machine with the local provider and starts its console:
#
#   curl -fsSL https://woodshed.run/install | bash
#
# or `bash install.sh` from a checkout. It asks for no repository: it builds a session image with no checkout, writes
# the settings to ~/.woodshed and runs the console at http://localhost:7690, where you add repos on Console settings,
# Repos. Each session clones its repo and runs its installs at start. With WOODSHED_REPO it builds the session image for
# that repository instead, holding its checkout and installs, and starts Postgres and Mongo in Docker for each database
# engine its project file names, so each session gets its own copy. Running it again keeps what it made and starts the
# console, after stopping this install's own console if it runs; a port the console needs that something else holds
# stops it before anything is built. The console's first page then asks for your Claude token; sessions push as you,
# with your gh sign-in, so a GitHub App is optional on this machine. providers/local/README.md says what each piece is.
#
# Optional settings: WOODSHED_REPO (owner/name: a repository whose image and databases this install makes; a later run
# can add one to an install that had none, but not change it), WOODSHED_HOME (~/.woodshed), WOODSHED_GIT (where the
# code is cloned from), WOODSHED_NETWORK (a docker network sessions join to reach the repository's own services, such
# as its compose file's `<folder>_default`), WOODSHED_PROJECT_FILES_DIR (an absolute path: a folder of project files,
# `<owner>/<name>.yaml`, one for a repository with no .woodshed/project.yaml of its own, which this script and every
# session then read in its place; saved in stack.env), WOODSHED_REBUILD=1 (build the session image again),
# WOODSHED_NO_START=1 (set up only), WOODSHED_SESSION_RUNTIME (the published runtime the session image is built on;
# empty builds it here), WOODSHED_BUILD_ONLY=1 (fetch the repository and build its session image, nothing else: with
# DOCKER_HOST set, on that docker host), WOODSHED_IMAGE (the session image's tag, woodshed-session:<owner>-<name>, or
# woodshed-session:generic with no repository, otherwise; the console's Update passes its own WOODSHED_IMAGE), WOODSHED_TAILSCALE=1 (also serve the console to your
# own Tailscale devices, at https://<this machine>.<tailnet>.ts.net, with each session's app on a port of that name:
# providers/local/README.md, "From your other devices, with Tailscale"), or WOODSHED_TAILSCALE=shared for a console
# others on the tailnet use, which signs them in once its GitHub App is made: no app ports, since sign-in keeps apps
# apart only on names of their own.
set -euo pipefail

WOODSHED_GIT_DEFAULT=https://github.com/ChifferCo/woodshed.git
# Everything in the session image that is the same for every repository (session/Dockerfile's `runtime` stage).
SESSION_RUNTIME_DEFAULT=ghcr.io/chifferco/woodshed-session-runtime:latest
CONSOLE_PORT=7690
SESSION_API_PORT=7691
# The session image of an install that names no repository: no checkout, so every session clones its own at start.
GENERIC_IMAGE=woodshed-session:generic
NO_CHECKOUT_DIR=/work/.no-checkout
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

# The session image is built for one repository: it holds a checkout and that checkout's node_modules. With no
# repository (an empty `repo`) it holds neither, and keeps the editor, which only a repo's project file turns off: every
# session clones its repo and runs its installs at start (session/Dockerfile, REPO empty), so the build needs no token.
buildImage() {
  local src=$1 repo=$2 repoDir=$3 image=$4 token=$5 context=$6 projectFilesDir=${7:-}
  rm -rf "$context"
  mkdir -p "$context/woodshed"
  cp -R "$src/session" "$src/shared" "$context/woodshed/"
  if [ -z "$repo" ]; then
    mkdir -p "$context/woodshed-deps"
    : >"$context/woodshed-deps.installs"
    printf 'true\n' >"$context/woodshed-deps.editor"
  else
    (cd "$repoDir" && WOODSHED_PROJECT_FILES_DIR=$projectFilesDir bash "$src/session/stageDeps.sh" "$context/woodshed-deps")
  fi
  local runtime
  runtime=$(sessionRuntime)
  if [ -z "$repo" ]; then
    say "Building the session image $image, for any repository (the first build takes a few minutes)"
    docker build -f "$context/woodshed/session/Dockerfile" \
      --build-arg RUNTIME="$runtime" --build-arg REPO= --build-arg REPO_DIR="$NO_CHECKOUT_DIR" -t "$image" "$context"
    return
  fi
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
      printf 'WOODSHED_PROVIDER=local\n'
      # None for an install that names no repository: the console starts with none, and an admin adds them.
      if [ -n "$repo" ]; then printf 'WOODSHED_REPO=%s\n' "$repo"; fi
      cat <<EOF
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

# A stack.env written with no repository, given one now: the repository decides its image, env files and seed
# secrets, and adds its databases' settings; every other line stays as it was (a Tailscale name, the session API's
# address, a line of its owner's). Takes writeStackEnv's arguments after the file.
addRepoToStackEnv() {
  local file=$1 fresh=$1.new kept line name
  shift
  rm -f "$fresh"
  writeStackEnv "$fresh" "$@"
  kept=$(grep -v -E '^WOODSHED_(CLOUD_)?(REPO|IMAGE|ENV_FILES|DB_ENV_SECRETS)=' "$file" || true)
  (
    umask 077
    {
      printf '%s\n' "$kept"
      printf '# Added by install.sh for %s\n' "$2"
      while IFS= read -r line; do
        case $line in WOODSHED_*=*) ;; *) continue ;; esac
        name=${line%%=*}
        # Kept under either name: a file from before the rename has WOODSHED_CLOUD_ ones.
        grep -q -E "^($name|WOODSHED_CLOUD_${name#WOODSHED_})=" <<<"$kept" || printf '%s\n' "$line"
      done <"$fresh"
    } >"$file"
  )
  rm -f "$fresh"
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

# Written once; a later run only moves WOODSHED_CONSOLE_URL, and adds the server of an engine hosted since (an install
# that had no repository, given one), so a shared service added to the file stays. Each engine's server, in the names
# its engine reads (shared/databases/).
writeSessionEnv() {
  local file=$1 consoleHost=$2 engines=$3
  local apiPort
  apiPort=$(consoleSetting SESSION_API_PORT)
  local url=http://$consoleHost:${apiPort:-$SESSION_API_PORT}
  if [ -f "$file" ]; then
    # shellcheck disable=SC2016 # JavaScript, not shell, expands these
    SESSION_ENV_FILE=$file CONSOLE_URL=$url ENGINES=" $engines " node -e '
      const fs = require("node:fs");
      const file = process.env.SESSION_ENV_FILE;
      const env = JSON.parse(fs.readFileSync(file, "utf8"));
      const hosted = (name) => process.env.ENGINES.includes(` ${name} `);
      if (hosted("postgres") && !env.PGHOST) Object.assign(env, { PGHOST: "postgres", PGPORT: "5432", PGSSLMODE: "disable" });
      if (hosted("mongo") && !env.WOODSHED_MONGO_HOST) env.WOODSHED_MONGO_HOST = "mongo:27017";
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

# A setting in stack.env, set to `value`, or taken out when it is empty. The rest of the file stays as it was.
setStackSetting() {
  local file=$1 name=$2 value=$3 kept
  kept=$(grep -v "^WOODSHED_\(CLOUD_\)\{0,1\}$name=" "$file" || true)
  (
    umask 077
    if [ -n "$value" ]; then printf '%s\nWOODSHED_%s=%s\n' "$kept" "$name" "$value" >"$file"; else printf '%s\n' "$kept" >"$file"; fi
  )
}

# Sessions use this machine's Docker unless stack.env says WOODSHED_SESSION_DOCKER=0 (console/config.mjs, sessionDocker).
# Saved only when this run sets it: 0 turns it off, 1 back on, and unset keeps what the file says.
saveSessionDocker() {
  local file=$1
  [ -n "${WOODSHED_SESSION_DOCKER+set}" ] || return 0
  case $WOODSHED_SESSION_DOCKER in
    0|1) setStackSetting "$file" SESSION_DOCKER "$WOODSHED_SESSION_DOCKER" ;;
    *) fail "WOODSHED_SESSION_DOCKER is 0 (sessions do not use this machine's Docker) or 1 (they do, the default), not $WOODSHED_SESSION_DOCKER" ;;
  esac
}

APP_PORTS_DEFAULT=7701-7710

# Where the tailscale CLI is: on the PATH, or inside the Mac app, which does not put it there.
tailscaleCli() {
  if command -v tailscale >/dev/null; then printf tailscale; return; fi
  local app=/Applications/Tailscale.app/Contents/MacOS/Tailscale
  [ -x "$app" ] && printf '%s' "$app" && return
  fail 'WOODSHED_TAILSCALE=1, but tailscale is not installed: https://tailscale.com/download'
}

# This machine's name on the tailnet, as MagicDNS gives it, with no trailing dot.
tailscaleName() {
  local cli=$1 name
  name=$("$cli" status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).Self?.DNSName??"").replace(/\.$/,""))}catch{}})')
  [ -n "$name" ] || fail 'tailscale is not up, or has no MagicDNS name for this machine: run `tailscale up`, and turn on MagicDNS and HTTPS certificates in the admin console'
  printf '%s' "$name"
}

# The ports of a range such as 7701-7710, one per line.
portsOf() {
  local from=${1%-*} to=${1#*-}
  seq "$from" "$to"
}

# Serves the console, and on one person's console each app port, to this tailnet's devices with Tailscale's HTTPS
# (`serve`, never `funnel`, which would put it on the internet). The console keeps listening on loopback alone.
setUpTailscale() {
  local file=$1 cli name shared=
  if [ "${WOODSHED_TAILSCALE:-}" = shared ] || [ "$(savedConsoleSetting "$1" REQUIRE_SIGN_IN)" = 1 ]; then shared=1; fi
  cli=$(tailscaleCli)
  name=$(tailscaleName "$cli")
  setStackSetting "$file" PUBLIC_URL "https://$name"
  "$cli" serve --bg --https=443 "http://127.0.0.1:$CONSOLE_PORT" >/dev/null
  if [ "$shared" = 1 ]; then
    setStackSetting "$file" APP_PORTS ''
    say "Serving the console to your tailnet at https://$name. Others use it: make the GitHub App first, then set WOODSHED_REQUIRE_SIGN_IN=1 (docs/self-host.md)"
    return 0
  fi
  local ports=${WOODSHED_APP_PORTS:-$(savedConsoleSetting "$file" APP_PORTS)}
  ports=${ports:-$APP_PORTS_DEFAULT}
  [[ $ports =~ ^[0-9]+-[0-9]+$ ]] || fail "WOODSHED_APP_PORTS must be a range such as $APP_PORTS_DEFAULT for Tailscale, not $ports"
  setStackSetting "$file" APP_PORTS "$ports"
  local port
  for port in $(portsOf "$ports"); do "$cli" serve --bg --https="$port" "http://127.0.0.1:$port" >/dev/null; done
  say "Serving the console to your own Tailscale devices at https://$name, and session apps on its ports $ports"
}

# An install works on one repository: its stack.env, image and databases are that repository's. One that named none
# takes one later (addRepoToStackEnv), and keeps it from then on.
refuseOtherRepo() {
  local file=$1 repo=$2 saved
  saved=$(savedConsoleSetting "$file" REPO)
  [ -z "$saved" ] || [ "$saved" = "$repo" ] || fail "this install works on $saved: set WOODSHED_HOME to another folder for $repo"
}

# Whether something already listens on 127.0.0.1:<port>, where the console would: the bind it would make, tried.
loopbackTaken() {
  node -e '
    const server = require("node:net").createServer();
    server.once("error", (err) => process.exit(err.code === "EADDRINUSE" ? 0 : 1));
    server.listen(Number(process.argv[1]), "127.0.0.1", () => server.close(() => process.exit(1)));
  ' "$1"
}

# What listens on <port> where the console would collide with it: loopback, every address, or <address> (the session
# API's, on Linux the docker gateway). A listener on another address does not count, nor Tailscale's own, which is
# `tailscale serve` handing that port to the console. One line, `<pid> <command>`, the pid empty when the system will
# not say whose it is (another user's); nothing, and status 1, when the port is free. lsof where there is one (macOS
# has it), else Linux's ss, and the bind in the end.
portHolder() {
  local port=$1 address=${2:-} out=
  if command -v lsof >/dev/null; then
    out=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -Fpcn 2>/dev/null | awk -v port="$port" -v address="$address" '
      /^p/ { pid = substr($0, 2) }
      /^c/ { command = substr($0, 2) }
      /^n/ {
        at = substr($0, 2); sub(":" port "$", "", at)
        if (tolower(command) ~ /tailscale|ipnextension/) next
        if (at ~ /^(127\.|\*$|0\.0\.0\.0$|\[::1\]$|\[::\]$|\[::ffff:127\.|localhost$)/ || (address != "" && at == address)) { print pid " " command; exit }
      }' || true)
  elif command -v ss >/dev/null; then
    out=$(ss -ltnpH 2>/dev/null | awk -v port="$port" -v address="$address" '{
        at = $4; if (at !~ (":" port "$")) next; sub(":" port "$", "", at)
        if (!(at ~ /^(127\.|\*$|0\.0\.0\.0$|\[::1\]$|\[::\]$|\[::ffff:127\.|localhost$)/ || (address != "" && at == address))) next
        pid = ""; command = ""
        if (match($0, /pid=[0-9]+/)) pid = substr($0, RSTART + 4, RLENGTH - 4)
        if (match($0, /\(\("[^"]*"/)) command = substr($0, RSTART + 3, RLENGTH - 4)
        if (tolower(command) ~ /tailscale/) next
        print pid " " command; exit
      }' || true)
  fi
  # Neither could say (another user's process hides from both): the bind itself still tells a taken port.
  if [ -z "$out" ] && loopbackTaken "$port"; then out=' '; fi
  [ -n "$out" ] || return 1
  printf '%s\n' "$out"
}

# The environment of <pid>, one variable a line, where the system shows it: /proc on Linux, `ps -E` on macOS (whose
# lines split at a value's spaces, which only makes a match fail).
processEnv() {
  if [ -r "/proc/$1/environ" ]; then tr '\0' '\n' <"/proc/$1/environ"; else ps -E -ww -o command= -p "$1" 2>/dev/null | tr ' ' '\n'; fi
}

# Whether <pid> is this install's console: one started from its stack.env, whose state folder is in its environment
# however it was started, or one its bin/woodshed runs.
isOwnConsole() {
  local home=$1 pid=$2 stateDir=$3 parent
  if [ -n "$stateDir" ] && processEnv "$pid" | grep -qxF -e "WOODSHED_STATE_DIR=$stateDir" -e "WOODSHED_CLOUD_STATE_DIR=$stateDir"; then return 0; fi
  parent=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  [ -n "$parent" ] && ps -o command= -p "$parent" 2>/dev/null | grep -qF "$home/bin/woodshed"
}

# The ports the console will listen on, one a line: its own, the session API's, and each app port, as stack.env (or
# this run's settings) will have them.
consolePorts() {
  local file=$1 console api ports part
  console=${WOODSHED_PORT:-$(savedConsoleSetting "$file" PORT)}
  api=${WOODSHED_SESSION_API_PORT:-$(savedConsoleSetting "$file" SESSION_API_PORT)}
  printf '%s\n%s\n' "${console:-$CONSOLE_PORT}" "${api:-$SESSION_API_PORT}"
  # Others on the tailnet get no app ports (setUpTailscale).
  [ "${WOODSHED_TAILSCALE:-}" != shared ] || return 0
  ports=${WOODSHED_APP_PORTS:-$(savedConsoleSetting "$file" APP_PORTS)}
  [ -n "$ports" ] || [ "${WOODSHED_TAILSCALE:-}" != 1 ] || ports=$APP_PORTS_DEFAULT
  for part in ${ports//,/ }; do
    if [[ $part =~ ^[0-9]+(-[0-9]+)?$ ]]; then portsOf "$part"; fi
  done
}

# Before anything is built or started: each port the console needs, refused when something else holds it, with what
# that is, rather than after the build, when the console would stop at its start (a console left running from another
# install once held 7690). This install's own console holding them is not refused: running this again restarts it with
# the new settings (stopOwnConsole), so its pid is printed.
checkPorts() {
  local home=$1 file=$2 port holder pid command own=
  local address stateDir
  address=$(savedConsoleSetting "$file" SESSION_API_HOST)
  stateDir=$(savedConsoleSetting "$file" STATE_DIR)
  for port in $(consolePorts "$file"); do
    holder=$(portHolder "$port" "$address") || continue
    pid=${holder%% *}
    if [ -z "$pid" ]; then
      fail "port $port, which the console needs, is taken, and this machine will not say by what (another user's process?): sudo lsof -nP -iTCP:$port -sTCP:LISTEN shows it. Stop it, then run this again"
    fi
    if isOwnConsole "$home" "$pid" "$stateDir"; then own=$pid; continue; fi
    command=$(ps -o command= -p "$pid" 2>/dev/null | cut -c1-160 || true)
    fail "port $port, which the console needs, is taken by ${holder#* } (pid $pid${command:+: $command}). Stop it, then run this again: a console left from another install or WOODSHED_HOME stops with kill $pid"
  done
  printf '%s' "$own"
}

# Stops this install's console, which checkPorts found running, so the one this run starts gets its ports.
stopOwnConsole() {
  local pid=$1 port=$2
  say "Stopping this install's running console (pid $pid), to start it again with these settings"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 40); do
    loopbackTaken "$port" || return 0
    sleep 0.5
  done
  fail "this install's console (pid $pid) did not stop: stop it, then run this again"
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
      if curl -fsS -o /dev/null "$url" 2>/dev/null; then
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

  case ${WOODSHED_TAILSCALE:-} in
    ''|1|shared) ;;
    *) fail "WOODSHED_TAILSCALE is 1 (only you) or shared (others on the tailnet too), not $WOODSHED_TAILSCALE" ;;
  esac

  # No repository is asked for: with none, the console starts with none, and you add them on its Console settings
  # page. Named (or named by an earlier run), the install makes that repository's image and databases.
  local repo=${WOODSHED_REPO:-$(savedConsoleSetting "$stackEnv" REPO)}
  local image repoDir='' slug
  if [ -n "$repo" ]; then
    validRepo "$repo" || fail "not a repository, owner/name: $repo"
    refuseOtherRepo "$stackEnv" "$repo"
    slug=$(printf '%s' "$repo" | tr '/[:upper:]' '-[:lower:]')
    image=${WOODSHED_IMAGE:-woodshed-session:$slug}
    repoDir=$home/repos/$slug
  else
    image=${WOODSHED_IMAGE:-$(savedConsoleSetting "$stackEnv" IMAGE)}
    image=${image:-$GENERIC_IMAGE}
  fi

  local projectFilesDir=${WOODSHED_PROJECT_FILES_DIR:-$(savedConsoleSetting "$stackEnv" PROJECT_FILES_DIR)}
  [ -z "$projectFilesDir" ] || [[ $projectFilesDir = /* ]] || fail "WOODSHED_PROJECT_FILES_DIR must be an absolute path: $projectFilesDir"

  # Before anything slow, so a port the console cannot have stops the run now rather than after the build. Not for a
  # run that starts no console.
  local ownConsole=''
  if [ -z "${WOODSHED_NO_START:-}${WOODSHED_BUILD_ONLY:-}" ]; then ownConsole=$(checkPorts "$home" "$stackEnv"); fi

  local token=''
  if [ -n "$repo" ]; then
    token=$(githubToken)
    [ -n "$token" ] || fail 'a GitHub token is needed to read the repository'
    say "Fetching $repo"
    fetchRepo "$repo" "$repoDir" "$token"
  fi

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

  # With no repository there is no project file yet: no env files, seed secrets or databases.
  local settings=$'\n\nnone' engines network
  if [ -n "$repo" ]; then settings=$(projectSettings "$src" "$repoDir" "$projectFilesDir"); fi
  engines=$(sed -n 3p <<<"$settings")
  network=${WOODSHED_NETWORK:-}
  [ -n "$network" ] || ! anyEngine "$engines" || network=woodshed
  local stackArgs=("$home" "$repo" "$image" "$(sed -n 1p <<<"$settings")" "$(sed -n 2p <<<"$settings")" "$engines" "$network")
  if [ -n "$repo" ] && [ -f "$stackEnv" ] && [ -z "$(savedConsoleSetting "$stackEnv" REPO)" ]; then
    addRepoToStackEnv "$stackEnv" "${stackArgs[@]}"
    say "This install had no repository: it works on $repo now, in its own session image. Repos added on Console settings still clone theirs at start"
  else
    writeStackEnv "$stackEnv" "${stackArgs[@]}"
  fi
  saveProjectFilesDir "$stackEnv" "$projectFilesDir"
  saveSessionDocker "$stackEnv"
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
  elif [ -n "$repo" ]; then
    say 'The project file has no databases: sessions get none of their own'
  else
    say "No repository yet, so no databases: a repo whose project file has some needs WOODSHED_REPO=owner/name bash install.sh"
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

  if [ -n "${WOODSHED_TAILSCALE:-}" ]; then setUpTailscale "$stackEnv"; fi
  writeLauncher "$home/bin/woodshed" "$home" "$src"
  say "Set up in $home. Start the console again any time with $home/bin/woodshed"
  say "Back up $WOODSHED_LOCAL_SECRETS_KEY_FILE somewhere else: losing it loses every secret"
  local url publicUrl
  url=http://localhost:$(consoleSetting PORT)
  publicUrl=$(consoleSetting PUBLIC_URL)
  [ -n "$repo" ] || say "Repositories are added in the console: Console settings, Repos, at ${publicUrl:-$url}/console-settings#card-projects"
  [ -z "${WOODSHED_NO_START:-}" ] || return 0

  [ -z "$ownConsole" ] || stopOwnConsole "$ownConsole" "$(consoleSetting PORT)"
  say "Starting the console at $url"
  openWhenReady "$url"
  exec "$home/bin/woodshed"
}

# Called last, so a download cut short runs nothing. The test sources the functions with WOODSHED_INSTALL_LIB=1.
if [ -z "${WOODSHED_INSTALL_LIB:-}" ]; then main "$@"; fi
