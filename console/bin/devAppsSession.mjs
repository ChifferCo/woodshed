// A made-up session for the dev console whose project declares two apps, served by the real statusd
// (session/statusd.mjs) over a small checkout made here. Start app's menu, the switch from one app to the other and Open
// app (`http://<id>.apps.localhost:<port>/`) all work as in a session: each app is a page that names itself, on its own
// frontend port beside one backend they share. No container, tmux or claude: the TUI and Terminal tabs go nowhere.
// Its checkout has three branches with a pull request each, one of them in a git worktree, behind a stand-in `gh`: its
// card shows a chip for each (branchesWithPulls).
// The console reads a session's status only while its launcher says the container runs, so `binDir` holds a `docker`
// that says so for this session's container alone, and hands every other call to the real one, if there is one.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { statusdReady } from './devStatusd.mjs';

const STATUSD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'session', 'statusd.mjs');
const AUTHOR = ['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev Console', '-c', 'commit.gpgsign=false'];

// One app's servers: its page on its frontend port, and the shared backend. Detached, as a real start leaves them.
const SERVE = `import fs from 'node:fs';
import http from 'node:http';
const [name, label, frontendPort, backendPort] = process.argv.slice(2);
fs.writeFileSync(\`run/\${name}.pid\`, String(process.pid));
const page = \`<!doctype html><meta charset="utf-8"><title>\${label}</title>
<body style="font-family: system-ui, sans-serif; margin: 15vh auto; max-width: 30rem"><h1>\${label}</h1>
<p>The <b>\${name}</b> app, on port \${frontendPort}.</p>\`;
http.createServer((req, res) => res.end(page)).listen(Number(frontendPort), '127.0.0.1');
http.createServer((req, res) => res.end('{"ok":true}')).listen(Number(backendPort), '127.0.0.1');
fs.appendFileSync(\`run/\${name}.log\`, \`\${label} listening on \${frontendPort} and \${backendPort}\\n\`);
process.on('SIGTERM', () => process.exit(0));
`;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function project({ webPort, adminPort, apiPort }) {
  const app = (name, label, frontendPort) => ({
    name, label,
    start: `nohup node scripts/serve.mjs ${name} '${label}' ${frontendPort} ${apiPort} >/dev/null 2>&1 & sleep 1`,
    stop: `kill $(cat run/${name}.pid) 2>/dev/null; rm -f run/${name}.pid; sleep 0.5`,
    frontendPort, backendPort: apiPort, logs: { [name]: `run/${name}.log` }, paths: [`${name}/`],
    howToProve: `Start ${label} and open it.`,
  });
  return JSON.stringify({ version: 1, apps: [app('web', 'Web', webPort), app('admin', 'Admin', adminPort)] });
}

const REPO = 'example-org/example-repo';
export const DEV_APPS_PULLS = { checkedOut: 26351, pushed: 26352, worktree: 26353 };

/**
 * Three branches with a pull request each, as a session that opened three has them: the one checked out, one pushed
 * and left, and one in a git worktree. The `gh` it writes answers `gh pr view` for the branch checked out and
 * statusd's read of every branch's pull requests (session/statusd.mjs, branchPullsQuery); each head is the branch's
 * own commit. The card then shows a chip for each.
 * @returns {string}  the folder of that `gh`, for statusd's PATH
 */
function branchesWithPulls({ root, repo, id, git }) {
  const read = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('remote', 'add', 'origin', `https://github.com/${REPO}.git`);
  git('branch', `woodshed/${id}-api`);
  git('worktree', 'add', '-q', '-b', `woodshed/${id}-docs`, path.join(root, 'docs-worktree'));
  const sha = read('rev-parse', 'HEAD');
  const url = (number) => `https://github.com/${REPO}/pull/${number}`;
  const pulls = { [`woodshed/${id}`]: DEV_APPS_PULLS.checkedOut, [`woodshed/${id}-api`]: DEV_APPS_PULLS.pushed, [`woodshed/${id}-docs`]: DEV_APPS_PULLS.worktree };
  const dir = path.join(root, 'gh-bin');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'gh.mjs'), `const args = process.argv.slice(2);
const pulls = ${JSON.stringify(pulls)};
if (args[0] === 'pr' && args[1] === 'view') {
  console.log(${JSON.stringify(url(DEV_APPS_PULLS.checkedOut))});
} else if (args[0] === 'api' && args[1] === 'graphql') {
  const asked = args.filter((a) => /^b\\d+=/.test(a)).map((a) => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]);
  const repository = Object.fromEntries(asked.map(([alias, branch]) => [alias, { nodes: pulls[branch]
    ? [{ url: 'https://github.com/${REPO}/pull/' + pulls[branch], headRefName: branch, headRefOid: '${sha}', isCrossRepository: false }] : [] }]));
  console.log(JSON.stringify({ data: { repository } }));
} else {
  console.error('gh: not answered by the dev console');
  process.exit(1);
}
`);
  fs.writeFileSync(path.join(dir, 'gh'), `#!/bin/sh\nexec '${process.execPath}' '${path.join(dir, 'gh.mjs')}' "$@"\n`, { mode: 0o755 });
  return dir;
}

