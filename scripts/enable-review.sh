#!/usr/bin/env bash
# Turn on Woodshed's AI code review and merge-risk check for a GitHub repository, with no Woodshed install. It writes
# the calling workflow to the default branch, lets GitHub Actions approve pull requests, and sets the Anthropic API
# key. After it runs, end a pull request's last commit message with [woodshed-review] to get a review.
#
#   scripts/enable-review.sh <owner/repo> [--ref <commit-or-branch>]
#
# --ref pins the review to a commit (the default is this repository's main); pin it so a change to the workflow never
# surprises a review. It needs the GitHub CLI signed in with the `workflow` scope (gh auth refresh -s workflow) and
# admin on the repository.
set -euo pipefail

REPO=""
REF="main"
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    -*) echo "Unknown option: $1" >&2; exit 2 ;;
    *) REPO="$1"; shift ;;
  esac
done
[ -n "$REPO" ] || { echo "Usage: enable-review.sh <owner/repo> [--ref <commit-or-branch>]" >&2; exit 2; }

command -v gh >/dev/null || { echo "Install the GitHub CLI (gh) first: https://cli.github.com" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Sign in first: gh auth login" >&2; exit 1; }

branch=$(gh repo view "$REPO" --json defaultBranchRef --jq .defaultBranchRef.name)
echo "Default branch: $branch"

workflow=".github/workflows/woodshed-review.yml"
body=$(cat <<YAML
name: Review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
jobs:
  review:
    permissions: { contents: write, pull-requests: write, issues: read, id-token: write, checks: write }
    uses: ChifferCo/woodshed/.github/workflows/review.yml@${REF}
    secrets:
      ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
YAML
)

# Commit the workflow to the default branch, replacing an earlier copy if one is there.
sha=$(gh api "repos/${REPO}/contents/${workflow}?ref=${branch}" --jq .sha 2>/dev/null || true)
encoded=$(printf '%s\n' "$body" | base64 | tr -d '\n')
if ! gh api --method PUT "repos/${REPO}/contents/${workflow}" \
      -f message="ci: enable Woodshed review" \
      -f content="$encoded" \
      -f branch="$branch" \
      ${sha:+-f sha="$sha"} >/dev/null; then
  echo "Could not write ${workflow} (a 404 here usually means the gh token lacks the workflow scope)." >&2
  echo "Run: gh auth refresh -s workflow   then run this script again." >&2
  exit 1
fi
echo "Wrote ${workflow} on ${branch}"

# Let Actions approve pull requests, keeping the repository's current default permission level.
level=$(gh api "repos/${REPO}/actions/permissions/workflow" --jq .default_workflow_permissions 2>/dev/null || echo read)
gh api --method PUT "repos/${REPO}/actions/permissions/workflow" \
  -f default_workflow_permissions="$level" -F can_approve_pull_request_reviews=true >/dev/null
echo "Allowed GitHub Actions to create and approve pull requests"

# Set the API key if it is not already there; its value is typed into gh, never into this script.
if gh secret list -R "$REPO" | awk '{print $1}' | grep -qx ANTHROPIC_API_KEY; then
  echo "ANTHROPIC_API_KEY already set"
else
  echo "Set ANTHROPIC_API_KEY (the value is hidden as you type or paste):"
  gh secret set ANTHROPIC_API_KEY -R "$REPO"
fi

echo
echo "Done. Open a pull request and end its last commit message with [woodshed-review]."
echo "Add .woodshed/review.md and .woodshed/riskAreas.md on ${branch} to give the review your own rules."
