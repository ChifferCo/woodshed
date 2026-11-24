#!/bin/bash
# Asks the console to open a GitHub issue for an ask session, through the session API (POST /issues,
# console/sessionApi.mjs). The console files it with its own App: this session's token only reads.
#
#   issue.sh <file>    JSON: {"repo": "owner/name", "title": "...", "body": "...", "labels": ["bug"]}
#
# Prints {"number", "url", "labels", "labelsIgnored"} once opened, or the console's reason it refused (and exits 1).
set -euo pipefail

: "${WOODSHED_CONSOLE_URL:?WOODSHED_CONSOLE_URL is not set}"
: "${SESSION_TOKEN:?SESSION_TOKEN is not set}"
[ -s "${1:-}" ] || { echo "usage: issue.sh <file with {repo, title, body, labels?} as JSON>" >&2; exit 2; }

# The session token goes to curl on stdin, not in its arguments, where `ps` would show it.
printf 'header = "Authorization: Bearer %s"\n' "$SESSION_TOKEN" \
  | curl -sS --fail-with-body --max-time 30 -X POST -K - -H 'content-type: application/json' \
    --data "@$1" "$WOODSHED_CONSOLE_URL/issues"
echo
