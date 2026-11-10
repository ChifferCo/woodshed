import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';

import { createDbRestore, restoreNames } from './dbRestore.mjs';

const PG_16 = Buffer.concat([Buffer.from('PGDMP'), Buffer.from([1, 15, 0]), Buffer.from('rest of the archive')]);
const PG_17 = Buffer.concat([Buffer.from('PGDMP'), Buffer.from([1, 16, 0]), Buffer.from('rest')]);
const MONGO = Buffer.concat([Buffer.from([0x6d, 0xe2, 0x99, 0x81]), Buffer.alloc(200, 1)]);
const SUMMARY = { tables: 2, rows: 30, top: [{ name: 'accounts', rows: 20 }, { name: 'deals', rows: 10 }], newest: '20261028_add_bill_tags' };

// A runner as restoreRunners.mjs makes one, recording what it was asked. `fail` names a step that throws; `hold`
// keeps the count waiting, so a test can look at the page's view in the middle of a restore.
function fakeRunner(kind, calls, { fail = null, hold = null } = {}) {
  return (opts) => {
    calls.push({ make: kind, live: opts.live, copy: opts.copy, previous: opts.previous, user: opts.creds.user });
    const step = (name, result = {}) => async () => {
      calls.push({ [kind]: name });
      if (fail === name) throw Object.assign(new Error(`${name} went wrong`), { step: name });
      return result;
    };
    const applySteps = kind === 'postgres' ? ['close', 'aside', 'name', 'drop'] : ['backup', 'replace', 'cleanup'];
    return {
      kind, items: step('items', kind === 'postgres' ? 1030 : null), makeCopy: step('makeCopy'), dropCopy: step('dropCopy'),
      summarize: async () => {
        calls.push({ [kind]: 'summarize' });
        if (hold) await hold;
        return SUMMARY;
      },
      restore: async (file, { gzip, onProgress }) => {
        calls.push({ [kind]: 'restore', gzip });
        onProgress({ done: 412, current: 'transactions', ...(kind === 'mongo' ? { total: 42 } : {}) });
        if (fail === 'restore') throw Object.assign(new Error('pg_restore: error: extension "postgis" is not available'), { step: 'restore' });
        return { done: 1030 };
      },
      apply: Object.fromEntries(applySteps.map((s) => [s, step(s, s === 'close' ? { closed: 2 } : {})])),
      applySteps,
      ...(kind === 'postgres' ? { migrationNames: async () => ['001_orgs.ts', '002_users.js'] } : {}),
    };
  };
}

function fakes({ fail = null, hold = null, targets = { pg: 'rds.example:5432', mongo: '10.0.0.10:27017' }, defaultBranchMigrations = null, projectDatabases = null } = {}) {
  const store = { state: {}, save() {} };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-restore-test-'));
  const databases = {
    available: true,
    status: 'ready',
    view() { return { status: this.status, name: 'woodshed_joel' }; },
    async credentials() { return this.status === 'ready' ? { user: 'woodshed_joel', password: 'ab12', name: 'woodshed_joel' } : null; },
  };
  const calls = [];
  const made = [];
  const keep = (make) => (opts) => { made.push(opts); return make(opts); };
  const runners = { pg: keep(fakeRunner('postgres', calls, { fail, hold })), mongo: keep(fakeRunner('mongo', calls, { fail, hold })) };
  const restore = createDbRestore({ store, dir, databases, targets, runners, defaultBranchMigrations, projectDatabases });
  return { store, dir, databases, calls, restore, made };
}

const until = async (check) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
};
const states = (view) => Object.fromEntries(view.steps.map((s) => [s.key, s.state]));
const ready = (fileName, kind = 'postgres') => ({ kind, status: 'ready', fileName, steps: {}, summary: SUMMARY });

test('the copy and the backup have names no person\'s database can have', () => {
  assert.deepEqual(restoreNames('woodshed_joel'), { copy: 'woodshed_joel__restore', previous: 'woodshed_joel__previous' },
    'login joel-restore is woodshed_joel_restore: one underscore, never two');
});

