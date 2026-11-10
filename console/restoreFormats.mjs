// What a dump is, and what the restore programs say while they run, for dbRestore.mjs. Pure functions, so the page's
// copy of the header check (public/dbRestore.js) and the console's agree, and the parsers are tested on real output.

// RDS runs Postgres 16, and a pg_restore newer than the server sends settings it does not know
// (`SET transaction_timeout`), so the console's is 16 too. It reads archives up to 1.15, what pg_dump 16 writes.
export const PG_MAJOR = 16;
const MAX_ARCHIVE_MINOR = 15;
// A mongodump archive's first four bytes, as mongodump writes them; `--gzip` wraps the whole archive in gzip.
const MONGO_ARCHIVE_MAGIC = Buffer.from([0x6d, 0xe2, 0x99, 0x81]);
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);
const ERROR_SHOWN = 400;

/**
 * @param {Buffer} head  the file's first bytes, and for a gzip file, the first bytes inside it
 * @param {Buffer|null} [inner]  the first bytes of what a gzip file holds, or null when it is not gzip
 * @returns {{kind: 'postgres'|'mongo', gzip: boolean}|{problem: string, detail: string}}
 *   `detail` is the step's short line on the page
 */
export function dumpKind(head, inner = null) {
  if (head.subarray(0, 5).toString('latin1') === 'PGDMP') {
    const [major, minor] = [head[5], head[6]];
    if (major === 1 && minor <= MAX_ARCHIVE_MINOR) return { kind: 'postgres', gzip: false };
    return {
      problem: `This dump was made by pg_dump 17 or newer (archive ${major}.${minor}). Your databases are Postgres ${PG_MAJOR}, which can't read it. Make it again with Postgres ${PG_MAJOR}'s pg_dump; Docker gives you one whatever version you have.`,
      detail: 'made by pg_dump 17 or newer',
    };
  }
  if (head.subarray(0, 4).equals(MONGO_ARCHIVE_MAGIC)) return { kind: 'mongo', gzip: false };
  if (head.subarray(0, 2).equals(GZIP_MAGIC) && inner?.subarray(0, 4).equals(MONGO_ARCHIVE_MAGIC)) return { kind: 'mongo', gzip: true };
  const plainSql = /^(--|SET |CREATE |\\)/.test(head.toString('latin1')) || inner?.toString('latin1').startsWith('--');
  return {
    problem: plainSql
      ? 'This is a plain SQL file. Plain SQL can run shell commands in the console, so only pg_dump\'s custom format is taken: make it with the command on this page.'
      : 'This is neither a pg_dump custom archive nor a mongodump archive. Make it with one of the commands on this page.',
    detail: plainSql ? 'plain SQL' : 'not a dump',
  };
}

/** @returns {string}  the last error a program printed, for the page; never logged, since it can quote a row */
export function lastError(stderr) {
  const lines = String(stderr).split('\n').map((l) => l.trim()).filter(Boolean);
  // mongorestore's last line counts the documents that "failed to restore" even when none did: not an error.
  const error = lines.findLast((l) => /error|fatal/i.test(l) || /\bFailed:/.test(l)) ?? lines.at(-1) ?? 'no reason given';
  const command = lines.find((l) => l.startsWith('Command was:'));
  return [error.replace(/^\S+T\S+\s+/, ''), command].filter(Boolean).join(' ').slice(0, ERROR_SHOWN);
}

/** @returns {number}  the items `pg_restore -l` lists, one a line, comments and blanks left out */
export function pgItemCount(listing) {
  return String(listing).split('\n').filter((l) => l.trim() && !l.startsWith(';')).length;
}

/**
 * pg_restore --verbose prints one line for each item it restores: `creating`, `processing data for table` or
 * `executing`, which add up to what `-l` lists.
 * @returns {{item: boolean, table: string|null}}
 */
export function pgVerboseLine(line) {
  const item = /^pg_restore: (creating|processing data for table|executing) /.test(line);
  const table = /^pg_restore: processing data for table "(?:public\.)?([^"]+)"/.exec(line)?.[1] ?? null;
  return { item, table };
}

/**
 * mongorestore reads every collection's metadata first, then says when it starts each one and when it is restored.
 * @returns {{collection: string|null, started: string|null, finished: {name: string, rows: number}|null}}
 */
export function mongoRestoreLine(line) {
  // mongorestore 100.20 quotes a namespace in backticks (`db.coll`, from "archive `file`"); 100.10 did not.
  const meta = /reading metadata for `?[^.\s`]+\.([^\s`]+)`? from "?archive/.exec(line);
  const done = /finished restoring `?[^.\s`]+\.([^\s`]+)`? \((\d+) documents?, (\d+) failures?\)/.exec(line);
  // Not `restoring indexes for collection …`, which comes after the documents.
  const start = /\trestoring `?[^.\s`]+\.([^\s`]+)`? from "?archive/.exec(line);
  return { collection: meta?.[1] ?? null, started: start?.[1] ?? null, finished: done ? { name: done[1], rows: Number(done[2]) } : null };
}
