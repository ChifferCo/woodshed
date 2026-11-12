// The Woodshed card's updates, against real git: a made-up upstream and a shallow clone of it behind, as install.sh makes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { commitRows, createWoodshedUpdate, shownRemote } from './woodshedUpdate.mjs';

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'Octo Cat', GIT_AUTHOR_EMAIL: 'o@example.invalid', GIT_COMMITTER_NAME: 'Octo Cat', GIT_COMMITTER_EMAIL: 'o@example.invalid' };
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: GIT_ENV }).toString().trim();

/** An upstream, a working copy that pushes to it, and a shallow clone `behind` commits behind, with `files` changed. */
function repos(t, newer = [['console/a.mjs', 'feat: one'], ['session/b.sh', 'fix: two']]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-update-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const upstream = path.join(dir, 'upstream');
  const work = path.join(dir, 'work');
  const clone = path.join(dir, 'clone');
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', upstream]);
  fs.mkdirSync(work);
  git(work, 'init', '--quiet', '--initial-branch=main');
  const commit = (file, title) => {
    fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
    fs.writeFileSync(path.join(work, file), `${title}\n`);
    git(work, 'add', '-A');
    git(work, 'commit', '--quiet', '-m', title);
  };
  commit('README.md', 'first');
  git(work, 'remote', 'add', 'origin', upstream);
  git(work, 'push', '--quiet', 'origin', 'main');
  execFileSync('git', ['clone', '--quiet', '--depth', '1', `file://${upstream}`, clone]);
  for (const [file, title] of newer) commit(file, title);
  git(work, 'push', '--quiet', 'origin', 'main');
  return { dir, upstream, work, clone, commit };
}

/** A stand-in for spawning install.sh: prints `lines`, then exits with `code`. */
function fakeSpawn(calls, { code = 0, lines = ['==> Built the session image'] } = {}) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts.env });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      for (const line of lines) child.stdout.emit('data', Buffer.from(`${line}\n`));
      child.emit('close', code);
    });
    return child;
  };
}

function setup(t, { clone, supervisor = 'systemd', code, lines, kind = 'docker' }) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-update-state-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const store = { state: {}, save() {} };
  const spawned = [];
  const exits = [];
  const updates = createWoodshedUpdate({
    config: { checkout: clone, stateDir, launcher: { kind, image: 'woodshed-session:acme-app' } }, store, supervisor,
    repo: () => 'acme/app', token: async () => 'app-token', spawnImpl: fakeSpawn(spawned, { code, lines }), exit: (c) => exits.push(c),
  });
  return { updates, store, spawned, exits };
}

const settle = async (updates) => {
  for (let i = 0; i < 100; i++) {
    const job = (await updates.view()).job;
    if (job && job.state !== 'running') return job;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('the update did not finish');
};

test('a remote is shown without the credentials in its URL, and git log\'s lines become the card\'s rows', () => {
  assert.equal(shownRemote('https://x-access-token:secret@github.com/ChifferCo/woodshed.git'), 'https://github.com/ChifferCo/woodshed.git');
  assert.equal(shownRemote('git@github.com:ChifferCo/woodshed.git'), 'git@github.com:ChifferCo/woodshed.git');
  assert.deepEqual(commitRows('abcdef0123\x1ffix: a\x1fOcto\x1f2026-11-12T00:00:00Z\n'), [{ sha: 'abcdef0', title: 'fix: a', author: 'Octo', date: '2026-11-12T00:00:00Z' }]);
});

test('check fetches the branch a shallow clone follows and counts what it lacks, newest first', async (t) => {
  const { clone } = repos(t);
  const { updates } = setup(t, { clone });
  assert.equal(updates.behindBy(), 0, 'nothing known before the first check');
  await updates.check();
  const view = await updates.view();
  assert.equal(view.upstream, 'origin/main');
  assert.equal(view.behindBy, 2);
  assert.equal(view.aheadBy, 0);
  assert.deepEqual(view.commits.map((c) => c.title), ['fix: two', 'feat: one']);
  assert.equal(updates.behindBy(), 2);
});

test('Update pulls, builds the session image when session/ changed, and restarts the console', async (t) => {
  const { clone } = repos(t);
  const { updates, store, spawned, exits } = setup(t, { clone });
  const before = git(clone, 'rev-parse', '--short=7', 'HEAD');
  await updates.update({ by: 'mia-dev' });
  const job = await settle(updates);
  assert.equal(job.state, 'restarting');
  assert.deepEqual(job.steps.map((s) => s.state), ['done', 'done', 'now']);
  assert.equal(git(clone, 'rev-list', '--count', 'HEAD..@{upstream}'), '0', 'the clone has the new commits');
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].args[0], path.join(clone, 'install.sh'));
  assert.equal(spawned[0].env.WOODSHED_BUILD_ONLY, '1');
  assert.equal(spawned[0].env.WOODSHED_IMAGE, 'woodshed-session:acme-app');
  assert.equal(spawned[0].env.WOODSHED_REPO, 'acme/app');
  assert.equal(spawned[0].env.GH_TOKEN, 'app-token');
  assert.deepEqual({ ...store.state.woodshedUpdate, at: null }, { from: before, to: git(clone, 'rev-parse', '--short=7', 'HEAD'), by: 'mia-dev', at: null, imageBuilt: true });
  await new Promise((r) => setTimeout(r, 1_100));
  assert.deepEqual(exits, [75], 'the supervisor starts it again');
});