test('a Postgres dump is sent, checked, copied, restored and counted, and the database is not touched', async () => {
  const { restore, calls, dir } = fakes();
  const sent = await restore.upload(Readable.from([PG_16]), { login: 'Joel', name: 'staging.dump' });
  assert.equal(sent.kind, 'postgres');
  assert.equal(sent.status, 'restoring');
  assert.equal(sent.steps.find((s) => s.key === 'check').detail, 1030, 'the check counts the archive\'s items for the bar');
  await until(() => restore.view('joel').status !== 'restoring');
  const view = restore.view('joel');
  assert.equal(view.status, 'ready');
  assert.deepEqual(states(view), { send: 'done', check: 'done', copy: 'done', restore: 'done', count: 'done' });
  assert.deepEqual(view.summary, { ...SUMMARY, lacking: null }, 'no list of the default branch\'s migrations, so nothing to compare');
  assert.equal(view.copy, 'woodshed_joel__restore');
  assert.deepEqual([calls[0].copy, calls[0].previous], ['woodshed_joel__restore', 'woodshed_joel__previous']);
  assert.ok(!calls.some((c) => ['close', 'aside', 'name', 'drop'].includes(c.postgres)), 'nothing touches the database before Apply');
  assert.deepEqual(fs.readdirSync(dir), [], 'the upload is deleted once restored');
});

test('in the middle of a restore the page sees the items done of the archive\'s, and the table it is on', async () => {
  let release;
  const { restore } = fakes({ hold: new Promise((r) => { release = r; }) });
  await restore.upload(Readable.from([PG_16]), { login: 'joel', name: 'staging.dump' });
  await until(() => restore.view('joel').steps.find((s) => s.key === 'count').state === 'now');
  const mid = restore.view('joel');
  assert.deepEqual(mid.progress, { total: 1030, done: 412, current: 'transactions' });
  assert.deepEqual(states(mid), { send: 'done', check: 'done', copy: 'done', restore: 'done', count: 'now' });
  release();
  await until(() => restore.view('joel').status === 'ready');
  assert.equal(restore.view('joel').progress, null);
});

test('a mongodump archive, gzipped, goes to the Mongo runner with gzip on, and counts collections as it goes', async () => {
  let release;
  const { restore, calls } = fakes({ hold: new Promise((r) => { release = r; }) });
  const sent = await restore.upload(Readable.from([gzipSync(MONGO)]), { login: 'joel', name: 'mongo.gz' });
  assert.equal(sent.kind, 'mongo');
  await until(() => restore.view('joel').steps.find((s) => s.key === 'count').state === 'now');
  assert.deepEqual(restore.view('joel').progress, { total: 42, done: 412, current: 'transactions' }, 'mongorestore says the total as it reads the archive');
  release();
  await until(() => restore.view('joel').status === 'ready');
  assert.equal(calls.find((c) => c.mongo === 'restore').gzip, true);
});

test('a dump the check refuses fails at the check, with the step\'s short line, and nothing runs', async () => {
  const { restore, calls, dir } = fakes();
  const view = await restore.upload(Readable.from([PG_17]), { login: 'joel', name: 'prod.dump' });
  assert.equal(view.status, 'failed');
  assert.deepEqual(states(view), { send: 'done', check: 'failed', copy: 'next', restore: 'next', count: 'next' });
  assert.equal(view.steps.find((s) => s.key === 'check').detail, 'made by pg_dump 17 or newer');
  assert.match(view.error, /pg_dump 17 or newer/);
  assert.equal(calls.length, 0);
  assert.deepEqual(fs.readdirSync(dir), []);
  const sql = await restore.upload(Readable.from([Buffer.from('-- PostgreSQL database dump\n\\! rm -rf /\n')]), { login: 'joel', name: 'x.sql' });
  assert.equal(sql.steps.find((s) => s.key === 'check').detail, 'plain SQL');
});

test('a Mongo dump is refused at the check on a console with no address for Mongo', async () => {
  const { restore, calls } = fakes({ targets: { pg: 'rds.example:5432', mongo: null } });
  const view = await restore.upload(Readable.from([MONGO]), { login: 'joel', name: 'mongo.archive' });
  assert.equal(view.status, 'failed');
  assert.match(view.error, /no address for your Mongo database/);
  assert.equal(calls.length, 0);
});

