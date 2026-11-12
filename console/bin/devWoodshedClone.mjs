// The dev console's stand-in for the Woodshed clone a real console runs from, for the Console settings page's Woodshed
// card (woodshedUpdate.mjs): a made-up upstream with four commits the clone lacks, one of them in session/, so Update
// pulls, runs the clone's providers/console.mjs as its start check (a stand-in that says it passed), "builds" the
// session image with the clone's install.sh (a stand-in that prints a few lines and waits) and restarts the console,
// which devConsole.mjs starts again. Nothing here touches the checkout the dev console runs from.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const NEWER = [
  ['perf(console): read pull request chips only when a webhook marks them due', 'Mona Lisa', 'console/prChips.mjs', 58],
  ['docs: say how a clone follows main', 'Octo Cat', 'README.md', 34],
  ['fix(session): keep the terminal connected through a console restart', 'Hu Bot', 'session/statusd.mjs', 21],
  ['feat(console): show how far behind its upstream the console is', 'Octo Cat', 'console/woodshedUpdate.mjs', 5],
];

// The start check runs the clone's providers/console.mjs with WOODSHED_START_CHECK=1; the real one is the dev
// console's own checkout, which the made-up clone is not.
const FAKE_CONSOLE = `// The dev console's stand-in for providers/console.mjs: Update's start check runs it.
await new Promise((r) => setTimeout(r, 1000));
console.log('console: start check passed (made up)');
`;

const FAKE_INSTALL = `#!/usr/bin/env bash
# The dev console's stand-in for install.sh: Update runs it to build the session image.
set -euo pipefail
echo "==> Fetching \${WOODSHED_REPO:-the repository}"
sleep 2
echo "==> Building the session image \${WOODSHED_IMAGE:-woodshed-session} (made up: nothing is built)"
for step in 1 2 3 4; do sleep 2; echo "#\$step [runtime \$step/4] DONE"; done
echo "==> Built the session image \${WOODSHED_IMAGE:-woodshed-session}"
`;

/**
 * @param {string} dir  an empty folder to make them in
 * @returns {string}  the clone, which WOODSHED_CHECKOUT names
 */
export function makeDevClone(dir) {
  const upstream = path.join(dir, 'upstream');
  const work = path.join(dir, 'work');
  const clone = path.join(dir, 'woodshed');
  const git = (cwd, args, hoursAgo = 72, name = 'Octo Cat') => {
    const date = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
    return execFileSync('git', ['-C', cwd, ...args], {
      env: {
        ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: 'dev@example.invalid', GIT_COMMITTER_NAME: name,
        GIT_COMMITTER_EMAIL: 'dev@example.invalid', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
  };
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
    fs.writeFileSync(path.join(work, file), text);
  };
  fs.mkdirSync(work, { recursive: true });
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', upstream]);
  git(work, ['init', '--quiet', '--initial-branch=main']);
  write('install.sh', FAKE_INSTALL);
  write('providers/console.mjs', FAKE_CONSOLE);
  write('session/statusd.mjs', '// made up\n');
  write('README.md', '# Woodshed (made up)\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '--quiet', '-m', 'feat(console): show new session\'s repo with only one project']);
  git(work, ['remote', 'add', 'origin', upstream]);
  git(work, ['push', '--quiet', 'origin', 'main']);
  // A shallow clone, as install.sh makes one.
  execFileSync('git', ['clone', '--quiet', '--depth', '1', `file://${upstream}`, clone]);
  for (const [title, name, file, hoursAgo] of NEWER) {
    write(file, `// ${title}\n`);
    git(work, ['add', '-A']);
    git(work, ['commit', '--quiet', '-m', title], hoursAgo, name);
  }
  git(work, ['push', '--quiet', 'origin', 'main']);
  return clone;
}
