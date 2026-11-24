// openedPulls: the pull requests claude opened with `gh pr create` from anywhere in the session, a second clone or
// another repo's included, which statusd's lookup of the checkout's own branches never finds (createBranchPulls in
// statusd.mjs). hookState.mjs records each one from claude's PostToolUse hook; statusd adds them to its `prUrls`, and
// the console keeps those on a repo of its projects (statusUpdate in console/sessions.mjs).
//
// A file, as hookState's state is: it outlives a statusd restart, and a hook that finds nobody listening loses nothing.
// Codex has no hooks, so a Codex session's are not recorded.

import fs from 'node:fs';

// WOODSHED_OPENED_PULLS_FILE moves it for the tests and a second claude on one machine; the fleet never sets it, so
// it is in no PER_SESSION_ENV (providers/aws/ecsLauncher.mjs).
export const OPENED_PULLS_FILE = process.env.WOODSHED_OPENED_PULLS_FILE || '/tmp/woodshed-opened-pulls.json';
export const MAX_OPENED = 20;

const PULL_URL_RE = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g;
const ONE_PULL_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/;

/**
 * @param {any} payload  a hook's stdin, parsed
 * @returns {string[]}  the pull requests a `gh pr create` in this Bash call opened, as its output names them
 */
export function pullsOpened(payload) {
  if (payload?.hook_event_name !== 'PostToolUse' || payload?.tool_name !== 'Bash') return [];
  if (!/\bgh\s+pr\s+create\b/.test(String(payload?.tool_input?.command ?? ''))) return [];
  const response = payload?.tool_response;
  const stdout = typeof response === 'string' ? response : String(response?.stdout ?? '');
  return [...new Set(stdout.match(PULL_URL_RE) ?? [])];
}

/** @returns {string[]}  the pull requests recorded, the first opened first */
export function readOpened(file = OPENED_PULLS_FILE) {
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(list) ? list.filter((url) => typeof url === 'string' && ONE_PULL_URL_RE.test(url)).slice(-MAX_OPENED) : [];
  } catch {
    return [];
  }
}

/** Adds `urls` to the file, the newest `MAX_OPENED` kept. */
export function recordOpened(urls, file = OPENED_PULLS_FILE) {
  if (!urls.length) return;
  const list = [...new Set([...readOpened(file), ...urls])].slice(-MAX_OPENED);
  const tmp = `${file}.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(list));
  fs.renameSync(tmp, file);
}