test('a restore that fails drops the half-made copy, and marks the step it failed at', async () => {
  const { restore, calls } = fakes({ fail: 'restore' });
  await restore.upload(Readable.from([PG_16]), { login: 'joel', name: 'staging.dump' });
  await until(() => restore.view('joel').status !== 'restoring');
  const view = restore.view('joel');
  assert.equal(view.status, 'failed');
  assert.deepEqual(states(view), { send: 'done', check: 'done', copy: 'done', restore: 'failed', count: 'next' });
  assert.match(view.error, /postgis/);
  assert.ok(calls.some((c) => c.postgres === 'dropCopy'));
});

test('no restore while the databases are not ready, nor two at once', async () => {
  const { restore, databases } = fakes();
  databases.status = 'working';
  await assert.rejects(restore.upload(Readable.from([PG_16]), { login: 'joel' }), /not ready/);
  databases.status = 'ready';
  const slow = new Readable({ read() {} });
  slow.push(PG_16);
  const first = restore.upload(slow, { login: 'joel', name: 'a.dump' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(restore.view('joel').status, 'sending');
  assert.equal(restore.busy('joel'), true);
  await assert.rejects(restore.upload(Readable.from([PG_16]), { login: 'joel' }), /already running/);
  slow.push(null);
  assert.equal((await first).status, 'restoring');
});

test('an upload cut off fails at Send the dump', async () => {
  const { restore } = fakes();
  const broken = new Readable({ read() {} });
  const sent = restore.upload(broken, { login: 'joel', name: 'a.dump' });
  broken.push(PG_16);
  // Mid-upload, as a browser closed while sending: the request ends with an error.
  await new Promise((r) => setTimeout(r, 10));
  broken.destroy(new Error('aborted'));
  await assert.rejects(sent, /cut off/);
  assert.equal(states(restore.view('joel')).send, 'failed');
});

test('apply runs each step in order, then the restore is applied and what was applied is kept', async () => {
  const { restore, store, calls } = fakes();
  store.state.dbRestores = { joel: ready('staging.dump') };
  assert.equal((await restore.apply('joel')).status, 'applying', 'Apply answers at once, and the page asks how it goes');
  await until(() => restore.view('joel').status !== 'applying');
  const view = restore.view('joel');
  assert.equal(view.status, 'applied');
  assert.deepEqual(calls.filter((c) => c.postgres).map((c) => c.postgres), ['close', 'aside', 'name', 'drop']);
  assert.deepEqual(view.apply.steps.map((s) => [s.key, s.state]), [['close', 'done'], ['aside', 'done'], ['name', 'done'], ['drop', 'done']]);
  assert.equal(view.apply.steps[0].detail, 2, 'how many session connections were closed');
  assert.equal(view.lastApplied.postgres.fileName, 'staging.dump');
});

test('a failed apply keeps the copy to try again or discard, and marks the step', async () => {
  const { restore, store } = fakes({ fail: 'name' });
  store.state.dbRestores = { joel: ready('staging.dump') };
  await restore.apply('joel');
  await until(() => restore.view('joel').status !== 'applying');
  const view = restore.view('joel');
  assert.equal(view.status, 'ready');
  assert.match(view.apply.error, /name went wrong/);
  assert.deepEqual(view.apply.steps.map((s) => s.state), ['done', 'done', 'failed', 'next']);
});

test('Mongo applies with its own steps: backup, replace, cleanup', async () => {
  const { restore, store, calls } = fakes();
  store.state.dbRestores = { joel: ready('m.gz', 'mongo') };
  await restore.apply('joel');
  await until(() => restore.view('joel').status !== 'applying');
  assert.deepEqual(calls.filter((c) => c.mongo).map((c) => c.mongo), ['backup', 'replace', 'cleanup']);
});

test('apply and discard need a copy; discard drops it and keeps what was applied before', async () => {
  const { restore, store, calls } = fakes();
  await assert.rejects(restore.apply('joel'), /cannot restore|no restored copy/);
  store.state.dbRestores = { joel: ready('staging.dump') };
  store.state.dbRestoresApplied = { joel: { mongo: { fileName: 'm.gz', at: '2026-11-04T10:00:00Z' } } };
  const view = await restore.discard('joel');
  assert.ok(calls.some((c) => c.postgres === 'dropCopy'));
  assert.equal(view.status, 'none');
  assert.equal(view.lastApplied.mongo.fileName, 'm.gz');
});

test('a console restart ends a restore or an apply in progress, and marks the step that was running', async () => {
  const { restore, store } = fakes();
  const at = '2026-11-06T10:00:00Z';
  const done = { startedAt: at, finishedAt: at };
  store.state.dbRestores = {
    joel: { kind: 'postgres', status: 'restoring', steps: { send: done, check: done, copy: done, restore: { startedAt: at } } },
    ana: { kind: 'postgres', status: 'applying', steps: {} },
    kim: ready('k.dump'),
  };
  await restore.recover();
  assert.equal(states(restore.view('joel')).restore, 'failed');
  assert.match(restore.view('joel').error, /during the restore/);
  assert.match(restore.view('ana').error, /during Apply/);
  assert.equal(restore.view('kim').status, 'ready');
});

test('each kind is available only with own databases and its address', () => {
  const store = { state: {}, save() {} };
  const make = (databases, targets) => createDbRestore({ store, dir: os.tmpdir(), databases, targets });
  assert.deepEqual(make({ available: true, view: () => ({ name: 'woodshed_joel' }) }, { pg: 'h:5432', mongo: null }).view('joel').kinds, { postgres: true, mongo: false });
  assert.equal(make({ available: true }, { pg: null, mongo: null }).available, false);
  assert.equal(make({ available: false }, { pg: 'h:5432', mongo: 'h:27017' }).available, false);
});

const PROJECT_DBS = [
  { engine: 'postgres', migrate: 'make db-migrate', migrationsTable: { table: 'schema_versions', column: 'version' }, dump: { skip: ['audit_log'], extensions: ['postgis'] } },
  { engine: 'mongo', migrate: null, migrationsTable: null, dump: { skip: ['cache'], extensions: [] } },
];

test('a Postgres runner is given the project\'s migrations table, and none without one', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { restore, made } = fakes({ projectDatabases: async () => PROJECT_DBS });
  await restore.upload(Readable.from([PG_16]), { login: 'joel', name: 'staging.dump' });
  await until(() => restore.view('joel').status === 'ready');
  assert.ok(made.length && made.every((opts) => opts.migrationsTable === PROJECT_DBS[0].migrationsTable));
  const without = fakes();
  await without.restore.upload(Readable.from([PG_16]), { login: 'joel', name: 'staging.dump' });
  await until(() => without.restore.view('joel').status === 'ready');
  assert.ok(without.made.length && without.made.every((opts) => opts.migrationsTable === null), 'none configured, none assumed');
});

test('the page gets the project\'s dump settings and migrate command, and none without a project file', async () => {
  let answer = null;
  const { restore } = fakes({ projectDatabases: () => new Promise((resolve) => { answer = resolve; }) });
  await restore.recover();
  assert.equal(restore.view('joel').migrate, null, 'the start does not wait on GitHub');
  answer(PROJECT_DBS);
  await until(() => restore.view('joel').migrate !== null);
  const view = restore.view('joel');
  assert.deepEqual([view.dump, view.migrate], [{ postgres: PROJECT_DBS[0].dump, mongo: PROJECT_DBS[1].dump }, 'make db-migrate']);
  const unread = fakes({ projectDatabases: async () => null });
  await unread.restore.recover();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([unread.restore.view('joel').dump.postgres, unread.restore.view('joel').migrate], [{ skip: [], extensions: [] }, null]);
});

test('the page is told how many of the default branch\'s migrations a Postgres dump lacks, and nothing when GitHub does not answer', async () => {
  const listed = async () => ['001_orgs.ts', '002_users.ts', '003_bills.ts', '004_tags.ts', 'README.md'];
  const { restore } = fakes({ defaultBranchMigrations: listed });
  await restore.upload(Readable.from([PG_16]), { login: 'joel', name: 'staging.dump' });
  await until(() => restore.view('joel').status === 'ready');
  assert.equal(restore.view('joel').summary.lacking, 2, 'knex keeps .js for a .ts file it ran compiled; README.md is no migration');
  const failing = fakes({ defaultBranchMigrations: async () => { throw new Error('HTTP 502'); } });
  await failing.restore.upload(Readable.from([PG_16]), { login: 'joel', name: 'staging.dump' });
  await until(() => failing.restore.view('joel').status === 'ready');
  assert.equal(failing.restore.view('joel').summary.lacking, null, 'the restore is ready all the same');
});
