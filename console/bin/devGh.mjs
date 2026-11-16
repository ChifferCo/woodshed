// A `gh` for the dev console that answers the reads it can fake: the repo's open pull requests, for New session's
// Work on list (github.mjs's OpenPulls query), with made-up ones, and, when it is given them, made-up project files. Every other call goes to the real gh, if there is one,
// which fails as before on the dev console's made-up token.

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
 * @param {{projectFiles?: Record<string, string>}} [opts]  `projectFiles`: each repo's (owner/name) made-up
 *   .woodshed/project.yaml, answered for the contents API's read of it on the default branch
 * @returns {string} dir
 */
export function writeDevGh(dir, { projectFiles = {} } = {}) {
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
  fs.writeFileSync(path.join(dir, 'gh'), `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    "query=query OpenPulls"*) cat '${path.join(dir, 'open-pulls.json')}'; exit 0 ;;
${projectCases}  esac
done
self=$(cd "$(dirname "$0")" && pwd)
real=$(PATH=$(printf '%s' "$PATH" | tr ':' '\\n' | grep -vx "$self" | paste -sd: -) command -v gh) && exec "$real" "$@"
echo "gh: not installed" >&2
exit 127
`, { mode: 0o755 });
  return dir;
}
