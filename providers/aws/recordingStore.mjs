// The AWS provider's store for QA recordings (console/qaRecordings.mjs): each in the private S3 bucket the Claude homes
// are in, which only the console's role reaches, under `_qa/` (no GitHub login starts with `_`). A browser watches a
// video through a five-minute link the console makes once it has let the person in, so S3 answers its ranges and the
// video never passes through the console on its way out.
import { spawn } from 'node:child_process';

const PREFIX = '_qa/';
// Long enough to start playing and seek; a reload asks the console for a new one.
const LINK_SECONDS = 300;
const DELETE_BATCH = 1000;

function isNotFound(err) {
  return /Not Found|NoSuchKey|404/.test(String(err?.stderr ?? err?.message ?? ''));
}

/**
 * @param {{bucket: string, aws: (args: string[]) => Promise<any>, spawnImpl?: typeof spawn}} opts
 */
export function createRecordingStore({ bucket, aws, spawnImpl = spawn }) {
  const url = (key) => `s3://${bucket}/${PREFIX}${key}`;

  // A CLI call whose output is not JSON (`s3 cp`, `s3 presign`), which `aws` (awsCli) would try to parse.
  function cli(args, { input = null } = {}) {
    const child = spawnImpl('aws', args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const done = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(Object.assign(new Error(`aws ${args[0]} ${args[1]} failed: ${stderr.trim().split('\n').pop()}`), { stderr }))));
    });
    if (input) child.stdin.end(input);
    return done;
  }

  async function exists(key) {
    try {
      return await aws(['s3api', 'head-object', '--bucket', bucket, '--key', `${PREFIX}${key}`]);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async function put(key, buffer, contentType) {
    await cli(['s3', 'cp', '-', url(key), '--content-type', contentType, '--only-show-errors'], { input: buffer });
  }

  /** @returns {Promise<string|null>}  a link that reads the object for LINK_SECONDS, or null when it is gone */
  async function link(key) {
    if (!(await exists(key))) return null;
    return (await cli(['s3', 'presign', url(key), '--expires-in', String(LINK_SECONDS)])).trim();
  }

  /** @returns {Promise<{stream: import('node:stream').Readable, bytes: number}|null>}  for the poster, which is small */
  async function get(key) {
    const head = await exists(key);
    if (!head) return null;
    const child = spawnImpl('aws', ['s3', 'cp', url(key), '-', '--only-show-errors'], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('close', (code) => { if (code !== 0) console.warn('qaRecordings: poster stream failed', { key, code }); });
    return { stream: child.stdout, bytes: head.ContentLength ?? 0 };
  }

  /** @returns {Promise<{key: string, modifiedAt: string|null}[]>} */
  async function list() {
    const out = await aws(['s3api', 'list-objects-v2', '--bucket', bucket, '--prefix', PREFIX]);
    return (out?.Contents ?? []).map((o) => ({ key: String(o.Key).slice(PREFIX.length), modifiedAt: o.LastModified ?? null }));
  }

  async function remove(keys) {
    for (let i = 0; i < keys.length; i += DELETE_BATCH) {
      const objects = keys.slice(i, i + DELETE_BATCH).map((key) => ({ Key: `${PREFIX}${key}` }));
      const deleted = await aws(['s3api', 'delete-objects', '--bucket', bucket, '--delete', JSON.stringify({ Objects: objects, Quiet: true })]);
      if (deleted?.Errors?.length) throw new Error(`S3 did not delete ${deleted.Errors.length} QA recordings: ${deleted.Errors[0].Code}`);
    }
  }

  return { put, link, get, list, remove };
}
