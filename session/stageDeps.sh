#!/bin/bash
# Copies the files each of the project file's `dependencies.installs` depends on (its `files`, globs expanded) to the
# folder given, in the repo's own layout: the deploy workflow's session job builds the session image with it as `woodshed-deps/`.
# Beside it, not inside it (the image copies the folder into the checkout whole): `<folder>.installs`, the manifest
# session/deps.sh runs the installs from, and `<folder>.editor`, the project file's `editor` (true or false), which the
# Dockerfile reads to add VS Code or leave it out. Run from the repo's root. The project file is the repo's, or the
# installation's for a repo with none when WOODSHED_CLOUD_PROJECT_FILES_DIR names its folder (shared/project.mjs).
set -euo pipefail

dest=${1:?usage: stageDeps.sh <folder>}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=deps.sh
. "$here/deps.sh"
# Read on their own: a failure inside a command substitution in a for list would not stop the script.
manifest=$(REPO_DIR=$PWD node "$here/../shared/project.mjs" installs) || { echo "stageDeps: the project file's dependencies could not be read" >&2; exit 1; }
editor=$(REPO_DIR=$PWD node "$here/../shared/project.mjs" get editor) || { echo "stageDeps: the project file's editor could not be read" >&2; exit 1; }
from=$(REPO_DIR=$PWD node "$here/../shared/project.mjs" get from) || { echo "stageDeps: the project file could not be read" >&2; exit 1; }

rm -rf "$dest"
mkdir -p "$dest"
printf '%s\n' "$editor" > "$dest.editor"
echo "stageDeps: project file from $from"
echo "stageDeps: editor $editor"
# An empty file when there are no installs.
: > "$dest.installs"
[ -z "$manifest" ] || printf '%s\n' "$manifest" > "$dest.installs"
while IFS=$'\t' read -r kind dir files output _command; do
  [ "$kind" = install ] || continue
  [ -d "$dir" ] || { echo "stageDeps: $dir, an install's dir, is not a folder in the repo" >&2; exit 1; }
  missing=$(depsMissing "$dir" "$files")
  [ -z "$missing" ] || { echo "stageDeps: $dir has no $(echo "$missing" | paste -sd ' ' -), which its install's files name" >&2; exit 1; }
  staged=$(depsFiles "$dir" "$files" "$output")
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    mkdir -p "$(dirname "$dest/$dir/$file")"
    cp "$dir/$file" "$dest/$dir/$file"
  done <<< "$staged"
  echo "stageDeps: staged $dir" "($(grep -c . <<< "$staged" || true) files)"
done < "$dest.installs"
