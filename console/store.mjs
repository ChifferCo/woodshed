// The console's whole state is one JSON file: the sessions and the GitHub
// polling cursors. Every change is written straight away, through a temp file
// and a rename, so a crash leaves either the old file or the new one.

import fs from 'node:fs';
import path from 'node:path';

const EMPTY_STATE = { sessions: [], github: null };
// A save the store refused is tried again after this, so a blip in it does not lose the change.
const RETRY_MS = 5_000;

/**
 * @param {string} dir
 * @returns {{state: {sessions: object[], github: object|null}, save: () => void}}
 */
export function openStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'state.json');
  let state = structuredClone(EMPTY_STATE);
  if (fs.existsSync(file)) {
    state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  }
  return {
    state,
    save() {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
  };
}

/**
 * The same `{state, save}` over a store kept by something other than the console, whose load and save
 * are async. The console saves after every change and never waits, as it does with the file: each save sends a copy of
 * the whole state, one at a time, and saves that come in while one is being written are sent once, as the latest.
 * @param {{load: () => Promise<object|null>, save: (state: object) => Promise<void>}} service
 * @param {{retryMs?: number}} [opts]
 * @returns {Promise<{state: object, save: () => void, flush: () => Promise<void>, close: () => Promise<void>}>}
 *   `flush` resolves once what was saved so far is written (or failed); `close` flushes, and from then on a save is
 *   refused, so an installation that was stopped cannot write over the state of the one that replaced it
 */
export async function openServiceStore(service, { retryMs = RETRY_MS } = {}) {
  const loaded = await service.load();
  if (loaded !== null && loaded !== undefined && (typeof loaded !== 'object' || Array.isArray(loaded))) {
    throw new Error('the store loaded something that is not a state object');
  }
  const state = { ...structuredClone(EMPTY_STATE), ...(loaded ? structuredClone(loaded) : {}) };
  let dirty = false;
  let writing = null;
  let retry = null;
  let closing = false;
  let closed = false;

  // Resolves true once everything saved is written, false when a write failed (a retry is then set).
  async function writeLatest() {
    while (dirty) {
      dirty = false;
      try {
        await service.save(JSON.parse(JSON.stringify(state)));
      } catch (err) {
        console.error('store: state not saved, trying again', { message: String(err?.message ?? err).split('\n')[0] });
        dirty = true;
        if (!closing && !retry) {
          retry = setTimeout(() => { retry = null; kick(); }, retryMs);
          retry.unref?.();
        }
        return false;
      }
    }
    return true;
  }

  function kick() {
    if (writing) return;
    writing = writeLatest().then((ok) => {
      writing = null;
      // A save that came in as the last write finished.
      if (ok && dirty) kick();
    });
  }

  function save() {
    // A request the stopped installation was still answering: one that replaced it owns the state now.
    if (closed) {
      console.warn('store: change after the installation stopped, not saved');
      return;
    }
    dirty = true;
    kick();
  }

  async function flush() {
    while (writing) await writing;
  }

  async function close() {
    closing = true;
    clearTimeout(retry);
    retry = null;
    // One last try at what a failed write left.
    if (dirty) kick();
    await flush();
    closed = true;
  }

  return { state, save, flush, close };
}
