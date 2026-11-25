#!/bin/bash
# A QA session's run (SESSION_MODE=qa): plans tests for the pull request, starts the app, runs the plan in a browser
# and sends the report to the console, which posts it on the pull request (POST /qa-report, console/sessionApi.mjs).
# The prompts and the verdict are the QA actions' own (shared/qa/qa.mjs), so a repo gets the same QA in its CI or here.
# Runs in claude's pane, so the session's terminal shows it; statusd calls the session working while /tmp/qa-running is there.
# The browser the tests drive records a video of each page, which goes to the console (POST /qa-video) before the
# report, for the QA comment to link.
#
#   qa.sh        the whole run, once; the entrypoint starts it after statusd's port is open
set -uo pipefail

: "${SESSION_DIR:?}" "${REPO_DIR:?}" "${PR:?}" "${QA_BASE:?}" "${SESSION_TOKEN:?}" "${WOODSHED_CONSOLE_URL:?}"
QA=${QA_SCRIPT:-/opt/woodshed/shared/qa/qa.mjs}
RUN_LOG=${QA_RUN_LOG:-$(dirname "$QA")/runLog.mjs}
DIR=$REPO_DIR/.qa
RUNNING=${QA_RUNNING:-/tmp/qa-running}
STATUSD=http://127.0.0.1:${STATUSD_PORT:-7682}
NOTES=${QA_NOTES:-.woodshed/qa.md}
APP_WAIT_SECONDS=${QA_APP_WAIT_SECONDS:-900}
PLAYWRIGHT_MCP=${QA_PLAYWRIGHT_MCP:-playwright-mcp}
QA_BROWSER=${QA_BROWSER:-$SESSION_DIR/qaBrowser.mjs}
# What the console takes (console/qaSessions.mjs): a bigger video is kept in the session and not sent.
MAX_VIDEO_BYTES=$((25 * 1024 * 1024))
# How long the browser may take to close after claude ends: qaBrowser.mjs gives it 30 s.
BROWSER_CLOSE_WAIT_SECONDS=${QA_BROWSER_CLOSE_WAIT_SECONDS:-40}
MAX_VIDEOS=5
# The ffmpeg Playwright records with, for the still the QA comment shows: the image ships it beside its Chromium.
QA_FFMPEG=${QA_FFMPEG:-$(ls -1d "${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"/ffmpeg-*/ffmpeg-linux 2>/dev/null | tail -1)}

