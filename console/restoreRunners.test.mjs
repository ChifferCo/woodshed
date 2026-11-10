import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { mongoRunner, pgRunner, stoppedBecause } from './restoreRunners.mjs';

const OK = { code: 0, stdout: '', stderr: '' };
const creds = { user: 'woodshed_joel', password: 'ab12cd' };
const address = { host: 'rds.example', port: 5432 };

// Each program run, kept with its environment; `answer` says what it prints.
function fakeRun(answer = () => OK) {
  const calls = [];
  const run = async (opts) => {
    calls.push(opts);
    if (opts.onLine) for (const line of (answer(opts).lines ?? [])) opts.onLine(line);
    return { ...OK, ...answer(opts) };
  };
  return { calls, run };
}

const sqlOf = (call) => call.args.filter((_, i) => call.args[i - 1] === '-c');
const pg = (run) => pgRunner({ address, creds, live: 'woodshed_joel', copy: 'woodshed_joel__restore', previous: 'woodshed_joel__previous', bin: '/pg', run, retryPauseMs: 0 });
const ownOnly = (name) => `SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid() AND usename = current_user`;

test('pg_restore runs as the person\'s user, the password in PGPASSWORD, and reports each item it restores', async () => {
  const { calls, run } = fakeRun(() => ({
    lines: ['pg_restore: connecting to database for restore', 'pg_restore: creating TABLE "public.accounts"', 'pg_restore: processing data for table "public.accounts"'],
  }));
  const progress = [];
  const result = await pg(run).restore('/state/restores/joel.dump', { onProgress: (p) => progress.push(p) });
  assert.deepEqual(result, { done: 2 });
  assert.deepEqual(progress, [{ done: 1, current: null }, { done: 2, current: 'accounts' }]);
  const [call] = calls;
  assert.equal(call.command, '/pg/pg_restore');
  assert.deepEqual(call.args.slice(0, 7), ['--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', '--verbose', '--dbname', 'woodshed_joel__restore']);
  assert.equal(call.env.PGUSER, 'woodshed_joel');
  assert.equal(call.env.PGPASSWORD, 'ab12cd');
  assert.ok(!call.args.join(' ').includes('ab12cd'), 'never an argument');
});

test('Apply\'s close puts a stranded database back first, before it drops any leftover', async () => {
  const { calls, run } = fakeRun((opts) => (opts.args.some((a) => a.startsWith('SELECT datname')) ? { stdout: 'woodshed_joel__previous\n' } : OK));
  const result = await pg(run).apply.close();
  assert.equal(result.putBack, true);
  assert.deepEqual(calls.slice(1, 3).map(sqlOf), [
    ['ALTER DATABASE "woodshed_joel__previous" RENAME TO "woodshed_joel"'],
    [ownOnly('woodshed_joel__previous'), 'DROP DATABASE IF EXISTS "woodshed_joel__previous"'],
  ], 'the person\'s data is renamed back, so the drop that follows finds nothing of theirs');
});

test('Apply\'s close stops when neither the database nor its backup is there', async () => {
  const { calls, run } = fakeRun();
  await assert.rejects(pg(run).apply.close(), /there is no woodshed_joel/);
  assert.equal(calls.length, 1, 'nothing is dropped or renamed');
});

test('Apply moves the database aside again while a session\'s app keeps connecting', async () => {
  let refusals = 2;
  const { calls, run } = fakeRun((opts) => (opts.args.some((a) => a.endsWith('RENAME TO "woodshed_joel__previous"')) && refusals-- > 0
    ? { code: 1, stderr: 'ERROR:  database "woodshed_joel" is being accessed by other users\n' } : OK));
  assert.deepEqual(await pg(run).apply.aside(), { attempts: 3 });
  assert.equal(calls.length, 3);
});

test('Apply gives the database its name back when the copy cannot take it, and closes the viewer on the copy first', async () => {
  const { calls, run } = fakeRun((opts) => (opts.args.includes('ALTER DATABASE "woodshed_joel__restore" RENAME TO "woodshed_joel"')
    ? { code: 1, stderr: 'psql: error: ERROR:  database "woodshed_joel__restore" does not exist\n' } : OK));
  await assert.rejects(pg(run).apply.name(), (err) => err.step === 'name' && /your database is as it was/.test(err.message));
  assert.match(sqlOf(calls[0])[0], /datname = 'woodshed_joel__restore'/);
  assert.deepEqual(sqlOf(calls[1]), ['ALTER DATABASE "woodshed_joel__previous" RENAME TO "woodshed_joel"']);
});

