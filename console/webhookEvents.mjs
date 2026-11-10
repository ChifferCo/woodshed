// The Webhook events tab: each message the console took off the queue and what
// it did with it, newest first, for the last week. A delivery the Lambda refused
// never reaches the queue: GitHub's Recent Deliveries page shows those.
//
// Kept as one JSON line per message in a file of its own, beside state.json, so a
// restart keeps the list. state.json is rewritten whole on every save of any state,
// so the log stays out of it: a message costs one append, and a sweep every 12 hours
// rewrites the file without what is older than a week.

import fs from 'node:fs';

import { questionText } from './asks.mjs';

export const KEPT_MS = 7 * 24 * 3_600_000;
export const SWEEP_MS = 12 * 3_600_000;
const DETAIL_CHARS = 80;
const REASON_CHARS = 200;

/**
 * @typedef {{receivedAt: string|null, handledAt: string, deliveryId: string|null, type: string|null,
 *            number: number|null, kind: string|null, login: string|null, detail: string,
 *            outcome: 'started'|'sent'|'resumed'|'refreshed'|'ignored'|'duplicate'|'failed', sessionId: string|null, reason: string|null}} WebhookEvent
 *   `detail` is the label's name, the start of the `/woodshed` comment, or of a Slack mention's question, or what changed
 *   on a pull request. `refreshed` is a pull request change that marked it due, with what read it again as `reason`.
 */

/**
 * @param {object} message  one queued message's body
 * @returns {string}
 */
export function eventDetail(message) {
  if (message?.type === 'label') return String(message.label ?? '');
  if (message?.type === 'comment' || message?.type === 'needsHuman') return String(message.body ?? '').trim().split('\n')[0].slice(0, DETAIL_CHARS);
  if (message?.type === 'mention') return questionText(message.text).split('\n')[0].slice(0, DETAIL_CHARS);
  if (message?.type === 'pr') return String(message.what ?? '').slice(0, DETAIL_CHARS);
  return '';
}

/**
 * @param {{file: string, store?: {state: object, save: () => void}|null, now?: () => number}} opts
 *   `file` is the log's path; `store` is the console's state, whose `webhookEvents` (where the log was kept
 *   before) is moved into the file once and deleted
 */
export function createWebhookEvents({ file, store = null, now = Date.now }) {
  moveFromState();

  function moveFromState() {
    const old = store?.state?.webhookEvents;
    if (!Array.isArray(old)) return;
    if (old.length) fs.appendFileSync(file, toLines([...old].reverse()), { mode: 0o600 });
    delete store.state.webhookEvents;
    store.save();
    console.log('webhookEvents: moved out of state.json', { count: old.length });
  }

  /**
   * @param {object|null} message  the queued body, or null when it could not be read
   * @param {{outcome: WebhookEvent['outcome'], sessionId?: string, reason?: string}} result
   */
  function record(message, { outcome, sessionId, reason }) {
    /** @type {WebhookEvent} */
    const entry = {
      receivedAt: message?.receivedAt ?? null,
      handledAt: new Date(now()).toISOString(),
      deliveryId: message?.deliveryId ?? message?.eventId ?? null,
      type: message?.type ?? null,
      number: Number.isInteger(message?.number) ? message.number : null,
      kind: message?.kind ?? null,
      login: message?.login ?? (message?.source === 'slack' && message.user ? `slack:${message.user}` : null),
      detail: eventDetail(message),
      outcome,
      sessionId: sessionId ?? null,
      reason: reason ? String(reason).slice(0, REASON_CHARS) : null,
    };
    fs.appendFileSync(file, toLines([entry]), { mode: 0o600 });
  }

  /** @returns {WebhookEvent[]}  oldest first, as written */
  function recent() {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const since = now() - KEPT_MS;
    return text.split('\n').map(parseLine).filter((e) => e && !(Date.parse(e.handledAt) < since));
  }

  /** @returns {WebhookEvent[]}  newest first */
  function list() {
    return recent().reverse();
  }

  // Through a temp file and a rename, like state.json, so a crash leaves the old file or the new one.
  function sweep() {
    if (!fs.existsSync(file)) return;
    const kept = recent();
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, toLines(kept), { mode: 0o600 });
    fs.renameSync(tmp, file);
    console.log('webhookEvents: swept', { kept: kept.length });
  }

  return { record, list, sweep };
}

function toLines(entries) {
  return entries.map((e) => `${JSON.stringify(e)}\n`).join('');
}

// A crash in the middle of an append can leave half a line; it is skipped, and the next sweep drops it.
function parseLine(line) {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}
