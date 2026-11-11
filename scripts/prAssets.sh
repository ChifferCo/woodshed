#!/usr/bin/env bash
# Push screenshots to a pull request's image-only ref, to embed them in its description, without touching the working
# tree or the real index, and without making a branch.
#
# Usage: prAssets.sh <pr-number>-<short-slug> <name>=<path> [<name>=<path> ...]
#   e.g. prAssets.sh 12-rail-card before.png=/tmp/before.png after.png=/tmp/after.png
#
# The images live on refs/pr-assets/<pr-number>-<short-slug> of origin, which is not a branch: clones don't fetch it,
# and a workflow deletes it when the pull request is closed without merging. Each run replaces the ref with one new,
# parentless commit holding every image the ref had plus the ones given, a name used again replacing that image, so
# the old commits can be collected. URLs can't name a custom ref, so the URLs it prints, one for every image on the
# ref, name the commit: a re-run gives new URLs for every image, and the pull request description must use the latest.
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <pr-number>-<short-slug> <name>=<path> [<name>=<path> ...]" >&2
  exit 1
fi

REF="refs/pr-assets/$1"
shift

# owner/repo from origin's configured URL (before any insteadOf rewrite): https://github.com/owner/repo(.git) or git@github.com:owner/repo(.git).
origin="$(git config --get remote.origin.url)"
slug="${origin%.git}"
slug="${slug#*github.com[:/]}"
case "$slug" in
  */*) ;;
  *) echo "origin is not a GitHub repository: $origin" >&2; exit 1 ;;
esac

for pair in "$@"; do
  if [ "${pair%%=*}" = "$pair" ] || [ ! -f "${pair#*=}" ]; then
    echo "Expected <name>=<existing file>, got: $pair" >&2
    exit 1
  fi
done

GIT_INDEX_FILE="$(mktemp -u)"
export GIT_INDEX_FILE
trap 'rm -f "$GIT_INDEX_FILE"' EXIT

# ls-remote fails on a network error and prints nothing for a ref that doesn't exist yet.
previous="$(git ls-remote origin "$REF" | cut -f1)"
if [ -n "$previous" ]; then
  git fetch -q origin "$REF"
  git read-tree "FETCH_HEAD^{tree}"
fi

for pair in "$@"; do
  blob="$(git hash-object -w -- "${pair#*=}")"
  git update-index --add --cacheinfo "100644,$blob,${pair%%=*}"
done

tree="$(git write-tree)"
commit="$(git commit-tree "$tree" -m "Screenshots for ${REF#refs/pr-assets/}")"
# The lease makes a concurrent run fail instead of dropping the images it pushed.
git push -q --force-with-lease="$REF:$previous" origin "$commit:$REF"

# Every image's URL, not only the new ones, since the commit they name is new.
git ls-tree --name-only "$tree" | while IFS= read -r name; do
  echo "https://github.com/$slug/blob/$commit/$name?raw=true"
done
echo "$REF is now $commit. A re-run gives new URLs for every image: use these in the pull request description." >&2
