import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { isolatedEnv } from '../test/isolatedEnv.mjs';
import { summaryProblem } from '../console/qaSummary.mjs';

const HERE = import.meta.dirname;
const QA_SH = path.join(HERE, 'qa.sh');
const QA_MJS = path.join(HERE, '../shared/qa/qa.mjs');

// A fake claude: the planner writes the plan (or SKIP.md), the tests write the report, and each ends with its cost.
const FAKE_CLAUDE = `#!/bin/bash
# The secret screen over the run log: it answers with the line numbers FAKE_SCREEN names, or fails with FAKE_SCREEN=fail.
case " $* " in *" haiku "*)
  [ "\${FAKE_SCREEN:-}" = fail ] && exit 1
  echo "\${FAKE_SCREEN:-NONE}"; exit 0 ;;
esac
if [ -n "\${FAKE_NO_REPORT:-}" ] && [ -f .qa/plan/plan.md ]; then
  echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Opening the app"},{"type":"tool_use","name":"x"}]}}'
  echo '{"type":"result","subtype":"error_max_turns","is_error":false,"num_turns":200,"total_cost_usd":2}'
  exit 0
fi
if [ ! -f .qa/plan/plan.md ]; then
  if [ -n "\${FAKE_SKIP:-}" ]; then echo 'Docs only' > .qa/plan/SKIP.md; else echo '# Plan' > .qa/plan/plan.md; fi
  echo '{"type":"result","total_cost_usd":0.5}'
  [ -n "\${FAKE_LEAK:-}" ] && echo 'npm ERR! _authToken=abcdef1234567890'
  [ -n "\${FAKE_OPAQUE:-}" ] && echo 'registry said the credential is zzOpaque7788 for this user'
else
  printf '## TC-1: signs in ✅\\n## TC-2: saves ❌\\n' > .qa/report.md
  # The browser's recording, where the MCP config claude was given says to write it.
  for a in "$@"; do [ "\${prev:-}" = --mcp-config ] && cp "$a" .qa/mcp-seen.json; prev=$a; done
  # Playwright writes it only as the browser closes, which qaBrowser.mjs may still be doing after claude has gone: a
  # stand-in that carries the run's config in its command line, as the proxy does, and writes the video a second later.
  cfg=$(jq -r '.mcpServers.playwright.args[-1]' .qa/mcp-seen.json)
  nohup bash -c 'sleep 1; printf "\\x1a\\x45\\xdf\\xa3webm" > .qa/video/page@1.webm' qaBrowser "$cfg" > /dev/null 2>&1 &
  echo '{"type":"result","total_cost_usd":1.25}'
fi
`;

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function runQa(t, { skip = false, app = 'running', noReport = false, leak = false, screen = null, opaque = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-sh-'));
  const sessionDir = path.join(dir, 'session');
  const bin = path.join(dir, 'fakebin');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(sessionDir, 'bin'), { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(sessionDir, 'bin', 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/bash\necho "# Pull request: Add GTM"\n', { mode: 0o755 });
  // A stand-in for Playwright's ffmpeg: it says what it was given, and writes a PNG where its last argument says.
  const ffmpeg = path.join(bin, 'ffmpeg-linux');
  fs.writeFileSync(ffmpeg, `#!/bin/bash\necho "$*" > "${path.join(dir, 'ffmpeg-args')}"\nprintf '\\x89PNG\\r\\n\\x1a\\nstill' > "\${@: -1}"\n`, { mode: 0o755 });
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
  const videos = [];
  const logs = [];
  const consoleServer = await listen((req, res) => {
    const chunks = [];
    req.on('data', (c) => { chunks.push(c); });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.url === '/qa-video' || req.url === '/qa-poster') {
        videos.push({ path: req.url, authorization: req.headers.authorization, type: req.headers['content-type'], body, before: reports.length });
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
        return;
      }
      if (req.url.startsWith('/qa-log')) {
        logs.push({ tier: new URL(req.url, 'http://x').searchParams.get('tier'), authorization: req.headers.authorization, type: req.headers['content-type'], text: body.toString('utf8'), reports: reports.length });
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
        return;
      }
      reports.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(204).end();
    });
  });
  t.after(() => { statusd.close(); consoleServer.close(); });

  const env = {
    ...isolatedEnv(), PATH: `${bin}:${process.env.PATH}`, SESSION_DIR: sessionDir, REPO_DIR: repo, PR: '7', QA_BASE: 'stacked-base',
    SESSION_ID: '0a1b2c3d', SESSION_TOKEN: 'tok', WOODSHED_CONSOLE_URL: `http://127.0.0.1:${consoleServer.address().port}`,
    STATUSD_PORT: String(statusd.address().port), QA_SCRIPT: QA_MJS, QA_FFMPEG: ffmpeg, QA_APP_WAIT_SECONDS: '6', QA_RUNNING: path.join(dir, 'qa-running'), ...(skip ? { FAKE_SKIP: '1' } : {}), ...(noReport ? { FAKE_NO_REPORT: '1' } : {}), ...(leak ? { FAKE_LEAK: '1' } : {}), ...(screen ? { FAKE_SCREEN: screen } : {}), ...(opaque ? { FAKE_OPAQUE: '1' } : {}),
  };
  const output = await new Promise((resolve, reject) => {
    const child = spawn('bash', [QA_SH], { env });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`qa.sh exited ${code}: ${out}`))));
  });
  const ffmpegArgs = () => fs.readFileSync(path.join(dir, 'ffmpeg-args'), 'utf8').trim();
  return { reports, videos, logs, statusdCalls, output, repo, ffmpegArgs, running: path.join(dir, 'qa-running') };
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

