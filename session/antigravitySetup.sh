# shellcheck shell=bash
# Shared by the session entrypoint and statusd (when it starts an Antigravity CLI beside another agent).
# Antigravity CLI (`agy`, shared/agents.cjs) keeps everything under ~/.gemini. Measured with agy 1.5.18:
#   antigravity-cli/settings.json  user settings (modelProvider, trustedWorkspaces, permissions, ...)
#   antigravity-cli/cache/onboarding.json  three booleans; all true skips the theme and Terms of Service pages
#   config/hooks.json  GLOBAL hooks. A repo's own .agents/hooks.json, .agents/mcp_config.json and plugins load too, in a
#                      folder the CLI trusts, and there is no setting, flag or environment variable that turns them off
#   AGENTS.md          global rules, read with the repo's own AGENTS.md and GEMINI.md (a repo's CLAUDE.md is never read)
# The folder is trusted by listing it in settings.json (`trustedWorkspaces`): the CLI otherwise asks, and its only other
# answer exits.

ANTIGRAVITY_DIR=${ANTIGRAVITY_DIR:-$HOME/.gemini}
# Left when a start went ahead on the team's key although the checkout ships startup code (below): agy then runs that code
# for as long as it is open, as the session's user, and statusd refuses to put a personal sign-in of the owner's in the container
# while the marker is there (session/statusd.mjs, refuseWhileRepoStartupCodeRuns). It names the files, never anything else.
REPO_STARTUP_CODE_MARKER=${REPO_STARTUP_CODE_MARKER:-$HOME/.config/woodshed/repo-startup-code}

# What a branch can ship that agy runs by itself when it opens in a trusted folder: hooks, MCP servers and plugins, from
# the checkout's .agents (or .agent, _agents, _agent) folder. Run as agy opens, before anyone asked, in Plan mode too, as
# the owner's user, they could read the owner's own sign-in or a Grok Build or OpenCode login beside it. Rules and skills
# are text the model reads, which the agent could be told to follow anyway, so they are not listed.
repoRunsCode() {
  local dir path found=()
  for dir in .agents .agent _agents _agent; do
    for path in hooks.json mcp_config.json plugins.json plugins; do
      [ -e "$REPO_DIR/$dir/$path" ] || [ -L "$REPO_DIR/$dir/$path" ] && found+=("$dir/$path")
    done
  done
  printf '%s\n' "${found[@]}"
}

