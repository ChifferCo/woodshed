// A dump of your own, Postgres or Mongo, restored into your databases in two steps, from My settings:
//
//   POST /api/my/databases/restore?name=<file>   the dump as the body: kept on the console's disk, checked, then
//                                                restored into a copy, `<your database>__restore`, while the page asks
//   POST /api/my/databases/restore/apply         {"confirm": "apply"}  the copy becomes your database
//   POST /api/my/databases/restore/discard       the copy goes
//
// Between the two the copy is yours to check: the page lists its biggest tables, and for Postgres a running private
// session's database viewer opens it (its pgweb has a bookmark for it, session/entrypoint.sh). Nothing touches your
// database until Apply, and Apply keeps the old one until the copy has taken its place, so a failure at any step
// leaves you with one of the two.
//
// The console runs the restore programs itself, as the person's own database user, to the addresses the tunnel uses
// (dbTunnel.mjs): what it can do is what that user can do from their own computer (restoreRunners.mjs). The db-admin
// task gives that user its rights on the copy and the backup beside its database; it plays no other part. Only
// pg_dump's custom format and mongodump archives are taken: a plain .sql file would go through psql, which runs `\!`
// lines as shell commands in the console.
//
// state.json keeps each person's under `dbRestores`: { kind, status, fileName, bytes, startedAt, finishedAt, steps,
// progress, summary, error, apply }. `status` is `sending`, `restoring`, `ready`, `applying`, `applied` or `failed`;
// each step is { startedAt, finishedAt, detail, failed }. What each person last applied, by kind, is under
// `dbRestoresApplied`. A console restart ends a restore or an apply in progress, and the record says so.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

import { parseTarget } from './dbTunnel.mjs';
import { dumpKind, PG_MAJOR } from './restoreFormats.mjs';
import { migrationStem, mongoRunner, pgRunner } from './restoreRunners.mjs';
import logins from './public/logins.cjs';
const { loginKey } = logins;

export const MAX_DUMP_BYTES = 2 * 1024 * 1024 * 1024;
const BUSY = new Set(['sending', 'restoring', 'applying']);
const RESTORE_STEPS = ['send', 'check', 'copy', 'restore', 'count'];
// The restore's progress is saved at most this often: pg_restore prints a line for each of thousands of items.
const PROGRESS_SAVE_MS = 2_000;
const MIGRATIONS_FRESH_MS = 10 * 60_000;

function shown(message, status = 409) {
  return Object.assign(new Error(message), { shown: true, status });
}

/**
 * The copy a dump is restored into, and the backup Apply keeps, beside the person's database. A login never makes a
 * name with `__` (a GitHub login has no `--`), so no person's database is another's copy (session/dbAdmin.mjs,
 * restoreNames, which gives the user its rights on both).
 */
export function restoreNames(name) {
  return { copy: `${name}__restore`, previous: `${name}__previous` };
}

/** @returns {Promise<Buffer|null>}  the first bytes inside a gzip file, or null when they cannot be read */
async function gunzippedHead(file) {
  const head = [];
  let size = 0;
  try {
    await pipeline(fs.createReadStream(file, { start: 0, end: 64 * 1024 }), createGunzip(), new Transform({
      transform(chunk, _enc, done) {
        head.push(chunk);
        size += chunk.length;
        done(size >= 64 ? new Error('enough') : null);
      },
    }));
  } catch {
    // Stopping early, or a file cut short within 64 KB, both leave what was read.
  }
  return size ? Buffer.concat(head) : null;
}