/** @param {{id: string, token: string, env?: NodeJS.ProcessEnv}} opts  `env` the environment its statusd starts from, this process's by default (a test's isolatedEnv) */
export async function startDevAppsSession({ id, token, env = process.env }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-dev-apps-'));
  const repo = path.join(root, 'repo');
  for (const dir of ['.woodshed', 'scripts', 'run', 'web', 'admin']) fs.mkdirSync(path.join(repo, dir), { recursive: true });
  const ports = { webPort: await freePort(), adminPort: await freePort(), apiPort: await freePort() };
  fs.writeFileSync(path.join(repo, '.woodshed/project.yaml'), project(ports));
  fs.writeFileSync(path.join(repo, 'scripts/serve.mjs'), SERVE);
  fs.writeFileSync(path.join(repo, 'web/index.html'), '');
  fs.writeFileSync(path.join(repo, 'admin/index.html'), '');
  const git = (...args) => execFileSync('git', ['-C', repo, ...AUTHOR, ...args], { stdio: 'ignore' });
  git('init', '-q', '-b', `woodshed/${id}`);
  git('add', '-A');
  git('commit', '-q', '-m', 'two apps');
  const ghDir = branchesWithPulls({ root, repo, id, git });
  const port = await freePort();
  // A home of its own, and an ordinary claude session's agent and mode whatever the dev console runs in: its token count
  // (session/tokenUsage.mjs) follows HOME, CODEX_HOME, AGENT and a review's REVIEW_* to the agent's records, and with
  // the machine's (a Woodshed session's own, or a Codex one's) would put its real usage on the made-up Usage page.
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const child = spawn(process.execPath, [STATUSD], {
    env: { ...env, PATH: [ghDir, env.PATH].join(path.delimiter), HOME: home, SESSION_TOKEN: token, SESSION_ID: id, STATUSD_PORT: String(port), STATUSD_HOST: '127.0.0.1', REPO_DIR: repo, APP_PORT: '', APP_API_PORT: '', WOODSHED_CONSOLE_URL: '',
      // A QA run or a question starts the dev console with its own mode, in which statusd reports no pull request.
      WOODSHED_CLAUDE_AUTH: '', AGENT: '', SESSION_MODE: '', CODEX_HOME: path.join(home, '.codex'), REVIEW_AGENTS: '', REVIEW_CODEX_AUTH: '', REVIEW_CODEX_HOME: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Its app decisions only: tmux is not here, which it warns of on every status read.
  const relay = (chunk) => { if (/statusd: app/.test(String(chunk))) process.stdout.write(`dev apps session: ${chunk}`); };
  child.stdout.on('data', relay);
  child.stderr.on('data', relay);
  try {
    await statusdReady(child);
  } catch (err) {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
    throw new Error(`the dev apps session did not start: ${err.message}`);
  }
  const binDir = path.join(root, 'bin');
  const ref = `woodshed-${id}`;
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'docker'), `#!/bin/sh
if [ "$1" = inspect ] && [ "$4" = ${ref} ]; then echo true; exit 0; fi
real=$(PATH='${process.env.PATH}' command -v docker) && exec "$real" "$@"
echo "Error: No such object: $4" >&2
exit 1
`, { mode: 0o755 });
  console.log('dev console: two-app session ready', { id, port, ...ports });
  return {
    port, ref, binDir,
    close() {
      child.kill();
      for (const name of ['web', 'admin']) {
        const file = path.join(repo, `run/${name}.pid`);
        if (!fs.existsSync(file)) continue;
        try {
          process.kill(Number(fs.readFileSync(file, 'utf8')));
        } catch (err) {
          if (err.code !== 'ESRCH') throw err;
        }
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
