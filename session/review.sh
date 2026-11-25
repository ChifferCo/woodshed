#!/bin/bash
# A review session's run (SESSION_MODE=review): gathers the pull request's context and the repo's rules from the base
# branch, reviews the diff with Claude, and sends the verdict to the console, which submits the formal review and the
# Merge risk check (POST /review-report, console/sessionApi.mjs). The session prompt in shared/codeReview shares
# verdict rules with the Actions review (review.yml) and defines its own merge-risk rubric. Runs in claude's pane;
# the review changes nothing on the branch.
# With REVIEW_AGENTS naming codex (Console settings' Reviews card), Codex reviews the same diff with the same prompt
# beside Claude, in .review/codex/, and the two verdicts become one (codeReview.mjs merge): the strictest conclusion and
# the higher merge risk. Codex reaches OpenAI through the console either way (console/openaiProxy.mjs), so the session
# holds no one's sign-in: on a key (REVIEW_CODEX_AUTH=key, the author's or the team's), or on the author's ChatGPT login
# (=chatgpt), for which codex holds a stand-in whose access token is the SESSION_TOKEN.
# With REVIEW_AGENTS naming grok or opencode (My settings' reviews: the default, or the author's own choice), Grok Build or OpenCode review the
# same way, in .review/grok/ and .review/opencode/, on the author's own sign-in, which the console adds to their calls
# (console/reviewAgentProxy.mjs): each holds the SESSION_TOKEN as its API key, with its model API pointed at the console.
# There is no team key for them, and the session never holds the author's sign-in.
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
GROK_DIR=$DIR/grok
OPENCODE_DIR=$DIR/opencode
# Grok Build's and OpenCode's homes for a review: a config pointing at the console and the session's token, nothing else.
GROK_REVIEW_HOME=${REVIEW_GROK_HOME:-$HOME/.grok-review}
OPENCODE_REVIEW_HOME=${REVIEW_OPENCODE_HOME:-$HOME/.opencode-review}
# How long Grok Build and OpenCode may take, as Codex.
AGENT_MINUTES=${REVIEW_AGENT_MINUTES:-$CODEX_MINUTES}

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
    | jq -rR --unbuffered 'fromjson? | select(.type == "assistant") | .message.content[]? | select(.type == "text") | .text'
  # claude's own status, for why it wrote no verdict (the pipeline's last command is jq).
  echo "${PIPESTATUS[0]}" > "$DIR/logs/claude.exit"
  # How claude ended, so a review that stops early says why in the pane and the session's log.
  jq -rR 'fromjson? | select(.type == "result") | "subtype=\(.subtype) is_error=\(.is_error) turns=\(.num_turns // "?")"' \
    "$DIR/logs/review.jsonl" 2>/dev/null | tail -1 | while read -r ended; do say "Claude ended ($ended)"; done
}

withAgent() { [[ " $AGENTS " == *" $1 "* ]]; }
withCodex() { withAgent codex; }
withClaude() { withAgent claude; }

# The reviewers that run here, in the order a comment names them (shared/agents.cjs), and their names as a sentence.
reviewers() { local a; for a in claude codex grok opencode; do withAgent "$a" && printf '%s\n' "$a"; done; }
productOf() { case "$1" in claude) echo 'Claude Code' ;; codex) echo Codex ;; grok) echo 'Grok Build' ;; opencode) echo OpenCode ;; esac; }
reviewerNames() {
  local names=() a
  while read -r a; do names+=("$(productOf "$a")"); done < <(reviewers)
  if [ "${#names[@]}" -le 1 ]; then printf '%s' "${names[0]:-}"; return; fi
  local last=${names[-1]}
  unset 'names[-1]'
  local IFS=,
  printf '%s and %s' "$(printf '%s' "${names[*]}" | sed 's/,/, /g')" "$last"
}

