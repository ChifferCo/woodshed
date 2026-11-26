# shellcheck shell=bash
# Shared by the session entrypoint and statusd when starting another Grok terminal.
# The rules files Grok Build reads into its first request by itself (measured with 1.0.92, `grok inspect`'s Project
# Instructions), where a branch's symlink could point at the owner's sign-in. One that resolves outside the checkout, or
# a rules folder that does, stops the start: Grok cannot be told to skip it. A link inside the checkout (AGENTS.md to
# CLAUDE.md) is a repo's own choice.
refuseRulesOutsideCheckout() {
  local checkout path real
  checkout=$(realpath -m "$REPO_DIR")
  outside() {
    real=$(realpath -m "$1")
    case "$real/" in "$checkout"/*) return 1 ;; esac
  }
  for path in AGENTS.md CLAUDE.md .claude .claude/CLAUDE.md .claude/rules .grok .grok/rules .cursor .cursor/rules; do
    [ -e "$REPO_DIR/$path" ] || [ -L "$REPO_DIR/$path" ] || continue
    ! outside "$REPO_DIR/$path" || die "the repo's $path points outside the checkout, where Grok Build would read it into its first request: it is not started on this branch"
  done
  while IFS= read -r -d '' path; do
    ! outside "$path" || die "the repo's ${path#"$REPO_DIR"/} points outside the checkout, where Grok Build would read it into its first request: it is not started on this branch"
  done < <(find "$REPO_DIR/.claude/rules" "$REPO_DIR/.grok/rules" "$REPO_DIR/.cursor/rules" -type l -print0 2>/dev/null)
}

configureGrok() {
  agentDir "$GROK_HOME_DIR" grok
  refuseRulesOutsideCheckout
  local file
  for file in auth.json config.toml trusted_folders.toml rules; do
    [ ! -L "$GROK_HOME_DIR/$file" ] || die "grok's $file is a symlink"
  done
  if ownAgentAuthIsKey; then
    rm -f "$GROK_HOME_DIR/auth.json"
    log "grok runs on the owner's own xAI key, directly"
  else
    (umask 077 && cp "$OWN_AGENT_AUTH_FILE" "$GROK_HOME_DIR/auth.json")
    log "grok runs on the owner's own Grok Build login, directly"
  fi
  cat > "$GROK_HOME_DIR/config.toml" <<'TOML'
[cli]
auto_update = false

[features]
telemetry = false
feedback = false

[compat.claude]
mcps = false
hooks = false

[compat.cursor]
mcps = false
TOML
  # A key is used only when grok is told to prefer it: with none of this, grok 1.0.92 opens its browser sign-in whatever
  # XAI_API_KEY holds (measured in the session image).
  if ownAgentAuthIsKey; then printf '\n[auth]\npreferred_method = "api_key"\n' >> "$GROK_HOME_DIR/config.toml"; fi
  printf '[folders.%s]\ntrusted = true\ndecided_at = %s\n' "$(jq -Rn --arg p "$REPO_DIR" '$p')" "$(date +%s)" > "$GROK_HOME_DIR/trusted_folders.toml"
  mkdir -p "$GROK_HOME_DIR/rules"
  cp "${WOODSHED_RULES_FILE:-/tmp/woodshed-rules.md}" "$GROK_HOME_DIR/rules/woodshed.md"
  # Its hooks, statusd's word on what it does, are in the image's /etc/grok/requirements.toml
  # (session/grokRequirements.toml), the only hooks Grok runs in a session: none of a repo's own.
}
