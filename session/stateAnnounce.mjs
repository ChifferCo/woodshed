// Tells the console the moment the agent's state changes, so the page's rail says Working, Done or Needs you within a
// moment rather than at the console's next read of the session (console/README.md, "How the rail keeps up").
//
// claude's hooks, and Grok Build's, write the state they saw to STATE_FILE on every event (hookState.mjs). statusd
// looks at that file's time every CHECK_EVERY_MS, a stat and nothing more, and reads it only when it changed. When the
// state it records differs from the one last told, statusd calls the console's session API, `POST /state-changed`,
// with the session's own token and no body. The console then reads the session's statusd as it always does: the call
// says only that something changed, never what, so the card still shows only what the console read itself.
//
// A call that fails is not tried again: the console still reads every session at its tick. Codex and OpenCode have no
// hooks, and an Esc that cuts a turn short fires none, so those changes wait for the console's own reads, as before.

import fs from 'node:fs/promises';

export const CHECK_EVERY_MS = 250;
const CALL_TIMEOUT_MS = 3_000;

/**
 * @param {{stateFile: string, consoleUrl: string, token: string, fetch?: typeof globalThis.fetch,
 *          stat?: (file: string) => Promise<{mtimeMs: number}>, readFile?: (file: string) => Promise<string>,
 *          log?: Pick<Console, 'log'|'warn'>}} args
 * @returns {{check: () => Promise<'told'|'unchanged'|'failed'|'none'>}}  one look at the file: `told` when the console
 *   was told of a new state, `failed` when the call to it failed, `none` when there is no file yet
 */
export function createStateAnnouncer({ stateFile, consoleUrl, token, fetch = globalThis.fetch, stat = (f) => fs.stat(f), readFile = (f) => fs.readFile(f, 'utf8'), log = console }) {
  let seenAt = null;
  let told = null;
  let failedWhy = null;
  let first = true;
  return {
    async check() {
      let mtimeMs;
      try {
        ({ mtimeMs } = await stat(stateFile));
      } catch {
        return 'none';
      }
      if (mtimeMs === seenAt) return 'unchanged';
      seenAt = mtimeMs;
      let state;
      try {
        state = JSON.parse(await readFile(stateFile)).state ?? null;
      } catch {
        // Caught mid-write: hookState.mjs renames a whole file into place, so the next look reads it.
        seenAt = null;
        return 'unchanged';
      }
      if (state === told) return 'unchanged';
      told = state;
      try {
        const res = await fetch(`${consoleUrl}/state-changed`, {
          method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        });
        await res.body?.cancel();
        if (!res.ok) throw new Error(`the console answered ${res.status}`);
        if (first) log.log('statusd: the console is told of each state change', { state });
        first = false;
        failedWhy = null;
        return 'told';
      } catch (err) {
        // Once per reason: a console from before the route answers 404 to every change.
        const why = String(err?.message ?? err);
        if (why !== failedWhy) log.warn('statusd: state change not told to the console', { message: why });
        failedWhy = why;
        return 'failed';
      }
    },
  };
}
