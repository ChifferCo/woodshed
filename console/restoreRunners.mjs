// The programs a restore runs, for dbRestore.mjs: Postgres's pg_restore and psql, and Mongo's mongorestore and mongosh
// (with mongoRestore.js), each as the person's own database user. A password is never an argument, where `ps` would
// show it: pg's go in PGPASSWORD, mongosh's in its environment, mongorestore's in a --config file only it reads.

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { lastError, mongoRestoreLine, pgItemCount, pgVerboseLine, PG_MAJOR } from './restoreFormats.mjs';

const PG_BIN = `/usr/lib/postgresql/${PG_MAJOR}/bin`;
const MONGO_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mongoRestore.js');
const RESTORE_TIMEOUT_MS = 2 * 3_600_000;
// mongorestore holds whole insert batches of documents, and its defaults (four collections at once, 1,000 documents
// a batch) went past 400 MB on 47 MB of conversations, in a 512 MB container shared with the console: the kernel
// killed it. One collection, 25 documents a batch and a Go memory target kept that at 138 MB, no slower.
const MONGORESTORE_THRIFT = ['--numParallelCollections=1', '--numInsertionWorkersPerCollection=1', '--batchSize=25'];
const MONGORESTORE_GOMEMLIMIT = '200MiB';
const STEP_TIMEOUT_MS = 30 * 60_000;
const SQL_TIMEOUT_MS = 2 * 60_000;
const STDERR_KEPT = 4000;
// What the swap tries when a session's app connects again between closing its connections and the rename.
const RENAME_ATTEMPTS = 3;
const RETRY_PAUSE_MS = 2_000;
const TOP_TABLES = 8;

function failure(message, step) {
  return Object.assign(new Error(message), { step });
}

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Why a program stopped on a signal, for the page. Only this console's own timer stops one with SIGTERM; SIGKILL from
 * anything else is the kernel ending it for want of memory, in a container with a few hundred MB.
 * @returns {string}
 */
export function stoppedBecause({ signal, timedOut, timeoutMs }) {
  if (timedOut) return `stopped after ${timeoutMs / 60_000} minutes`;
  if (signal === 'SIGKILL') return 'it was stopped for using more memory than the console has: make the dump smaller (leave out more), or ask for the console to be given more memory';
  return `it was stopped (${signal})`;
}

/**
 * One program, its stderr handed over a line at a time as it comes.
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
export function runProgram({ command, args, env, timeoutMs, onLine = null }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let partial = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-256_000); });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-STDERR_KEPT);
      if (!onLine) return;
      const lines = (partial + chunk).split('\n');
      partial = lines.pop();
      for (const line of lines) onLine(line);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\nerror: ${err.message}` });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (onLine && partial) onLine(partial);
      resolve({ code: code ?? -1, stdout, stderr: signal ? `${stderr}\nerror: ${stoppedBecause({ signal, timedOut, timeoutMs })}` : stderr });
    });
  });
}

// Names come from databases.mjs, never from a request; this is the line that keeps them out of SQL as anything else.
/**
 * A migration's name without its file's extension: a tool may record the file it ran (`001_orgs.js`, compiled from
 * `001_orgs.ts`), so a name and a file are compared by their stems.
 */
export function migrationStem(name) {
  return String(name).replace(/\.[A-Za-z0-9]+$/, '');
}

function ident(name) {
  if (!/^[a-z0-9_]{1,63}$/.test(name)) throw new Error(`not a database name Woodshed makes: ${name}`);
  return `"${name}"`;
}

/**
 * @param {{address: {host: string, port: number}, creds: {user: string, password: string}, live: string, copy: string,
 *          previous: string, migrationsTable?: {table: string, column: string}|null, bin?: string, run?: typeof runProgram,
 *          retryPauseMs?: number}} opts
 *   `migrationsTable` is the project file's `databases[].migrationsTable`, project.mjs having checked it is plain names;
 *   null when the project keeps none, and then nothing is said of the dump's migrations
 */