test('the tests run on a browser that records, and its video goes to the console before the report', async (t) => {
  const { reports, videos, repo, ffmpegArgs } = await runQa(t);
  const mcp = JSON.parse(fs.readFileSync(path.join(repo, '.qa', 'mcp-seen.json'), 'utf8')).mcpServers.playwright;
  assert.equal(mcp.command, 'node');
  assert.match(mcp.args[0], /qaBrowser\.mjs$/, 'behind the proxy that closes the browser, so the video is whole');
  assert.deepEqual(mcp.args.slice(1, 5), ['playwright-mcp', '--headless', '--browser', 'chromium']);
  const config = JSON.parse(fs.readFileSync(mcp.args.at(-1), 'utf8'));
  assert.equal(config.browser.contextOptions.recordVideo.dir, path.join(repo, '.qa', 'video'));
  assert.deepEqual(videos.map((v) => v.path), ['/qa-video', '/qa-poster'], 'the video, then a still from it');
  assert.deepEqual([videos[0].authorization, videos[0].type, videos[0].body.toString('latin1'), videos[0].before], ['Bearer tok', 'video/webm', '\x1a\x45\xdf\xa3webm', 0]);
  assert.deepEqual([videos[1].authorization, videos[1].type, videos[1].body.toString('latin1'), videos[1].before], ['Bearer tok', 'image/png', '\x89PNG\r\n\x1a\nstill', 0]);
  assert.match(ffmpegArgs(), /-sseof -1 -i \S+\/\.qa\/video\/page@1\.webm -frames:v 1/, 'the first video\'s last second');
  assert.equal(reports.length, 1);
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

test('the run log reaches the console after each pass and with the report, and says how the passes ended', async (t) => {
  let { logs } = await runQa(t);
  assert.equal(logs.length, 8, 'a summary and a full log after the plan, as the tests begin, after the tests, and as the run finishes');
  logs = logs.filter((l) => l.tier === 'full');
  assert.deepEqual([logs[0].authorization, logs[0].type], ['Bearer tok', 'text/plain']);
  assert.deepEqual(logs.map((l) => l.reports), [0, 0, 0, 0], 'each before the report');
  assert.match(logs[1].text, /Test pass started; if the run is stopped now/);
  assert.match(logs[3].text, /## steps[\s\S]*Planning the tests[\s\S]*Running the tests/);
  assert.match(logs[3].text, /## plan\nEnded: finished/);
});

test('a test pass that runs out of turns with no report says so in the verdict and the log', async (t) => {
  const { reports, logs } = await runQa(t, { noReport: true });
  const { verdict } = reports[0].body;
  assert.equal(verdict.conclusion, 'neutral');
  assert.match(verdict.status, /the run ended without a QA report, because the test pass ran out of turns before it finished \(200 turns\)/);
  assert.match(logs.at(-1).text, /## test\nEnded: ran out of turns[\s\S]*Opening the app[\s\S]*No report\.md was written\./);
});

test('a credential a pass printed is taken out of the log the console keeps', async (t) => {
  const { logs } = await runQa(t, { leak: true });
  assert.ok(logs.length > 0);
  for (const l of logs) assert.doesNotMatch(l.text, /abcdef1234567890/);
  assert.match(logs.at(-1).text, /_authToken=\[redacted\]/);
});

test('the model\'s secret screen blanks the lines it names, and a screen that cannot run leaves a note', async (t) => {
  // An opaque value in prose, which no pattern knows: the screen names its line, and it is blanked.
  const first = await runQa(t, { opaque: true, screen: 'NONE' });
  assert.match(first.logs.at(-1).text, /zzOpaque7788/, 'a pattern cannot know it: only the screen can');
  const lineOf = (text) => text.split('\n').findIndex((l) => l.includes('zzOpaque7788')) + 1;
  const line = lineOf(first.logs.at(-1).text);
  assert.ok(line > 0);
  const second = await runQa(t, { opaque: true, screen: `${line}` });
  assert.doesNotMatch(second.logs.at(-1).text, /zzOpaque7788/);
  assert.match(second.logs.at(-1).text, /\[line removed: the secret screen found a secret in it\]/);
  const failed = await runQa(t, { screen: 'fail' });
  assert.match(failed.logs.at(-1).text, /model check for secrets did not run/);
});

test('the summary tier never carries what a pass printed, even when the secret screen misses it, while the full log does', async (t) => {
  const { logs } = await runQa(t, { opaque: true, screen: 'NONE' });
  const summary = logs.filter((l) => l.tier === 'summary');
  const full = logs.filter((l) => l.tier === 'full');
  assert.ok(summary.length > 0 && full.length > 0);
  for (const l of summary) assert.doesNotMatch(l.text, /zzOpaque7788/);
  assert.match(full.at(-1).text, /zzOpaque7788/, 'the screen missed it: only the full log, for admins and the starter, has it');
  const failed = await runQa(t, { opaque: true, screen: 'fail' });
  for (const l of failed.logs.filter((x) => x.tier === 'summary')) assert.doesNotMatch(l.text, /zzOpaque7788/, 'a screen that cannot run leaves the summary safe');
});

test('every summary the script sends is one the console accepts, in each kind of run', async (t) => {
  for (const options of [{}, { skip: true }, { noReport: true }, { app: 'failed' }, { opaque: true, leak: true }]) {
    const { logs } = await runQa(t, options);
    const summaries = logs.filter((l) => l.tier === 'summary');
    assert.ok(summaries.length > 0);
    for (const l of summaries) assert.equal(summaryProblem(l.text, { number: 7, base: 'stacked-base' }), null, `${JSON.stringify(options)}: ${l.text}`);
  }
});
