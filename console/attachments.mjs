// Files attached to New session, after the shed's launcher. The page sends each one on its own as it is picked
// (POST /api/my/uploads), so nothing big sits in the console's memory; New session then names the ones it keeps,
// and they move under the session. Its entrypoint asks the session API for them at start (POST /attachments) as one
// tar, writes them under /tmp/uploads and lists their paths under the prompt. Each Resume fetches them again, since
// the conversation names those paths; they go with the session's Remove, or a day after they were sent for a session
// that never started.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

export const MAX_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
// Across what one person has sent and not yet started a session with.
const MAX_STAGED_BYTES = 40 * 1024 * 1024;
const STAGED_KEPT_MS = 24 * 3_600_000;
const UPLOAD_ID_RE = /^[0-9a-f]{16}$/;
const LOGIN_RE = /^[A-Za-z0-9-]{1,39}$/;

function shown(message, status = 400) {
  return Object.assign(new Error(message), { shown: true, status });
}

/** @returns {string}  the shed's slug for a file name, its extension kept */
export function attachmentName(name, index) {
  const base = path.basename(String(name || 'file'));
  const dot = base.lastIndexOf('.');
  const rawExt = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  const ext = /^[a-z0-9]{1,8}$/.test(rawExt) ? rawExt : 'txt';
  const stem = (dot > 0 ? base.slice(0, dot) : base).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(0, 40) || 'file';
  return `${index + 1}-${stem}.${ext}`;
}

/** @param {{dir: string, now?: () => number}} opts  `dir` is the console's state folder's attachments/ */
export function createAttachments({ dir, now = Date.now }) {
  const stagedDir = (login) => path.join(dir, 'staged', login);
  const sessionDir = (id) => path.join(dir, 'sessions', id);

  async function stagedBytes(login) {
    const names = await fsp.readdir(stagedDir(login)).catch(() => []);
    let total = 0;
    for (const name of names) total += (await fsp.stat(path.join(stagedDir(login), name)).catch(() => ({ size: 0 }))).size;
    return total;
  }

  /**
   * One file from the request body, kept for the person's next New session.
   * @returns {Promise<{id: string, name: string, bytes: number}>}
   */
  async function stage(req, { login, name }) {
    if (!LOGIN_RE.test(String(login ?? ''))) throw shown('My Woodshed needs GitHub sign-in');
    const room = Math.min(MAX_ATTACHMENT_BYTES, MAX_STAGED_BYTES - (await stagedBytes(login)));
    if (room <= 0) throw shown('your attachments waiting to start add up to 40 MB already: start the session or drop some', 413);
    await fsp.mkdir(stagedDir(login), { recursive: true });
    const id = randomBytes(8).toString('hex');
    const file = path.join(stagedDir(login), id);
    let bytes = 0;
    const cap = new Transform({
      transform(chunk, _enc, done) {
        bytes += chunk.length;
        if (bytes > room) return done(shown(room < MAX_ATTACHMENT_BYTES ? 'that would put your attachments over 40 MB' : 'over 25 MB', 413));
        return done(null, chunk);
      },
    });
    try {
      await pipeline(req, cap, fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }));
    } catch (err) {
      await fsp.rm(file, { force: true });
      throw err;
    }
    if (!bytes) {
      await fsp.rm(file, { force: true });
      throw shown('the file is empty');
    }
    await fsp.writeFile(`${file}.name`, String(name || 'file').slice(0, 200), { mode: 0o600 });
    console.log('attachments: staged', { login, bytes });
    return { id, name: String(name || 'file'), bytes };
  }

  /**
   * The staged files a New session named, moved under it in the order given.
   * @returns {Promise<number>}  how many it has
   */
  async function claim({ login, ids, sessionId }) {
    const picked = [...new Set((Array.isArray(ids) ? ids : []).map(String))];
    if (!picked.length) return 0;
    if (picked.length > MAX_ATTACHMENTS) throw shown(`at most ${MAX_ATTACHMENTS} attachments`);
    if (!picked.every((id) => UPLOAD_ID_RE.test(id))) throw shown('attachments must be upload ids');
    const from = stagedDir(login);
    for (const id of picked) {
      if (!(await fsp.stat(path.join(from, id)).catch(() => null))) throw shown('an attachment is gone: add it again');
    }
    const to = sessionDir(sessionId);
    await fsp.mkdir(to, { recursive: true });
    for (const [i, id] of picked.entries()) {
      const name = await fsp.readFile(path.join(from, `${id}.name`), 'utf8').catch(() => 'file');
      await fsp.rename(path.join(from, id), path.join(to, attachmentName(name, i)));
      await fsp.rm(path.join(from, `${id}.name`), { force: true });
    }
    console.log('attachments: claimed', { login, sessionId, count: picked.length });
    return picked.length;
  }

  /** @returns {Promise<boolean>}  whether the session has any, before tarring them */
  async function has(sessionId) {
    return (await fsp.readdir(sessionDir(sessionId)).catch(() => [])).length > 0;
  }

  /** The session's files as a tar on `res`. */
  async function send(sessionId, res) {
    const folder = sessionDir(sessionId);
    const names = await fsp.readdir(folder);
    res.writeHead(200, { 'content-type': 'application/x-tar', 'cache-control': 'no-store' });
    const tar = spawn('tar', ['cf', '-', '-C', folder, '--', ...names], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    tar.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(0, 500); });
    const exited = new Promise((resolve) => tar.on('close', resolve));
    await pipeline(tar.stdout, res, { end: false });
    const code = await exited;
    // The 200 is already sent: a cut connection is what tells the session's curl the tar is not whole.
    if (code !== 0) {
      console.warn('attachments: tar failed, connection cut', { sessionId, code, message: stderr.split('\n')[0] || null });
      res.destroy();
      return;
    }
    res.end();
    console.log('attachments: handed out', { sessionId, count: names.length });
  }

  async function drop(sessionId) {
    await fsp.rm(sessionDir(sessionId), { recursive: true, force: true });
  }

  // Files sent for a New session nobody started.
  async function sweep() {
    const logins = await fsp.readdir(path.join(dir, 'staged')).catch(() => []);
    let removed = 0;
    for (const login of logins) {
      for (const name of await fsp.readdir(stagedDir(login)).catch(() => [])) {
        const file = path.join(stagedDir(login), name);
        const stat = await fsp.stat(file).catch(() => null);
        if (stat && now() - stat.mtimeMs > STAGED_KEPT_MS) {
          await fsp.rm(file, { force: true });
          removed += 1;
        }
      }
    }
    if (removed) console.log('attachments: old staged files removed', { removed });
  }

  return { stage, claim, has, send, drop, sweep };
}