export function pgRunner({ address, creds, live, copy, previous, migrationsTable = null, bin = PG_BIN, run = runProgram, retryPauseMs = RETRY_PAUSE_MS }) {
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin', PGHOST: address.host, PGPORT: String(address.port), PGUSER: creds.user,
    PGPASSWORD: creds.password, PGSSLMODE: 'require', PGCONNECT_TIMEOUT: '15', PGAPPNAME: 'woodshed-cloud-restore',
    ...(process.env.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH } : {}),
  };
  const program = (name) => path.join(bin, name);

  // Each -c is its own statement outside a transaction, as CREATE and DROP DATABASE need.
  function sql(database, statements) {
    const args = ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-d', database, ...statements.flatMap((s) => ['-c', s])];
    return run({ command: program('psql'), args, env: { ...env, PGOPTIONS: '-c lock_timeout=30s' }, timeoutMs: SQL_TIMEOUT_MS });
  }

  async function mustSql(database, statements, step) {
    const out = await sql(database, statements);
    if (out.code !== 0) throw failure(lastError(out.stderr), step);
    return out.stdout;
  }

  // Only the person's own connections: RDS's own (its monitoring, autovacuum) may not be ended by them, and asking
  // fails the whole statement. A drop or rename stops autovacuum by itself, and waits out the rest by trying again.
  const terminate = (name) => `SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid() AND usename = current_user`;

  /** Each try closes the person's connections first; a connection of RDS's own gets a few seconds to go. */
  async function retried(statements, step) {
    for (let attempt = 1; ; attempt++) {
      const out = await sql('postgres', statements);
      if (out.code === 0) return { attempts: attempt, stdout: out.stdout };
      if (attempt === RENAME_ATTEMPTS) throw failure(lastError(out.stderr), step);
      await pause(retryPauseMs);
    }
  }

  const drop = (name, step) => retried([terminate(name), `DROP DATABASE IF EXISTS ${ident(name)}`], step);

  /** @returns {Promise<number>}  the items in the archive, for the restore's progress */
  async function items(file) {
    const out = await run({ command: program('pg_restore'), args: ['-l', file], env, timeoutMs: SQL_TIMEOUT_MS });
    if (out.code !== 0) throw failure(lastError(out.stderr), 'check');
    return pgItemCount(out.stdout);
  }

  async function makeCopy() {
    await drop(copy, 'copy');
    await mustSql('postgres', [`CREATE DATABASE ${ident(copy)}`, `REVOKE CONNECT, TEMPORARY ON DATABASE ${ident(copy)} FROM PUBLIC`], 'copy');
  }

  /** One transaction that stops at the first error, so the copy is the whole dump or nothing. */
  async function restore(file, { onProgress }) {
    let done = 0;
    const out = await run({
      command: program('pg_restore'), env, timeoutMs: RESTORE_TIMEOUT_MS,
      args: ['--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', '--verbose', '--dbname', copy, file],
      onLine: (line) => {
        const { item, table } = pgVerboseLine(line);
        if (!item) return;
        done++;
        onProgress({ done, current: table });
      },
    });
    if (out.code !== 0) throw failure(lastError(out.stderr), 'restore');
    return { done };
  }

  async function summarize(database = copy) {
    const tables = "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'";
    const out = await mustSql(database, [
      'ANALYZE',
      `SELECT 'total', count(*), coalesce(sum(greatest(c.reltuples, 0)), 0)::bigint ${tables}`,
      `SELECT 'table', CASE WHEN n.nspname = 'public' THEN c.relname ELSE n.nspname || '.' || c.relname END, greatest(c.reltuples, 0)::bigint ${tables} ORDER BY c.reltuples DESC, 2 LIMIT ${TOP_TABLES}`,
    ], 'count');
    // The newest of the project's migrations says how far the dump's schema goes. The names go into the SQL as they
    // are: project.mjs lets through only lowercase SQL names. A dump with no such table has no
    // newest, and fails this query alone.
    const migration = migrationsTable ? await sql(database, [`SELECT max(${migrationsTable.column}) FROM ${migrationsTable.table}`]) : null;
    const rows = out.split('\n').filter(Boolean).map((l) => l.split('|'));
    const total = rows.find((r) => r[0] === 'total') ?? ['total', '0', '0'];
    return {
      tables: Number(total[1]), rows: Number(total[2]),
      top: rows.filter((r) => r[0] === 'table').map((r) => ({ name: r[1], rows: Number(r[2]) })),
      newest: migration?.code === 0 ? (migrationStem(migration.stdout.trim()) || null) : null,
    };
  }

  async function dropCopy() {
    await drop(copy, 'discard');
  }

  /** @returns {Promise<string[]|null>}  the migrations the copy has run, as its migrations table names them, or null when it keeps none */
  async function migrationNames() {
    if (!migrationsTable) return null;
    const out = await sql(copy, [`SELECT ${migrationsTable.column} FROM ${migrationsTable.table}`]);
    return out.code === 0 ? out.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : null;
  }

  /**
   * An Apply that failed to rename the database back, or that a console restart cut short, leaves it as `previous`
   * with nothing under its own name: it gets its name back before anything else, so the leftover drop after this can
   * only ever drop an old copy.
   * @returns {Promise<boolean>}  whether it was put back
   */
  async function ensureLive() {
    const names = (await mustSql('postgres', [`SELECT datname FROM pg_database WHERE datname IN ('${live}', '${previous}')`], 'close')).split('\n').filter(Boolean);
    if (names.includes(live)) return false;
    if (!names.includes(previous)) throw failure(`there is no ${live}: Reset my data makes a fresh one`, 'close');
    await mustSql('postgres', [`ALTER DATABASE ${ident(previous)} RENAME TO ${ident(live)}`], 'close');
    return true;
  }

  // The four steps Apply shows, in order. A rename needs no connection to the database it renames.
  const apply = {
    async close() {
      const putBack = await ensureLive();
      await drop(previous, 'close');
      const closed = Number((await mustSql('postgres', [terminate(live)], 'close')).trim()) || 0;
      return { putBack, closed };
    },
    async aside() {
      const { attempts } = await retried([terminate(live), `ALTER DATABASE ${ident(live)} RENAME TO ${ident(previous)}`], 'aside');
      return { attempts };
    },
    async name() {
      // The database viewer may still have the copy open, which the rename would wait on.
      const out = await sql('postgres', [terminate(copy), `ALTER DATABASE ${ident(copy)} RENAME TO ${ident(live)}`]);
      if (out.code === 0) return {};
      const back = await sql('postgres', [`ALTER DATABASE ${ident(previous)} RENAME TO ${ident(live)}`]);
      throw failure(back.code === 0
        ? `your database is as it was: ${lastError(out.stderr)}`
        : `your database is left as ${previous}, with your data, and the next Apply gives it its name back first. Do not Reset my data, which drops it: ${lastError(out.stderr)}`, 'name');
    },
    async drop() {
      const left = await drop(previous, 'drop').then(() => false, () => true);
      return { left };
    },
  };

  return { kind: 'postgres', items, makeCopy, restore, summarize, dropCopy, migrationNames, apply, applySteps: ['close', 'aside', 'name', 'drop'] };
}

