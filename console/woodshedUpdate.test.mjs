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

/**
 * A stand-in for spawning install.sh, which prints `lines` and exits with `code`, and the new code's start check
 * (node), which prints `startLines` and exits with `startCode`. Each call is kept in `calls`, the start checks' in
 * `calls.starts`.
 */
function fakeSpawn(calls, { code = 0, lines = ['==> Built the session image'], startCode = 0, startLines = ['console: start check passed'] } = {}) {
  calls.starts = [];
  return (cmd, args, opts) => {
    const starting = cmd === process.execPath;
    (starting ? calls.starts : calls).push({ cmd, args, env: opts.env });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      for (const line of starting ? startLines : lines) child.stdout.emit('data', Buffer.from(`${line}\n`));
      child.emit('close', starting ? startCode : code);
    });
    return child;
  };
}

function setup(t, { clone, supervisor = 'systemd', code, lines, startCode, startLines, kind = 'docker' }) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-update-state-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const store = { state: {}, save() {} };
  const spawned = [];
  const exits = [];
  const updates = createWoodshedUpdate({
    config: { checkout: clone, stateDir, launcher: { kind, image: 'woodshed-session:acme-app' } }, store, supervisor,
    repo: () => 'acme/app', token: async () => 'app-token', spawnImpl: fakeSpawn(spawned, { code, lines, startCode, startLines }), exit: (c) => exits.push(c),
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
  assert.deepEqual(job.steps.map((s) => s.key), ['pull', 'starts', 'image', 'restart']);
  assert.deepEqual(job.steps.map((s) => s.state), ['done', 'done', 'done', 'now']);
  assert.equal(spawned.starts.length, 1, 'the new code was started as far as its start check');
  assert.deepEqual(spawned.starts[0].args, [path.join(clone, 'providers', 'console.mjs')]);
  assert.equal(spawned.starts[0].env.WOODSHED_CLOUD_START_CHECK, '1');
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
  assert.equal(job.steps[2].detail, 'unchanged');
  assert.equal(spawned.length, 0);
});

