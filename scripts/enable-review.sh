#!/usr/bin/env bash
# Turn on Woodshed's AI code review and merge-risk check for a GitHub repository, with no Woodshed install. It writes
# the calling workflow to the default branch, lets GitHub Actions approve pull requests, and sets the Anthropic API
# key. After it runs, end a pull request's last commit message with [woodshed-review] to get a review.
#
#   scripts/enable-review.sh <owner/repo> [--ref <commit-or-branch>] [--qa] [--qa-runner actions|woodshed]
#
# --ref pins the review to a commit (the default is this repository's main); pin it so a change to the workflow never
# surprises a review. --qa also sets up QA, which runs on the woodshed-qa label. --qa-runner picks where QA runs:
# `actions` (the default) runs it in this repository's own CI; `woodshed` runs it as a session on a Woodshed console
# you already have (the script then sets no QA workflow and prints the console steps). It needs the GitHub CLI signed
# in with the `workflow` scope (gh auth refresh -s workflow) and admin on the repository.
set -euo pipefail

REPO=""
REF="main"
QA=false
QA_RUNNER="actions"
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --qa) QA=true; shift ;;
    --qa-runner) QA=true; QA_RUNNER="$2"; shift 2 ;;
    -*) echo "Unknown option: $1" >&2; exit 2 ;;
    *) REPO="$1"; shift ;;
  esac
done
[ -n "$REPO" ] || { echo "Usage: enable-review.sh <owner/repo> [--ref <commit-or-branch>] [--qa] [--qa-runner actions|woodshed]" >&2; exit 2; }
case "$QA_RUNNER" in actions|woodshed) ;; *) echo "--qa-runner must be actions or woodshed" >&2; exit 2 ;; esac

command -v gh >/dev/null || { echo "Install the GitHub CLI (gh) first: https://cli.github.com" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Sign in first: gh auth login" >&2; exit 1; }

# Pin to a commit by default, as the docs urge, so a later change to the workflow never surprises a review.
if [ "$REF" = "main" ]; then
  REF=$(gh api repos/ChifferCo/woodshed/commits/main --jq .sha)
  echo "Pinned the review to ChifferCo/woodshed@${REF}"
fi

branch=$(gh repo view "$REPO" --json defaultBranchRef --jq .defaultBranchRef.name)
echo "Default branch: $branch"

# Commit a workflow to the default branch, replacing an earlier copy if one is there.
write_workflow() {
  local path="$1" content="$2" sha encoded
  sha=$(gh api "repos/${REPO}/contents/${path}?ref=${branch}" --jq .sha 2>/dev/null) || sha=""
  encoded=$(printf '%s\n' "$content" | base64 | tr -d '\n')
  if ! gh api --method PUT "repos/${REPO}/contents/${path}" \
        -f message="ci: enable Woodshed $(basename "$path" .yml | sed 's/^woodshed-//')" \
        -f content="$encoded" \
        -f branch="$branch" \
        ${sha:+-f sha="$sha"} >/dev/null; then
    echo "Could not write ${path} (a 404 here usually means the gh token lacks the workflow scope)." >&2
    echo "Run: gh auth refresh -s workflow   then run this script again." >&2
    exit 1
  fi
  echo "Wrote ${path} on ${branch}"
}

write_workflow ".github/workflows/woodshed-review.yml" "$(cat <<YAML
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
)"

# QA runs the app and tests it in a browser, on the woodshed-qa label. In the default `actions` runner it runs in this
# repository's CI, starting the app from .woodshed/project.yaml's app.start, with nothing repo-specific to edit. The
# `woodshed` runner runs it as a session on a console you already have: the script writes no QA workflow and prints the
# steps, since a console and the GitHub App are what it needs, not CI.
if [ "$QA" = true ] && [ "$QA_RUNNER" = woodshed ]; then
  gh label create woodshed-qa -R "$REPO" --color 0e8a16 --description "Run Woodshed QA" --force >/dev/null
  echo "Created the woodshed-qa label"
  echo
  echo "QA will run as a Woodshed session. On the console you set up:"
  echo "  1. Install the Woodshed GitHub App on ${REPO} and add the repo in Console settings."
  echo "  2. In .woodshed/project.yaml add:"
  echo "       pullRequests:"
  echo "         qa: { runner: woodshed, label: woodshed-qa, check: QA, heading: '## QA' }"
  echo "Then the woodshed-qa label starts a QA session. No QA workflow was written."
elif [ "$QA" = true ]; then
  write_workflow ".github/workflows/woodshed-qa.yml" "$(cat <<YAML
name: QA
on:
  pull_request:
    types: [labeled]
jobs:
  qa:
    if: github.event.label.name == 'woodshed-qa'
    runs-on: ubuntu-latest
    permissions: { contents: read, pull-requests: write, issues: write, checks: write }
    steps:
      - uses: actions/checkout@v4
        with: { ref: '\${{ github.head_ref }}', fetch-depth: 50 }
      - id: app
        uses: ChifferCo/woodshed/.github/actions/qa/app-url@${REF}
      - id: plan
        uses: ChifferCo/woodshed/.github/actions/qa/plan@${REF}
        with: { anthropic-api-key: '\${{ secrets.ANTHROPIC_API_KEY }}', app-url: '\${{ steps.app.outputs.url }}' }
      - id: start
        if: steps.plan.outputs.should-run == 'true'
        env:
          START: \${{ steps.app.outputs.start }}
          URL: \${{ steps.app.outputs.url }}
        run: |
          # Start the app the way the project file says, then wait for it.
          if [ -z "\$START" ]; then echo "::error::no app.start in .woodshed/project.yaml"; exit 1; fi
          bash -c "\$START" > app.log 2>&1 &
          for i in \$(seq 60); do curl -sf "\$URL" >/dev/null && exit 0; sleep 2; done
          echo "the app did not come up at \$URL"; cat app.log; exit 1
      - if: steps.plan.outputs.should-run == 'true'
        timeout-minutes: 15
        uses: ChifferCo/woodshed/.github/actions/qa/test@${REF}
        with: { anthropic-api-key: '\${{ secrets.ANTHROPIC_API_KEY }}' }
      - if: \${{ !cancelled() }}
        uses: ChifferCo/woodshed/.github/actions/qa/report@${REF}
        with:
          not-covered: \${{ steps.start.outcome == 'failure' && 'the app did not start' || '' }}
YAML
)"
  gh label create woodshed-qa -R "$REPO" --color 0e8a16 --description "Run Woodshed QA" --force >/dev/null
  echo "Created the woodshed-qa label"
fi

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
