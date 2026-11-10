#!/usr/bin/env bash
# Push screenshots to an image-only branch, to embed them in a pull request's description, without touching the
# working tree or the real index.
#
# Usage: prAssets.sh <pr-number>-<short-slug> <name>=<path> [<name>=<path> ...]
#   e.g. prAssets.sh 12-rail-card before.png=/tmp/before.png after.png=/tmp/after.png
#
# Each image is stored under <name>, on the branch pr-assets/<pr-number>-<short-slug> of origin. Running it again adds
# to the branch; reusing a name replaces that image everywhere it is embedded. Prints the URL to embed for each image.
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <pr-number>-<short-slug> <name>=<path> [<name>=<path> ...]" >&2
  exit 1
fi

BRANCH="pr-assets/$1"
shift

# owner/repo from origin's configured URL (before any insteadOf rewrite): https://github.com/owner/repo(.git) or git@github.com:owner/repo(.git).
origin="$(git config --get remote.origin.url)"
slug="${origin%.git}"
slug="${slug#*github.com[:/]}"
case "$slug" in
  */*) ;;
  *) echo "origin is not a GitHub repository: $origin" >&2; exit 1 ;;
esac

GIT_INDEX_FILE="$(mktemp -u)"
export GIT_INDEX_FILE
trap 'rm -f "$GIT_INDEX_FILE"' EXIT

PARENT=()
if git fetch -q origin "$BRANCH" 2>/dev/null; then
  git read-tree FETCH_HEAD
  PARENT=(-p FETCH_HEAD)
fi

for pair in "$@"; do
  name="${pair%%=*}"
  file="${pair#*=}"
  if [ "$name" = "$pair" ] || [ ! -f "$file" ]; then
    echo "Expected <name>=<existing file>, got: $pair" >&2
    exit 1
  fi
  blob="$(git hash-object -w -- "$file")"
  git update-index --add --cacheinfo "100644,$blob,$name"
done

tree="$(git write-tree)"
# The ${…+…} form keeps an empty PARENT from tripping `set -u` on bash 3.2 (macOS).
commit="$(git commit-tree "$tree" ${PARENT[@]+"${PARENT[@]}"} -m "Screenshots for ${BRANCH#pr-assets/}")"
git push -q origin "$commit:refs/heads/$BRANCH"

for pair in "$@"; do
  echo "https://github.com/$slug/blob/$BRANCH/${pair%%=*}?raw=true"
done