test('a failed build puts the clone back where it was, and the console keeps running', async (t) => {
  const { clone } = repos(t);
  const { updates, exits, store } = setup(t, { clone, code: 1, lines: ['ERROR: failed to solve: no space left on device'] });
  const before = git(clone, 'rev-parse', 'HEAD');
  await updates.update({ by: 'mia-dev' });
  const job = await settle(updates);
  assert.equal(job.state, 'failed');
  assert.deepEqual(job.steps.map((s) => s.state), ['done', 'done', 'failed', 'next']);
  assert.match(job.error, /install\.sh stopped with code 1: ERROR: failed to solve: no space left on device/);
  assert.equal(job.logTail.at(-1), 'ERROR: failed to solve: no space left on device');
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

test('a clone with commits upstream lacks is counted, and Update is refused saying so, before anything moves', async (t) => {
  const { clone } = repos(t);
  fs.writeFileSync(path.join(clone, 'local.txt'), 'mine\n');
  git(clone, 'add', '-A');
  git(clone, 'commit', '--quiet', '-m', 'local');
  const { updates, spawned } = setup(t, { clone });
  await updates.check();
  const view = await updates.view();
  assert.equal(view.aheadBy, 1);
  assert.equal(view.behindBy, 2);
  const before = git(clone, 'rev-parse', 'HEAD');
  await assert.rejects(updates.update({ by: 'mia-dev' }),
    (err) => err.shown && err.message === 'The clone has 1 commit of its own that origin/main does not, so it cannot simply move forward: merge it by hand.');
  assert.equal((await updates.view()).job, null);
  assert.equal(git(clone, 'rev-parse', 'HEAD'), before);
  assert.equal(spawned.starts.length, 0);
  await updates.update({ by: 'mia-dev' }).catch(() => {});
  await assert.rejects(updates.update({ by: 'mia-dev' }), /of its own/, 'the refusal frees Update for a later try');
});

test('a fetch that fails refuses Update, rather than pulling what an earlier check fetched', async (t) => {
  const { clone, upstream, dir } = repos(t);
  const { updates } = setup(t, { clone });
  await updates.check();
  assert.equal((await updates.view()).behindBy, 2);
  fs.renameSync(upstream, path.join(dir, 'moved'));
  const before = git(clone, 'rev-parse', 'HEAD');
  await assert.rejects(updates.update({ by: 'mia-dev' }), (err) => err.shown && /^Could not fetch origin\/main from file:\/\/.*: fatal: /.test(err.message));
  assert.equal(git(clone, 'rev-parse', 'HEAD'), before, 'the commits fetched before were not pulled');
  assert.equal((await updates.view()).job, null);
});

test('new code that cannot start fails the update before the build or the restart, and the clone goes back', async (t) => {
  const { clone } = repos(t);
  const { updates, spawned, exits, store } = setup(t, {
    clone, startCode: 1,
    startLines: ['file:///w/providers/console.mjs:1', 'throw new Error("boom");', '^', '', 'Error: boom', '    at file:///w/providers/console.mjs:1:7', '', 'Node.js v22.16.0'],
  });
  const before = git(clone, 'rev-parse', 'HEAD');
  await updates.update({ by: 'mia-dev' });
  const job = await settle(updates);
  assert.equal(job.state, 'failed');
  assert.deepEqual(job.steps.map((s) => [s.key, s.state]), [['pull', 'done'], ['starts', 'failed'], ['image', 'next'], ['restart', 'next']]);
  assert.equal(job.error, 'the new code cannot start (code 1): Error: boom');
  assert.equal(git(clone, 'rev-parse', 'HEAD'), before, 'back on the commit that worked');
  assert.equal(spawned.length, 0, 'no image built from code that cannot start');
  assert.equal(store.state.woodshedUpdate, undefined);
  await new Promise((r) => setTimeout(r, 1_100));
  assert.deepEqual(exits, []);
});

test('a console that says why it could not start is quoted by that line', async (t) => {
  const { clone } = repos(t);
  const { updates } = setup(t, { clone, startCode: 1, startLines: ["console: could not start { message: 'WOODSHED_CLOUD_NEW_THING is not set' }"] });
  await updates.update({ by: 'mia-dev' });
  assert.match((await settle(updates)).error, /cannot start \(code 1\): console: could not start \{ message: 'WOODSHED_CLOUD_NEW_THING is not set' \}$/);
});

test('a clone reached through a symlink still tells a session/ change from any other', async (t) => {
  const { clone, dir } = repos(t, [['console/a.mjs', 'feat: only the console']]);
  const link = path.join(dir, 'linked');
  fs.symlinkSync(clone, link);
  const { updates, spawned } = setup(t, { clone: link });
  await updates.update({ by: 'mia-dev' });
  const job = await settle(updates);
  assert.equal(job.state, 'restarting');
  assert.equal(job.steps[2].detail, 'unchanged');
  assert.equal(spawned.length, 0);

  const other = repos(t);
  const otherLink = path.join(other.dir, 'linked');
  fs.symlinkSync(other.clone, otherLink);
  const built = setup(t, { clone: otherLink });
  await built.updates.update({ by: 'mia-dev' });
  assert.equal((await settle(built.updates)).state, 'restarting');
  assert.equal(built.spawned.length, 1, 'session/ changed, so the image is built');
});

test('the page gets install.sh\'s lines without their terminal colours', async (t) => {
  const { clone } = repos(t);
  const { updates } = setup(t, { clone, lines: ['\x1b[1m==>\x1b[0m Built the session image woodshed-session:acme-app'] });
  await updates.update({ by: 'mia-dev' });
  assert.deepEqual((await settle(updates)).logTail.at(-1), '==> Built the session image woodshed-session:acme-app');
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

test('two Updates at once start one, and the other is refused before it fetches', async (t) => {
  const { clone } = repos(t);
  const { updates, spawned } = setup(t, { clone });
  const results = await Promise.allSettled([updates.update({ by: 'mia-dev' }), updates.update({ by: 'sam-ops' })]);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected']);
  assert.match(results[1].reason.message, /already running/);
  await settle(updates);
  assert.equal(spawned.length, 1, 'one build');
});

test('a failed update frees Update for another try', async (t) => {
  const { clone } = repos(t);
  const { updates } = setup(t, { clone, code: 1 });
  await updates.update({ by: 'mia-dev' });
  assert.equal((await settle(updates)).state, 'failed');
  await updates.update({ by: 'mia-dev' });
  assert.equal((await settle(updates)).state, 'failed', 'it ran again');
});
