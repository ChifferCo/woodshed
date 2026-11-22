import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createCliSignIn } from '../console/cliSignIn.mjs';
import { createKeptReviews } from '../console/keptReview.mjs';
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
// `keeps: false` is a console from before the kept review.
async function setup(t, { projectFile = null, signedIn = true, origin: gitOrigin = 'https://github.com/acme/game.git', keeps = true } = {}) {
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
  const keptReviews = keeps ? createKeptReviews({ store }) : null;
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
      sourceOf: async () => (state.gatesError ? null : state.from ?? (state.gates ? 'default branch' : 'none')), keptReviews,
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
  return { origin, run, repo, state, file, sent, cli, store, tmp };
}

test('enable writes the review into the project file, checks it, and with nothing missing says to commit it', async (t) => {
  const s = await setup(t, { projectFile: 'version: 1\n# Ours.\neditor: true\n' });
  const run = await s.run(['review', 'enable', '--commit']);
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
    assert.equal(status.code, EXIT.waiting);
    assert.equal(status.lines[0].repo, 'acme/game');
    const enabled = await s.run(['review', 'enable', '--commit', '--json']);
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
    for (const words of [['status'], ['enable', '--commit']]) {
      const result = await s.run(['review', ...words, '--json']);
      assert.equal(result.code, EXIT.failed);
      assert.match(result.lines[0].error, /project\.yaml.*symlink/);
    }
    assert.equal(fs.readFileSync(path.join(outside, 'project.yaml'), 'utf8'), original);
  }
});

