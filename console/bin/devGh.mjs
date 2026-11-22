// A `gh` for the dev console that answers the reads it can fake: the repo's open pull requests, for New session's
// Work on list (github.mjs's OpenPulls query), with made-up ones; any repo's default branch, as `main`, which a start
// reads (github.mjs's defaultBranch); made-up project files when it is given them; and,
// with DEV_CONSOLE_MONGO_REPO=<owner/name>, that repo's project file as one that asks for a Mongo database, which the
// dev console does not run (databaseGate.mjs's Needs setup card); and, with `mine`, that person's own open pull requests
// on a repo (github.mjs's search for My Woodshed's group) with each one's read, its head commit's and the review's
// comment, for `woodshed review pulls|start` and `woodshed setup`'s reviews (DEV_CONSOLE_REVIEW_ON=1). Every other call
// goes to the real gh, if there is one, which fails as before on the dev console's made-up token.

import fs from 'node:fs';
import path from 'node:path';

const HOUR = 3_600_000;
const PULLS = [
  [26412, 'Retry the image pull when the registry answers 429', 'fix/registry-retry', 'ann-dev', false, 0.4],
  [26408, 'Billing: show the currency on every invoice line', 'woodshed/bob-1a2b3c4d', 'bob-builds', false, 2],
  [26401, 'Draft: move the session API onto its own port', 'session-api-port', 'cat-codes', true, 5],
  [26395, 'Docs: how to restore a Mongo dump into your copy', 'docs/mongo-restore', 'ann-dev', false, 26],
  [26388, 'Rail: fold the stopped zones by default on a phone', 'rail-fold-phone', 'dee-ux', false, 50],
  [26377, 'Slack: answer a follow-up in the same thread', 'slack-followups', 'bob-builds', false, 120],
  [26030, 'Upgrade pgweb and pin its version in the image', 'deps/pgweb', 'renovate', false, 400],
];

/**
 * @param {string} dir  where to write `gh`; put it first on the console's PATH
 * @param {{projectFiles?: Record<string, string>, mongoRepo?: string, mine?: {repo: string, login: string}|null}} [opts]
 *   `projectFiles`: each repo's (owner/name) made-up .woodshed/project.yaml, answered for the contents API's read of it
 *   on the default branch; `mongoRepo`: a repo whose project file asks for Mongo; `mine`: whose open pull requests on
 *   which repo the search finds (MINE below)
 * @returns {string} dir
 */
export function writeDevGh(dir, { projectFiles = {}, mongoRepo = process.env.DEV_CONSOLE_MONGO_REPO || '', mine = null } = {}) {
  const now = Date.now();
  const nodes = PULLS.map(([number, title, headRefName, login, isDraft, hoursAgo]) => ({
    number, title, headRefName, isDraft, author: { login }, updatedAt: new Date(now - hoursAgo * HOUR).toISOString(),
  }));
  const answer = JSON.stringify({ data: { repository: { pullRequests: { totalCount: nodes.length, nodes } } } });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'open-pulls.json'), answer);
  const projectCases = Object.entries(projectFiles).map(([repo, text], i) => {
    const file = path.join(dir, `project-${i}.json`);
    fs.writeFileSync(file, JSON.stringify({ content: Buffer.from(text).toString('base64'), encoding: 'base64' }));
    return `    "repos/${repo}/contents/.woodshed/project.yaml") cat '${file}'; exit 0 ;;\n`;
  }).join('');
  const projectFile = JSON.stringify({ version: 1, databases: [{ engine: 'mongo', dir: 'api' }] });
  fs.writeFileSync(path.join(dir, 'mongo-project.json'), JSON.stringify({ content: Buffer.from(projectFile).toString('base64') }));
  const mongoCase = /^[\w.-]+\/[\w.-]+$/.test(mongoRepo) && !(mongoRepo in projectFiles)
    ? `    "repos/${mongoRepo}/contents/.woodshed/project.yaml") cat '${path.join(dir, 'mongo-project.json')}'; exit 0 ;;\n`
    : '';
  const mineCases = mine && /^[\w.-]+\/[\w.-]+$/.test(mine.repo) && /^[\w-]+$/.test(mine.login) ? writeMine(dir, now, mine) : '';
  fs.writeFileSync(path.join(dir, 'gh'), `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    "query=query OpenPulls"*) cat '${path.join(dir, 'open-pulls.json')}'; exit 0 ;;
${projectCases}${mongoCase}${mineCases}    repos/*) if printf '%s' "$arg" | grep -Eq '^repos/[^/]+/[^/]+$'; then echo '{"default_branch":"main"}'; exit 0; fi ;;
  esac
done
self=$(cd "$(dirname "$0")" && pwd)
real=$(PATH=$(printf '%s' "$PATH" | tr ':' '\\n' | grep -vx "$self" | paste -sd: -) command -v gh) && exec "$real" "$@"
echo "gh: not installed" >&2
exit 127
`, { mode: 0o755 });
  return dir;
}

// Made-up open pull requests of `mine.login`'s on `mine.repo`: number, title, branch, draft, hours since updated.
const MINE = [
  [27104, 'Show the review\'s verdict on the session card', 'review-verdict-chip', false, 1],
  [27098, 'Retry a failed image build once before giving up', 'build-retry', false, 6],
  [27090, 'Draft: a second Herdr space per repo', 'herdr-space', true, 30],
];

// The cases that answer them: the search, each pull request's read and its head commit's, and the review's comment.
function writeMine(dir, now, { repo, login }) {
  const nodes = MINE.map(([number, title, headRefName, isDraft, hoursAgo]) => ({ number, title, headRefName, isDraft, updatedAt: new Date(now - hoursAgo * HOUR).toISOString() }));
  fs.writeFileSync(path.join(dir, 'mine.json'), JSON.stringify({ data: { mine: { nodes }, review: { nodes: [] } } }));
  fs.writeFileSync(path.join(dir, 'commit.json'), JSON.stringify({ sha: 'b'.repeat(40), commit: { message: 'A commit with no review tag' } }));
  fs.writeFileSync(path.join(dir, 'comment.json'), JSON.stringify({ id: 1, html_url: `https://github.com/${repo}/pull/0#issuecomment-1` }));
  const pulls = MINE.map(([number, title, ref, draft]) => {
    const file = path.join(dir, `pull-${number}.json`);
    fs.writeFileSync(file, JSON.stringify({
      number, title, state: 'open', draft, user: { login }, html_url: `https://github.com/${repo}/pull/${number}`,
      head: { ref, sha: `${number}`.padEnd(40, 'a'), repo: { full_name: repo } }, base: { ref: 'main' },
    }));
    return `    "repos/${repo}/pulls/${number}") cat '${file}'; exit 0 ;;\n`;
  }).join('');
  return `    "query=query($mine"*) cat '${path.join(dir, 'mine.json')}'; exit 0 ;;\n${pulls}`
    + `    "repos/${repo}/commits/"*) cat '${path.join(dir, 'commit.json')}'; exit 0 ;;\n`
    + `    "repos/${repo}/issues/"*"/comments") cat '${path.join(dir, 'comment.json')}'; exit 0 ;;\n`;
}