# A reviewer other than Claude is told how the prompt's tool names map to its own, and reads what Claude reads, from its
# own copy: $1 its name, $2 its folder.
agentPrompt() {
  local others
  others=$(( $(reviewers | wc -l) - 1 ))
  if [ "$others" -gt 1 ]; then
    printf '%s ' "You are $1, reviewing beside other reviewers whose verdicts are combined with yours."
  elif [ "$others" = 1 ]; then
    printf '%s ' "You are $1, reviewing beside another reviewer whose verdict is combined with yours."
  else
    printf '%s ' "You are $1, the pull request's reviewer."
  fi
  printf '%s ' "Where the steps below say the Write tool, write that file with your own tools. Change nothing in the repository but the files the steps name."
  # Codex took every bug it found as a blocker, a narrower one each round, where Claude approved: step 6 is the bar.
  # After the bar alone (#252) it still blocked 91 of the 99 rounds Claude approved, through a race in one request's
  # window, a second failure, an older image mid-deploy, a missing edge-case test, or a declined point raised again.
  printf '%s ' "Hold to step 6's bar for what blocks: a bug that needs unlikely timing, or whose harm a reload undoes, is optional, never a reason to request changes."
  # It also gave one or two findings a round, and the next ones a round later: step 5 asks for all of them at once.
  printf '%s ' "Read the whole change before you write, and give every finding you have in this one review, as step 5 says, rather than one or two now and more next round."
  printf '%s\n\n' "Its list of optional cases is the list of what you blocked on before that the authors and the other reviewer rightly let through: do not reword one of them into a blocker."
  cat "$2/review-prompt.md"
}
codexPrompt() { agentPrompt Codex "$CODEX_DIR"; }

# A reviewer's own folder: what Claude reads, and its prompt naming it. $1 the folder, $2 its name, $3 the repo.
prepareAgentDir() {
  local f
  mkdir -p "$1"
  for f in context.md earlier-comments.jsonl base-rules instructions.md risk-areas.md; do [ -e "$DIR/$f" ] && cp -r "$DIR/$f" "$1/"; done
  node "$REVIEW" prompt "$1" --pr "$PR" --head "$(git rev-parse HEAD)" --server "$SERVER" --repo "$3" \
    --reviewer "${REVIEW_AUTHOR:-}" --agent "$2"
}

# What the console refused, in the pane: an author's sign-in turned off, removed or expired since the review started.
sayRefusal() {
  grep -oE '@[A-Za-z0-9-]+[^"\\]*(sign-in|login)[^"\\]*' "$2" 2>/dev/null | tail -1 | while read -r why; do say "$1: $why"; done
}

# Grok Build, on the author's own sign-in: grok holds the session's token as its xAI key (a key is what it sends to a
# models API it is pointed at), and GROK_MODELS_BASE_URL sends every model call to the console, which swaps the token for
# the author's key or login (reviewAgentProxy.mjs). Its home is this review's own: no login, no memory, Woodshed's config
# alone (no updater, no telemetry, nothing from ~/.claude), and the checkout is not trusted, so grok reads none of the
# pull request's own rules files into its first request: the review's rules are the base branch's, in its prompt. The
# image's /etc/grok/requirements.toml keeps every MCP server and the repo's hooks off, as in a Grok session; its hooks
# write their state to this home, not the pane's. Headless, it approves its own tool calls, as codex's review does in its
# container (--always-approve, as a Grok session in auto mode): it may write only the files its prompt names.
# No X search either: on a login's model list grok makes its turns on /v1/responses and offers xAI's own x_search tool
# there, which --disable-web-search leaves in, and the console's proxy refuses every provider tool (reviewAgentScope.mjs),
# so with it in, grok's first turn is refused and the review gets no verdict from it.
runGrok() {
  local code
  prepareAgentDir "$GROK_DIR" "Grok Build" "$1" || { say "Could not write Grok Build's review prompt"; return 0; }
  say "Grok Build reviews on the author's own sign-in, which the console adds to its calls"
  mkdir -p "$GROK_REVIEW_HOME" && chmod 700 "$GROK_REVIEW_HOME"
  printf '[cli]\nauto_update = false\n\n[features]\ntelemetry = false\nfeedback = false\n\n[compat.claude]\nmcps = false\nhooks = false\n\n[compat.cursor]\nmcps = false\n\n[auth]\npreferred_method = "api_key"\n' \
    > "$GROK_REVIEW_HOME/config.toml"
  XAI_API_KEY=$SESSION_TOKEN GROK_HOME=$GROK_REVIEW_HOME GROK_MODELS_BASE_URL=$WOODSHED_CONSOLE_URL/grok/v1 \
    WOODSHED_CLAUDE_STATE_FILE=$GROK_REVIEW_HOME/state.json \
    timeout --kill-after=30 "$AGENT_MINUTES"m "$SESSION_DIR/bin/grok" -p "$(agentPrompt "Grok Build" "$GROK_DIR")" \
    --always-approve --no-auto-update --no-memory --disable-web-search --disallowed-tools x_search \
    --output-format streaming-json \
    > "$DIR/logs/grok.jsonl" 2>&1 < /dev/null
  code=$?
  [ "$code" = 124 ] && say "Grok Build took longer than $AGENT_MINUTES minutes and was stopped"
  echo "$code" > "$DIR/logs/grok.exit"
  say "Grok Build ended (exit=$code)"
  sayRefusal "Grok Build" "$DIR/logs/grok.jsonl"
  return 0
}

