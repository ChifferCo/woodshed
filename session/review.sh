#!/bin/bash
# A review session's run (SESSION_MODE=review): gathers the pull request's context and the repo's rules from the base
# branch, reviews the diff with Claude, and sends the verdict to the console, which submits the formal review and the
# Merge risk check (POST /review-report, console/sessionApi.mjs). The prompt and verdict are shared/codeReview's, so
# the verdict matches the Actions review (review.yml). Runs in claude's pane; the review changes nothing on the branch.
# With REVIEW_AGENTS naming codex (Console settings' Reviews card), Codex reviews the same diff with the same prompt
# beside Claude, with no tools, from .review/codex/, on the author's own Codex sign-in when they turned that on for
# reviews, or on the team's OpenAI key through the console, and the two verdicts become one
# (codeReview.mjs merge): the strictest conclusion and the higher merge risk.
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
AGENTS=${REVIEW_AGENTS:-claude}
CODEX_DIR=$DIR/codex
CODEX_HOME_DIR=${CODEX_HOME:-$HOME/.codex}
# The author's Codex sign-in as the console gave it, which the entrypoint keeps (reviewCodexAuth).
OWN_CODEX_AUTH_FILE=${REVIEW_CODEX_GIVEN:-$HOME/.config/woodshed/codex-auth}
# How long Codex may take: Claude is held to its turns, and the verdict waits for both.
CODEX_MINUTES=${REVIEW_CODEX_MINUTES:-20}

say() { printf '\n[review %s] %s\n' "$(date +%H:%M:%S)" "$*"; }

# owner/name, from the checkout's origin: GITHUB_REPOSITORY is set only in GitHub Actions, never in a session.
repoOfCheckout() {
  local url
  url=$(git -C "$REPO_DIR" remote get-url origin 2>/dev/null) || return 1
  url=${url%.git}
  printf '%s\n' "${url#*github.com[:/]}"
}

runClaude() {
  "$SESSION_DIR/bin/claude" --model opus -p "$(cat "$DIR/review-prompt.md")" --max-turns 60 \
    --allowedTools "Bash(gh pr view:*),Bash(gh pr diff:*),Bash(git log:*),Bash(git diff:*),Bash(git show:*),Bash(git grep:*),Bash(ls:*),Bash(wc:*),Read,Grep,Glob,Write,Edit" \
    --output-format stream-json --verbose 2>&1 | tee "$DIR/logs/review.jsonl" \
    | jq -rR --unbuffered 'fromjson? | select(.type == "assistant") | .message.content[]? | select(.type == "text") | .text' \
    || true
  # How claude ended, so a review that stops early says why in the pane and the session's log.
  jq -rR 'fromjson? | select(.type == "result") | "subtype=\(.subtype) is_error=\(.is_error) turns=\(.num_turns // "?")"' \
    "$DIR/logs/review.jsonl" 2>/dev/null | tail -1 | while read -r ended; do say "Claude ended ($ended)"; done
}

withCodex() { [[ " $AGENTS " == *" codex "* ]]; }