test('what only an admin can do is printed as its step, with exit 2; the file is written anyway', async (t) => {
  const s = await setup(t);
  s.state.reviewer = 'none';
  const none = await s.run(['review', 'enable', '--commit', '--json']);
  assert.equal(none.code, EXIT.waiting);
  const [result] = none.lines;
  assert.equal(result.written, true);
  assert.deepEqual(result.missing.map((m) => [m.key, m.by]), [['reviewer-app', 'admin']]);
  assert.match(result.missing[0].step, new RegExp(`${s.origin}/setup/github, Create the reviewer App on GitHub`));
  assert.ok(s.file().includes('runner: woodshed'));

  s.state.reviewer = 'made';
  const made = await s.run(['review', 'enable', '--commit']);
  assert.equal(made.code, EXIT.waiting);
  assert.match(made.out, /\.woodshed\/project\.yaml already has the review in a Woodshed session\./);
  assert.match(made.out, /Still to do:\n {2}- An owner of acme\/game's account installs the reviewer App \(acme-reviewer\[bot\]\) on acme\/game: https:\/\/github\.com\/apps\/acme-reviewer\/installations\/new\. \(an admin\)/);
});

test('--qa adds QA in a session, and warns when there is no app for it to start', async (t) => {
  const s = await setup(t);
  const run = await s.run(['review', 'enable', '--commit', '--qa', '--every-commit']);
  assert.equal(run.code, EXIT.done, run.out);
  const gates = parseProject(parseYaml(s.file())).pullRequests;
  assert.deepEqual([gates.qa.runner, gates.qa.label, gates.qa.check, gates.review.rerun], ['woodshed', 'woodshed-qa', 'QA', null]);
  assert.match(run.out, /Warning: QA in a session starts the app the project file names, and this one names none/);
  assert.match(run.out, /reviews each pull request on each new commit, and QA runs when a pull request gets the woodshed-qa label/);
});

test('--dry-run writes nothing; a file that does not read is left alone with 1', async (t) => {
  const s = await setup(t, { projectFile: 'version: 1\n' });
  const dry = await s.run(['review', 'enable', '--commit', '--dry-run']);
  assert.equal(dry.code, EXIT.done);
  assert.match(dry.out, /Would change \.woodshed\/project\.yaml:/);
  assert.equal(s.file(), 'version: 1\n');

  const bad = await setup(t, { projectFile: 'version: 1\npullRequest: {}\n' });
  const run = await bad.run(['review', 'enable', '--commit']);
  assert.equal(run.code, EXIT.failed);
  assert.match(run.err, /does not read as a project file, so it was not changed: .*pullRequest/);
  assert.equal(bad.file(), 'version: 1\npullRequest: {}\n');
});

test('an omitted review option value cannot consume --dry-run', async (t) => {
  const s = await setup(t);
  for (const option of ['--rerun', '--dir']) {
    const missing = await s.run(['review', 'enable', '--commit', option, '--dry-run']);
    assert.equal(missing.code, EXIT.failed);
    assert.ok(missing.err.includes(`${option} needs a value`));
    assert.equal(s.file(), null);
  }
  const dry = await s.run(['review', 'enable', '--commit', '--rerun=--tag', '--dry-run']);
  assert.equal(dry.code, EXIT.done);
  assert.match(dry.out, /rerun: --tag/);
  assert.equal(s.file(), null);
});

test('project check\'s problems stop the write', async (t) => {
  const s = await setup(t, { projectFile: 'version: 1\nrules: docs/missing.md\n' });
  const run = await s.run(['review', 'enable', '--commit']);
  assert.equal(run.code, EXIT.failed);
  assert.match(run.out, /project check found problems, so nothing was written:\n {2}\.woodshed\/project\.yaml: /);
  assert.equal(s.file(), 'version: 1\nrules: docs/missing.md\n');
});

test('not signed in: the file is written, and the console is not asked: 2', async (t) => {
  const s = await setup(t, { signedIn: false });
  const run = await s.run(['review', 'enable', '--commit']);
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

  await s.run(['review', 'enable', '--commit']);
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
  assert.deepEqual(readinessFindings({ consoleApp: { login: 'a[bot]', name: 'staging' }, missing: [] }, { runsOn: 'a[bot]/staging' }).warnings, []);
  assert.equal(readinessFindings({ consoleApp: { login: 'a[bot]', name: null }, missing: [] }, { runsOn: 'a[bot]/staging' }).warnings.length, 1, 'another console of the same App, as the fleet reads it');
});

test('outside a checkout, or a checkout not on GitHub', async (t) => {
  const s = await setup(t, { origin: 'https://gitlab.com/acme/game.git' });
  const run = await s.run(['review', 'enable', '--commit']);
  assert.equal(run.code, EXIT.failed, 'written, but no console said it can run it');
  assert.match(run.out, /Console: not asked: this checkout's origin is not on GitHub/);
  assert.match(run.out, /is written, but the console did not say it can run the review/);
  const outside = await s.run(['review', 'status', '--dir', os.tmpdir()]);
  assert.equal(outside.code, EXIT.failed);
  assert.match(outside.err, /is not in a git checkout/);
  const unknown = await s.run(['review', 'enable', '--commit', '--wat']);
  assert.equal(unknown.code, EXIT.failed);
  assert.match(unknown.err, /unknown option --wat/);
});

test('status is on only with the installation known and runsOn naming this console; a console that cannot answer is 1', async (t) => {
  const s = await setup(t);
  await s.run(['review', 'enable', '--commit']);
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
  const run = await noApp.run(['review', 'enable', '--commit', '--console', 'http://localhost:1']);
  assert.equal(run.code, EXIT.waiting, 'not signed in to that console');
});

test('a default branch\'s project file the console could not read leaves enable unconfirmed: 1', async (t) => {
  const s = await setup(t);
  s.state.gatesError = 'the project file could not be read: HTTP 502';
  const run = await s.run(['review', 'enable', '--commit']);
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
  const enable = await s.run(['review', 'enable', '--commit']);
  assert.equal(enable.code, EXIT.failed);
});

// The default: the console keeps the review on, with no commit and no checkout.

test('enable with --repo needs no checkout: the console keeps it on, at once, and nothing is written', async (t) => {
  const s = await setup(t);
  const run = await s.run(['review', 'enable', '--repo', 'acme/game'], { cwd: s.tmp });
  assert.equal(run.code, EXIT.done, run.err + run.out);
  assert.match(run.out, /Turned on the review the console keeps for acme\/game, in a Woodshed session, on commits tagged \[woodshed-review\]: no commit needed\./);
  assert.match(run.out, /Review is on, kept on by the console, with no commit: the console reviews each pull request whose head commit's message has \[woodshed-review\]\./);
  assert.equal(s.file(), null, 'no project file written');
  assert.deepEqual(Object.keys(s.store.state.keptReviews), ['acme/game']);
  assert.deepEqual([s.store.state.keptReviews['acme/game'].review, s.store.state.keptReviews['acme/game'].by], [{ runner: 'woodshed', rerun: '[woodshed-review]' }, 'bob']);
  assert.deepEqual(s.sent.map((c) => [c.url.replace(s.origin, ''), c.headers.origin]), [['/api/kept-review', undefined]]);

  const again = await s.run(['review', 'enable', '--json'], { cwd: s.repo });
  assert.equal(again.code, EXIT.done, 'the checkout\'s origin names the repo');
  assert.deepEqual([again.lines[0].event, again.lines[0].where, again.lines[0].changed, again.lines[0].console.review], ['enable', 'console', false, { runner: 'woodshed', rerun: '[woodshed-review]', from: 'console' }]);

  const status = await s.run(['review', 'status', '--repo', 'acme/game'], { cwd: s.tmp });
  assert.equal(status.code, EXIT.done, status.out);
  assert.match(status.out, /Default branch: {2}no \.woodshed\/project\.yaml/);
  assert.match(status.out, /Console keeps: {3}review on, by @bob \(.+\), in a Woodshed session, on commits tagged \[woodshed-review\]/);
  assert.match(status.out, /Runs: {12}review in a Woodshed session, on commits tagged \[woodshed-review\], kept on by the console, with no commit/);
  assert.match(status.out, /Review is on\./);
  assert.ok(!/This checkout/.test(status.out), 'no checkout was read');
});

test('disable turns the kept review off; --every-commit and a tag are kept as asked', async (t) => {
  const s = await setup(t);
  await s.run(['review', 'enable', '--every-commit']);
  assert.equal(s.store.state.keptReviews['acme/game'].review.rerun, null);
  const tagged = await s.run(['review', 'enable', '--rerun', '[review me]', '--json']);
  assert.equal(tagged.lines[0].changed, true);
  assert.equal(s.store.state.keptReviews['acme/game'].review.rerun, '[review me]');

  const off = await s.run(['review', 'disable', '--json']);
  assert.equal(off.code, EXIT.done, off.out);
  assert.deepEqual([off.lines[0].event, off.lines[0].on, off.lines[0].changed, off.lines[0].console.review], ['disable', false, true, null]);
  assert.deepEqual(s.store.state.keptReviews, {});
  const status = await s.run(['review', 'status']);
  assert.equal(status.code, EXIT.waiting);
  assert.match(status.out, /Console keeps: {3}review off/);
  assert.match(status.out, /Next: woodshed review enable\./);
  const again = await s.run(['review', 'disable']);
  assert.match(again.out, /The review the console keeps was already off\./);
});

test('--dry-run asks and changes nothing', async (t) => {
  const s = await setup(t);
  const dry = await s.run(['review', 'enable', '--dry-run']);
  assert.equal(dry.code, EXIT.done);
  assert.match(dry.out, /Would turn the review the console keeps on, in a Woodshed session, on commits tagged \[woodshed-review\]\. Nothing changed \(--dry-run\)\./);
  assert.equal(s.store.state.keptReviews, undefined);
  assert.deepEqual(s.sent.map((c) => new URL(c.url).pathname), ['/api/review-readiness']);
});

test('the project file\'s own review wins, and is said to', async (t) => {
  const s = await setup(t);
  s.state.gates = { review: { runner: 'actions', heading: '## R', rerun: null, author: 'claude[bot]' }, qa: null };
  const run = await s.run(['review', 'enable']);
  assert.equal(run.code, EXIT.waiting, 'kept, but the file\'s Actions review is what runs');
  assert.ok(s.store.state.keptReviews['acme/game']);
  assert.match(run.out, /Warning: the repo's project file reviews in GitHub Actions, which wins over the one the console keeps/);
  const status = await s.run(['review', 'status']);
  assert.equal(status.code, EXIT.waiting);
  assert.match(status.out, /Runs: {12}review in GitHub Actions, from the default branch's \.woodshed\/project\.yaml/);

  s.state.gates = { review: { runner: 'woodshed', heading: '## R', rerun: null }, qa: null };
  const own = await s.run(['review', 'enable']);
  assert.equal(own.code, EXIT.done);
  assert.match(own.out, /Review is on, from the default branch's \.woodshed\/project\.yaml: the console reviews each pull request on each new commit\./);
  const off = await s.run(['review', 'disable']);
  assert.match(off.out, /Review is still on, from the default branch's/);
});

test('a repo the console does not have for them is not kept; --qa and --repo are --commit\'s and not', async (t) => {
  const s = await setup(t);
  const other = await s.run(['review', 'enable', '--repo', 'acme/other']);
  assert.equal(other.code, EXIT.waiting);
  assert.match(other.out, /An admin of the console adds acme\/other/);
  assert.equal(s.store.state.keptReviews, undefined);
  const qa = await s.run(['review', 'enable', '--qa']);
  assert.equal(qa.code, EXIT.failed);
  assert.match(qa.err, /--qa needs the repo's \.woodshed\/project\.yaml.*add --commit/);
  const both = await s.run(['review', 'enable', '--commit', '--repo', 'acme/game']);
  assert.equal(both.code, EXIT.failed);
  assert.match(both.err, /--commit writes the checkout's/);
  const noRepo = await s.run(['review', 'enable'], { cwd: s.tmp });
  assert.equal(noRepo.code, EXIT.failed);
  assert.match(noRepo.err, /give the repo with --repo owner\/name/);
  const bad = await s.run(['review', 'enable', '--repo', 'not a repo']);
  assert.match(bad.err, /--repo must be a GitHub repo as owner\/name/);
});

test('a console from before the kept review says to use --commit: 1', async (t) => {
  const s = await setup(t, { keeps: false });
  const run = await s.run(['review', 'enable', '--json']);
  assert.equal(run.code, EXIT.failed);
  assert.equal(run.lines[0].unsupported, true);
  assert.match(run.lines[0].unasked, /from before the console could keep a repo's review on: run woodshed review enable --commit/);
});
