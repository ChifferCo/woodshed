#!/bin/bash
# The dev box's Claude status line (~/.claude/statusline-command.sh there). It also saves the plan's limits, which
# Claude Code hands only to this command, for statusd's plan chip (session/planUsage.mjs).

# Read the JSON input from stdin
input=$(cat)

usage_dir="$HOME/.claude/woodshed-usage"
usage_json=$(echo "$input" | jq -c 'select(.rate_limits) | {at: (now | floor), rate_limits}' 2>/dev/null)
if [ -n "$usage_json" ] && mkdir -p "$usage_dir"; then
    printf '%s' "$usage_json" > "$usage_dir/claude.json.$$" && mv "$usage_dir/claude.json.$$" "$usage_dir/claude.json"
fi

# Extract the current working directory
cwd=$(echo "$input" | jq -r '.workspace.current_dir')

# Extract context window fields
used_percentage=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
window_size=$(echo "$input" | jq -r '.context_window.context_window_size // empty')

# Change to the directory to run git commands
cd "$cwd" 2>/dev/null || exit 0

# ANSI color codes
CYAN='\033[36m'
GREEN='\033[32m'
YELLOW='\033[33m'
BLUE='\033[34m'
MAGENTA='\033[35m'
RED='\033[31m'
RESET='\033[0m'

# Abbreviate a token count to e.g. 24k or 200k
abbrev_tokens() {
    local n=$1
    if [ "$n" -ge 1000 ]; then
        printf "%dk" $(( (n + 500) / 1000 ))
    else
        printf "%d" "$n"
    fi
}

# Build context window segment
context_segment=""
if [ -n "$used_percentage" ] && [ -n "$window_size" ]; then
    used_int=$(printf "%.0f" "$used_percentage")
    used_tokens=$(echo "$used_percentage $window_size" | awk '{printf "%d", $1/100 * $2}')
    used_abbrev=$(abbrev_tokens "$used_tokens")
    total_abbrev=$(abbrev_tokens "$window_size")
    if [ "$used_int" -ge 90 ]; then
        ctx_color="$RED"
    elif [ "$used_int" -ge 70 ]; then
        ctx_color="$YELLOW"
    else
        ctx_color="$GREEN"
    fi
    context_segment=" ctx:${ctx_color}${used_abbrev}/${total_abbrev} (${used_int}%)${RESET}"
fi

# Check if we're in a git repository
if git rev-parse --git-dir > /dev/null 2>&1; then
    # Get the current branch name
    branch=$(git symbolic-ref --short HEAD 2>/dev/null || git rev-parse --short HEAD 2>/dev/null)

    # Get git status with optional locks disabled
    git_status=$(git -c core.useBuiltinFSMonitor=false status --porcelain 2>/dev/null)

    # Determine status indicators
    if [ -z "$git_status" ]; then
        status_indicator="${GREEN}✓${RESET}"
    else
        # Check for different types of changes
        has_staged=$(echo "$git_status" | grep -E '^[MADRC]' | wc -l | tr -d ' ')
        has_modified=$(echo "$git_status" | grep -E '^.[MD]' | wc -l | tr -d ' ')
        has_untracked=$(echo "$git_status" | grep -E '^\?\?' | wc -l | tr -d ' ')

        status_parts=()
        [ "$has_staged" -gt 0 ] && status_parts+=("${GREEN}${has_staged}✚${RESET}")
        [ "$has_modified" -gt 0 ] && status_parts+=("${YELLOW}${has_modified}●${RESET}")
        [ "$has_untracked" -gt 0 ] && status_parts+=("${RED}${has_untracked}?${RESET}")

        status_indicator=$(IFS=' '; echo "${status_parts[*]}")
    fi

    # Detect worktree
    worktree_info=""
    git_dir=$(git rev-parse --git-dir 2>/dev/null)
    if [[ "$git_dir" == *".git/worktrees/"* ]]; then
        worktree_name=$(basename "$git_dir")
        worktree_info=" ⊞ ${BLUE}${worktree_name}${RESET}"
    fi

    # Output with git info
    printf "› ${CYAN}%s${RESET}%b ⎇ [${MAGENTA}%s${RESET} %b]%b" "${cwd/#$HOME/~}" "$worktree_info" "$branch" "$status_indicator" "$context_segment"
else
    # Not a git repository
    printf "› ${CYAN}%s${RESET}%b" "${cwd/#$HOME/~}" "$context_segment"
fi
