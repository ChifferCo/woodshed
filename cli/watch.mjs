// `woodshed session watch`: what changed in the sessions the console lists, as one event per session that starts, runs,
// is done with its turn, needs its person, pauses, stops, finishes or fails. The command reads the console's list (GET
// /api/sessions) every few seconds and hands each read to `changes`, which compares it with the last: nothing here reads
// the network, so a mod, a script or a test sees the same events from the same lists.
//
// Each session is in one phase at a time, from the page's own words for it (sessions.mjs, stateOf):
//   pending   in line or starting
//   working   running, its agent busy (or still opening)
//   done      running, its agent done with its turn, or exited: waiting for a message
//   needs-you running, asking its person something (a question, an approval)
//   stopping  on its way out: no event until it has stopped, so a review's or QA's verdict is there to say
//   failed    failed to start, or failed
//   ended     stopped, paused, finished, merged or deleted
// An event is a move into a phase that matters to the person: `starting` (into pending: new, or resumed), `started`
// (into running from anything else), `done`, `needs-you`, `failed`, and, into ended from a live phase, one of `paused`
// (idle), `stopped` (at its lifetime, by a person, or otherwise) or `finished` (a review's or QA's verdict, a pull request
// merged or closed, posted to Slack), with `why`. A review or QA run works by itself, so its turns are not told: it says
// `starting`, `started`, `needs-you` if it asks, then `finished` with its verdict, or `failed`.
//
// `herdrRecord` is the same event as an OSC 7501 record: what a terminal running the watch inside Herdr's hc writes, so
// the Herdr app shows each session's state, and sounds and toasts as it does for its own agents, with no machine added.

import { stateOf } from './sessions.mjs';

export const EVENT_NAMES = ['starting', 'started', 'done', 'needs-you', 'paused', 'stopped', 'finished', 'failed'];
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
 * How a session that ended did, from what the console keeps of its stop (console/sessions.mjs, stopReason: `idle for
 * 2 h` at its idle pause, `ran for 12 h` at its lifetime; `stoppedBy` when a person stopped it).
 * @returns {{event: 'paused'|'stopped'|'finished', why: string}}
 */
export function endOf(s, kind) {
  if (kind === 'review' || kind === 'qa') return { event: 'finished', why: 'reported' };
  if (s.prClosedAt) return { event: 'finished', why: s.prMerged ? 'merged' : 'closed' };
  if (s.slackPostedAt || s.stopReason === 'posted to Slack') return { event: 'finished', why: 'posted' };
  if (s.stoppedBy) return { event: 'stopped', why: 'person' };
  const reason = String(s.stopReason ?? '');
  if (/^idle for /.test(reason)) return { event: 'paused', why: 'idle' };
  if (/^ran for /.test(reason)) return { event: 'stopped', why: 'lifetime' };
  if (s.cleanedAt) return { event: 'stopped', why: 'deleted' };
  return { event: 'stopped', why: 'other' };
}

/**
 * The events between two reads of the list.
 * @param {Map<string, string>|null} before  each session's phase at the last read, by id; null for the first read,
 *   which only learns what is there: a watch tells what happens from when it starts
 * @param {object[]} sessions  the console's sessions, as /api/sessions lists them
 * @param {{kindOf: (s: object) => string}} opts
 * @returns {{phases: Map<string, string>, events: {event: string, why?: string, session: object}[]}}
 */
