// What the shed's terminal does with files, inside a session: a file pasted or dropped on a terminal is saved and its
// path typed at the prompt, a picture's path claude printed is served to the page that clicked it, and a swipe on a
// phone scrolls tmux. statusd routes these (POST /upload, GET /image, POST /scroll); the console checks who asks.
//
// Kept apart from statusd.mjs so the rules can be tested against a temp tree and a fake tmux.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

import { resolveTerminalImage } from '../shared/terminalImages.mjs';

export const UPLOADS_DIR = process.env.UPLOADS_DIR || '/tmp/uploads';
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_SCROLL_STEPS = 40;
// The two tmux sessions a page shows: claude's (the Agent tab) and the plain shell (the Terminal tab).
const PANES = { agent: 'claude', terminal: 'shell' };
const IMAGE_TYPES = new Map([['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['gif', 'image/gif'], ['webp', 'image/webp']]);

function shown(message, status = 400) {
  return Object.assign(new Error(message), { shown: true, status });
}

/** @returns {string}  a name safe on disk and in a prompt: the shed's slug, with its extension kept */
export function uploadName(name, now = new Date()) {
  const base = path.basename(String(name || 'file'));
  const dot = base.lastIndexOf('.');
  const rawExt = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  const ext = /^[a-z0-9]{1,8}$/.test(rawExt) ? rawExt : 'txt';
  const stem = (dot > 0 ? base.slice(0, dot) : base).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(0, 40) || 'file';
  // Later pastes never overwrite earlier ones.
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  return `${stamp}-${randomBytes(2).toString('hex')}-${stem}.${ext}`;
}

/**
 * One file from the request body, saved under the uploads folder; refused past the size limit, with nothing left.
 * @returns {Promise<{path: string, bytes: number}>}
 */
export async function saveUpload(req, { name, dir = UPLOADS_DIR, maxBytes = MAX_UPLOAD_BYTES }) {
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, uploadName(name));
  let bytes = 0;
  const cap = new Transform({
    transform(chunk, _enc, done) {
      bytes += chunk.length;
      if (bytes > maxBytes) return done(shown(`over ${Math.round(maxBytes / 1024 / 1024)} MB`, 413));
      return done(null, chunk);
    },
  });
  try {
    await pipeline(req, cap, fs.createWriteStream(file, { flags: 'wx', mode: 0o644 }));
  } catch (err) {
    await fsp.rm(file, { force: true });
    throw err;
  }
  if (!bytes) {
    await fsp.rm(file, { force: true });
    throw shown('the file is empty');
  }
  return { path: file, bytes };
}

/** Typed at the prompt with no Enter, as the shed does: the person adds the question. */
export async function typePaths(run, paths, pane = 'agent') {
  await run('tmux', ['send-keys', '-t', PANES[pane] ?? PANES.agent, '-l', `${paths.join(' ')} `]);
}

/** @returns {{file: string, mime: string}|null}  the picture a terminal path names, if it is one the page may see */
export function imageFor(requested, { repoDir, home = os.homedir(), uploadsDir = UPLOADS_DIR, tmpDir = os.tmpdir() }) {
  // Claude's scratchpad is /tmp/claude-<uid>/…, and Playwright's screenshots land in the repo.
  const roots = [repoDir, uploadsDir, path.join(tmpDir, `claude-${process.getuid?.() ?? 1000}`)];
  return resolveTerminalImage({ requested, cwd: repoDir, roots, home, types: IMAGE_TYPES });
}

/**
 * A swipe, as tmux's own wheel binding would take it: wheel bytes to a pane that asked for the mouse (claude),
 * copy mode for one that did not (a shell), and nothing at the bottom already.
 * @param {(cmd: string, args: string[]) => Promise<{stdout: string}>} run
 * @param {{steps: number, pane?: 'agent'|'terminal'}} opts  negative steps scroll up
 * @returns {Promise<'mouse'|'copy-mode'|'bottom'>}
 */
export async function scrollPane(run, { steps, pane = 'agent' }) {
  const count = Math.min(MAX_SCROLL_STEPS, Math.abs(Math.trunc(Number(steps))));
  if (!count) throw shown('steps must be a number other than 0');
  const target = PANES[pane];
  if (!target) throw shown('pane must be agent or terminal');
  const probe = (await run('tmux', ['display', '-p', '-t', target, '#{mouse_any_flag} #{pane_in_mode}'])).stdout.trim();
  const [mouse, inMode] = probe.split(' ');
  if (mouse === '1' && inMode !== '1') {
    await run('tmux', ['send-keys', '-t', target, '-l', (steps < 0 ? '\x1b[<64;1;1M' : '\x1b[<65;1;1M').repeat(count)]);
    return 'mouse';
  }
  if (steps < 0) {
    // -e leaves copy mode once scrolled back to the bottom.
    if (inMode !== '1') await run('tmux', ['copy-mode', '-e', '-t', target]);
    await run('tmux', ['send-keys', '-t', target, '-X', '-N', String(count), 'scroll-up']);
    return 'copy-mode';
  }
  if (inMode !== '1') return 'bottom';
  await run('tmux', ['send-keys', '-t', target, '-X', '-N', String(count), 'scroll-down']);
  return 'copy-mode';
}
