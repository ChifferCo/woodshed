#!/bin/bash
# A QA session's run (SESSION_MODE=qa): plans tests for the pull request, starts the app, runs the plan in a browser
# and sends the report to the console, which posts it on the pull request (POST /qa-report, console/sessionApi.mjs).
# The prompts and the verdict are the QA actions' own (shared/qa/qa.mjs), so a repo gets the same QA in its CI or here.
# Runs in claude's pane, so the session's terminal shows it; statusd calls the session working while /tmp/qa-running is there.
#
#   qa.sh        the whole run, once; the entrypoint starts it after statusd's port is open
set -uo pipefail

: "${SESSION_DIR:?}" "${REPO_DIR:?}" "${PR:?}" "${QA_BASE:?}" "${SESSION_TOKEN:?}" "${WOODSHED_CONSOLE_URL:?}"
QA=${QA_SCRIPT:-/opt/woodshed/shared/qa/qa.mjs}
DIR=$REPO_DIR/.qa
RUNNING=${QA_RUNNING:-/tmp/qa-running}
STATUSD=http://127.0.0.1:${STATUSD_PORT:-7682}
NOTES=${QA_NOTES:-.woodshed/qa.md}
APP_WAIT_SECONDS=${QA_APP_WAIT_SECONDS:-900}

say() { printf '\n[qa %s] %s\n' "$(date +%H:%M:%S)" "$*"; }

# The session token goes to curl on stdin, not in its arguments, where `ps` would show it.
statusd() {
  local method=$1 path=$2
  printf 'header = "Authorization: Bearer %s"\n' "$SESSION_TOKEN" | curl -sS --max-time 30 -X "$method" -K - "$STATUSD$path"
}

# claude headless on the session's credential (session/bin/claude), its stream kept for the cost and the end reason,
# and its replies shown in the pane as it goes.
runClaude() {
  local prompt=$1 log=$2 turns=$3
  shift 3
  "$SESSION_DIR/bin/claude" --model opus -p "$(cat "$prompt")" --max-turns "$turns" "$@" \
    --output-format stream-json --verbose 2>&1 | tee "$log" \
    | jq -rR --unbuffered 'fromjson? | select(.type == "assistant") | .message.content[]? | select(.type == "text") | .text' \
    || true
}

# Background facts the planner reads from files, as the plan action gathers them: the pull request and its linked issues.
gatherContext() {
  gh pr view "$PR" --json title,body --jq '"# Pull request: \(.title)\n\n\(.body)\n"' > "$DIR/logs/pr-context.md" 2>/dev/null || true
  : > "$DIR/logs/past-fixes.md"
}

waitForApp() {
  local deadline=$((SECONDS + APP_WAIT_SECONDS)) app
  while [ $SECONDS -lt $deadline ]; do
    app=$(statusd GET /status | jq -r '.app // empty' 2>/dev/null)
    case "$app" in
      running) return 0 ;;
      failed) return 1 ;;
    esac
    sleep 5
  done
  return 1
}

sendReport() {
  local notCovered=$1 verdict body code
  verdict=$(node "$QA" verdict "$DIR" --not-covered "$notCovered")
  say "Verdict: $(jq -r '"\(.conclusion), \(.passed) of \(.total) passed, \(.failed) failed, \(.unverified) unverified"' <<< "$verdict")"
  cost_of() { [ -f "$1" ] && jq -rR 'fromjson? | select(.type == "result") | .total_cost_usd // empty' "$1" | tail -1; }
  body=$(mktemp)
  jq -n --argjson verdict "$verdict" --rawfile report <(cat "$DIR/report.md" 2>/dev/null || true) \
    --arg sha "$(git -C "$REPO_DIR" rev-parse HEAD)" \
    --arg cost "$(awk -v p="$(cost_of "$DIR/logs/plan.jsonl")" -v t="$(cost_of "$DIR/logs/test.jsonl")" 'BEGIN { printf "%.2f", p + t }')" \
    '{verdict: $verdict, report: $report, sha: $sha, costUsd: ($cost | tonumber)}' > "$body"
  code=$(printf 'header = "Authorization: Bearer %s"\n' "$SESSION_TOKEN" \
    | curl -sS --max-time 60 -o /tmp/qa-report-reply.json -w '%{http_code}' -X POST -K - -H 'content-type: application/json' \
      --data "@$body" "$WOODSHED_CONSOLE_URL/qa-report") || code=000
  rm -f "$body"
  say "Report sent to the console (status: $code)"
}

# The run ends here, whichever way it went: the report goes to the console, and the session reads as done.
finish() {
  sendReport "$1"
  rm -f "$RUNNING"
  exit 0
}

main() {
  touch "$RUNNING"
  mkdir -p "$DIR/logs" "$DIR/plan" "$DIR/screenshots"
  cd "$REPO_DIR" || exit 1
  # The run's files stay out of the Diff tab: they are the run's, not changes to the branch.
  grep -qx '/.qa/' .git/info/exclude 2>/dev/null || echo '/.qa/' >> .git/info/exclude
  say "QA of pull request #$PR against $QA_BASE"
  local port appUrl
  port=$(statusd GET /status | jq -r '.appServers.frontendPort // empty' 2>/dev/null)
  if [ -z "$port" ]; then
    say "The project file names no app to test"
    finish 'the project file names no app'
  fi
  appUrl="http://localhost:$port"
  # A pr session fetches only the default branch, and a stacked pull request merges into another.
  git fetch --quiet origin "+refs/heads/$QA_BASE:refs/remotes/origin/$QA_BASE" || say "Could not fetch $QA_BASE: the planner's diff will fail"
  if git show "origin/$QA_BASE:$NOTES" > "$DIR/notes.md" 2>/dev/null; then say "QA notes: $NOTES"; else rm -f "$DIR/notes.md"; say "No QA notes on $QA_BASE"; fi
  node "$QA" prompts "$DIR" --app-url "$appUrl" --base "$QA_BASE" --notes "$DIR/notes.md"
  gatherContext

  say "Planning the tests"
  runClaude "$DIR/plan-prompt.md" "$DIR/logs/plan.jsonl" 40 --allowedTools "Bash,Read,Write,Edit"
  if [ -f "$DIR/plan/SKIP.md" ]; then
    say "Nothing to test: $(head -1 "$DIR/plan/SKIP.md")"
    finish ''
  fi
  if [ ! -s "$DIR/plan/plan.md" ]; then
    echo 'the planner ended without writing a test plan' > "$DIR/plan/NO_PLAN.md"
    say "No test plan"
    finish ''
  fi

  say "Starting the app"
  statusd POST /app/start > /dev/null
  if ! waitForApp; then
    say "The app did not start; its log is on the App log tab"
    finish 'the app did not start'
  fi

  say "Running the tests at $appUrl"
  runClaude "$DIR/test-prompt.md" "$DIR/logs/test.jsonl" 200 --allowedTools "Bash,Read,Write,Edit,Glob,Grep,mcp__playwright"
  finish ''
}

main "$@"