# OpenCode, on one of the author's own provider API keys (REVIEW_OPENCODE_PROVIDER, anthropic or openai): its own
# auth.json in this review's home holds the session's token as that provider's key, and its config points the provider
# at the console, which swaps the token for the author's key (reviewAgentProxy.mjs). Only that provider is on, with no
# plugin (--pure) and no MCP server; session/bin/opencode keeps the repo's own config off, so a pull request cannot point
# a provider elsewhere. Headless, it approves its own tool calls (--auto), as codex's review does in its container.
runOpencode() {
  local code provider=${REVIEW_OPENCODE_PROVIDER:-} home=$OPENCODE_REVIEW_HOME
  case "$provider" in
    anthropic | openai) ;;
    *) say "OpenCode has no provider to review on, so it does not review"; return 0 ;;
  esac
  prepareAgentDir "$OPENCODE_DIR" OpenCode "$1" || { say "Could not write OpenCode's review prompt"; return 0; }
  say "OpenCode reviews on the author's own $provider key, which the console adds to its calls"
  mkdir -p "$home/data/opencode" "$home/config/opencode" && chmod 700 "$home"
  # The token goes to jq on stdin, never in its arguments.
  printf '%s' "$SESSION_TOKEN" | (umask 077 && jq -Rn --arg p "$provider" '{($p): {type: "api", key: input}}' > "$home/data/opencode/auth.json")
  jq -n --arg p "$provider" --arg url "$WOODSHED_CONSOLE_URL/opencode/$provider/v1" \
    '{"$schema": "https://opencode.ai/config.json", autoupdate: false, share: "disabled", enabled_providers: [$p],
      provider: {($p): {options: {baseURL: $url}}}, mcp: {}}' > "$home/config/opencode/opencode.json"
  XDG_DATA_HOME=$home/data XDG_CONFIG_HOME=$home/config OPENCODE_DISABLE_AUTOUPDATE=1 \
    timeout --kill-after=30 "$AGENT_MINUTES"m "$SESSION_DIR/bin/opencode" run --pure --auto --format json \
    "$(agentPrompt OpenCode "$OPENCODE_DIR")" > "$DIR/logs/opencode.jsonl" 2>&1 < /dev/null
  code=$?
  [ "$code" = 124 ] && say "OpenCode took longer than $AGENT_MINUTES minutes and was stopped"
  echo "$code" > "$DIR/logs/opencode.exit"
  say "OpenCode ended (exit=$code)"
  sayRefusal OpenCode "$DIR/logs/opencode.jsonl"
  return 0
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
  local code via=${REVIEW_CODEX_AUTH:-key}
  prepareAgentDir "$CODEX_DIR" Codex "$1" || { say "Could not write Codex's review prompt"; return 0; }
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
  echo "$code" > "$DIR/logs/codex.exit"
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
    > "$DIR/earlier-comments.jsonl" 2>/dev/null \
    || say "Earlier comments' writers not read, so a fixed thread is resolved only when both reviewers list it"
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

