import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dumpKind, lastError, mongoRestoreLine, pgItemCount, pgVerboseLine } from './restoreFormats.mjs';

const pgHead = (minor) => Buffer.concat([Buffer.from('PGDMP'), Buffer.from([1, minor, 0])]);
const MONGO = Buffer.from([0x6d, 0xe2, 0x99, 0x81, 0x68, 0, 0, 0]);
const GZIP = Buffer.from([0x1f, 0x8b, 0x08, 0x00]);

test('dumpKind takes pg_dump 16 archives and mongodump archives, gzipped or not', () => {
  assert.deepEqual(dumpKind(pgHead(15)), { kind: 'postgres', gzip: false });
  assert.deepEqual(dumpKind(pgHead(14)), { kind: 'postgres', gzip: false }, 'an older pg_dump too');
  assert.deepEqual(dumpKind(MONGO), { kind: 'mongo', gzip: false });
  assert.deepEqual(dumpKind(GZIP, MONGO), { kind: 'mongo', gzip: true });
});

test('dumpKind names what is wrong with anything else, with the short line the step shows', () => {
  const newer = dumpKind(pgHead(16));
  assert.equal(newer.detail, 'made by pg_dump 17 or newer');
  assert.match(newer.problem, /archive 1\.16.*Postgres 16/);
  assert.equal(dumpKind(Buffer.from('-- PostgreSQL database dump\n')).detail, 'plain SQL', 'psql would run its \\! lines');
  assert.equal(dumpKind(Buffer.from('\\! rm -rf /\n')).detail, 'plain SQL');
  assert.equal(dumpKind(GZIP, Buffer.from('-- PostgreSQL database dump')).detail, 'plain SQL', 'gzipped SQL too');
  assert.equal(dumpKind(GZIP, null).detail, 'not a dump');
  assert.equal(dumpKind(Buffer.from('PK\x03\x04')).detail, 'not a dump');
});

test('pg_restore --verbose says one line for each item -l lists, and which table it is on', () => {
  // Lines as pg_restore 16 printed them, restoring a pg_dump 16 archive of this repo's database.
  assert.deepEqual(pgVerboseLine('pg_restore: connecting to database for restore'), { item: false, table: null });
  assert.deepEqual(pgVerboseLine('pg_restore: creating EXTENSION "pg_trgm"'), { item: true, table: null });
  assert.deepEqual(pgVerboseLine('pg_restore: processing data for table "public.accounting_spreads"'), { item: true, table: 'accounting_spreads' });
  assert.deepEqual(pgVerboseLine('pg_restore: processing data for table "crm.deals"'), { item: true, table: 'crm.deals' });
  assert.deepEqual(pgVerboseLine('pg_restore: executing SEQUENCE SET accounting_spreads_id_seq'), { item: true, table: null });
  assert.equal(pgItemCount(';\n; Archive created at 2026-11-06\n;\n12; 2615 2200 SCHEMA - public\n3700; 0 0 ENCODING - ENCODING\n\n'), 2);
});

test('mongorestore says each collection it will restore, then each one it has', () => {
  // Lines as mongorestore 100.10 printed them, restoring this repo's Mongo database.
  assert.deepEqual(mongoRestoreLine("2026-11-06T15:26:30.034+0000\treading metadata for woodshed_octocat__restore.userpreferences from archive 'real.archive.gz'"),
    { collection: 'userpreferences', started: null, finished: null });
  assert.deepEqual(mongoRestoreLine('2026-11-06T15:26:30.069+0000\tfinished restoring woodshed_octocat__restore.conversations (18 documents, 0 failures)'),
    { collection: null, started: null, finished: { name: 'conversations', rows: 18 } });
  assert.deepEqual(mongoRestoreLine('2026-11-06T15:26:33.924+0000\t3566 document(s) restored successfully. 0 document(s) failed to restore.'),
    { collection: null, started: null, finished: null });
  assert.equal(mongoRestoreLine("2026-11-06T15:26:30.054+0000\trestoring woodshed_octocat_restore.conversations from archive 'real.archive.gz'").started, 'conversations');
});

test('mongorestore 100.20, the console image\'s, quotes each namespace in backticks', () => {
  // Lines as mongorestore 100.20.1 printed them, restoring a conversations archive.
  assert.deepEqual(mongoRestoreLine('2026-11-06T17:05:39.605+0000\treading metadata for `woodshed_octocat__restore.conversations` from "archive `/var/lib/woodshed-cloud/restores/octocat.dump`"'),
    { collection: 'conversations', started: null, finished: null });
  assert.deepEqual(mongoRestoreLine('2026-11-06T17:06:29.597+0000\tfinished restoring `woodshed_octocat__restore.conversations` (677 documents, 0 failures)'),
    { collection: null, started: null, finished: { name: 'conversations', rows: 677 } });
  assert.equal(mongoRestoreLine('2026-11-06T17:10:47.300+0000\trestoring `woodshed_octocat__restore.agentruns` from "archive `/var/lib/woodshed-cloud/restores/octocat.dump`"').started, 'agentruns');
  assert.equal(mongoRestoreLine('2026-11-06T17:10:47.400+0000\trestoring indexes for collection `woodshed_octocat__restore.agentruns` from metadata').started, null, 'indexes come after its documents');
});

test('lastError keeps the error and the command it ran, and not mongorestore\'s closing count', () => {
  const pg = 'pg_restore: connecting\npg_restore: error: could not execute query: ERROR:  relation "x" already exists\nCommand was: CREATE TABLE x ();\n';
  assert.equal(lastError(pg), 'pg_restore: error: could not execute query: ERROR:  relation "x" already exists Command was: CREATE TABLE x ();');
  const mongo = '2026-11-06T15:26:31.000+0000\tFailed: woodshed__restore.x: error restoring from archive: E11000 duplicate key\n2026-11-06T15:26:31.001+0000\t12 document(s) restored successfully. 1 document(s) failed to restore.\n';
  assert.equal(lastError(mongo), 'Failed: woodshed__restore.x: error restoring from archive: E11000 duplicate key', 'the timestamp goes too');
});
