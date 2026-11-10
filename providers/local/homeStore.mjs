// The local provider's Claude home store: each home as one gzipped tar in a folder on the console's machine, at the
// same names the S3 store (../aws/homeStore.mjs) uses as keys, which console/homes.mjs gives them. The same calls, so
// a private session's Resume and a person's home between sessions work the same on either.
//
// A home is written to a temporary file and renamed over the old one once it is whole, so a save that fails or runs
// over the limit leaves the last good one. The folder is readable by the console's user only.
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { byteLimit, MAX_HOME_BYTES } from '../../console/homes.mjs';
import logins from '../../console/public/logins.cjs';

const { loginKey } = logins;

const HOME_FILE = 'claude-home.tar.gz';
// `joel`, `joel/sessions/0a1b2c3d`, `_sessions/0a1b2c3d`, `joel/claude-settings.json`: plain segments only.
const SEGMENT = /^[a-z0-9_][a-z0-9._-]*$/i;

function isNotFound(err) {
  return err?.code === 'ENOENT';
}

/**
 * @param {{dir: string}} opts  `dir` is made, readable by its owner only, if it is not there
 */
export function createHomeStore({ dir }) {
  const root = path.resolve(dir);

  function fileOf(key) {
    const parts = String(key).split('/');
    if (!parts.every((p) => SEGMENT.test(p) && p !== '..')) throw new Error(`not a home name: ${key}`);
    return path.join(root, ...parts);
  }
  const homeFile = (login) => fileOf(`${loginKey(login)}/${HOME_FILE}`);

  async function writeWhole(file, write) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.chmod(root, 0o700);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      await write(tmp);
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
  }

  /** @returns {Promise<number>}  the bytes saved */
  async function put(login, stream) {
    let bytes = 0;
    await writeWhole(homeFile(login), async (tmp) => {
      const limit = byteLimit(MAX_HOME_BYTES);
      limit.on('data', (c) => { bytes += c.length; });
      await pipeline(stream, limit, createWriteStream(tmp, { mode: 0o600 }));
    });
    console.log('homes: saved', { login, bytes });
    return bytes;
  }

  /** @returns {Promise<{stream: import('node:stream').Readable, bytes: number}|null>}  null when nothing is saved */
  // Opened here, not as the stream is first read: a home replaced or removed in between does not break the restore.
  async function get(login) {
    let handle;
    try {
      handle = await fs.open(homeFile(login));
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    const { size } = await handle.stat();
    return { stream: handle.createReadStream(), bytes: size };
  }

  async function removeFile(file) {
    try {
      await fs.unlink(file);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  async function remove(login) {
    await removeFile(homeFile(login));
    console.log('homes: deleted', { login });
  }

  /**
   * Every one of a person's private sessions' own homes, those of sessions already off the list too: each is a whole
   * copy of their Claude home, so forgetting theirs means forgetting these.
   * @returns {Promise<number>}  how many were deleted
   */
  async function removeSessionsOf(login) {
    const sessions = fileOf(`${loginKey(login)}/sessions`);
    let ids = [];
    try {
      ids = await fs.readdir(sessions);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    let count = 0;
    for (const id of ids) {
      try {
        await fs.unlink(path.join(sessions, id, HOME_FILE));
        count++;
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    }
    await fs.rm(sessions, { recursive: true, force: true });
    console.log('homes: session homes deleted', { login, count });
    return count;
  }

  async function copy(from, to) {
    await writeWhole(homeFile(to), (tmp) => fs.copyFile(homeFile(from), tmp));
    console.log('homes: copied', { from, to });
  }

  /** A small file beside the homes (claudeSettings.mjs), under a name of its own. */
  async function putText(objectKey, text) {
    await writeWhole(fileOf(objectKey), (tmp) => fs.writeFile(tmp, text, { mode: 0o600 }));
  }

  /** @returns {Promise<string|null>}  null when nothing is saved under that name */
  async function getText(objectKey) {
    try {
      return await fs.readFile(fileOf(objectKey), 'utf8');
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async function removeKey(objectKey) {
    await removeFile(fileOf(objectKey));
  }

  /** @returns {Promise<{id: string, bytes: number, savedAt: string|null}[]>}  every shared session's saved home */
  async function listShared() {
    const shared = fileOf('_sessions');
    let ids = [];
    try {
      ids = await fs.readdir(shared);
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
    const found = await Promise.all(ids.filter((id) => /^[0-9a-f]{8}$/.test(id)).map(async (id) => {
      try {
        const stat = await fs.stat(path.join(shared, id, HOME_FILE));
        return [{ id, bytes: stat.size, savedAt: stat.mtime.toISOString() }];
      } catch (err) {
        if (isNotFound(err)) return [];
        throw err;
      }
    }));
    return found.flat();
  }

  return { put, get, remove, removeSessionsOf, copy, listShared, putText, getText, removeKey };
}