dirOf() { case "$1" in claude) echo "$DIR" ;; codex) echo "$CODEX_DIR" ;; grok) echo "$GROK_DIR" ;; opencode) echo "$OPENCODE_DIR" ;; esac; }

# Each reviewer's reason for no verdict, as one line for the console's log.
whyAll() {
  local a
  while read -r a; do [ -f "$(dirOf "$a")/why-no-verdict.txt" ] && printf '%s: %s; ' "$(productOf "$a")" "$(cat "$(dirOf "$a")/why-no-verdict.txt")"; done < <(reviewers)
}

sendReport() {
  local verdict code body a log pairs=()
  while read -r a; do
    pairs+=("$a=$(dirOf "$a")")
    # Why a reviewer wrote no verdict, one fixed sentence (never its log's text), for the note on GitHub and the pane.
    log=$DIR/logs/$a.jsonl; [ "$a" = claude ] && log=$DIR/logs/review.jsonl
    node "$REVIEW" reason "$(dirOf "$a")" "$log" "$(cat "$DIR/logs/$a.exit" 2>/dev/null)" 2>/dev/null || true
    [ -f "$(dirOf "$a")/why-no-verdict.txt" ] && say "$(productOf "$a") wrote no verdict: $(cat "$(dirOf "$a")/why-no-verdict.txt")"
  done < <(reviewers)
  # No verdict still reports, with a null conclusion, so the console stops the session rather than leaving it idle.
  if [ "${#pairs[@]}" -gt 1 ]; then verdict=$(node "$REVIEW" merge "${pairs[@]}")
  elif [ "${#pairs[@]}" = 1 ] && ! withClaude; then a=${pairs[0]%%=*}; verdict=$(node "$REVIEW" verdict "${pairs[0]#*=}" "$a")
  else verdict=$(node "$REVIEW" verdict "$DIR"); fi || { say "The reviewer wrote no verdict, so nothing is submitted"; verdict=$(jq -cn --arg why "$(whyAll)" '{conclusion: null, why: $why}'); }
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
  cd "$REPO_DIR" || exit 1
  # The review's folder is the run's alone: a branch can commit one, verdict and all, which a reviewer that writes none
  # would leave to be read as its own. Removed whole first, a link to elsewhere included (the link, not what it names).
  if [ -e "$DIR" ] || [ -L "$DIR" ]; then
    if [ -n "$(git ls-files -- "$DIR" 2>/dev/null | head -1)" ]; then say "The pull request carries a .review folder of its own: it is removed, and none of it is read"; fi
    rm -rf -- "$DIR"
  fi
  mkdir -p "$DIR/logs"
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
    if [ "$(reviewers | tr '\n' ' ')" = 'claude ' ] || [ -z "$(reviewers)" ]; then
      say "Reviewing the diff of $repo"
      runClaude
    else
      # Each reviewer but Claude runs beside it, in the background; the verdict waits for all of them.
      say "Reviewing the diff of $repo with $(reviewerNames)"
      local running=() others
      withCodex && { runCodex "$repo" & running+=($!); }
      withAgent grok && { runGrok "$repo" & running+=($!); }
      withAgent opencode && { runOpencode "$repo" & running+=($!); }
      withClaude && runClaude
      others=$(reviewerNames | sed 's/^Claude Code, //; s/^Claude Code and //')
      if withClaude; then say "Waiting for $others to finish"; fi
      [ "${#running[@]}" -eq 0 ] || wait "${running[@]}"
    fi
  fi
  sendReport
  rm -f "$RUNNING"
  exit 0
}

main "$@"
