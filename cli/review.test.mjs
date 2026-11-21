import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createCliSignIn } from '../console/cliSignIn.mjs';
import { createReviewReadiness } from '../console/reviewReadiness.mjs';
import { createHandler } from '../console/server.mjs';
import { parseProject } from '../shared/project.mjs';
import { parseYaml } from '../shared/yamlLite.mjs';
import { createCredentials } from './credentials.mjs';
import { readinessFindings } from './review.mjs';
import { EXIT, main } from './woodshed.mjs';

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });

// A console with the command line's sign-in and a reviewer App in `state.reviewer` ('none', 'made' or 'installed'),
// whose default branch's project file is `state.gates`; a checkout of acme/game; and bob signed in on this computer.
async function setup(t, { projectFile = null, signedIn = true, origin: gitOrigin = 'https://github.com/acme/game.git' } = {}) {
  const state = { reviewer: 'installed', gates: null, runsOn: null };
  const reviewer = {
    login: () => (state.reviewer === 'none' ? null : 'acme-reviewer[bot]'),
    configured: () => state.reviewer !== 'none',
    installedOn: async (repo) => state.reviewer === 'installed' && repo === 'acme/game',
    view: async () => ({ installUrl: 'https://github.com/apps/acme-reviewer/installations/new' }),
    submitReview: async () => null,
  };
  const store = { state: {}, save() {} };
  const cli = createCliSignIn({ store });
  let handle = null;
  const server = http.createServer((req, res) => { handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const origin = `http://localhost:${server.address().port}`;
  const config = { host: '127.0.0.1', publicUrl: origin, extraHosts: [], repo: 'acme/game', label: 'woodshed', consoleName: 'Acme', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const auth = { enabled: () => true, available: () => true, sessionFor: async () => null };
  handle = createHandler({
    config, fleet: { sessions: () => [], find: () => null }, auth, cli,
    projectAccess: { startable: async (login) => (login === 'bob' ? [{ name: 'game', repo: 'acme/game' }] : []), view: async () => ({ projects: [] }) },
    reviewReadiness: createReviewReadiness({
      publicUrl: origin, reviewer, ownReviewer: true, appLogin: async () => 'acme-woodshed[bot]', pullRequestsOf: async () => state.gates,
    }),
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-cli-review-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const repo = path.join(tmp, 'game');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, 'remote', 'add', 'origin', gitOrigin);
  if (projectFile !== null) {
    fs.mkdirSync(path.join(repo, '.woodshed'));
    fs.writeFileSync(path.join(repo, '.woodshed', 'project.yaml'), projectFile);
  }
  const home = path.join(tmp, 'config');
  const credentials = createCredentials({ platform: 'test', dir: path.join(home, 'woodshed') });
  if (signedIn) {
    const { deviceCode, userCode } = cli.start({ name: 'bob-laptop' });
    cli.decide({ code: userCode, login: 'bob', approve: true });
    const { token, id } = cli.poll(deviceCode);
    const kept = credentials.save(origin, token);
    fs.writeFileSync(path.join(home, 'woodshed', 'cli.json'), JSON.stringify({ current: origin, consoles: { [origin]: { login: 'bob', store: kept.kind, tokenId: id } } }));
  } else {
    fs.mkdirSync(path.join(home, 'woodshed'), { recursive: true });
  }
  const sent = [];
  const run = async (args) => {
    let out = '';
    let err = '';
    const code = await main([...args, ...(signedIn ? [] : ['--console', origin])], {
      env: { XDG_CONFIG_HOME: home }, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } },
      platform: 'test', credentials, cwd: repo,
      fetch: async (url, init) => { sent.push({ url: String(url), headers: init.headers }); return fetch(url, init); },
    });
    return { code, out, err, lines: out.trim().split('\n').filter(Boolean).map((l) => (l.startsWith('{') ? JSON.parse(l) : l)) };
  };
  const file = () => (fs.existsSync(path.join(repo, '.woodshed', 'project.yaml')) ? fs.readFileSync(path.join(repo, '.woodshed', 'project.yaml'), 'utf8') : null);
  return { origin, run, repo, state, file, sent, cli };
}

test('enable writes the review into the project file, checks it, and with nothing missing says to commit it', async (t) => {
  const s = await setup(t, { projectFile: 'version: 1\n# Ours.\neditor: true\n' });
  const run = await s.run(['review', 'enable']);
  assert.equal(run.code, EXIT.done, run.err + run.out);
  const review = parseProject(parseYaml(s.file())).pullRequests.review;
  assert.deepEqual([review.runner, review.rerun, review.author, review.commentAuthor], ['woodshed', '[woodshed-review]', null, null]);
  assert.ok(s.file().startsWith('version: 1\n# Ours.\neditor: true\n'), 'what was there stays as it was');
  assert.match(run.out, /Changed \.woodshed\/project\.yaml:\n {2}- pullRequests\.review with runner: woodshed/);
  assert.match(run.out, /Reviewer App: acme-reviewer\[bot\], installed on the repo\./);
  assert.match(run.out, /Next: commit \.woodshed\/project\.yaml and open a pull request\. Once it is merged, the console reviews each pull request whose head commit's message has \[woodshed-review\]\./);
  assert.ok(!fs.existsSync(path.join(s.repo, '.github')), 'no workflow written');
  for (const call of s.sent) assert.ok(!('origin' in call.headers));
  assert.deepEqual(s.sent.map((c) => new URL(c.url).pathname), ['/api/review-readiness'], 'one read of the console, and nothing else');
});

test('what only an admin can do is printed as its step, with exit 2; the file is written anyway', async (t) => {
  const s = await setup(t);
  s.state.reviewer = 'none';
  const none = await s.run(['review', 'enable', '--json']);
  assert.equal(none.code, EXIT.waiting);
  const [result] = none.lines;
  assert.equal(result.written, true);
  assert.deepEqual(result.missing.map((m) => [m.key, m.by]), [['reviewer-app', 'admin']]);
  assert.match(result.missing[0].step, new RegExp(`${s.origin}/setup/github, Create the reviewer App on GitHub`));
  assert.ok(s.file().includes('runner: woodshed'));

  s.state.reviewer = 'made';
  const made = await s.run(['review', 'enable']);
  assert.equal(made.code, EXIT.waiting);
  assert.match(made.out, /\.woodshed\/project\.yaml already has the review in a Woodshed session\./);
  assert.match(made.out, /Still to do, by an admin:\n {2}- An owner of acme\/game's account installs the reviewer App \(acme-reviewer\[bot\]\) on acme\/game: https:\/\/github\.com\/apps\/acme-reviewer\/installations\/new\./);
});

test('--qa adds QA in a session, and warns when there is no app for it to start', async (t) => {
  const s = await setup(t);
  const run = await s.run(['review', 'enable', '--qa', '--every-commit']);
  assert.equal(run.code, EXIT.done, run.out);
  const gates = parseProject(parseYaml(s.file())).pullRequests;
  assert.deepEqual([gates.qa.runner, gates.qa.label, gates.qa.check, gates.review.rerun], ['woodshed', 'woodshed-qa', 'QA', null]);
  assert.match(run.out, /Warning: QA in a session starts the app the project file names, and this one names none/);
  assert.match(run.out, /reviews each pull request on each new commit, and QA runs when a pull request gets the woodshed-qa label/);
});

test('--dry-run writes nothing; a file that does not read is left alone with 1', async (t) => {
  const s = await setup(t, { projectFile: 'version: 1\n' });
  const dry = await s.run(['review', 'enable', '--dry-run']);
  assert.equal(dry.code, EXIT.done);
  assert.match(dry.out, /Would change \.woodshed\/project\.yaml:/);
  assert.equal(s.file(), 'version: 1\n');

  const bad = await setup(t, { projectFile: 'version: 1\npullRequest: {}\n' });
  const run = await bad.run(['review', 'enable']);
  assert.equal(run.code, EXIT.failed);
  assert.match(run.err, /does not read as a project file, so it was not changed: .*pullRequest/);
  assert.equal(bad.file(), 'version: 1\npullRequest: {}\n');
});

test('project check\'s problems stop the write', async (t) => {
  const s = await setup(t, { projectFile: 'version: 1\nrules: docs/missing.md\n' });
  const run = await s.run(['review', 'enable']);
  assert.equal(run.code, EXIT.failed);
  assert.match(run.out, /project check found problems, so nothing was written:\n {2}\.woodshed\/project\.yaml: /);
  assert.equal(s.file(), 'version: 1\nrules: docs/missing.md\n');
});

test('not signed in: the file is written, and the console is not asked: 2', async (t) => {
  const s = await setup(t, { signedIn: false });
  const run = await s.run(['review', 'enable']);
  assert.equal(run.code, EXIT.waiting);
  assert.match(run.out, /Console: not asked: not signed in to .*: run woodshed login/);
  assert.ok(s.file().includes('runner: woodshed'));
  assert.deepEqual(s.sent, []);
});

test('status: off, then in the checkout only, then on', async (t) => {
  const s = await setup(t);
  const off = await s.run(['review', 'status']);
  assert.equal(off.code, EXIT.waiting);
  assert.match(off.out, /This checkout: {3}review off/);
  assert.match(off.out, /Next: woodshed review enable/);

  await s.run(['review', 'enable']);
  const local = await s.run(['review', 'status', '--json']);
  assert.equal(local.code, EXIT.waiting);
  assert.equal(local.lines[0].on, false);
  assert.equal(local.lines[0].checkout.review.runner, 'woodshed');

  s.state.gates = { review: { runner: 'woodshed', heading: '## R', rerun: '[woodshed-review]' }, qa: null };
  const on = await s.run(['review', 'status']);
  assert.equal(on.code, EXIT.done, on.out);
  assert.match(on.out, /Default branch: {2}review in a Woodshed session, on commits tagged \[woodshed-review\]/);
  assert.match(on.out, /Review is on\./);
});

test('a runsOn or logins in the file that are not this console\'s are warned of', async (t) => {
  const { warnings } = readinessFindings(
    { consoleApp: { login: 'acme-woodshed[bot]' }, reviewerApp: { login: 'acme-reviewer[bot]' }, missing: [] },
    { runsOn: 'other[bot]/prod', review: { author: 'old-bot[bot]', commentAuthor: 'acme-woodshed[bot]' } },
  );
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /runsOn names other\[bot\]\/prod/);
  assert.match(warnings[1], /author is old-bot\[bot\].*verdicts would not count/);
  assert.deepEqual(readinessFindings({ consoleApp: { login: 'a[bot]' }, missing: [] }, { runsOn: 'a[bot]/staging' }).warnings, []);
});

test('outside a checkout, or a checkout not on GitHub', async (t) => {
  const s = await setup(t, { origin: 'https://gitlab.com/acme/game.git' });
  const run = await s.run(['review', 'enable']);
  assert.equal(run.code, EXIT.done);
  assert.match(run.out, /Console: not asked: this checkout's origin is not on GitHub/);
  const outside = await s.run(['review', 'status', '--dir', os.tmpdir()]);
  assert.equal(outside.code, EXIT.failed);
  assert.match(outside.err, /is not in a git checkout/);
  const unknown = await s.run(['review', 'enable', '--wat']);
  assert.equal(unknown.code, EXIT.failed);
  assert.match(unknown.err, /unknown option --wat/);
});
