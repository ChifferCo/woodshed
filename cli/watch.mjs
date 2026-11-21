// `woodshed session watch`: what changed in the sessions the console lists, as one event per session that starts, has
// done its turn, needs its person, finishes or fails. The command reads the console's list (GET /api/sessions) every
// few seconds and hands each read to `changes`, which compares it with the last: nothing here reads the network, so a
// mod, a script or a test sees the same events from the same lists.
//
// Each session is in one phase at a time, from the page's own words for it (sessions.mjs, stateOf):
//   pending   in line or starting
//   working   running, its agent busy (or still opening)
//   done      running, its agent done with its turn, or exited: waiting for a message
//   needs-you running, asking its person something (a question, an approval)
//   stopping  on its way out: no event until it has stopped, so a review's or QA's verdict is there to say
//   failed    failed to start, or failed
//   ended     stopped, paused, finished, merged or deleted
// An event is a move into a phase that matters to the person: `started` (into running from anything else), `done`,
// `needs-you`, `finished` (into ended from a live phase) and `failed`. A review or QA run works by itself, so its turns
// are not told: it says `started`, `needs-you` if it asks, then `finished` with its verdict, or `failed`.

import { stateOf } from './sessions.mjs';

export const EVENT_NAMES = ['started', 'done', 'needs-you', 'finished', 'failed'];
export const KINDS = ['private', 'shared', 'review', 'qa', 'ask'];

const RUNNING = new Set(['working', 'done', 'needs-you']);
const LIVE = new Set(['pending', ...RUNNING, 'stopping']);

/** @returns {'pending'|'working'|'done'|'needs-you'|'stopping'|'failed'|'ended'} */
export function phaseOf(s) {
  if (s.status === 'queued' || s.status === 'starting') return 'pending';
  if (s.status === 'stopping') return 'stopping';
  const { key } = stateOf(s);
  if (s.status === 'running') {
    if (key === 'needs-you') return 'needs-you';
    if (key === 'working' || key === 'starting') return 'working';
    return 'done';
  }
  return key === 'failed' ? 'failed' : 'ended';
}

/**
 * The events between two reads of the list, for the sessions `wanted` keeps.
 * @param {Map<string, string>|null} before  each session's phase at the last read, by id; null for the first read,
 *   which only learns what is there: a watch tells what happens from when it starts
 * @param {object[]} sessions  the console's sessions, as /api/sessions lists them
 * @param {{kindOf: (s: object) => string}} opts
 * @returns {{phases: Map<string, string>, events: {event: string, session: object}[]}}
 */
export function changes(before, sessions, { kindOf }) {
  const phases = new Map();
  const events = [];
  for (const s of sessions) {
    const now = phaseOf(s);
    phases.set(s.id, now);
    if (!before) continue;
    // One that appeared since the last read was in line a moment ago, as far as this watch knows.
    const was = before.get(s.id) ?? 'pending';
    if (was === now) continue;
    const byItself = ['review', 'qa'].includes(kindOf(s));
    const tell = (event) => events.push({ event, session: s });
    if (RUNNING.has(now)) {
      if (!RUNNING.has(was)) tell('started');
      if (now === 'needs-you') tell('needs-you');
      else if (now === 'done' && !byItself) tell('done');
    } else if (now === 'failed') tell('failed');
    else if (now === 'ended' && LIVE.has(was)) tell('finished');
  }
  return { phases, events };
}

/**
 * --kind's value: kinds separated by commas.
 * @returns {Set<string>|null}  null for every kind
 */
export function parseKinds(value, fail) {
  if (value === undefined) return null;
  const kinds = String(value).split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
  const unknown = kinds.find((k) => !KINDS.includes(k));
  if (unknown || !kinds.length) throw fail(`--kind takes ${KINDS.join(', ')}, separated by commas${unknown ? `: not ${unknown}` : ''}`);
  return new Set(kinds);
}

/**
 * --every's value, in seconds: how often the list is read. The console answers it from memory, but a watch runs for
 * hours on many laptops at once, so it is never asked more than every 5 s.
 * @returns {number}  milliseconds
 */
export function parseEvery(value, fail) {
  if (value === undefined) return 15_000;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 5 || seconds > 600) throw fail('--every is a number of seconds, from 5 to 600');
  return Math.round(seconds * 1000);
}
