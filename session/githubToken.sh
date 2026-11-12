#!/bin/bash
# Prints a GitHub token for this session. git's credential helper and the `gh`
# wrapper both call it.
#
# A session given GH_TOKEN (local Docker, no GitHub App) gets that. Otherwise it
# is a token from the console (console/sessionApi.mjs): an installation token,
# or the owner's own. It is cached for 5 minutes, and never past 10 minutes
# before it expires: the console can end an owner's token early (Disconnect),
# and the session then gets the installation token on its next ask.
set -euo pipefail

if [ -n "${GH_TOKEN:-}" ]; then
  printf '%s\n' "$GH_TOKEN"
  exit 0
fi
: "${WOODSHED_CONSOLE_URL:?neither GH_TOKEN nor WOODSHED_CONSOLE_URL is set}"
: "${SESSION_TOKEN:?SESSION_TOKEN is not set}"

# WOODSHED_TMP: a start run beside a live session keeps its own (entrypoint.sh).
CACHE=${WOODSHED_TMP:-/tmp}/woodshed-github-token
MIN_LEFT_SECONDS=600
MAX_CACHE_SECONDS=300

if [ -f "$CACHE" ]; then
  read -r useUntil token < "$CACHE"
  if [ "$useUntil" -gt "$(date +%s)" ]; then
    printf '%s\n' "$token"
    exit 0
  fi
fi

# The session token goes to curl on stdin, not in its arguments, where `ps` would show it. Minting a token is safe to
# repeat, so a push made while the console restarts (each redeploy) waits for it, as the entrypoint's consoleCall does:
# up to about 40 s on any failure but a 4xx, the answer in a file curl empties before each try. A refusal's reason,
# such as an owner who must connect GitHub again, goes to stderr at once, where git and gh show it.
umask 077
answerFile=$(mktemp "${WOODSHED_TMP:-/tmp}/woodshed-github-token-answer.XXXXXX")
trap 'rm -f "$answerFile"' EXIT
code=$(printf 'header = "Authorization: Bearer %s"\n' "$SESSION_TOKEN" \
  | curl -sS -X POST -K - -o "$answerFile" -w '%{http_code}' --max-time 15 \
    --retry 8 --retry-delay 5 --retry-max-time 60 --retry-all-errors "$WOODSHED_CONSOLE_URL/github-token") || code=000
answer=$(cat "$answerFile")
if [ "$code" != 200 ]; then
  echo "could not get a GitHub token (status $code): $(jq -r '.error // empty' <<< "$answer" 2>/dev/null || true)" >&2
  exit 1
fi
token=$(jq -er .token <<< "$answer")
expires=$(date -d "$(jq -er .expiresAt <<< "$answer")" +%s)
now=$(date +%s)
useUntil=$((expires - MIN_LEFT_SECONDS))
[ "$useUntil" -le $((now + MAX_CACHE_SECONDS)) ] || useUntil=$((now + MAX_CACHE_SECONDS))

tmp=$(mktemp "$CACHE.XXXXXX")
printf '%s %s\n' "$useUntil" "$token" > "$tmp"
mv "$tmp" "$CACHE"
printf '%s\n' "$token"
