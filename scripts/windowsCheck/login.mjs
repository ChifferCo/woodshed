// TEMPORARY, not for merge: `woodshed login`, `status` and `logout` for real on Windows, against a console on this
// machine, approving the code through the console's own /cli route as its page's button does. With CHECK_USER and
// CHECK_PASSWORD set, the command line runs as that account (Start-Process -Credential, its profile loaded), and this
// script, as the runner's account, approves and checks. Prints PASS/FAIL per step; never prints a token.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { windowsTools } from '../../cli/credentials.mjs';

const origin = process.argv[2] || 'http://localhost:7690';
const repo = process.env.CHECK_REPO || process.cwd();
const outDir = process.env.CHECK_OUT_DIR || path.join(repo, 'wincheck-out');
const asUser = process.env.CHECK_USER || null;
fs.mkdirSync(outDir, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;

// Runs `node cli/woodshed.mjs <args>`, its stdout and stderr to files read as they grow.
function woodshed(args) {
  n += 1;
  const out = path.join(outDir, `cli-${n}.out`);
  const err = path.join(outDir, `cli-${n}.err`);
  const cli = path.join(repo, 'cli', 'woodshed.mjs');
  let child;
  if (!asUser) {
    child = spawn(process.execPath, [cli, ...args], { cwd: repo, stdio: ['ignore', fs.openSync(out, 'w'), fs.openSync(err, 'w')] });
  } else {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      '$cred = New-Object System.Management.Automation.PSCredential($env:CHECK_USER, (ConvertTo-SecureString $env:CHECK_PASSWORD -AsPlainText -Force))',
      '$list = @($env:CHECK_ARGS | ConvertFrom-Json)',
      '$p = Start-Process -FilePath $env:CHECK_NODE -ArgumentList $list -Credential $cred -LoadUserProfile -WorkingDirectory $env:CHECK_REPO -RedirectStandardOutput $env:CHECK_STDOUT -RedirectStandardError $env:CHECK_STDERR -PassThru -Wait',
      'exit $p.ExitCode',
    ].join('\n');
    child = spawn(windowsTools().powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      cwd: repo, stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, CHECK_NODE: process.execPath, CHECK_ARGS: JSON.stringify([cli, ...args]), CHECK_REPO: repo, CHECK_STDOUT: out, CHECK_STDERR: err },
    });
  }
  const done = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const read = (file) => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  };
  const lines = () => read(out).split(/\r?\n/).filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
  return { done, lines, stderr: () => read(err) };
}

async function consoleUp() {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${origin}/healthz`);
      if (res.status < 500) return true;
    } catch {}
    await sleep(1000);
  }
  return false;
}

// What the person does in the browser: open the page the CLI names, and press its button (a form POST from the
// console's own page, with the hidden fields the page holds).
async function approve(url) {
  const page = await fetch(url);
  const text = await page.text();
  const fields = [...text.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)]
    .map(([, name, value]) => [name, value.replaceAll('&quot;', '"').replaceAll('&amp;', '&')]);
  const done = await fetch(`${origin}/cli`, {
    method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams([...fields, ['decision', 'approve']]).toString(),
  });
  return { page: page.status, done: done.status };
}

console.log(`console ${origin}; running the command line as ${asUser ? `"${asUser}" (another account)` : 'this account'}`);
check('console answers', await consoleUp());

const login = woodshed(['login', '--console', origin, '--no-browser', '--json']);
let code = null;
for (let i = 0; i < 60 && !code; i++) {
  code = login.lines().find((l) => l.event === 'code') ?? null;
  if (!code) await sleep(500);
}
check('login printed a code', Boolean(code), code ? code.userCode : login.stderr().slice(0, 500));
if (code) {
  const answered = await approve(code.verificationUrlComplete);
  check('approved on the console\'s page', answered.page === 200 && answered.done === 200, JSON.stringify(answered));
}
const loginExit = await login.done;
const signed = login.lines().find((l) => l.event === 'signed-in');
check('login exited 0', loginExit === 0, `exit ${loginExit}; ${login.stderr().slice(0, 500)}`);
check('signed in, token sealed with DPAPI', signed?.store === 'dpapi', signed ? `store ${signed.store}, login ${signed.login}, file ${signed.credentialsFile}` : 'no signed-in line');
if (signed?.credentialsFile) {
  let read = null;
  try {
    read = fs.readFileSync(signed.credentialsFile, 'utf8');
  } catch (err) {
    read = err;
  }
  if (asUser) {
    check('another account (this one, an admin) cannot read the credentials file', read instanceof Error && /EPERM|EACCES/.test(read.code ?? ''), read instanceof Error ? read.code : 'it read it');
  } else {
    check('the credentials file holds no token', typeof read === 'string' && !read.includes('wsc_'));
  }
}

const status = woodshed(['status', '--console', origin, '--json']);
const statusExit = await status.done;
const said = status.lines()[0];
check('status exited 0, signed in', statusExit === 0 && said?.signedIn === true, `exit ${statusExit}; login ${said?.login}; store ${said?.store}; ${status.stderr().slice(0, 300)}`);

const logout = woodshed(['logout', '--console', origin, '--json']);
const logoutExit = await logout.done;
const ended = logout.lines()[0];
check('logout exited 0 and ended it at the console', logoutExit === 0 && ended?.endedAtConsole === true, `exit ${logoutExit}; ${JSON.stringify(ended)}`);

const after = woodshed(['status', '--console', origin, '--json']);
check('status after logout exits 2', (await after.done) === 2);

const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
