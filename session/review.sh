#!/bin/bash
# A review session's run (SESSION_MODE=review): gathers the pull request's context and the repo's rules from the base
# branch, reviews the diff with Claude, and sends the verdict to the console, which submits the formal review and the
# Merge risk check (POST /review-report, console/sessionApi.mjs). The prompt and verdict are shared/codeReview's, so
# the verdict matches the Actions review (review.yml). Runs in claude's pane; the review changes nothing on the branch.
#
#   review.sh    the whole run, once; the entrypoint starts it
set -uo pipefail

: "${SESSION_DIR:?}" "${REPO_DIR:?}" "${PR:?}" "${REVIEW_BASE:?}" "${SESSION_TOKEN:?}" "${WOODSHED_CONSOLE_URL:?}"
REVIEW=${REVIEW_SCRIPT:-/opt/woodshed/shared/codeReview/codeReview.mjs}
DIR=$REPO_DIR/.review
RUNNING=${REVIEW_RUNNING:-/tmp/review-running}
RULES=${REVIEW_RULES:-CLAUDE.md .woodshed/rules.md CONTRIBUTING.md}
INSTRUCTIONS=${REVIEW_INSTRUCTIONS:-.woodshed/review.md}
RISK_AREAS=${REVIEW_RISK_AREAS:-.woodshed/riskAreas.md}
SERVER=${GITHUB_SERVER_URL:-https://github.com}

say() { printf '\n[review %s] %s\n' "$(date +%H:%M:%S)" "$*"; }

runClaude() {
  "$SESSION_DIR/bin/claude" --model opus -p "$(cat "$DIR/review-prompt.md")" --max-turns 60 \
    --allowedTools "Bash(gh pr view:*),Bash(gh pr diff:*),Bash(git log:*),Bash(git diff:*),Bash(git show:*),Bash(git grep:*),Bash(ls:*),Bash(wc:*),Read,Grep,Glob,Write,Edit" \
    --output-format stream-json --verbose 2>&1 | tee "$DIR/logs/review.jsonl" \
    | jq -rR --unbuffered 'fromjson? | select(.type == "assistant") | .message.content[]? | select(.type == "text") | .text' \
    || true
}

# The pull request's context and the repo's rules, from the base branch so a pull request cannot soften its own review.
gatherContext() {
  local repo="${GITHUB_REPOSITORY:-}"
  {
    echo "# Pull request #$PR"
    gh pr view "$PR" --json title,body,author --template '{{.title}} (by {{.author.login}}){{"\n\n"}}{{.body}}{{"\n"}}'
    echo; echo "# Discussion"
    gh pr view "$PR" --json comments --template '{{range .comments}}{{.author.login}}: {{.body}}{{"\n\n"}}{{end}}'
    echo "# Linked issues"
    for issue in $(gh pr view "$PR" --json closingIssuesReferences --jq '.closingIssuesReferences[].number' 2>/dev/null); do
      gh issue view "$issue" --comments; echo
    done
  } > "$DIR/context.md" 2>&1 || true
  mkdir -p "$DIR/base-rules"
  set -f
  for f in $RULES; do
    mkdir -p "$DIR/base-rules/$(dirname "$f")"
    git show "origin/$REVIEW_BASE:$f" > "$DIR/base-rules/$f" 2>/dev/null || rm -f "$DIR/base-rules/$f"
  done
  set +f
  git show "origin/$REVIEW_BASE:$INSTRUCTIONS" > "$DIR/instructions.md" 2>/dev/null || rm -f "$DIR/instructions.md"
  git show "origin/$REVIEW_BASE:$RISK_AREAS" > "$DIR/risk-areas.md" 2>/dev/null || rm -f "$DIR/risk-areas.md"
}

sendReport() {
  local verdict code body
  # No verdict still reports, with a null conclusion, so the console stops the session rather than leaving it idle.
  verdict=$(node "$REVIEW" verdict "$DIR") || { say "The reviewer wrote no verdict, so nothing is submitted"; verdict='{"conclusion":null}'; }
  cost_of() { [ -f "$1" ] && jq -rR 'fromjson? | select(.type == "result") | .total_cost_usd // empty' "$1" | tail -1; }
  body=$(mktemp)
  jq -n --argjson v "$verdict" --arg sha "$(git -C "$REPO_DIR" rev-parse HEAD)" \
    --arg cost "$(cost_of "$DIR/logs/review.jsonl")" \
    '$v + {sha: $sha, costUsd: (($cost | tonumber?) // null)}' > "$body"
  code=$(printf 'header = "Authorization: Bearer %s"\n' "$SESSION_TOKEN" \
    | curl -sS --max-time 60 -o /tmp/review-report-reply.json -w '%{http_code}' -X POST -K - -H 'content-type: application/json' \
      --data "@$body" "$WOODSHED_CONSOLE_URL/review-report") || code=000
  rm -f "$body"
  say "Verdict sent to the console (status: $code)"
}

main() {
  touch "$RUNNING"
  mkdir -p "$DIR/logs"
  cd "$REPO_DIR" || exit 1
  grep -qx '/.review/' .git/info/exclude 2>/dev/null || echo '/.review/' >> .git/info/exclude
  say "Review of pull request #$PR against $REVIEW_BASE"
  git fetch --quiet origin "+refs/heads/$REVIEW_BASE:refs/remotes/origin/$REVIEW_BASE" || say "Could not fetch $REVIEW_BASE"
  gatherContext
  node "$REVIEW" prompt "$DIR" --pr "$PR" --head "$(git rev-parse HEAD)" --server "$SERVER" --repo "${GITHUB_REPOSITORY:-}"
  say "Reviewing the diff"
  runClaude
  sendReport
  rm -f "$RUNNING"
  exit 0
}

main "$@"
