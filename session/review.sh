#!/bin/bash
# A review session's run (SESSION_MODE=review): gathers the pull request's context and the repo's rules from the base
# branch, reviews the diff with Claude, and sends the verdict to the console, which submits the formal review and the
# Merge risk check (POST /review-report, console/sessionApi.mjs). The prompt and verdict are shared/codeReview's, so
# the verdict matches the Actions review (review.yml). Runs in claude's pane; the review changes nothing on the branch.
# With REVIEW_AGENTS naming codex (Console settings' Reviews card), Codex reviews the same diff with the same prompt
# beside Claude, in .review/codex/, and the two verdicts become one (codeReview.mjs merge): the strictest conclusion and
# the higher merge risk. Codex reaches OpenAI through the console either way (console/openaiProxy.mjs), so the session
# holds no one's sign-in: on a key (REVIEW_CODEX_AUTH=key, the author's or the team's), or on the author's ChatGPT login
# (=chatgpt), for which codex holds a stand-in whose access token is the SESSION_TOKEN.
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
# Codex's home for a review on the author's ChatGPT login: the stand-in login, and nothing else.
CODEX_REVIEW_HOME=${REVIEW_CODEX_HOME:-$HOME/.codex-review}
# The HTTPS front codex reaches the console's /chatgpt through (chatgptRelay.mjs).
RELAY=${REVIEW_CHATGPT_RELAY:-/opt/woodshed/session/chatgptRelay.mjs}
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
withClaude() { [[ " $AGENTS " == *" claude "* ]]; }

# Codex is told how the prompt's tool names map to its own, and reads what Claude reads, from its own copy.
codexPrompt() {
  if withClaude; then
    printf '%s ' "You are Codex, reviewing beside another reviewer whose verdict is combined with yours."
  else
    printf '%s ' "You are Codex, the pull request's reviewer."
  fi
  printf '%s ' "Where the steps below say the Write tool, write that file with your own tools. Change nothing in the repository but the files the steps name."
  # Codex took every bug it found as a blocker, a narrower one each round, where Claude approved: step 6 is the bar.
  # After the bar alone (#252) it still blocked 91 of the 99 rounds Claude approved, through a race in one request's
  # window, a second failure, an older image mid-deploy, a missing edge-case test, or a declined point raised again.
  printf '%s ' "Hold to step 6's bar for what blocks: a bug that needs unlikely timing, or whose harm a reload undoes, is optional, never a reason to request changes."
  # It also gave one or two findings a round, and the next ones a round later: step 5 asks for all of them at once.
  printf '%s ' "Read the whole change before you write, and give every finding you have in this one review, as step 5 says, rather than one or two now and more next round."
  printf '%s\n\n' "Its list of optional cases is the list of what you blocked on before that the authors and the other reviewer rightly let through: do not reword one of them into a blocker."
  cat "$CODEX_DIR/review-prompt.md"
}

# A ChatGPT login in codex's shape that holds nothing of anyone's: its access token is this session's token, which the
# console's proxy swaps for the author's at each call. last_refresh is now, so codex never tries to refresh it. The
# account is the author's (REVIEW_CODEX_ACCOUNT, an id and no credential), since codex looks for it in ChatGPT's list.
writeStandInLogin() {
  local part claims account=${REVIEW_CODEX_ACCOUNT:-woodshed-stand-in}
  part() { printf '%s' "$1" | base64 -w0 | tr '+/' '-_' | tr -d '='; }
  claims=$(jq -cn --arg a "$account" '{"https://api.openai.com/auth": {chatgpt_account_id: $a, chatgpt_plan_type: "plus"}}')
  mkdir -p "$CODEX_REVIEW_HOME" && chmod 700 "$CODEX_REVIEW_HOME"
  # The token goes to jq on stdin, never in its arguments.
  printf '%s' "$SESSION_TOKEN" | (umask 077 && jq -Rn \
    --arg id "$(part '{"alg":"none"}').$(part "$claims").stand-in" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg a "$account" \
    '{auth_mode: "chatgpt", OPENAI_API_KEY: null, last_refresh: $at,
      tokens: {id_token: $id, access_token: input, refresh_token: "woodshed-stand-in", account_id: $a}}' \
    > "$CODEX_REVIEW_HOME/auth.json")
}