# Each step is kept as well as shown, for the run log the console keeps (sendLog).
say() { printf '\n[qa %s] %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$DIR/logs/steps.log"; }

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

# The tests' own Playwright MCP, as the image adds it for claude (session/Dockerfile) but recording each page into
# $DIR/video, behind qaBrowser.mjs, which closes the browser when claude ends so that each video is written whole.
writeMcpConfig() {
  jq -n --arg dir "$DIR/video" '{browser: {contextOptions: {recordVideo: {dir: $dir, size: {width: 1280, height: 720}}}}}' \
    > "$DIR/playwright.json"
  jq -n --arg proxy "$QA_BROWSER" --arg cmd "$PLAYWRIGHT_MCP" --arg config "$DIR/playwright.json" \
    '{mcpServers: {playwright: {command: "node", args: [$proxy, $cmd, "--headless", "--browser", "chromium", "--config", $config]}}}' \
    > "$DIR/mcp.json"
}

# claude can end before qaBrowser.mjs has closed the browser, and Playwright writes a video only at the close: wait for
# the proxy and its server, the processes that carry this run's Playwright config in their command lines, to be gone.
waitForBrowser() {
  local deadline=$((SECONDS + BROWSER_CLOSE_WAIT_SECONDS))
  while pgrep -f -- "$DIR/playwright.json" > /dev/null; do
    if [ $SECONDS -ge $deadline ]; then
      say "The browser did not close in ${BROWSER_CLOSE_WAIT_SECONDS}s, its video may be cut short"
      return
    fi
    sleep 1
  done
}

# Each page's video, oldest first, to the console, which keeps them for the pull request's QA comment to link, then a
# still from the first one's last second, which the comment shows. One at a time: the console takes no more.
sendVideos() {
  local file bytes code sent=0 first=''
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    bytes=$(stat -c %s "$file")
    if [ "$sent" -ge "$MAX_VIDEOS" ]; then say "Video not sent, past $MAX_VIDEOS: $file"; continue; fi
    if [ "$bytes" -gt "$MAX_VIDEO_BYTES" ]; then say "Video not sent, over $((MAX_VIDEO_BYTES / 1024 / 1024)) MB ($bytes bytes): $file"; continue; fi
    code=$(sendRecording /qa-video video/webm "$file")
    say "Video sent to the console ($((bytes / 1024)) KB, status: $code)"
    if [ "$code" = 200 ]; then
      sent=$((sent + 1))
      [ -n "$first" ] || first=$file
    fi
  done < <(ls -1tr "$DIR"/video/*.webm 2>/dev/null)
  [ -n "$first" ] && sendPoster "$first"
  return 0
}

sendPoster() {
  if [ -z "$QA_FFMPEG" ]; then say "No still sent: Playwright's ffmpeg is not in this image"; return; fi
  if ! "$QA_FFMPEG" -hide_banner -loglevel error -y -sseof -1 -i "$1" -frames:v 1 -vf scale=800:-2 "$DIR/poster.png" \
    || [ ! -s "$DIR/poster.png" ]; then
    say "No still sent: ffmpeg made none from $1"
    return
  fi
  say "Still sent to the console (status: $(sendRecording /qa-poster image/png "$DIR/poster.png"))"
}

# @returns the console's status code, 000 when it was not reached
sendRecording() {
  local path=$1 type=$2 file=$3 code
  code=$(printf 'header = "Authorization: Bearer %s"\n' "$SESSION_TOKEN" \
    | curl -sS --max-time 300 -o /tmp/qa-recording-reply.json -w '%{http_code}' -X POST -K - -H "content-type: $type" \
      --data-binary "@$file" "$WOODSHED_CONSOLE_URL$path") || code=000
  echo "$code"
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

# The run log: the steps this script took, then how each claude pass ended (shared/qa/runLog.mjs). Kept on the console
# beside the report, and sent after each pass too, so a session that is stopped before its report still leaves one.
sendLog() {
  local code
  {
    echo "QA of pull request #$PR against $QA_BASE, session ${SESSION_ID:-unknown}"
    echo
    echo '## steps'
    sed '/^$/d' "$DIR/logs/steps.log" 2>/dev/null
    echo
    node "$RUN_LOG" plan "$DIR/logs/plan.jsonl"
    echo
    node "$RUN_LOG" test "$DIR/logs/test.jsonl"
    for f in SKIP NO_PLAN; do [ -f "$DIR/plan/$f.md" ] && { echo; echo "## plan/$f.md"; head -c 2000 "$DIR/plan/$f.md"; }; done
    [ -f "$DIR/report.md" ] || { echo; echo 'No report.md was written.'; }
  } > "$DIR/logs/run.log" 2>&1
  code=$(printf 'header = "Authorization: Bearer %s"\n' "$SESSION_TOKEN" \
    | curl -sS --max-time 60 -o /tmp/qa-log-reply.json -w '%{http_code}' -X POST -K - -H 'content-type: text/plain' \
      --data-binary "@$DIR/logs/run.log" "$WOODSHED_CONSOLE_URL/qa-log") || code=000
  echo "Run log sent to the console (status: $code)"
}

sendReport() {
  local notCovered=$1 verdict body code ended=''
  # No report because a pass ran out of turns or was cut off: the verdict says so, not only "no QA report".
  if [ ! -s "$DIR/report.md" ] && [ -f "$DIR/logs/test.jsonl" ]; then ended=$(node "$RUN_LOG" --why test "$DIR/logs/test.jsonl"); fi
  [ -n "$ended" ] || { [ -f "$DIR/logs/plan.jsonl" ] && [ ! -s "$DIR/plan/plan.md" ] && ended=$(node "$RUN_LOG" --why plan "$DIR/logs/plan.jsonl"); }
  verdict=$(node "$QA" verdict "$DIR" --not-covered "$notCovered" --ended "$ended")
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
  sendLog
  sendReport "$1"
  rm -f "$RUNNING"
  exit 0
}

main() {
  touch "$RUNNING"
  mkdir -p "$DIR/logs" "$DIR/plan" "$DIR/screenshots" "$DIR/video"
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
  sendLog
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

  say "Running the tests at $appUrl, recording the browser"
  writeMcpConfig
  runClaude "$DIR/test-prompt.md" "$DIR/logs/test.jsonl" 200 --allowedTools "Bash,Read,Write,Edit,Glob,Grep,mcp__playwright" \
    --mcp-config "$DIR/mcp.json" --strict-mcp-config
  waitForBrowser
  sendLog
  sendVideos
  finish ''
}

main "$@"
