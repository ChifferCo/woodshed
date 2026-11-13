// Every session's databases: one on each engine the installation hosts (`engines`, shared/databases/), each a copy of
// the template that the db-admin task (session/dbAdmin.mjs) migrates and seeds from the default branch, with a user of their own,
// the same name and password on each engine, that reaches nothing else.
//   - A person's, woodshed_<login>, are theirs to keep across their private sessions, until Reset or Remove.
//   - A shared session's, woodshed__<session id>, are made as it first starts and kept while it is resumable; the
//     fleet's sweep says which to keep, and the rest are dropped.
// The db-admin task makes, resets and drops them; it alone reads the root passwords, and the console only ever
// picks its command. The console makes each password, in `users/<login>/database` or `sessions/<id>/database`, and
// hands it to the session it is for (sessionApi.mjs).
//
// state.json keeps where each is, people's under `databases` and sessions' under `sessionDatabases`:
// { status, action, taskArn, startedAt, finishedAt, error }, with status `working` while a task runs, then `ready`
// or `failed`. A console restart picks up a running task where it was. The provider runs the tasks (`dbAdmin`, on AWS
// providers/aws/dbAdminRunner.mjs); `taskArn` is the id it gave the run, named for the ECS task it was first.

import crypto from 'node:crypto';

import { engine } from '../shared/databases/index.mjs';
import { userSecretName } from './userSettings.mjs';
import logins from './public/logins.cjs';
const { loginKey } = logins;

const DATABASE = 'database';
// A session waits on its copy, which takes seconds: a poll that finds no task running asks the provider nothing.
const POLL_MS = 3_000;
// A copy takes seconds, a cold image pull a minute or two; past this the task is stopped and called failed.
const TASK_TIMEOUT_MS = 30 * 60_000;
// A drop that failed is tried again by the next sweep after this, rather than on every tick.
const DROP_RETRY_MS = 10 * 60_000;

/** @returns {string}  the name of a person's databases and of their user on every engine, as dbAdmin.mjs makes them */
export function databaseName(login) {
  return `woodshed_${loginKey(login).replace(/-/g, '_')}`;
}

/** @returns {string}  the name of a shared session's databases and of their user, as dbAdmin.mjs makes them */
export function sessionDatabaseName(id) {
  return `woodshed__${id}`;
}

function sessionSecretName(id) {
  return `sessions/${id}/database`;
}

function newPassword() {
  return crypto.randomBytes(24).toString('hex');
}

/**
 * @param {{store: {state: object, save: () => void}, secrets: {read: Function, save: Function, remove: Function}|null,
 *          dbAdmin: {start: (command: string[]) => Promise<string>, stop: (id: string) => Promise<void>,
 *            outcomes: (ids: string[]) => Promise<Array<{done: boolean, ok?: boolean, reason?: string|null}>>}|null,
 *          engines?: string[], now?: () => number}} deps  without `dbAdmin` there are no databases of the
 *   console's making: sessions use the ones their environment names. `engines` are the ones its db-admin makes, the
 *   provider's `databases`
 */
