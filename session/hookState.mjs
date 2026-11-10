// hookState: run by claude's own hooks (claudeHooks.json, passed with --settings), so statusd knows what claude is
// doing from claude itself rather than from what its terminal draws.
//
// Each firing writes the state to STATE_FILE; statusd reads it on every /status. A file, not a socket: it outlives
// a statusd restart, and a hook that finds nobody listening loses nothing.
//
// It must print nothing. What a UserPromptSubmit hook writes to stdout is added to claude's context.
//
// Pressing Esc fires no hook at all, mid-turn or on a dialog (measured on Claude Code 2.1.311), so a turn cut short
// is read from the transcript's `[Request interrupted by user` record instead: see claudeState in statusd.mjs.

import fs from 'node:fs';
import { isMain } from '../shared/isMain.mjs';

export const STATE_FILE = '/tmp/woodshed-claude-state.json';

// PreToolUse comes 30 ms before PermissionRequest for the same call, so needs-you is the later write. Notification
// repeats it 6 s on, in case a parallel tool's PostToolUse landed in between.
const STATE_BY_EVENT = {
  // A claude that has just opened sits at its prompt, whatever an earlier claude in this container left here. It
  // fires before the first prompt's UserPromptSubmit, which claude waits on. claudeHooks.json leaves out the
  // SessionStart that an auto-compact fires mid-turn.
  SessionStart: 'done',
  UserPromptSubmit: 'working',
  PreToolUse: 'working',
  PostToolUse: 'working',
  PermissionRequest: 'needs-you',
  Notification: 'needs-you',
  Stop: 'done',
};

/**
 * @param {any} payload  the hook's stdin, parsed
 * @returns {'working'|'needs-you'|'done'|null}  null for a firing that says nothing about the main turn
 */
export function stateForHook(payload) {
  const event = payload?.hook_event_name;
  // Only a permission prompt blocks; the idle reminder fires on a claude that is already done.
  if (event === 'Notification' && payload?.notification_type !== 'permission_prompt') return null;
  // A background agent's tool calls go on after the main turn's Stop. The Stop itself says whether one is running.
  if ((event === 'PreToolUse' || event === 'PostToolUse') && payload?.agent_id) return null;
  // Claude wakes itself when the agent finishes: a UserPromptSubmit, then a Stop with no agent left. Background
  // shells are left out, since a dev server would keep the session working for ever; main() records how many
  // are waiting on a job, so the rail can tell a session waiting on one from one that is done.
  if (event === 'Stop' && runningSubagents(payload) > 0) return 'working';
  return STATE_BY_EVENT[event] ?? null;
}

function runningSubagents(payload) {
  const tasks = Array.isArray(payload?.background_tasks) ? payload.background_tasks : [];
  return tasks.filter((t) => t?.type === 'subagent' && t?.status === 'running').length;
}

// A shell that waits on something and then ends, as claude writes it: a poll loop (`until`, `while`, `sleep`), a check
// on GitHub, a deploy or a URL, or a finite job such as a test run. An allowlist, not a blocklist: a dev server
// (`npm run dev`, `node server.js`) matches none of it, and an unknown shell reads as done, so a person looks.
// A shell entry in a Stop payload has `command` and `description` (measured on Claude Code 2.1.x).
const WAITING_JOB_RE = new RegExp([
  String.raw`^\s*sleep\b`,
  String.raw`\b(until|while)\b`,
  String.raw`\bgh\s+(run|pr|api|workflow)\b`,
  String.raw`\b(curl|wget)\b`,
  String.raw`\baws\s+\S+\s+(wait|describe-\S+)\b`,
  String.raw`\bkubectl\s+(wait|rollout)\b`,
  String.raw`\b(npm|yarn|pnpm)\s+(run\s+)?(test|build)\b`,
  String.raw`\bnpx\s+(jest|vitest|playwright)\b`,
].join('|'));

/** @returns {number}  the background shells still waiting on a job when claude's turn ends */
export function runningShells(payload) {
  if (payload?.hook_event_name !== 'Stop') return 0;
  const tasks = Array.isArray(payload?.background_tasks) ? payload.background_tasks : [];
  return tasks.filter((t) => t?.type === 'shell' && t?.status === 'running' && WAITING_JOB_RE.test(String(t?.command ?? ''))).length;
}

function main() {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  const state = stateForHook(payload);
  if (!state) return;
  const tmp = `${STATE_FILE}.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ state, event: payload.hook_event_name, at: Date.now(), shells: runningShells(payload) }));
  fs.renameSync(tmp, STATE_FILE);
}

if (isMain(import.meta.url)) main();
