// A made-up session for the dev console whose project declares two apps, served by the real statusd
// (session/statusd.mjs) over a small checkout made here. Start app's menu, the switch from one app to the other and Open
// app (`http://<id>.apps.localhost:<port>/`) all work as in a session: each app is a page that names itself, on its own
// frontend port beside one backend they share. No container, tmux or claude: the Agent and Terminal tabs go nowhere.
// The console reads a session's status only while its launcher says the container runs, so `binDir` holds a `docker`
// that says so for this session's container alone, and hands every other call to the real one, if there is one.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

export async function startDevAppsSession({ id, token }) {
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
  const port = await freePort();
  const child = spawn(process.execPath, [STATUSD], {
    env: { ...process.env, SESSION_TOKEN: token, SESSION_ID: id, STATUSD_PORT: String(port), REPO_DIR: repo, APP_PORT: '', APP_API_PORT: '', WOODSHED_CONSOLE_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Its app decisions only: tmux and gh are not here, which it warns of on every status read.
  const relay = (chunk) => { if (/statusd: app/.test(String(chunk))) process.stdout.write(`dev apps session: ${chunk}`); };
  child.stdout.on('data', relay);
  child.stderr.on('data', relay);
  await new Promise((resolve) => child.stdout.on('data', (chunk) => { if (String(chunk).includes('listening')) resolve(); }));
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