# A personal credential already in this container, in a file that code run as the session's user could read: the owner's
# own Claude token or login, their Codex or Grok Build or OpenCode sign-in, whichever agent holds it, as the session's own
# or beside it. Names the first one found, by what it is. A session on the team's key and the session's own token alone has
# none: that token is every agent's in the session.
personalCredentialPresent() {
  local woodshed=$HOME/.config/woodshed entry file what
  for entry in \
    "${OWN_CLAUDE_TOKEN_FILE:-$woodshed/claude-token}|the owner's Claude token" \
    "$HOME/.claude/.credentials.json|the owner's Claude login" \
    "${OWN_CODEX_AUTH_FILE:-$woodshed/codex-auth}|the owner's Codex sign-in" \
    "$HOME/.codex/auth.json|the owner's Codex sign-in" \
    "$woodshed/agent-auth|the owner's Grok Build or OpenCode sign-in" \
    "$HOME/.grok/auth.json|the owner's Grok Build sign-in" \
    "$HOME/.local/share/opencode/auth.json|the owner's OpenCode sign-in" \
    "${ANTIGRAVITY_DIR:-$HOME/.gemini}/antigravity-cli/antigravity-oauth-token|the owner's Antigravity CLI login"; do
    file=${entry%%|*}
    what=${entry#*|}
    if [ -s "$file" ]; then
      printf '%s' "$what"
      return 0
    fi
  done
  return 1
}

# Text agy reads into its prompt by itself, which a symlink out of the checkout would point at a sign-in: refused as
# Grok Build's rules files are (grokSetup.sh).
refuseAntigravityRulesOutsideCheckout() {
  local checkout path real
  checkout=$(realpath -m "$REPO_DIR")
  outside() {
    real=$(realpath -m "$1")
    case "$real/" in "$checkout"/*) return 1 ;; esac
  }
  for path in AGENTS.md GEMINI.md .agents .agent _agents _agent; do
    [ -e "$REPO_DIR/$path" ] || [ -L "$REPO_DIR/$path" ] || continue
    ! outside "$REPO_DIR/$path" || die "the repo's $path points outside the checkout, where Antigravity CLI would read it into its first request: it is not started on this branch"
  done
  while IFS= read -r -d '' path; do
    ! outside "$path" || die "the repo's ${path#"$REPO_DIR"/} points outside the checkout, where Antigravity CLI would read it into its first request: it is not started on this branch"
  done < <(find "$REPO_DIR/.agents" "$REPO_DIR/.agent" "$REPO_DIR/_agents" "$REPO_DIR/_agent" -type l -print0 2>/dev/null)
}

# $1: `key` (the team's Gemini key, through the console) or `own` (the owner's Google login). Run again for each extra
# agent started beside another (statusd), where it only adds what is not there.
# With a sign-in at risk (the owner's own Google login, or any personal credential in the container: a Claude token or
# login, a Codex, Grok Build or OpenCode sign-in, as the session's own agent or beside it), a repo that ships hooks, MCP
# servers or plugins stops the start; with only the team key (the session's own token, which every agent in the session
# holds) it is a warning.
configureAntigravity() {
  local auth=${1:-key} file found atRisk=0 held=
  agentDir "$ANTIGRAVITY_DIR" antigravity
  refuseAntigravityRulesOutsideCheckout
  mkdir -p "$ANTIGRAVITY_DIR/antigravity-cli/cache" "$ANTIGRAVITY_DIR/config"
  for file in antigravity-cli antigravity-cli/settings.json antigravity-cli/cache antigravity-cli/cache/onboarding.json config config/hooks.json AGENTS.md; do
    [ ! -L "$ANTIGRAVITY_DIR/$file" ] || die "antigravity's $file is a symlink"
  done
  found=$(repoRunsCode)
  if [ -n "$found" ]; then
    [ "$auth" != own ] || atRisk=1
    case "${AGENT:-claude}" in grok | opencode) atRisk=1 ;; esac
    held=$(personalCredentialPresent) && atRisk=1
    if [ "$atRisk" = 1 ]; then
      die "the repo ships $(tr '\n' ' ' <<< "$found")which Antigravity CLI would run as it opens, where it can read a saved sign-in${held:+ ($held)}: it is not started on this branch"
    fi
    log "WARNING: the repo ships hooks, MCP servers or plugins that Antigravity CLI runs by itself" "(files: $(tr '\n' ' ' <<< "$found"))"
    # Agents started beside this one later must not be given a personal sign-in: that code, already running, would read it.
    mkdir -p "$(dirname "$REPO_STARTUP_CODE_MARKER")"
    (umask 077 && printf '%s\n' "$found" > "$REPO_STARTUP_CODE_MARKER")
  fi
  # Onboarding done, so no theme page and no Terms of Service page, whose data-use box is ticked by default.
  printf '{"consumerOnboardingComplete":true,"enterpriseOnboardingComplete":true,"onboardingComplete":true}\n' > "$ANTIGRAVITY_DIR/antigravity-cli/cache/onboarding.json"
  # The checkout is trusted. Everything else is per run (antigravitySettings.mjs): the credential and the permission mode.
  local settings=$ANTIGRAVITY_DIR/antigravity-cli/settings.json current='{}'
  [ ! -s "$settings" ] || current=$(cat "$settings")
  jq -n --argjson current "$current" --arg repo "$REPO_DIR" \
    '$current + {altScreenMode: "never", showTips: false, showFeedbackSurvey: false, notifications: false, enableTerminalSandbox: false,
                 trustedWorkspaces: ((($current.trustedWorkspaces // []) + [$repo]) | unique)}' > "$settings.new"
  mv "$settings.new" "$settings"
  # Hooks tell statusd what agy is doing (session/hookState.mjs agy). A named group of the session's own; nothing else is here.
  local hook="node ${SESSION_DIR:-/opt/woodshed/session}/hookState.mjs agy"
  jq -n --arg hook "$hook" '
    ([{type: "command", command: $hook, timeout: 10}]) as $handlers
    | ([{matcher: "*", hooks: $handlers}]) as $matched
    | {woodshed: {SessionStart: $handlers, PreInvocation: $handlers, PostInvocation: $handlers, Stop: $handlers, PreToolUse: $matched, PostToolUse: $matched}}' \
    > "$ANTIGRAVITY_DIR/config/hooks.json"
  # The rules, then the repo's own CLAUDE.md where it has neither AGENTS.md nor GEMINI.md, which agy reads by itself.
  local claudeMd=
  if [ ! -e "$REPO_DIR/AGENTS.md" ] && [ ! -e "$REPO_DIR/GEMINI.md" ] && [ -f "$REPO_DIR/CLAUDE.md" ]; then
    if [ -L "$REPO_DIR/CLAUDE.md" ]; then
      log "WARNING: the repo's CLAUDE.md is a symlink, so Antigravity CLI does not get it"
    else
      claudeMd=$REPO_DIR/CLAUDE.md
    fi
  fi
  {
    cat "${WOODSHED_RULES_FILE:-/tmp/woodshed-rules.md}"
    if [ -n "$claudeMd" ]; then
      printf '\n\n# The repo\x27s own CLAUDE.md\n\n'
      cat "$claudeMd"
    fi
  } > "$ANTIGRAVITY_DIR/AGENTS.md"
  if [ "$auth" = own ]; then
    installAntigravityLogin
    log "antigravity runs on the owner's own Google login, directly"
  else
    log "antigravity runs on the team's Gemini key, through the console"
  fi
}

# The settings agy is started with, one file for the session's own agent: its permission mode and credential
# (antigravitySettings.mjs). Extra agents get theirs from statusd (agents.mjs).
writeAntigravityRunSettings() {
  node "${SESSION_DIR:-/opt/woodshed/session}/antigravitySettings.mjs" "${PERMISSION_MODE:-auto}" "${1:-key}" "$REPO_DIR" > "$ANTIGRAVITY_RUN_SETTINGS" \
    || die "antigravity's settings for this run could not be written"
}
ANTIGRAVITY_RUN_SETTINGS=${ANTIGRAVITY_RUN_SETTINGS:-/tmp/woodshed-agy-settings.json}

# The owner's own Google login: the console stores the compact JSON of agy's one login file, which is written back as it
# was, mode 0600, from OWN_AGENT_AUTH_FILE (what /settings handed out). agy refreshes the access token in that file by
# itself; the refresh token does not rotate (measured with 1.5.18), so nothing is sent back at stop. Never logged.
installAntigravityLogin() {
  local file=$ANTIGRAVITY_DIR/antigravity-cli/antigravity-oauth-token
  [ -s "${OWN_AGENT_AUTH_FILE:-}" ] || die "the console sent no Google login for Antigravity CLI"
  [ ! -L "$file" ] || die "antigravity's login file is a symlink"
  jq -e '.token.refresh_token | type == "string"' "$OWN_AGENT_AUTH_FILE" > /dev/null 2>&1 || die "the saved Antigravity CLI login is not agy's login file"
  (umask 077 && cp "$OWN_AGENT_AUTH_FILE" "$file.new" && mv "$file.new" "$file")
  chmod 600 "$file"
}
