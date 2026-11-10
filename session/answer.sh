#!/bin/bash
# Posts an ask session's answer in its Slack thread, through the console's
# session API (POST /answer, console/sessionApi.mjs).
#
#   answer.sh <file>    the answer, as Markdown
#
# Prints the console's answer: {"posted": true} once Slack took it.
set -euo pipefail

: "${WOODSHED_CONSOLE_URL:?WOODSHED_CONSOLE_URL is not set}"
: "${SESSION_TOKEN:?SESSION_TOKEN is not set}"
[ -s "${1:-}" ] || { echo "usage: answer.sh <file with the answer, as Markdown>" >&2; exit 2; }

body=$(mktemp)
trap 'rm -f "$body"' EXIT
jq -Rs '{text: .}' < "$1" > "$body"
# The session token goes to curl on stdin, not in its arguments, where `ps` would show it.
printf 'header = "Authorization: Bearer %s"\n' "$SESSION_TOKEN" \
  | curl -sS --fail-with-body --max-time 30 -X POST -K - -H 'content-type: application/json' \
    --data "@$body" "$WOODSHED_CONSOLE_URL/answer"
echo