async function fileHead(file) {
  const handle = await fsp.open(file, 'r');
  try {
    const head = Buffer.alloc(64);
    const { bytesRead } = await handle.read(head, 0, 64, 0);
    return head.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

// A migrations folder may also hold its notes and dotfiles, which are no migration.
function isMigrationFile(name) {
  return !name.startsWith('.') && !/\.(md|txt)$/i.test(name);
}

const NO_DUMP = Object.freeze({ skip: [], extensions: [] });

/**
 * @param {{store: {state: object, save: () => void}, dir: string,
 *          databases: ReturnType<import('./databases.mjs').createDatabases>|null,
 *          targets: {pg: string|null, mongo: string|null}, runners?: {pg?: Function, mongo?: Function},
 *          defaultBranchMigrations?: (() => Promise<string[]>)|null, projectDatabases?: (() => Promise<object[]|null>)|null,
 *          now?: () => number}} deps
 *   `dir` is the console's state folder's restores/; `targets` are the tunnel's `host:port`s as the console reaches
 *   them. Without own databases, or an address, there is no restore of that kind. `runners` stand in for
 *   restoreRunners.mjs in tests. `defaultBranchMigrations` lists the migration files on the default branch, so the page can
 *   say how many a Postgres dump lacks; without it, the page says only to migrate. `projectDatabases` are the project
 *   file's `databases` on the default branch (null when it could not be read): each one's `migrate`, `migrationsTable`
 *   and `dump`
 */
export function createDbRestore({ store, dir, databases, targets, runners = {}, defaultBranchMigrations = null, projectDatabases = null, now = Date.now }) {
  const addresses = { postgres: parseTarget(targets?.pg), mongo: parseTarget(targets?.mongo) };
  const kinds = { postgres: Boolean(databases?.available && addresses.postgres), mongo: Boolean(databases?.available && addresses.mongo) };
  const available = kinds.postgres || kinds.mongo;
  const makeRunner = { postgres: runners.pg ?? pgRunner, mongo: runners.mongo ?? mongoRunner };
  const nowIso = () => new Date(now()).toISOString();
  const fileFor = (login) => path.join(dir, `${loginKey(login)}.dump`);
  // Logins whose dump is still arriving: a second upload would write the same file.
  const receiving = new Set();
  let defaultBranchCache = null;
  // The project file's databases as last read: the page is drawn from them without waiting on GitHub.
  let projectKnown = [];

  /** @returns {Promise<object[]>}  the project's databases, read again (the reader keeps them a while) */
  async function refreshProject() {
    const read = projectDatabases ? await projectDatabases() : null;
    if (read) projectKnown = read;
    return projectKnown;
  }

  const projectDatabase = (kind, dbs = projectKnown) => dbs.find((d) => d.engine === kind) ?? null;

  // The default branch's migration files, read at most every 10 minutes: every restore asks.
  async function defaultBranchNames() {
    if (defaultBranchCache && now() - defaultBranchCache.at < MIGRATIONS_FRESH_MS) return defaultBranchCache.names;
    const names = await defaultBranchMigrations();
    defaultBranchCache = { at: now(), names };
    return names;
  }

  /** @returns {Promise<number|null>}  the default branch's migrations the copy has not run, or null when it cannot be told */
  async function lackingMigrations(login, runner) {
    if (!defaultBranchMigrations || !runner.migrationNames) return null;
    try {
      const [listed, ran] = await Promise.all([defaultBranchNames(), runner.migrationNames()]);
      if (!ran || !listed.length) return null;
      const done = new Set(ran.map(migrationStem));
      return listed.filter((name) => isMigrationFile(name) && !done.has(migrationStem(name))).length;
    } catch (err) {
      console.warn('dbRestore: the default branch\'s migrations not read', { login, message: String(err?.message ?? err).split('\n')[0].slice(0, 200) });
      return null;
    }
  }

  function all(key = 'dbRestores') {
    store.state[key] ??= {};
    return store.state[key];
  }

  function record(login) {
    return all()[loginKey(login)] ?? null;
  }

  function set(login, fields) {
    const key = loginKey(login);
    all()[key] = { ...all()[key], ...fields };
    store.save();
  }

  function step(login, name, fields) {
    const r = record(login);
    set(login, { steps: { ...r.steps, [name]: { ...r.steps?.[name], ...fields } } });
  }

  function applyStep(login, name, fields) {
    const r = record(login);
    set(login, { apply: { ...r.apply, steps: { ...r.apply?.steps, [name]: { ...r.apply?.steps?.[name], ...fields } } } });
  }

  // A step's state for the page: done, now, next or failed, with how long it took or has been running.
  function stepView(entry, busy) {
    const seconds = entry?.startedAt ? Math.round(((entry.finishedAt ? Date.parse(entry.finishedAt) : now()) - Date.parse(entry.startedAt)) / 1000) : null;
    const state = entry?.failed ? 'failed' : entry?.finishedAt ? 'done' : entry?.startedAt && busy ? 'now' : 'next';
    return { state, seconds: state === 'next' ? null : seconds, detail: entry?.detail ?? null };
  }

  /** @returns {object}  what My settings shows */
  function view(login) {
    // Drawn from the last read; a newer one shows at the page's next ask. The reader answers null rather than throw.
    refreshProject().catch((err) => console.warn('dbRestore: project databases not read', { message: String(err?.message ?? err).split('\n')[0] }));
    const r = record(login);
    const live = databases?.view(login).name ?? null;
    const busy = BUSY.has(r?.status);
    const names = live ? restoreNames(live) : { copy: null, previous: null };
    return {
      available, kinds, status: r?.status ?? 'none', kind: r?.kind ?? null, live, copy: names.copy,
      fileName: r?.fileName ?? null, bytes: r?.bytes ?? null, startedAt: r?.startedAt ?? null, finishedAt: r?.finishedAt ?? null,
      steps: RESTORE_STEPS.map((key) => ({ key, ...stepView(r?.steps?.[key], busy && r?.status !== 'applying') })),
      progress: r?.progress ?? null, summary: r?.summary ?? null, error: r?.error ?? null,
      apply: r?.apply ? {
        startedAt: r.apply.startedAt, finishedAt: r.apply.finishedAt ?? null, error: r.apply.error ?? null,
        steps: (r.apply.order ?? []).map((key) => ({ key, ...stepView(r.apply.steps?.[key], r.status === 'applying') })),
      } : null,
      lastApplied: all('dbRestoresApplied')[loginKey(login)] ?? {},
      maxBytes: MAX_DUMP_BYTES, pgMajor: PG_MAJOR,
      // What the dump commands leave out, and the command that migrates a restored copy: the project file's.
      dump: { postgres: projectDatabase('postgres')?.dump ?? NO_DUMP, mongo: projectDatabase('mongo')?.dump ?? NO_DUMP },
      migrate: projectDatabase('postgres')?.migrate ?? null,
    };
  }

  /** @returns {boolean}  a restore or an apply is running: Reset and Remove wait for it */
  function busy(login) {
    return receiving.has(loginKey(login)) || BUSY.has(record(login)?.status);
  }

  async function runnerFor(login, kind) {
    const creds = await databases.credentials(login);
    if (!creds) throw shown('your databases are not ready yet');
    const { copy, previous } = restoreNames(creds.name);
    const table = kind === 'postgres' ? projectDatabase(kind, await refreshProject())?.migrationsTable ?? null : null;
    if (kind === 'postgres' && !table) console.log('dbRestore: no migrations table, the dump\'s migrations are not read', { login });
    return makeRunner[kind]({ address: addresses[kind], creds, live: creds.name, copy, previous, dir, migrationsTable: table });
  }

  async function saveUpload(req, file) {
    let bytes = 0;
    const cap = new Transform({
      transform(chunk, _enc, done) {
        bytes += chunk.length;
        if (bytes > MAX_DUMP_BYTES) return done(shown(`over ${MAX_DUMP_BYTES / 1024 ** 3} GB`, 413));
        return done(null, chunk);
      },
    });
    await fsp.mkdir(dir, { recursive: true });
    await fsp.rm(file, { force: true });
    try {
      await pipeline(req, cap, fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }));
    } catch (err) {
      await fsp.rm(file, { force: true });
      throw err;
    }
    return bytes;
  }

  // A restore that stopped keeps its progress, so the page can say how far it got.
  function fail(login, name, message) {
    step(login, name, { finishedAt: nowIso(), failed: true });
    set(login, { status: 'failed', finishedAt: nowIso(), error: message, ...(name === 'restore' ? {} : { progress: null }) });
  }

  // The copy, the restore and the count, after the upload and the check: the page asks how it goes.
  async function restoreInBackground(login, file, { kind, gzip }) {
    const started = now();
    let current = 'copy';
    let runner = null;
    try {
      runner = await runnerFor(login, kind);
      step(login, 'copy', { startedAt: nowIso() });
      await runner.makeCopy();
      step(login, 'copy', { finishedAt: nowIso() });
      current = 'restore';
      step(login, 'restore', { startedAt: nowIso() });
      console.log('dbRestore: restore started', { login, kind, bytes: record(login)?.bytes });
      let savedAt = 0;
      const total = record(login).progress?.total ?? null;
      const result = await runner.restore(file, {
        gzip,
        onProgress: (progress) => {
          const r = record(login);
          r.progress = { total, ...progress };
          if (now() - savedAt < PROGRESS_SAVE_MS) return;
          savedAt = now();
          store.save();
        },
      });
      await fsp.rm(file, { force: true });
      step(login, 'restore', { finishedAt: nowIso(), detail: result.done });
      current = 'count';
      step(login, 'count', { startedAt: nowIso() });
      const summary = { ...(await runner.summarize()), lacking: await lackingMigrations(login, runner) };
      step(login, 'count', { finishedAt: nowIso() });
      set(login, { status: 'ready', finishedAt: nowIso(), error: null, summary, progress: null });
      console.log('dbRestore: restored into the copy', { login, kind, seconds: Math.round((now() - started) / 1000), tables: summary.tables });
    } catch (err) {
      // Half a copy is no use to check, and Discard only drops a finished one.
      if (runner) await runner.dropCopy().catch(() => {});
      fail(login, err.step ?? current, err.message);
      console.warn('dbRestore: restore failed', { login, kind, step: err.step ?? current, seconds: Math.round((now() - started) / 1000) });
      await fsp.rm(file, { force: true });
    }
  }

  /**
   * The dump in the request body, saved and checked, then restored into the copy without waiting.
   * @returns {Promise<object>}  the view, `restoring`, or `failed` at the check
   */
  async function upload(req, { login, name }) {
    if (!available) throw shown('this console cannot restore a dump: it has no databases of your own, or no address for them', 404);
    if (databases.view(login).status !== 'ready') throw shown('your databases are not ready yet');
    if (busy(login)) throw shown('a restore is already running: wait for it to finish');
    const file = fileFor(login);
    const key = loginKey(login);
    receiving.add(key);
    all()[key] = {
      kind: null, status: 'sending', fileName: String(name || 'dump').slice(0, 200), bytes: null, startedAt: nowIso(), finishedAt: null,
      steps: { send: { startedAt: nowIso() } }, progress: null, summary: null, error: null, apply: null,
    };
    store.save();
    let bytes;
    try {
      bytes = await saveUpload(req, file);
    } catch (err) {
      fail(login, 'send', err.shown ? err.message : 'the upload was cut off before the whole dump arrived');
      console.log('dbRestore: upload not finished', { login, why: err.shown ? 'too big' : 'cut off' });
      throw err.shown ? err : shown('the upload was cut off before the whole dump arrived', 400);
    } finally {
      receiving.delete(key);
    }
    set(login, { bytes });
    step(login, 'send', { finishedAt: nowIso(), detail: bytes });
    step(login, 'check', { startedAt: nowIso() });
    const head = await fileHead(file);
    const found = bytes ? dumpKind(head, head[0] === 0x1f ? await gunzippedHead(file) : null) : { problem: 'The file is empty.', detail: 'empty' };
    const problem = found.problem ?? (kinds[found.kind] ? null : `This console has no address for your ${found.kind === 'mongo' ? 'Mongo' : 'Postgres'} database, so it cannot restore this dump.`);
    if (problem) {
      await fsp.rm(file, { force: true });
      step(login, 'check', { detail: found.detail ?? found.kind });
      fail(login, 'check', problem);
      console.log('dbRestore: dump refused', { login, bytes, detail: found.detail ?? 'no address' });
      return view(login);
    }
    let items = null;
    try {
      items = await (await runnerFor(login, found.kind)).items(file);
    } catch (err) {
      await fsp.rm(file, { force: true });
      fail(login, 'check', err.message);
      console.log('dbRestore: dump refused', { login, bytes, detail: 'unreadable' });
      return view(login);
    }
    set(login, { kind: found.kind, status: 'restoring', progress: items ? { done: 0, total: items, current: null } : null });
    step(login, 'check', { finishedAt: nowIso(), detail: items });
    void restoreInBackground(login, file, found);
    return view(login);
  }

  /**
   * The copy takes the database's place, one step at a time so the page can show each, without waiting: the page
   * asks how it goes. Postgres renames, keeping the old database until the copy has its name; Mongo, which cannot
   * rename, copies, keeping a backup until the end.
   * @returns {Promise<object>}  the view, `applying`
   */
  async function apply(login) {
    const r = record(login);
    if (!kinds[r?.kind]) throw shown('this console cannot restore a dump', 404);
    if (r?.status !== 'ready') throw shown('there is no restored copy to apply: restore a dump first');
    if (databases.view(login).status !== 'ready') throw shown('your databases are busy with another change: wait for it to finish');
    const runner = await runnerFor(login, r.kind);
    set(login, { status: 'applying', apply: { startedAt: nowIso(), order: runner.applySteps, steps: {} } });
    void applyInBackground(login, runner, r);
    return view(login);
  }

  // Each step in turn, saved as it goes for the page to show. A failure leaves the copy to try again or discard.
  async function applyInBackground(login, runner, r) {
    let current = runner.applySteps[0];
    try {
      for (const name of runner.applySteps) {
        current = name;
        applyStep(login, name, { startedAt: nowIso() });
        const result = await runner.apply[name]();
        applyStep(login, name, { finishedAt: nowIso(), detail: result.closed ?? null });
        if (result.putBack) console.warn('dbRestore: the database was found under its old name, and put back first', { login, kind: r.kind });
        if (result.left) console.warn('dbRestore: the old database was left behind, Reset my data drops it', { login });
      }
    } catch (err) {
      applyStep(login, current, { finishedAt: nowIso(), failed: true });
      set(login, { status: 'ready', apply: { ...record(login).apply, error: err.message, finishedAt: nowIso() } });
      console.warn('dbRestore: apply failed', { login, kind: r.kind, step: current });
      return;
    }
    // What was applied is what the copy held, which the page already showed.
    all('dbRestoresApplied')[loginKey(login)] = { ...all('dbRestoresApplied')[loginKey(login)], [r.kind]: { fileName: r.fileName, at: nowIso() } };
    set(login, { status: 'applied', finishedAt: nowIso(), apply: { ...record(login).apply, finishedAt: nowIso() } });
    console.log('dbRestore: applied', { login, kind: r.kind });
  }

  /** The copy goes, or a failed or finished restore's record. */
  async function discard(login) {
    if (!available) throw shown('this console cannot restore a dump', 404);
    if (busy(login)) throw shown('a restore is still running: wait for it to finish');
    const r = record(login);
    if (r?.status === 'ready') {
      await (await runnerFor(login, r.kind)).dropCopy().catch((err) => {
        console.warn('dbRestore: discard failed', { login, kind: r.kind });
        throw shown(`could not drop the copy: ${err.message}`, 502);
      });
    }
    delete all()[loginKey(login)];
    store.save();
    console.log('dbRestore: discarded', { login, kind: r?.kind ?? null });
    return view(login);
  }

  /** Reset my data and Remove My Woodshed drop the copies with every other database the user has. */
  function forget(login) {
    if (!record(login)) return;
    delete all()[loginKey(login)];
    store.save();
    console.log('dbRestore: record dropped with the databases', { login });
  }

  /** At start: a restore or an apply that was running died with the console that ran it. */
  async function recover() {
    let ended = 0;
    for (const [key, r] of Object.entries(all())) {
      if (!BUSY.has(r.status)) continue;
      const running = RESTORE_STEPS.find((s) => r.steps?.[s]?.startedAt && !r.steps[s].finishedAt) ?? 'send';
      const error = r.status === 'applying'
        ? 'The console restarted during Apply. If your sessions find no database, the next Apply puts it back first; restore the dump again.'
        : 'The console restarted during the restore. Your database was not touched: restore the dump again.';
      all()[key] = { ...r, status: 'failed', finishedAt: nowIso(), progress: null, error, steps: { ...r.steps, [running]: { ...r.steps?.[running], failed: true, finishedAt: nowIso() } } };
      ended++;
    }
    if (ended) store.save();
    // Not awaited: a slow GitHub must not hold the console's start, and each view and restore reads it again.
    refreshProject().catch((err) => console.warn('dbRestore: project databases not read', { message: String(err?.message ?? err).split('\n')[0] }));
    await fsp.rm(dir, { recursive: true, force: true });
    console.log('dbRestore: ready', { kinds, ended });
  }

  return { available, view, busy, upload, apply, discard, forget, recover };
}