# codex reaches a ChatGPT backend only over https, and the console's session port is http: the relay is an https front
# on 127.0.0.1, with a certificate made for this run that only this codex trusts. Sets RELAY_PORT and RELAY_PID.
startRelay() {
  local tls=$CODEX_REVIEW_HOME/relay
  mkdir -p "$tls" && chmod 700 "$tls"
  # A CA made and thrown away here, and the relay's own certificate from it: codex's TLS refuses a CA as the server's.
  {
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 2 -subj '/CN=Woodshed review relay CA' \
      -keyout "$tls/ca-key.pem" -out "$tls/ca.pem" &&
    openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -subj '/CN=127.0.0.1' \
      -keyout "$tls/key.pem" -out "$tls/relay.csr" &&
    printf 'subjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n' > "$tls/ext.cnf" &&
    openssl x509 -req -in "$tls/relay.csr" -CA "$tls/ca.pem" -CAkey "$tls/ca-key.pem" -CAcreateserial -days 2 \
      -extfile "$tls/ext.cnf" -out "$tls/cert.pem"
  } > /dev/null 2>&1 || return 1
  rm -f "$tls/ca-key.pem"
  # exec, so the coprocess is node itself and killing RELAY_PID stops the relay, not only a shell around it.
  coproc RELAY_PROC { exec node "$RELAY" "$tls/cert.pem" "$tls/key.pem" "$WOODSHED_CONSOLE_URL" 2>&1; }
  RELAY_PID=$RELAY_PROC_PID
  if read -r -t 10 RELAY_PORT <&"${RELAY_PROC[0]}" && [[ "$RELAY_PORT" =~ ^[0-9]+$ ]]; then return 0; fi
  # It never said its port: stop it rather than leave it running.
  kill "$RELAY_PID" 2>/dev/null
  return 1
}

runCodex() {
  local code f via=${REVIEW_CODEX_AUTH:-key}
  mkdir -p "$CODEX_DIR"
  cp -r "$DIR/context.md" "$CODEX_DIR/" 2>/dev/null
  for f in base-rules instructions.md risk-areas.md; do [ -e "$DIR/$f" ] && cp -r "$DIR/$f" "$CODEX_DIR/"; done
  node "$REVIEW" prompt "$CODEX_DIR" --pr "$PR" --head "$(git rev-parse HEAD)" --server "$SERVER" --repo "$1" \
    --reviewer "${REVIEW_AUTHOR:-}" || { say "Could not write Codex's review prompt"; return 0; }
  # The container is the sandbox, as for a Codex session; the review's GitHub token is read-only, and no sign-in is here.
  if [ "$via" = chatgpt ]; then
    say "Codex reviews on the author's ChatGPT login, which the console adds to its calls"
    writeStandInLogin
    if ! startRelay; then
      say "Could not start the relay to the console, so Codex does not review"
      return 0
    fi
    WOODSHED_CODEX_AUTH=own CODEX_HOME=$CODEX_REVIEW_HOME CODEX_CA_CERTIFICATE=$CODEX_REVIEW_HOME/relay/ca.pem \
      timeout --kill-after=30 "$CODEX_MINUTES"m "$SESSION_DIR/bin/codex" \
      -c "chatgpt_base_url=\"https://127.0.0.1:$RELAY_PORT/backend-api\"" \
      -c "openai_base_url=\"https://127.0.0.1:$RELAY_PORT/backend-api/codex\"" \
      exec --skip-git-repo-check --sandbox danger-full-access --json "$(codexPrompt)" > "$DIR/logs/codex.jsonl" 2>&1 < /dev/null
    code=$?
    kill "$RELAY_PID" 2>/dev/null
  else
    say "Codex reviews on a key the console adds to its calls (the author's or the team's)"
    WOODSHED_CODEX_AUTH=key timeout --kill-after=30 "$CODEX_MINUTES"m "$SESSION_DIR/bin/codex" \
      exec --skip-git-repo-check --sandbox danger-full-access --json "$(codexPrompt)" > "$DIR/logs/codex.jsonl" 2>&1 < /dev/null
    code=$?
  fi
  [ "$code" = 124 ] && say "Codex took longer than $CODEX_MINUTES minutes and was stopped"
  say "Codex ended (exit=$code)"
  # What the console refused, in the pane: an author's sign-in turned off or expired since the review started.
  grep -o '"message":"[^"]*sign-in[^"]*"' "$DIR/logs/codex.jsonl" 2>/dev/null | tail -1 | while read -r why; do say "Codex: $why"; done
  return 0
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
  # The same inline comments as records, for whose each one is when two reviewers' verdicts merge (codeReview.mjs
  # commentAuthorsIn): a comment's text in context.md could pass for another record.
  gh api "repos/{owner}/{repo}/pulls/$PR/comments" --paginate --jq '.[] | {id, body: .body[0:80]} | tojson' \
    > "$DIR/earlier-comments.jsonl" 2>/dev/null || true
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
  if withCodex && withClaude; then verdict=$(node "$REVIEW" merge "$DIR" "$CODEX_DIR")
  elif withCodex; then verdict=$(node "$REVIEW" verdict "$CODEX_DIR")
  else verdict=$(node "$REVIEW" verdict "$DIR"); fi || { say "The reviewer wrote no verdict, so nothing is submitted"; verdict='{"conclusion":null}'; }
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
    if withCodex && ! withClaude; then
      say "Reviewing the diff of $repo with Codex"
      runCodex "$repo"
    elif withCodex; then
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