/**
 * @param {{address: {host: string, port: number}, creds: {user: string, password: string}, live: string, copy: string,
 *          dir: string, bin?: string, mongosh?: string, run?: typeof runProgram}} opts
 *   `dir` holds mongorestore's --config file for the length of one run
 */
export function mongoRunner({ address, creds, live, copy, dir, bin = '/usr/bin', mongosh = '/usr/bin/mongosh', run = runProgram }) {
  // The user lives in its own database, as dbAdmin.mjs makes it.
  const uri = `mongodb://${encodeURIComponent(creds.user)}:${encodeURIComponent(creds.password)}@${address.host}:${address.port}/?authSource=${encodeURIComponent(creds.user)}`;
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir };

  async function script(action, step, timeoutMs = STEP_TIMEOUT_MS) {
    const out = await run({
      command: mongosh, args: ['--nodb', '--quiet', '--norc', '--file', MONGO_SCRIPT], timeoutMs,
      env: { ...env, WOODSHED_MONGO_URI: uri, WOODSHED_MONGO_ACTION: action, WOODSHED_MONGO_DB: live },
    });
    const answer = (() => {
      try {
        return JSON.parse(out.stdout.trim().split('\n').at(-1));
      } catch {
        return null;
      }
    })();
    if (!answer) throw failure(lastError(out.stderr || out.stdout), step);
    if (!answer.ok) throw failure(answer.error, step);
    return answer;
  }

  async function makeCopy() {
    await script('drop-copy', 'copy');
  }

  /** Every collection of the archive goes into the copy, whatever database it was dumped from; it stops at the first error. */
  async function restore(file, { gzip, onProgress }) {
    const config = path.join(dir, `mongorestore-${process.pid}-${Date.now()}.yaml`);
    await fsp.writeFile(config, `uri: ${JSON.stringify(uri)}\n`, { mode: 0o600 });
    let total = 0;
    let done = 0;
    let rows = 0;
    let current = null;
    try {
      const out = await run({
        command: path.join(bin, 'mongorestore'), env: { ...env, GOMEMLIMIT: MONGORESTORE_GOMEMLIMIT }, timeoutMs: RESTORE_TIMEOUT_MS,
        args: [
          `--config=${config}`, `--archive=${file}`, ...(gzip ? ['--gzip'] : []), '--stopOnError', ...MONGORESTORE_THRIFT,
          '--nsExclude=admin.*', '--nsExclude=config.*', '--nsExclude=local.*',
          '--nsFrom=$db$.$coll$', `--nsTo=${copy}.$coll$`,
        ],
        onLine: (line) => {
          const { collection, started, finished } = mongoRestoreLine(line);
          if (collection) total++;
          // One collection at a time (MONGORESTORE_THRIFT), so the one it last started is the one it is on.
          if (started) current = started;
          if (finished) {
            done++;
            rows += finished.rows;
            current = null;
          }
          if (collection || started || finished) onProgress({ done, total, current });
        },
      });
      if (out.code !== 0) throw failure(lastError(out.stderr), 'restore');
      return { done, rows };
    } finally {
      await fsp.rm(config, { force: true });
    }
  }

  async function summarize() {
    return (await script('summary', 'count')).summary;
  }

  async function dropCopy() {
    await script('drop-copy', 'discard');
  }

  const apply = {
    backup: async () => script('backup', 'backup'),
    replace: async () => script('replace', 'replace'),
    cleanup: async () => script('cleanup', 'cleanup'),
  };

  return { kind: 'mongo', items: async () => null, makeCopy, restore, summarize, dropCopy, apply, applySteps: ['backup', 'replace', 'cleanup'] };
}
