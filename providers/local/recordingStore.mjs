// The local provider's store for QA recordings (console/qaRecordings.mjs): each under its key in a folder of the
// console's state folder, readable by the console's user only. The console serves a video from here itself, with
// ranges, since there is no S3 to hand a link to.
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

// `0a1b2c3d/video-1.webm`, `0a1b2c3d/poster-<secret>.png`: a session id, then one file.
const KEY_RE = /^[0-9a-f]{8}\/[a-z0-9-]+\.(webm|png)$/;

/** @param {{dir: string}} opts */
export function createRecordingStore({ dir }) {
  const root = path.resolve(dir);

  function fileOf(key) {
    if (!KEY_RE.test(String(key))) throw new Error(`not a recording name: ${key}`);
    return path.join(root, ...key.split('/'));
  }

  async function put(key, buffer) {
    const file = fileOf(key);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.chmod(root, 0o700);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(tmp, buffer, { mode: 0o600 });
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
  }

  /** @returns {Promise<{path: string, bytes: number}|null>} */
  async function file(key) {
    const at = fileOf(key);
    const stat = await fs.stat(at).catch((err) => (err.code === 'ENOENT' ? null : Promise.reject(err)));
    return stat?.isFile() ? { path: at, bytes: stat.size } : null;
  }

  /** @returns {Promise<{stream: import('node:stream').Readable, bytes: number}|null>} */
  async function get(key) {
    const found = await file(key);
    return found ? { stream: createReadStream(found.path), bytes: found.bytes } : null;
  }

  /** @returns {Promise<{key: string, modifiedAt: string}[]>} */
  async function list() {
    const ids = await fs.readdir(root).catch((err) => (err.code === 'ENOENT' ? [] : Promise.reject(err)));
    const out = [];
    for (const id of ids) {
      for (const name of await fs.readdir(path.join(root, id)).catch(() => [])) {
        const key = `${id}/${name}`;
        if (!KEY_RE.test(key)) continue;
        const stat = await fs.stat(path.join(root, id, name)).catch(() => null);
        if (stat) out.push({ key, modifiedAt: stat.mtime.toISOString() });
      }
    }
    return out;
  }

  async function remove(keys) {
    for (const key of keys) await fs.rm(fileOf(key), { force: true });
    // A run's folder goes with its last file.
    for (const id of new Set(keys.map((k) => k.split('/')[0]))) await fs.rmdir(path.join(root, id)).catch(() => {});
  }

  return { put, get, file, list, remove };
}