export function createDatabases({ store, secrets, dbAdmin, engines: given = [], now = Date.now }) {
  const available = Boolean(secrets && dbAdmin);
  const engines = available ? [...given] : [];
  const nowIso = () => new Date(now()).toISOString();
  const KINDS = {
    people: { stateKey: 'databases', secret: (login) => userSecretName(login, DATABASE) },
    sessions: { stateKey: 'sessionDatabases', secret: sessionSecretName },
  };

  function records(kind) {
    store.state[KINDS[kind].stateKey] ??= {};
    return store.state[KINDS[kind].stateKey];
  }

  function recordFor(kind, key) {
    return records(kind)[loginKey(key)] ?? null;
  }

  function set(kind, key, fields) {
    const k = loginKey(key);
    records(kind)[k] = { ...records(kind)[k], ...fields };
    store.save();
  }

  function shown(message) {
    return Object.assign(new Error(message), { shown: true });
  }

  /** @returns {{available: boolean, engines: string[], labels: string[], status: 'none'|'working'|'ready'|'failed', action: string|null,
   *             name: string, startedAt: string|null, finishedAt: string|null, error: string|null}} */
  function view(login) {
    const r = recordFor('people', login);
    return {
      available, engines, labels: engines.map((name) => engine(name).label), status: r?.status ?? 'none', action: r?.action ?? null, name: databaseName(login),
      startedAt: r?.startedAt ?? null, finishedAt: r?.finishedAt ?? null, error: r?.error ?? null,
    };
  }

  async function start(kind, key, action, command) {
    const taskArn = await dbAdmin.start(command);
    set(kind, key, { status: 'working', action, taskArn, startedAt: nowIso(), finishedAt: null, error: null });
    console.log('databases: task started', { kind, key, action, taskArn });
  }

  async function stopTask(taskArn) {
    await dbAdmin.stop(taskArn).catch((err) => {
      console.warn('databases: could not stop the earlier task', { taskArn, message: err.message });
    });
  }

  async function ensurePassword(kind, key, description) {
    const name = KINDS[kind].secret(key);
    if (!(await secrets.read(name))) await secrets.save(name, newPassword(), description);
  }

  /** A person's first databases, or the same ones copied from the template again: both are the task's `reset`. */
  async function create(login) {
    if (!available) throw shown('this console has no db-admin task, so there are no databases of your own');
    if (recordFor('people', login)?.status === 'working') throw shown('your databases are busy with the last change: wait for it to finish');
    await ensurePassword('people', login, `Woodshed: @${login}'s database password, for their My Woodshed sessions only`);
    await start('people', login, recordFor('people', login)?.status === 'ready' ? 'reset' : 'create', ['reset', login]);
    return view(login);
  }

  /** Remove My Woodshed: the record goes once the task has dropped them; the password goes with the person's secrets. */
  async function remove(login) {
    const record = recordFor('people', login);
    if (!available || !record) return;
    if (record.status === 'working') await stopTask(record.taskArn);
    await start('people', login, 'remove', ['drop', login]);
  }

  /**
   * A shared session's own databases, copied while its container starts; it waits for them (sessionApi.mjs). A
   * resumed session finds them already there and keeps them as they were.
   */
  async function createForSession(id) {
    const record = recordFor('sessions', id);
    if (record?.status === 'ready' && record.action !== 'remove') {
      console.log('databases: a resumed session keeps its databases', { session: id });
      return;
    }
    // A start the provider had no room for is tried again, and its first copy may still be running.
    if (record?.status === 'working' && record.action === 'clone') {
      console.log('databases: the session\'s copy is already running', { session: id });
      return;
    }
    await ensurePassword('sessions', id, `Woodshed: session ${id}'s database password, deleted with its databases`);
    try {
      await start('sessions', id, 'clone', ['clone', id]);
    } catch (err) {
      // No task, so no record for the sweep to find: the password goes now or never.
      await secrets.remove(sessionSecretName(id)).catch((removeErr) => {
        console.warn('databases: a session\'s password outlived its failed copy', { session: id, message: removeErr.message });
      });
      throw err;
    }
  }

  async function readyCredentials(kind, key, name) {
    if (!available || recordFor(kind, key)?.status !== 'ready') return null;
    const password = await secrets.read(KINDS[kind].secret(key));
    if (!password) return null;
    return { user: name, password, name };
  }

  /** @returns {Promise<{user: string, password: string, name: string}|null>}  only once they are ready */
  async function credentials(login) {
    return readyCredentials('people', login, databaseName(login));
  }

  /**
   * @returns {Promise<{status: 'none'|'working'|'ready'|'failed', database: {user: string, password: string, name: string}|null,
   *                    error: string|null}>}
   */
  async function sessionDatabase(id) {
    const record = recordFor('sessions', id);
    if (!record || record.action === 'remove') return { status: 'none', database: null, error: null };
    return { status: record.status, database: await readyCredentials('sessions', id, sessionDatabaseName(id)), error: record.error ?? null };
  }

  /**
   * Drops the databases of every shared session the fleet no longer keeps, however it ended: the fleet calls this on
   * each tick with the active sessions and the stopped ones that can still be resumed.
   * @param {Set<string>} keepIds
   */
  async function sweep(keepIds) {
    if (!available) return;
    for (const [id, record] of Object.entries(records('sessions'))) {
      if (keepIds.has(id)) continue;
      if (record.action === 'remove' && (record.status === 'working' || now() - Date.parse(record.finishedAt) < DROP_RETRY_MS)) continue;
      if (record.action !== 'remove' && record.status === 'working') await stopTask(record.taskArn);
      try {
        await start('sessions', id, 'remove', ['drop-session', id]);
      } catch (err) {
        console.warn('databases: could not start a session\'s drop', { session: id, message: err.message });
      }
    }
  }

  /**
   * Drop now, from the Console settings page, for a shared session's databases the sweep has not managed to drop.
   * @param {string} id
   * @param {string} by
   * @throws {Error}  shown, while a task for them still runs
   */
  async function dropSessionNow(id, by) {
    const record = recordFor('sessions', id);
    if (!record) throw shown('there are no databases for that session');
    // A task that has not finished past the retry time is the stall the page shows: it is stopped and dropped again.
    const stale = record.status === 'working' && now() - Date.parse(record.startedAt) > DROP_RETRY_MS;
    if (record.status === 'working' && !stale) throw shown('a db-admin task for them is still running: wait for it to finish');
    if (stale) await stopTask(record.taskArn);
    console.log('databases: drop asked from the console', { session: id, by, stale });
    await start('sessions', id, 'remove', ['drop-session', id]);
  }

  /** @returns {object}  every shared session's record, by id, as state.json has it */
  function sessionRecords() {
    return available ? { ...records('sessions') } : {};
  }

  async function finish(kind, key, record, outcome) {
    const late = !outcome.done && now() - Date.parse(record.startedAt) > TASK_TIMEOUT_MS;
    if (!outcome.done && !late) return;
    if (late) await stopTask(record.taskArn);
    if (record.action === 'remove' && outcome.ok) {
      // The password before the record: a removal that fails leaves the record for the next poll to try again.
      if (kind === 'sessions') await secrets.remove(sessionSecretName(key));
      delete records(kind)[key];
      store.save();
      console.log('databases: dropped', { kind, key });
      return;
    }
    const error = late ? `no result after ${TASK_TIMEOUT_MS / 60_000} minutes` : outcome.reason;
    set(kind, key, { status: outcome.ok ? 'ready' : 'failed', finishedAt: nowIso(), error });
    console.log('databases: task finished', { kind, key, action: record.action, ok: outcome.ok, error });
  }

  async function poll() {
    const working = Object.keys(KINDS).flatMap((kind) => Object.entries(records(kind))
      .filter(([, r]) => r.status === 'working' && r.taskArn)
      .map(([key, record]) => ({ kind, key, record })));
    if (!working.length) return;
    const outcomes = await dbAdmin.outcomes(working.map((w) => w.record.taskArn));
    for (const [i, { kind, key, record }] of working.entries()) await finish(kind, key, record, outcomes[i]);
  }

  return {
    available, engines, view, create, remove, credentials, createForSession, sessionDatabase, sweep, dropSessionNow, sessionRecords, poll, POLL_MS,
    DROP_RETRY_MS,
  };
}
