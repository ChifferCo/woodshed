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
  const state = { reviewer: 'installed', gates: null, runsOn: null, gatesError: null };
  const reviewer = {
    login: () => (state.reviewer === 'none' ? null : 'acme-reviewer[bot]'),
    configured: () => state.reviewer !== 'none',
    installedOn: async (repo) => (state.reviewer === 'unknown' ? null : state.reviewer === 'installed' && repo === 'acme/game'),
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
    reviewReadiness: createReviewReadiness({
      publicUrl: origin, reviewer, ownReviewer: true, appLogin: async () => 'acme-woodshed[bot]', pullRequestsOf: async () => { if (state.gatesError) throw new Error(state.gatesError); return state.gates; },
      canWrite: async (login) => { if (state.writeError) throw new Error(state.writeError); return login === 'bob'; },
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
  const run = async (args, { cwd = repo } = {}) => {
    let out = '';
    let err = '';
    const code = await main([...args, ...(signedIn ? [] : ['--console', origin])], {
      env: { XDG_CONFIG_HOME: home }, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } },
      platform: 'test', credentials, cwd,
      fetch: async (url, init) => { sent.push({ url: String(url), headers: init.headers }); return fetch(url, init); },
    });
    return { code, out, err, lines: out.trim().split('\n').filter(Boolean).map((l) => (l.startsWith('{') ? JSON.parse(l) : l)) };
  };
  const file = () => (fs.existsSync(path.join(repo, '.woodshed', 'project.yaml')) ? fs.readFileSync(path.join(repo, '.woodshed', 'project.yaml'), 'utf8') : null);
  return { origin, run, repo, state, file, sent, cli, tmp };
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

test('review status and enable use installed Git when run from a checkout containing git.exe', async (t) => {
  const s = await setup(t);
  // An inert file, never a program. On Windows a bare Git invocation from this checkout would fail.
  fs.writeFileSync(path.join(s.repo, 'git.exe'), '');
  const before = process.cwd();
  try {
    process.chdir(s.repo);
    const status = await s.run(['review', 'status', '--json']);
    assert.equal(status.code, EXIT.done, 'on by default');
    assert.equal(status.lines[0].repo, 'acme/game');
    const enabled = await s.run(['review', 'enable', '--json']);
    assert.equal(enabled.code, EXIT.done);
    assert.equal(enabled.lines[0].written, true);
  } finally {
    process.chdir(before);
  }
});

test('review leaves linked project files and directories alone', async (t) => {
  for (const linked of ['file', 'directory']) {
    const s = await setup(t);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-review-project-'));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    const original = 'version: 1\n# Fixture\n';
    fs.writeFileSync(path.join(outside, 'project.yaml'), original);
    const folder = path.join(s.repo, '.woodshed');
    if (linked === 'file') {
      fs.mkdirSync(folder);
      fs.symlinkSync(path.join(outside, 'project.yaml'), path.join(folder, 'project.yaml'), 'file');
    } else {
      fs.symlinkSync(outside, folder, 'junction');
    }
    for (const sub of ['status', 'enable']) {
      const result = await s.run(['review', sub, '--json']);
      assert.equal(result.code, EXIT.failed);
      assert.match(result.lines[0].error, /project\.yaml.*symlink/);
    }
    assert.equal(fs.readFileSync(path.join(outside, 'project.yaml'), 'utf8'), original);
  }
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
  assert.match(made.out, /Still to do:\n {2}- An owner of acme\/game's account installs the reviewer App \(acme-reviewer\[bot\]\) on acme\/game: https:\/\/github\.com\/apps\/acme-reviewer\/installations\/new\. \(an admin\)/);
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

test('an omitted review option value cannot consume --dry-run', async (t) => {
  const s = await setup(t);
  for (const option of ['--rerun', '--dir']) {
    const missing = await s.run(['review', 'enable', option, '--dry-run']);
    assert.equal(missing.code, EXIT.failed);
    assert.ok(missing.err.includes(`${option} needs a value`));
    assert.equal(s.file(), null);
  }
  const dry = await s.run(['review', 'enable', '--rerun=--tag', '--dry-run']);
  assert.equal(dry.code, EXIT.done);
  assert.match(dry.out, /rerun: --tag/);
  assert.equal(s.file(), null);
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

test('status: on by default with no project file, needing no checkout; the file\'s own review, when it names one', async (t) => {
  const s = await setup(t);
  const byDefault = await s.run(['review', 'status', '--repo', 'acme/game'], { cwd: s.tmp });
  assert.equal(byDefault.code, EXIT.done, byDefault.out);
  assert.match(byDefault.out, /Runs: {12}review in a Woodshed session, on commits tagged \[woodshed-review\], default, for every repo/);
  assert.match(byDefault.out, /Review is on: put \[woodshed-review\] in a commit's message, and the console reviews the pull request at that commit\./);
  assert.ok(!/This checkout/.test(byDefault.out), 'no checkout was read');
  const json = await s.run(['review', 'status', '--json']);
  assert.deepEqual([json.lines[0].on, json.lines[0].review], [true, { runner: 'woodshed', rerun: '[woodshed-review]', from: 'default' }]);

  s.state.reviewer = 'made';
  const notInstalled = await s.run(['review', 'status', '--repo', 'acme/game'], { cwd: s.tmp });
  assert.equal(notInstalled.code, EXIT.waiting);
  assert.match(notInstalled.out, /installs the reviewer App/);
  s.state.reviewer = 'installed';

  s.state.gates = { review: { runner: 'woodshed', heading: '## R', rerun: null }, qa: null };
  const own = await s.run(['review', 'status']);
  assert.equal(own.code, EXIT.done, own.out);
  assert.match(own.out, /Project file: {4}review in a Woodshed session, on each commit/);
  assert.match(own.out, /Runs: {12}review in a Woodshed session, on each commit, the repo's project file/);

  s.state.gates = { review: { runner: 'actions', heading: '## R', rerun: null, author: 'claude[bot]' }, qa: null };
  const actions = await s.run(['review', 'status']);
  assert.equal(actions.code, EXIT.waiting);
  assert.match(actions.out, /Review runs in GitHub Actions, by the repo's project file/);
  const bad = await s.run(['review', 'status', '--repo', 'nope']);
  assert.match(bad.err, /--repo must be a GitHub repo as owner\/name/);
});

test('a runsOn or logins in the file that are not this console\'s are warned of', async (t) => {
  const { warnings } = readinessFindings(
    { consoleApp: { login: 'acme-woodshed[bot]' }, reviewerApp: { login: 'acme-reviewer[bot]' }, missing: [] },
    { runsOn: 'other[bot]/prod', review: { author: 'old-bot[bot]', commentAuthor: 'acme-woodshed[bot]' } },
  );
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /runsOn names other\[bot\]\/prod/);
  assert.match(warnings[1], /author is old-bot\[bot\].*verdicts would not count/);
  assert.deepEqual(readinessFindings({ consoleApp: { login: 'a[bot]', name: 'staging' }, missing: [] }, { runsOn: 'a[bot]/staging' }).warnings, []);
  assert.equal(readinessFindings({ consoleApp: { login: 'a[bot]', name: null }, missing: [] }, { runsOn: 'a[bot]/staging' }).warnings.length, 1, 'another console of the same App, as the fleet reads it');
});

test('outside a checkout, or a checkout not on GitHub', async (t) => {
  const s = await setup(t, { origin: 'https://gitlab.com/acme/game.git' });
  const run = await s.run(['review', 'enable']);
  assert.equal(run.code, EXIT.failed, 'written, but no console said it can run it');
  assert.match(run.out, /Console: not asked: this checkout's origin is not on GitHub/);
  assert.match(run.out, /is written, but the console did not say it can run the review/);
  const outside = await s.run(['review', 'status', '--dir', os.tmpdir()]);
  assert.equal(outside.code, EXIT.failed);
  assert.match(outside.err, /is not in a git checkout/);
  const unknown = await s.run(['review', 'enable', '--wat']);
  assert.equal(unknown.code, EXIT.failed);
  assert.match(unknown.err, /unknown option --wat/);
});

test('status is on only with the installation known and runsOn naming this console; a console that cannot answer is 1', async (t) => {
  const s = await setup(t);
  await s.run(['review', 'enable']);
  s.state.gates = { review: { runner: 'woodshed', heading: '## R', rerun: '[woodshed-review]' }, qa: null, runsOn: null };
  assert.equal((await s.run(['review', 'status'])).code, EXIT.done);

  s.state.reviewer = 'unknown';
  const unknown = await s.run(['review', 'status', '--json']);
  assert.equal(unknown.code, EXIT.waiting);
  assert.equal(unknown.lines[0].on, false);
  assert.deepEqual(unknown.lines[0].missing.map((m) => m.key), ['reviewer-installed-unknown']);

  s.state.reviewer = 'installed';
  s.state.gates = { ...s.state.gates, runsOn: 'acme-woodshed[bot]/prod' };
  const elsewhere = await s.run(['review', 'status']);
  assert.equal(elsewhere.code, EXIT.waiting, 'the same App, another of its consoles');
  assert.match(elsewhere.out, /runsOn names acme-woodshed\[bot\]\/prod, so this console \(acme-woodshed\[bot\]\) runs none of its reviews/);
  s.state.gates = { ...s.state.gates, runsOn: 'acme-woodshed[bot]' };
  assert.equal((await s.run(['review', 'status'])).code, EXIT.done);

  const noApp = await setup(t);
  noApp.state.reviewer = 'installed';
  const run = await noApp.run(['review', 'enable', '--console', 'http://localhost:1']);
  assert.equal(run.code, EXIT.waiting, 'not signed in to that console');
});

test('a default branch\'s project file the console could not read leaves enable unconfirmed: 1', async (t) => {
  const s = await setup(t);
  s.state.gatesError = 'the project file could not be read: HTTP 502';
  const run = await s.run(['review', 'enable']);
  assert.equal(run.code, EXIT.failed);
  assert.match(run.out, /the default branch's \.woodshed\/project\.yaml was not read: the project file could not be read: HTTP 502/);
  assert.ok(s.file().includes('runner: woodshed'), 'the edit is kept');
  assert.equal((await s.run(['review', 'status'])).code, EXIT.failed);
});

test('status is 1, not 2, when the console answered with a failure', async (t) => {
  const s = await setup(t);
  s.state.writeError = 'GitHub did not answer';
  const run = await s.run(['review', 'status']);
  assert.equal(run.code, EXIT.failed);
  assert.match(run.out, /Console: not asked: .* answered 502: the console could not tell: GitHub did not answer/);
  const enable = await s.run(['review', 'enable']);
  assert.equal(enable.code, EXIT.failed);
});