# What Codex reads, put in its own folder, since it reviews with no tools (codeReview.mjs, codexPrompt): the context and
# rules Claude reads, the pull request's diff, and each changed file whole with its folder's README, as at the head.
gatherForCodex() {
  local f d
  mkdir -p "$CODEX_DIR/files"
  cp -r "$DIR/context.md" "$CODEX_DIR/" 2>/dev/null
  for f in base-rules instructions.md risk-areas.md; do [ -e "$DIR/$f" ] && cp -r "$DIR/$f" "$CODEX_DIR/"; done
  gh pr diff "$PR" > "$CODEX_DIR/pr.diff" 2>/dev/null \
    || git diff "origin/$REVIEW_BASE...HEAD" > "$CODEX_DIR/pr.diff" 2>/dev/null || true
  git diff --name-only --diff-filter=d "origin/$REVIEW_BASE...HEAD" 2>/dev/null | while IFS= read -r f; do
    for f in "$f" "$(dirname "$f")/README.md"; do
      f=${f#./}
      # Text files in the checkout only, never through a link out of it.
      [ -f "$f" ] && [ ! -e "$CODEX_DIR/files/$f" ] && grep -Iq . "$f" 2>/dev/null || continue
      case "$(realpath -e "$f" 2>/dev/null)" in "$(realpath "$REPO_DIR")"/*) ;; *) continue ;; esac
      d=$(dirname "$CODEX_DIR/files/$f")
      mkdir -p "$d" && cp "$f" "$d/"
    done
  done
}

runCodex() {
  local code answer=$CODEX_DIR/answer.json
  gatherForCodex
  node "$REVIEW" codex-prompt "$CODEX_DIR" --pr "$PR" --head "$(git rev-parse HEAD)" --server "$SERVER" --repo "$1" \
    --reviewer "${REVIEW_AUTHOR:-}" || { say "Could not write Codex's review prompt"; return 0; }
  # On the author's own sign-in when the entrypoint wrote it into codex's home (reviewCodexAuth); otherwise the session
  # holds no OpenAI key, and session/bin/codex goes through the console's proxy, which adds the team's.
  local auth=key
  [ -s "$CODEX_HOME_DIR/auth.json" ] && auth=own
  say "Codex reviews on $([ "$auth" = own ] && echo "the author's own Codex sign-in" || echo "the team's OpenAI key"), with no tools"
  # No tools: no shell, no patches (read-only), no web search, apps, browser or hooks. Codex's sandbox cannot run in this
  # container (bubblewrap has no user namespaces here), so the model gets nothing to run; the pull request's text can
  # then neither read the sign-in beside it, reach the network nor touch Claude's files. It answers in JSON alone.
  WOODSHED_CODEX_AUTH=$auth timeout --kill-after=30 "$CODEX_MINUTES"m "$SESSION_DIR/bin/codex" exec --skip-git-repo-check --ephemeral \
    --sandbox read-only --disable shell_tool --disable unified_exec --disable apps --disable browser_use \
    --disable computer_use --disable hooks --disable goals -c 'web_search="disabled"' \
    --output-schema "$CODEX_DIR/answer-schema.json" -o "$answer" --json - \
    < "$CODEX_DIR/review-prompt.md" > "$DIR/logs/codex.jsonl" 2>&1
  code=$?
  [ "$code" = 124 ] && say "Codex took longer than $CODEX_MINUTES minutes and was stopped"
  say "Codex ended (exit=$code)"
  [ -s "$answer" ] && { node "$REVIEW" codex-answer "$CODEX_DIR" "$answer" || say "Codex's answer was not the JSON asked for"; }
  [ "$auth" = own ] && keepCodexAuth
  return 0
}

# ChatGPT's refresh token rotates: a login codex refreshed goes back to the console, which keeps it for the author's
# next session, or the copy on My settings would stop working. Only a changed one, as statusd does for a Codex session.
keepCodexAuth() {
  local code
  [ -s "$OWN_CODEX_AUTH_FILE" ] && [[ "$(head -c 3 "$OWN_CODEX_AUTH_FILE")" != sk- ]] || return 0
  if [ "$(jq -cS . "$OWN_CODEX_AUTH_FILE" 2>/dev/null)" = "$(jq -cS . "$CODEX_HOME_DIR/auth.json" 2>/dev/null)" ]; then
    say "The author's Codex sign-in is unchanged, not sent back"
    return 0
  fi
  code=$(printf 'header = "Authorization: Bearer %s"\n' "$SESSION_TOKEN" \
    | curl -sS --max-time 15 -o /dev/null -w '%{http_code}' -X POST -K - --data-binary "@$CODEX_HOME_DIR/auth.json" \
      "$WOODSHED_CONSOLE_URL/codex-auth") || code=000
  say "The author's refreshed Codex sign-in sent back (status: $code)"
}

# The pull request's context and the repo's rules, from the base branch so a pull request cannot soften its own review.
gatherContext() {
  {
    echo "# Pull request #$PR"
    gh pr view "$PR" --json title,body,author --template '{{.title}} (by {{.author.login}}){{"\n\n"}}{{.body}}{{"\n"}}'
    echo; echo "# Discussion"
    gh pr view "$PR" --json comments --template '{{range .comments}}{{.author.login}}: {{.body}}{{"\n\n"}}{{end}}'
    echo "# Inline comments"
    gh api "repos/{owner}/{repo}/pulls/$PR/comments" --paginate \
      --jq '.[] | "[comment \(.id)] \(.user.login) on \(.path):\(.line // .original_line): \(.body)\n"'
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
  if withCodex; then verdict=$(node "$REVIEW" merge "$DIR" "$CODEX_DIR"); else verdict=$(node "$REVIEW" verdict "$DIR"); fi || { say "The reviewer wrote no verdict, so nothing is submitted"; verdict='{"conclusion":null}'; }
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
  local repo
  repo=$(repoOfCheckout) || repo=
  if [ -z "$repo" ] || ! node "$REVIEW" prompt "$DIR" --pr "$PR" --head "$(git rev-parse HEAD)" --server "$SERVER" --repo "$repo" \
    --reviewer "${REVIEW_AUTHOR:-}"; then
    say "Could not write the review prompt (repo: ${repo:-unknown}), so there is no review"
  else
    if withCodex; then
      say "Reviewing the diff of $repo with Claude Code and Codex"
      runCodex "$repo" &
      local codex=$!
      runClaude
      say "Waiting for Codex to finish"
      wait "$codex"
    else
      say "Reviewing the diff of $repo"
      runClaude
    fi
  fi
  sendReport
  rm -f "$RUNNING"
  exit 0
}

main "$@"
