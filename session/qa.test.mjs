import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const HERE = import.meta.dirname;
const QA_SH = path.join(HERE, 'qa.sh');
const QA_MJS = path.join(HERE, '../shared/qa/qa.mjs');

// A fake claude: the planner writes the plan (or SKIP.md), the tests write the report, and each ends with its cost.
const FAKE_CLAUDE = `#!/bin/bash
if [ ! -f .qa/plan/plan.md ]; then
  if [ -n "\${FAKE_SKIP:-}" ]; then echo 'Docs only' > .qa/plan/SKIP.md; else echo '# Plan' > .qa/plan/plan.md; fi
  echo '{"type":"result","total_cost_usd":0.5}'
else
  printf '## TC-1: signs in ✅\\n## TC-2: saves ❌\\n' > .qa/report.md
  echo '{"type":"result","total_cost_usd":1.25}'
fi
`;

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function runQa(t, { skip = false, app = 'running' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-sh-'));
  const sessionDir = path.join(dir, 'session');
  const bin = path.join(dir, 'fakebin');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(sessionDir, 'bin'), { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(sessionDir, 'bin', 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/bash\necho "# Pull request: Add GTM"\n', { mode: 0o755 });
  // The base is a branch the clone has never fetched, as for a stacked pull request.
  execFileSync('bash', ['-c', `git init -q -b main "${repo}" && cd "${repo}" && mkdir .woodshed && echo 'Sign in as demo.' > .woodshed/qa.md &&
    git add -A && git -c user.email=t@t -c user.name=t commit -qm base && git init -q --bare "${dir}/origin.git" &&
    git push -q "${dir}/origin.git" HEAD:refs/heads/stacked-base && git remote add origin "${dir}/origin.git"`]);

  const statusdCalls = [];
  const statusd = await listen((req, res) => {
    statusdCalls.push(`${req.method} ${req.url} ${req.headers.authorization}`);
    res.end(JSON.stringify(req.url === '/status' ? { app, appServers: { frontendPort: 3999 } } : { started: true }));
  });
  const reports = [];
  const consoleServer = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      reports.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(204).end();
    });
  });
  t.after(() => { statusd.close(); consoleServer.close(); });

  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, SESSION_DIR: sessionDir, REPO_DIR: repo, PR: '7', QA_BASE: 'stacked-base',
    SESSION_TOKEN: 'tok', WOODSHED_CONSOLE_URL: `http://127.0.0.1:${consoleServer.address().port}`,
    STATUSD_PORT: String(statusd.address().port), QA_SCRIPT: QA_MJS, QA_APP_WAIT_SECONDS: '6', QA_RUNNING: path.join(dir, 'qa-running'), ...(skip ? { FAKE_SKIP: '1' } : {}),
  };
  const output = await new Promise((resolve, reject) => {
    const child = spawn('bash', [QA_SH], { env });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`qa.sh exited ${code}: ${out}`))));
  });
  return { reports, statusdCalls, output, repo, running: path.join(dir, 'qa-running') };
}

test('a QA run plans, starts the app, tests and sends the verdict, the report, the commit and the cost', async (t) => {
  const { reports, statusdCalls, repo, running } = await runQa(t);
  assert.equal(reports.length, 1);
  const [{ path: where, authorization, body }] = reports;
  assert.deepEqual([where, authorization], ['/qa-report', 'Bearer tok']);
  assert.equal(body.verdict.conclusion, 'failure');
  assert.equal(body.verdict.title, 'Fail: 1 of 2 test cases failed');
  assert.match(body.report, /## TC-2: saves ❌/);
  assert.equal(body.sha, execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  assert.equal(body.costUsd, 1.75);
  assert.ok(statusdCalls.includes('POST /app/start Bearer tok'));
  assert.match(fs.readFileSync(path.join(repo, '.qa', 'plan-prompt.md'), 'utf8'), /http:\/\/localhost:3999[\s\S]*Sign in as demo\./);
  assert.equal(fs.existsSync(running), false, 'the session reads as done');
});

test('a plan with nothing to test sends a neutral verdict and never starts the app', async (t) => {
  const { reports, statusdCalls } = await runQa(t, { skip: true });
  assert.deepEqual([reports[0].body.verdict.conclusion, reports[0].body.verdict.status], ['neutral', '⏭️ **Not covered**: Docs only']);
  assert.equal(statusdCalls.some((c) => c.startsWith('POST /app/start')), false);
});

test('an app that fails to start is not covered, and says so', async (t) => {
  const { reports } = await runQa(t, { app: 'failed' });
  assert.equal(reports[0].body.verdict.title, 'Not covered: the app did not start');
});
