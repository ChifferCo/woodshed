#!/bin/bash
# The repo's dependency installs, from the manifest `project.mjs installs` prints (the project file's
# `dependencies.installs`): one `install` line each, tab separated: dir, files, output, prune, command. Nothing here knows a
# package manager or names a variable: each install is its own command, and reads what it needs from the environment.
#
#   deps.sh install <manifest> <out>   the image's deps stage, in the checkout's path: with INSTALL_ENV_FILE's
#                                      `NAME=value` lines exported (the build's install_env secret, when it has one),
#                                      runs each command in its dir, prunes it (depsPrune), then moves what it keeps to <out>/checkout (paths in the dir) and <out>/home
#                                      (`~/` paths), and the record of the files it was built from to <out>/records
#   deps.sh check <manifest>           the image's last stage, in the checkout: fails unless each install's files are
#                                      the ones its record says it was built from
#
# Sourced, it only defines the functions: stageDeps.sh and refreshDeps (entrypoint.sh) use them too, so the image,
# its build and a session agree on which files an install depends on.
#
# `files` are globs in the dir (`*`, `?` and `[...]`, within one folder: `packages/*/package.json`). A file under one
# of the install's own outputs never counts. The record is each file's sha256 and path, under WOODSHED_DEPS_RECORDS
# (/work/.woodshed-deps in the image), at <dir>/built-from.

DEPS_RECORDS=${WOODSHED_DEPS_RECORDS:-/work/.woodshed-deps}
# Beside this file: the Dockerfile mounts the two side by side, and the image keeps them in one folder.
DEPS_PRUNE=$(dirname "${BASH_SOURCE[0]}")/pruneDeps.mjs

# depsFiles <dir> <files> <output>: the files the globs match, relative to the dir, one a line and sorted.
depsFiles() {
  local dir=$1 files=$2 output=$3
  (
    cd "$dir" 2>/dev/null || exit 0
    shopt -s dotglob nullglob
    local file out kept
    # Unquoted on purpose: each glob expands here, in the dir.
    # shellcheck disable=SC2086
    for file in $files; do
      [ -f "$file" ] || continue
      kept=
      for out in $output; do
        case "$out" in "~/"*) continue ;; esac
        case "$file" in "${out%/}/"*) kept=1 ;; esac
      done
      [ -n "$kept" ] || printf '%s\n' "$file"
    done | LC_ALL=C sort -u
  )
}

# depsMissing <dir> <files>: each entry with no glob in it whose file is not there, one a line.
depsMissing() {
  local dir=$1 files=$2
  (
    set -f
    local file
    # shellcheck disable=SC2086
    for file in $files; do
      case "$file" in *[*?[]*) continue ;; esac
      [ -f "$dir/$file" ] || printf '%s\n' "$file"
    done
  )
}

# depsRecord <dir> <files> <output>: what the install is built from, as `sha256  path` lines.
depsRecord() {
  local dir=$1
  depsFiles "$@" | (cd "$dir" 2>/dev/null && xargs -r -d '\n' sha256sum --)
}

depsRecordFile() {
  printf '%s/%s/built-from\n' "$DEPS_RECORDS" "$1"
}

# depsBuiltFrom <dir> <files> <output>: whether the dir's files are still the ones its record says it was built from.
depsBuiltFrom() {
  local record
  record=$(depsRecordFile "$1")
  [ -f "$record" ] && [ "$(depsRecord "$@")" = "$(cat "$record")" ]
}

# depsRun <dir> <command>: the install's command, in its dir, with bash. Not on the manifest's stdin, which the loops
# that call it read: a command that reads stdin would take the installs after it.
depsRun() {
  (cd "$1" && bash -c "$2" </dev/null)
}

# depsLoadEnv <file>: exports the file's `NAME=value` lines, the installation's install secrets. Their names are
# logged, never their values.
depsLoadEnv() {
  [ -s "${1:-}" ] || { echo "deps: no install secrets"; return 0; }
  set -a
  # shellcheck disable=SC1090
  . "$1"
  set +a
  echo "deps: install secrets in $(sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' "$1" | paste -sd ' ' -)"
}

# depsPrune <dir> <output> <prune>: removes from each `node_modules` the install keeps in its dir what this image never
# loads (pruneDeps.mjs). Never fails the install: a prune that fails only warns, and keeps what it had not removed.
depsPrune() {
  local dir=$1 output=$2 prune=$3 path roots=()
  if [ "$prune" != true ]; then echo "deps: not pruning $dir (prune: false)"; return 0; fi
  for path in $output; do
    case "$path" in "~/"*) continue ;; esac
    if [ "${path##*/}" = node_modules ] && [ -d "$dir/$path" ]; then roots+=("$dir/$path"); fi
  done
  [ "${#roots[@]}" -gt 0 ] || return 0
  node "$DEPS_PRUNE" "${roots[@]}" || echo "deps: WARNING: pruning $dir failed, what is left of it is kept" >&2
}

depsInstall() {
  local manifest=$1 out=$2 kind dir files output prune command path from to count=0
  depsLoadEnv "${INSTALL_ENV_FILE:-}"
  mkdir -p "$out/checkout" "$out/home" "$out/records"
  while IFS=$'\t' read -r kind dir files output prune command; do
    [ "$kind" = install ] || continue
    echo "deps: installing $dir"
    depsRun "$dir" "$command" || { echo "deps: the install in $dir failed: $command" >&2; return 1; }
    depsPrune "$dir" "$output" "$prune"
    mkdir -p "$out/records/$dir"
    depsRecord "$dir" "$files" "$output" > "$out/records/$dir/built-from"
    for path in $output; do
      case "$path" in
        "~/"*) from=$HOME/${path#"~/"}; to=$out/home/${path#"~/"} ;;
        *) from=$dir/$path; to=$out/checkout/$dir/$path ;;
      esac
      [ -e "$from" ] || { echo "deps: the install in $dir made no $path" >&2; return 1; }
      mkdir -p "$(dirname "$to")"
      mv "$from" "$to"
    done
    count=$((count + 1))
  done < "$manifest"
  echo "deps: installed ($count installs)"
}

depsCheck() {
  local manifest=$1 kind dir files output _prune _command
  while IFS=$'\t' read -r kind dir files output _prune _command; do
    [ "$kind" = install ] || continue
    depsBuiltFrom "$dir" "$files" "$output" \
      || { echo "deps: $dir's files in the build context are not the cloned commit's: build from that commit" >&2; return 1; }
  done < "$manifest"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  case "${1:-}" in
    install) depsInstall "${2:?usage: deps.sh install <manifest> <out>}" "${3:?usage: deps.sh install <manifest> <out>}" ;;
    check) depsCheck "${2:?usage: deps.sh check <manifest>}" ;;
    *) echo "usage: deps.sh install <manifest> <out> | check <manifest>" >&2; exit 1 ;;
  esac
fi