export function changes(before, sessions, { kindOf }) {
  const phases = new Map();
  const events = [];
  for (const s of sessions) {
    const now = phaseOf(s);
    phases.set(s.id, now);
    if (!before) continue;
    const seen = before.get(s.id);
    if (seen === now) continue;
    const byItself = ['review', 'qa'].includes(kindOf(s));
    const tell = (event, why) => events.push({ event, ...(why ? { why } : {}), session: s });
    // One that appeared since the last read was in line a moment ago, as far as this watch knows.
    const was = seen ?? 'pending';
    if (now === 'pending') {
      if (seen !== 'pending') tell('starting');
    } else if (RUNNING.has(now)) {
      if (!RUNNING.has(was)) tell('started');
      if (now === 'needs-you') tell('needs-you');
      else if (now === 'done' && !byItself) tell('done');
    } else if (now === 'failed') tell('failed');
    else if (now === 'ended' && LIVE.has(was)) {
      const end = endOf(s, kindOf(s));
      tell(end.event, end.why);
    }
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

// The words after an event, in a line and in a Herdr record's message.
const WHY_TEXT = {
  idle: 'idle', lifetime: 'at its lifetime', person: 'by a person', deleted: 'deleted', other: null,
  merged: 'merged', closed: 'closed', posted: 'posted to Slack', reported: null,
};

/**
 * What an event says after its name: a verdict, why it ended, or why it failed.
 * @param {{event: string, why?: string}} e
 * @param {object} x  the session as summary() gives it
 * @returns {string|null}
 */
export function eventDetail(e, x) {
  if (e.event === 'failed') return x.error ?? x.stopReason ?? null;
  if (e.event === 'finished') return x.verdict ?? WHY_TEXT[e.why] ?? x.stateWord;
  if (e.event === 'stopped' && e.why === 'person') return x.stoppedBy ? `by @${x.stoppedBy}` : WHY_TEXT.person;
  if (e.event === 'paused' || e.event === 'stopped') return WHY_TEXT[e.why] ?? x.stopReason ?? null;
  return null;
}

/** @returns {string}  what a session's machine in Herdr is told when the session pauses or stops */
export function unreachableText(machine, id) {
  return `${machine} in Herdr is unreachable until it runs again: woodshed session herdr ${id} brings it back`;
}

// An OSC 7501 record's state for each event (`hc schema`, Status: idle, working, done, blocked or error). Herdr sounds
// and toasts on its own agents' done, blocked and error: a session pausing or stopping is told as done, its failure as
// error, a question as blocked.
const RECORD_STATE = {
  starting: 'working', started: 'working', done: 'done', 'needs-you': 'blocked',
  paused: 'done', stopped: 'done', finished: 'done', failed: 'error',
};

// Text in a record is base64 (hc refuses one whose msg or title is not), and a record is kept short.
const RECORD_TITLE_MAX = 80;
const RECORD_MSG_MAX = 300;
const b64 = (text, most) => Buffer.from(String(text).slice(0, most), 'utf8').toString('base64');

/**
 * The OSC 7501 record a session's event is in Herdr: one record per session (`id=<session>`), on the terminal the watch
 * runs in, replacing that session's last. hc keeps it in the terminal's `records`, and the Herdr app shows it.
 * @param {{event: string, why?: string}} e
 * @param {object} x  the session as summary() gives it
 * @param {{machine?: string|null}} [opts]  its machine in Herdr, when it is one
 * @returns {string}
 */
export function herdrRecord(e, x, { machine = null } = {}) {
  const detail = eventDetail(e, x);
  const words = [`${x.id} ${e.event}${detail ? ` (${detail})` : ''}`];
  if (machine && (e.event === 'paused' || e.event === 'stopped')) words.push(unreachableText(machine, x.id));
  if (e.event === 'needs-you' || e.event === 'failed') words.push(x.url);
  const pairs = [
    `id=${x.id}`, `state=${RECORD_STATE[e.event]}`, ...(e.event === 'needs-you' ? ['kind=question'] : []), 'app=woodshed',
    `title=${b64(x.title ?? `${x.kind} ${x.id}`, RECORD_TITLE_MAX)}`, `msg=${b64(words.join('. '), RECORD_MSG_MAX)}`,
  ];
  return `\x1b]7501;${pairs.join(':')}\x07`;
}

/** @returns {string}  the OSC 7501 report that takes a session's record off the watch's terminal */
export function herdrClear(id) {
  return `\x1b]7501;id=${id}:state=clear\x07`;
}
