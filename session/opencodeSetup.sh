# shellcheck shell=bash
# OpenCode: the providers the owner signed in to, as `opencode auth login` saved them, as its own auth.json, which
# statusd sends back refreshed at stop. Its config turns off its updater and sharing, and gives the effort (its
# `variant`) to the build and plan agents; the rules go in its global AGENTS.md, which it reads with the repo's own.
installOpencodeAuth() {
  agentDir "$OPENCODE_DATA_DIR" opencode
  [ ! -L "$OPENCODE_DATA_DIR/auth.json" ] || die "opencode's auth.json is a symlink"
  ! ownAgentAuthIsKey || die "OpenCode takes its auth.json, and the console sent something else"
  (umask 077 && cp "$OWN_AGENT_AUTH_FILE" "$OPENCODE_DATA_DIR/auth.json")
  log "opencode runs on the owner's own provider sign-ins, directly" "(providers: $(jq -r 'keys | join(" ")' "$OWN_AGENT_AUTH_FILE"))"
}

configureOpencodePane() {
  agentDir "$OPENCODE_CONFIG_DIR" opencode
  local file
  for file in opencode.json AGENTS.md; do
    [ ! -L "$OPENCODE_CONFIG_DIR/$file" ] || die "opencode's $file is a symlink"
  done
  # session/bin/opencode turns the repo's own config off (OPENCODE_DISABLE_PROJECT_CONFIG): an opencode.json in the
  # repo could point a provider at another address, which would get the owner's key. That also leaves out the repo's
  # AGENTS.md (measured with 1.19.6), so its text, or CLAUDE.md's where the repo has none, goes after the rules in
  # opencode's own AGENTS.md, copied once here: never named by path, which a symlink made later in the session could
  # turn into another file, and never through a symlink, which could point at auth.json and send every saved provider
  # key to the model.
  jq -n --arg effort "${EFFORT:-}" --argjson permission "$(opencodePermission)" \
    '{"$schema": "https://opencode.ai/config.json", autoupdate: false, share: "disabled"}
    + (if $permission.global == null then {} else {permission: $permission.global} end)
    + ([(if $effort == "" then {} else {agent: {build: {variant: $effort}, plan: {variant: $effort}}} end),
        (if $permission.plan == null then {} else {agent: {plan: {permission: $permission.plan}}} end)]
       | reduce .[] as $part ({}; . * $part))' \
    > "$OPENCODE_CONFIG_DIR/opencode.json"
  cp "${WOODSHED_RULES_FILE:-/tmp/woodshed-rules.md}" "$OPENCODE_CONFIG_DIR/AGENTS.md"
  local rules
  for rules in AGENTS.md CLAUDE.md; do
    if [ -L "$REPO_DIR/$rules" ]; then
      log "WARNING: the repo's $rules is a symlink, so OpenCode does not get it"
      break
    fi
    if [ -f "$REPO_DIR/$rules" ]; then
      { printf '\n\n# The repo\x27s own %s\n\n' "$rules"; cat "$REPO_DIR/$rules"; } >> "$OPENCODE_CONFIG_DIR/AGENTS.md"
      break
    fi
  done
}

# OpenCode's permission rules for New session's mode, so each means what it does for Claude Code: its own policy allows
# almost everything, edits and commands included. {global, plan}: `permission` for every agent, and the plan agent's own,
# which OpenCode 1.19.6 applies after the global (its agent.ts: the last rule that matches wins), so plan's edit deny
# holds where the global asks. Measured with 1.19.6 against a stand-in model (PR #335):
#   default      edits and commands ask
#   acceptEdits  edits allowed, commands ask
#   plan         the plan agent: edits refused (the edit tools are not even offered), commands ask, so a write through
#                bash waits for a person; a switch to the build agent asks for both
#   auto         none: --auto answers every ask itself
# A web fetch asks in all three, as Claude Code's does.
opencodePermission() {
  local asks='{"edit": "ask", "bash": "ask", "webfetch": "ask"}'
  case "${PERMISSION_MODE:-auto}" in
    default) printf '{"global": %s}' "$asks" ;;
    acceptEdits) printf '{"global": {"edit": "allow", "bash": "ask", "webfetch": "ask"}}' ;;
    plan) printf '{"global": %s, "plan": {"edit": "deny", "bash": "ask"}}' "$asks" ;;
    *) printf '{}' ;;
  esac
}