test('mongorestore takes the password from a --config file it alone reads, gone after, and counts collections', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mongo-runner-test-'));
  let config = null;
  const { calls, run } = fakeRun((opts) => {
    if (!opts.command.endsWith('mongorestore')) return OK;
    const file = opts.args.find((a) => a.startsWith('--config=')).slice('--config='.length);
    config = { text: fs.readFileSync(file, 'utf8'), mode: fs.statSync(file).mode & 0o777 };
    return { lines: [
      "2026-11-06T15:26:30.034+0000\treading metadata for woodshed_joel__restore.skills from archive 'm.gz'",
      "2026-11-06T15:26:30.034+0000\treading metadata for woodshed_joel__restore.workflows from archive 'm.gz'",
      "2026-11-06T15:26:30.040+0000\trestoring woodshed_joel__restore.workflows from archive 'm.gz'",
      '2026-11-06T15:26:30.154+0000\tfinished restoring woodshed_joel__restore.workflows (14 documents, 0 failures)',
    ] };
  });
  const runner = mongoRunner({ address: { host: '10.0.0.10', port: 27017 }, creds, live: 'woodshed_joel', copy: 'woodshed_joel__restore', dir, bin: '/tools', run });
  const progress = [];
  const result = await runner.restore('/state/restores/joel.dump', { gzip: true, onProgress: (p) => progress.push(p) });
  assert.deepEqual(result, { done: 1, rows: 14 });
  assert.deepEqual(progress.at(-2), { done: 0, total: 2, current: 'workflows' }, 'one at a time, so the one it started is the one it is on');
  assert.deepEqual(progress.at(-1), { done: 1, total: 2, current: null });
  assert.equal(config.text, 'uri: "mongodb://woodshed_joel:ab12cd@10.0.0.10:27017/?authSource=woodshed_joel"\n');
  assert.equal(config.mode, 0o600);
  assert.deepEqual(fs.readdirSync(dir), [], 'the config file is gone after the run');
  const args = calls[0].args.join(' ');
  assert.ok(!args.includes('ab12cd'));
  assert.match(args, /--gzip .*--nsFrom=\$db\$\.\$coll\$ --nsTo=woodshed_joel__restore\.\$coll\$/);
  assert.match(args, /--nsExclude=admin\.\*/);
  assert.match(args, /--numParallelCollections=1 --numInsertionWorkersPerCollection=1 --batchSize=25/, 'what kept 47 MB of conversations under 140 MB');
  assert.equal(calls[0].env.GOMEMLIMIT, '200MiB');
});

test('mongosh gets the URI in its environment, and a failed step says what the script said', async () => {
  const { calls, run } = fakeRun(() => ({ stdout: '{"ok":false,"error":"the copy could not be applied, and your Mongo data is as it was: boom"}\n' }));
  const runner = mongoRunner({ address: { host: '10.0.0.10', port: 27017 }, creds, live: 'woodshed_joel', copy: 'woodshed_joel__restore', dir: os.tmpdir(), mongosh: '/m', run });
  await assert.rejects(runner.apply.replace(), (err) => err.step === 'replace' && /as it was: boom/.test(err.message));
  assert.equal(calls[0].env.WOODSHED_MONGO_ACTION, 'replace');
  assert.match(calls[0].env.WOODSHED_MONGO_URI, /ab12cd/);
  assert.ok(!calls[0].args.join(' ').includes('ab12cd'));
});

test('a drop ends only the person\'s own connections, and waits out one of RDS\'s own by trying again', async () => {
  let busy = 1;
  const { calls, run } = fakeRun((opts) => (opts.args.includes('DROP DATABASE IF EXISTS "woodshed_joel__restore"') && busy-- > 0
    ? { code: 1, stderr: 'ERROR:  database "woodshed_joel__restore" is being accessed by other users\n' } : OK));
  await pg(run).dropCopy();
  assert.equal(calls.length, 2, 'tried again once');
  assert.deepEqual(sqlOf(calls[1]), [ownOnly('woodshed_joel__restore'), 'DROP DATABASE IF EXISTS "woodshed_joel__restore"']);
  assert.ok(calls.every((c) => !c.args.join(' ').includes('FORCE')), 'FORCE would try to end RDS\'s own connections, which the person may not');
});

test('a program stopped by the kernel is said to have run out of memory, not to have run too long', () => {
  assert.equal(stoppedBecause({ signal: 'SIGTERM', timedOut: true, timeoutMs: 7_200_000 }), 'stopped after 120 minutes');
  assert.match(stoppedBecause({ signal: 'SIGKILL', timedOut: false, timeoutMs: 7_200_000 }), /more memory than the console has/);
  assert.equal(stoppedBecause({ signal: 'SIGTERM', timedOut: false, timeoutMs: 1 }), 'it was stopped (SIGTERM)');
});

test('a copy\'s migrations are read from the project\'s own table and column, and not at all without one', async () => {
  const table = { table: 'app.schema_versions', column: 'version' };
  const answer = (opts) => {
    const sql = sqlOf(opts).join(' ');
    if (sql.includes('schema_versions')) return { stdout: sql.includes('max(') ? '20261101_add_tags.rb\n' : '20261030_orgs.rb\n20261101_add_tags.rb\n' };
    return { stdout: 'total|2|30\n' };
  };
  const own = fakeRun(answer);
  const runner = pgRunner({ address, creds, live: 'woodshed_joel', copy: 'woodshed_joel__restore', previous: 'woodshed_joel__previous', migrationsTable: table, bin: '/pg', run: own.run });
  assert.equal((await runner.summarize()).newest, '20261101_add_tags');
  assert.deepEqual(await runner.migrationNames(), ['20261030_orgs.rb', '20261101_add_tags.rb']);
  const asked = own.calls.flatMap(sqlOf).filter((s) => s.includes('schema_versions'));
  assert.deepEqual(asked, ['SELECT max(version) FROM app.schema_versions', 'SELECT version FROM app.schema_versions']);

  const none = fakeRun(answer);
  const bare = pg(none.run);
  assert.equal((await bare.summarize()).newest, null);
  assert.equal(await bare.migrationNames(), null);
  assert.equal(none.calls.flatMap(sqlOf).some((s) => /migrations|schema_versions/.test(s)), false, 'no table of any tool is guessed');
});
