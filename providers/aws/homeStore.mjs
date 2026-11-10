// The AWS provider's Claude home store: each home as one gzipped tar in the private S3 bucket only the console's role
// reaches, at the names console/homes.mjs gives them. A home streams through the console without being held whole.
import { spawn } from 'node:child_process';

import { byteLimit, MAX_HOME_BYTES } from '../../console/homes.mjs';
import logins from '../../console/public/logins.cjs';

const { loginKey } = logins;

// S3 takes at most this many keys in one delete-objects call.
const DELETE_BATCH = 1000;

function isNotFound(err) {
  return /Not Found|NoSuchKey|404/.test(String(err?.stderr ?? err?.message ?? ''));
}

/**
 * @param {{bucket: string, aws: (args: string[]) => Promise<any>, spawnImpl?: typeof spawn}} opts
 */
export function createHomeStore({ bucket, aws, spawnImpl = spawn }) {
  const key = (login) => `${loginKey(login)}/claude-home.tar.gz`;
  const url = (login) => `s3://${bucket}/${key(login)}`;

  function cli(args, { stdin = 'ignore', stdout = 'ignore' } = {}) {
    return spawnImpl('aws', args, { stdio: [stdin, stdout, 'pipe'] });
  }

  function finished(child) {
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    return new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(Object.assign(new Error(`aws s3 cp failed: ${stderr.trim().split('\n').pop()}`), { stderr }))));
    });
  }

  /** @returns {Promise<number>}  the bytes saved */
  async function put(login, stream) {
    const child = cli(['s3', 'cp', '-', url(login), '--only-show-errors', '--expected-size', String(MAX_HOME_BYTES)], { stdin: 'pipe' });
    const limit = byteLimit(MAX_HOME_BYTES);
    let bytes = 0;
    limit.on('data', (c) => { bytes += c.length; });
    const done = finished(child);
    const failed = new Promise((_, reject) => {
      limit.on('error', (err) => { child.kill(); reject(err); });
      stream.on('error', (err) => { child.kill(); reject(err); });
    });
    stream.pipe(limit).pipe(child.stdin);
    await Promise.race([done, failed]);
    console.log('homes: saved', { login, bytes });
    return bytes;
  }

  /** @returns {Promise<{stream: import('node:stream').Readable, bytes: number}|null>}  null when nothing is saved */
  async function get(login) {
    let head;
    try {
      head = await aws(['s3api', 'head-object', '--bucket', bucket, '--key', key(login)]);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    const child = cli(['s3', 'cp', url(login), '-', '--only-show-errors'], { stdout: 'pipe' });
    finished(child).catch((err) => console.warn('homes: restore stream failed', { login, message: err.message.split('\n')[0] }));
    return { stream: child.stdout, bytes: head?.ContentLength ?? 0 };
  }

  async function remove(login) {
    await aws(['s3api', 'delete-object', '--bucket', bucket, '--key', key(login)]);
    console.log('homes: deleted', { login });
  }

  /**
   * Every one of a person's private sessions' own homes, those of sessions already off the list too: each is a whole
   * copy of their Claude home, so forgetting theirs means forgetting these.
   * @returns {Promise<number>}  how many were deleted
   */
  async function removeSessionsOf(login) {
    const prefix = `${loginKey(login)}/sessions/`;
    const out = await aws(['s3api', 'list-objects-v2', '--bucket', bucket, '--prefix', prefix]);
    const keys = (out?.Contents ?? []).map((o) => o.Key).filter(Boolean);
    for (let i = 0; i < keys.length; i += DELETE_BATCH) {
      const objects = keys.slice(i, i + DELETE_BATCH).map((Key) => ({ Key }));
      const deleted = await aws(['s3api', 'delete-objects', '--bucket', bucket, '--delete', JSON.stringify({ Objects: objects, Quiet: true })]);
      // S3 answers 200 with the keys it could not delete listed, not an error.
      if (deleted?.Errors?.length) throw new Error(`S3 did not delete ${deleted.Errors.length} session homes: ${deleted.Errors[0].Code}`);
    }
    console.log('homes: session homes deleted', { login, count: keys.length });
    return keys.length;
  }

  /** Inside S3: nothing passes through the console. */
  async function copy(from, to) {
    await aws(['s3api', 'copy-object', '--bucket', bucket, '--copy-source', `${bucket}/${key(from)}`, '--key', key(to)]);
    console.log('homes: copied', { from, to });
  }

  /** A small file beside the homes (claudeSettings.mjs), under a key of its own. */
  async function putText(objectKey, text) {
    const child = cli(['s3', 'cp', '-', `s3://${bucket}/${objectKey}`, '--only-show-errors'], { stdin: 'pipe' });
    const done = finished(child);
    child.stdin.end(text);
    await done;
  }

  /** @returns {Promise<string|null>}  null when nothing is saved under that key */
  async function getText(objectKey) {
    try {
      await aws(['s3api', 'head-object', '--bucket', bucket, '--key', objectKey]);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    const child = cli(['s3', 'cp', `s3://${bucket}/${objectKey}`, '-', '--only-show-errors'], { stdout: 'pipe' });
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    await finished(child);
    return Buffer.concat(chunks).toString('utf8');
  }

  async function removeKey(objectKey) {
    await aws(['s3api', 'delete-object', '--bucket', bucket, '--key', objectKey]);
  }

  /** @returns {Promise<{id: string, bytes: number, savedAt: string|null}[]>}  every shared session's saved home */
  async function listShared() {
    const out = await aws(['s3api', 'list-objects-v2', '--bucket', bucket, '--prefix', '_sessions/']);
    return (out?.Contents ?? []).flatMap((o) => {
      const id = /^_sessions\/([0-9a-f]{8})\/claude-home\.tar\.gz$/.exec(o.Key ?? '')?.[1];
      return id ? [{ id, bytes: o.Size ?? 0, savedAt: o.LastModified ?? null }] : [];
    });
  }

  return { put, get, remove, removeSessionsOf, copy, listShared, putText, getText, removeKey };
}