test('a change outside session/ and shared/ restarts the console without building the image', async (t) => {
  const { clone } = repos(t, [['console/a.mjs', 'feat: only the console']]);
  const { updates, spawned } = setup(t, { clone });
  await updates.update({ by: 'mia-dev' });
  const job = await settle(updates);
  assert.equal(job.state, 'restarting');
  assert.equal(job.steps[1].detail, 'unchanged');
  assert.equal(spawned.length, 0);
});

test('a failed build puts the clone back where it was, and the console keeps running', async (t) => {
  const { clone } = repos(t);
  const { updates, exits, store } = setup(t, { clone, code: 1, lines: ['ERROR: failed to solve: no space left on device'] });
  const before = git(clone, 'rev-parse', 'HEAD');
  await updates.update({ by: 'mia-dev' });
  const job = await settle(updates);
  assert.equal(job.state, 'failed');
  assert.deepEqual(job.steps.map((s) => s.state), ['done', 'failed', 'next']);
  assert.match(job.error, /install\.sh stopped with code 1: ERROR: failed to solve: no space left on device/);
  assert.deepEqual(job.logTail, ['ERROR: failed to solve: no space left on device']);
  assert.equal(git(clone, 'rev-parse', 'HEAD'), before, 'back on the commit that worked');
  assert.equal(store.state.woodshedUpdate, undefined);
  await new Promise((r) => setTimeout(r, 1_100));
  assert.deepEqual(exits, []);
});

test('a clone with changes of its own is refused before anything moves', async (t) => {
  const { clone } = repos(t);
  fs.writeFileSync(path.join(clone, 'README.md'), 'edited by hand\n');
  const { updates } = setup(t, { clone });
  const before = git(clone, 'rev-parse', 'HEAD');
  await updates.update({ by: 'mia-dev' });
  const job = await settle(updates);
  assert.equal(job.state, 'failed');
  assert.match(job.error, /the clone has changes of its own \(README\.md\)/);
  assert.equal(git(clone, 'rev-parse', 'HEAD'), before);
});

test('a clone with commits upstream lacks is counted, and Update cannot move it forward', async (t) => {
  const { clone } = repos(t);
  fs.writeFileSync(path.join(clone, 'local.txt'), 'mine\n');
  git(clone, 'add', '-A');
  git(clone, 'commit', '--quiet', '-m', 'local');
  const { updates } = setup(t, { clone });
  await updates.check();
  const view = await updates.view();
  assert.equal(view.aheadBy, 1);
  assert.equal(view.behindBy, 2);
  await updates.update({ by: 'mia-dev' });
  const job = await settle(updates);
  assert.equal(job.state, 'failed');
  assert.match(job.steps[0].detail, /forward|fast-forward/i);
});

test('Update is refused with nothing to start the console again, while one runs, or when up to date', async (t) => {
  const { clone, upstream } = repos(t);
  const alone = setup(t, { clone, supervisor: null });
  await assert.rejects(alone.updates.update({ by: 'mia-dev' }), (err) => err.shown && /Nothing would start this console again/.test(err.message));
  const { updates } = setup(t, { clone });
  await updates.update({ by: 'mia-dev' });
  await assert.rejects(updates.update({ by: 'mia-dev' }), /already running/);
  await settle(updates);
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-update-fresh-'));
  t.after(() => fs.rmSync(fresh, { recursive: true, force: true }));
  execFileSync('git', ['clone', '--quiet', `file://${upstream}`, path.join(fresh, 'c')]);
  const upToDate = setup(t, { clone: path.join(fresh, 'c') });
  await assert.rejects(upToDate.updates.update({ by: 'mia-dev' }), /Already up to date/);
});

test('a console that runs from no clone, or from one on no branch, has no card and no Update', async (t) => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-update-plain-'));
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  const none = setup(t, { clone: plain });
  assert.equal(await none.updates.view(), null);
  await none.updates.check();
  await assert.rejects(none.updates.update({ by: 'mia-dev' }), /does not run from a git clone/);
  const { clone } = repos(t);
  git(clone, 'checkout', '--quiet', '--detach');
  const detached = setup(t, { clone });
  assert.equal((await detached.updates.view()).upstream, null);
  await assert.rejects(detached.updates.update({ by: 'mia-dev' }), /follows no branch/);
});
