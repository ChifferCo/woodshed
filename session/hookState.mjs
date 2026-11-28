// hookState: run by claude's own hooks (claudeHooks.json, passed with --settings), so statusd knows what claude is
// doing from claude itself rather than from what its terminal draws. Grok Build runs it too, from the image's policy
// file (/etc/grok/requirements.toml, session/grokRequirements.toml), the only hooks it runs in a session: the same
// events in camelCase (`hookEventName`, `notificationType`, `subagentType`; docs.x.ai/build/features/hooks), and a StopCancelled for a turn
// cut short, which claude never fires. Antigravity CLI runs it as `hookState.mjs agy` from ~/.gemini/config/hooks.json
// (session/antigravitySetup.sh): its own events, in camelCase too (stateForAgyHook), and it wants a JSON answer.
//
// Each firing writes the state to STATE_FILE; statusd reads it on every /status. A file, not a socket: it outlives
// a statusd restart, and a hook that finds nobody listening loses nothing.
//
// It must print nothing (except for agy, above). What a UserPromptSubmit hook writes to stdout is added to claude's context.
//
// Pressing Esc fires no hook at all, mid-turn or on a dialog (measured on Claude Code 2.1.311), so a turn cut short
// is read from the transcript's `[Request interrupted by user` record instead: see claudeState in statusd.mjs.

import fs from 'node:fs';
import { isMain } from '../shared/isMain.mjs';
import { pullsOpened, recordOpened } from './openedPulls.mjs';

// WOODSHED_CLAUDE_STATE_FILE moves it, for a second claude on one machine with a statusd of its own: the dev console's
// real-agent session (console/bin/devChatSession.mjs), beside the session's own claude. The fleet never sets it, so no
// session task needs it and it is in no PER_SESSION_ENV (providers/aws/ecsLauncher.mjs): every session uses the default.
export const STATE_FILE = process.env.WOODSHED_CLAUDE_STATE_FILE || '/tmp/woodshed-claude-state.json';

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
  // Grok's: a turn that ended on an API error, or was cut short (an interrupt, a declined approval, its turn limit).
  StopFailure: 'done',
  StopCancelled: 'done',
};

// What each agent names its fields: claude in snake_case, Grok Build in camelCase.
const eventOf = (payload) => payload?.hook_event_name ?? payload?.hookEventName;
const notificationOf = (payload) => payload?.notification_type ?? payload?.notificationType;

/**
 * @param {any} payload  the hook's stdin, parsed
 * @returns {'working'|'needs-you'|'done'|null}  null for a firing that says nothing about the main turn
 */
export function stateForHook(payload) {
  const event = eventOf(payload);
  // Grok's subagents fire the session's events too, marked with their type: a subagent's stop is not the session's.
  if (payload?.subagentType) return null;
  if (event === 'Notification') {
    const type = notificationOf(payload);
    if (type === 'permission_prompt') return 'needs-you';
    // Grok's backstop for a turn that reported no Stop (a rewind, a superseded turn): it is at its prompt. claude's idle
    // reminder fires on a claude that is already done, and says nothing new.
    if (type === 'idle_prompt' && payload?.hookEventName) return 'done';
    return null;
  }
  // A background agent's tool calls go on after the main turn's Stop. The Stop itself says whether one is running.
  if ((event === 'PreToolUse' || event === 'PostToolUse') && payload?.agent_id) return null;
  // Claude wakes itself when the agent finishes: a UserPromptSubmit, then a Stop with no agent left. Background
  // shells are left out, since a dev server would keep the session working for ever; main() records how many
  // are waiting on a job, so the rail can tell a session waiting on one from one that is done.
  if (event === 'Stop' && runningSubagents(payload) > 0) return 'working';
  return STATE_BY_EVENT[event] ?? null;
}

/**
 * Antigravity CLI's hooks (measured with agy 1.5.18, ~/.gemini/config/hooks.json). It fires none as it opens: SessionStart
 * comes with the first message of a conversation, before its first model call, so every event of a turn means working
 * until its Stop. A turn cut short with Esc fires nothing at all (a PreInvocation stays the last firing), so its state is
 * read from the pane over this one (agentState.mjs, antigravityState).
 * @param {any} payload  the hook's stdin, parsed
 * @returns {'working'|'done'|null}
 */
export function stateForAgyHook(payload) {
  switch (payload?.hookEventName) {
    case 'SessionStart': case 'PreInvocation': case 'PreToolUse': case 'PostToolUse': return 'working';
    case 'Stop': return 'done';
    // After each model call, tools included: another call or the Stop follows.
    default: return null;
  }
}

/**
 * What an agy hook answers on stdout. A PreToolUse hook that prints nothing useful decides the call: `{}` denied it, and
 * `{"decision": "allow"}` leaves it to the next hook and agy's own policy, which is what a hook that only watches must say
 * (measured: a command still asks in default mode, and runs with --dangerously-skip-permissions). Every other event takes `{}`.
 */
export function agyAnswer(payload) {
  return payload?.hookEventName === 'PreToolUse' ? { decision: 'allow' } : {};
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
  if (eventOf(payload) !== 'Stop') return 0;
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
  if (process.argv[2] === 'agy') {
    // Its answer first: whatever goes wrong after it must not leave agy waiting, or change a decision.
    process.stdout.write(JSON.stringify(agyAnswer(payload)));
    const state = stateForAgyHook(payload);
    if (!state) return;
    const transcript = typeof payload.transcriptPath === 'string' ? payload.transcriptPath.slice(0, 1000) : null;
    const conversation = typeof payload.conversationId === 'string' ? payload.conversationId.slice(0, 80) : null;
    const tmp = `${STATE_FILE}.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ state, event: payload.hookEventName, at: Date.now(), shells: 0, transcript, conversation }));
    fs.renameSync(tmp, STATE_FILE);
    return;
  }
  // A pull request opened from another clone or on another repo, which statusd would not find (openedPulls.mjs). A
  // background agent's counts too. Its failing must not lose the state below.
  try {
    recordOpened(pullsOpened(payload));
  } catch { /* the card misses that chip; claude's state still goes */ }
  const state = stateForHook(payload);
  if (!state) return;
  const tmp = `${STATE_FILE}.${process.pid}`;
  // The transcript the firing claude writes to: a second claude in the session (agents.mjs) reads its own conversation by
  // it, since a /clear starts another file.
  const transcript = typeof payload.transcript_path === 'string' ? payload.transcript_path.slice(0, 1000) : null;
  fs.writeFileSync(tmp, JSON.stringify({ state, event: eventOf(payload), at: Date.now(), shells: runningShells(payload), transcript }));
  fs.renameSync(tmp, STATE_FILE);
}

if (isMain(import.meta.url)) main();
