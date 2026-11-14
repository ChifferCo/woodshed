// Push notifications to people's phones (console/README.md, "Push notifications"). The phone app registers each phone
// with a relay, which alone holds the Apple key, and then here, with the relay's handle for it and a key of its own.
// The console decides when to notify and whom, seals what it says with that phone's key, and hands the relay only the
// handle and the sealed text, so the relay passes on what it cannot read.
//
// Only you are notified: about your private sessions, and the shared ones assigned to you; an admin also hears of
// someone asking to join. Never about a session you have open (the console saw you read it in the last 30 s: its
// page, its terminals, a change through its routes, or the page's poll while it shows it). A notification may have
// up to two reminders, held by quiet hours on the phone's clock (pushSchedule.mjs); once what it is about is dealt
// with (a new turn, stopped, its pull request closed, opened, seen) the reminders are dropped and the phones that
// showed it are told to take it down. Phones, notifications and reminders are kept in state.json under `push`, so a
// restart loses none. Best effort: a relay that fails is logged and changes nothing else, and one that says a phone is
// gone drops it.

import { createCipheriv, randomBytes } from 'node:crypto';

import logins from './public/logins.cjs';
import { ACTIVE_STATUSES, START_STEPS, isAsk, isQa, isReview } from './sessions.mjs';
import { afterQuietHours, clockText, reminderTimes, validTimeZone } from './pushSchedule.mjs';
const { sameLogin } = logins;

export const DEFAULT_RELAY = 'https://console.woodshed.run/push';
export const KINDS = ['waiting', 'prReady', 'prStuck', 'startFailed', 'started', 'assigned', 'planLimit', 'planReset', 'joinRequest'];
// A phone hears every kind until its owner turns one off, but a queued session starting: that is most sessions.
const OFF_BY_DEFAULT = new Set(['started']);
export const MAX_REMINDERS = 2;
// A read of a session's page or routes this recent means its person has it open.
export const LOOKING_MS = 30_000;
// A turn has to stay ended this long before it counts: claude's state can flick to done and back between two tools.
export const IDLE_SETTLE_MS = 15_000;
// A session that waited in line at least this long before it started is "a queued session started".
export const QUEUED_MS = 60_000;
const RELAY_TIMEOUT_MS = 10_000;
// A notification nobody dealt with is forgotten after this, without telling the phones.
const NOTE_TTL_MS = 7 * 24 * 3_600_000;
const MAX_DEVICES = 10;
const MAX_SNOOZE_MINUTES = 7 * 24 * 60;
const TITLE_CHARS = 120;
const BODY_CHARS = 500;
const NAME_CHARS = 100;
const ID_RE = /^[0-9a-f]{16}$/;
// The relay's handle: random, base64url (the relay makes it from 32 bytes).
const HANDLE_RE = /^[A-Za-z0-9_-]{22,512}$/;
const IDLE_STATES = new Set(['done', 'needs-you']);
// What Claude Code writes as its turn when the plan refuses it, as "You've hit your limit · resets 3pm" or "5-hour
// limit reached ∙ resets 2pm". Only a short message counts, so claude writing about limits in a reply does not.
const LIMIT_TEXT_RE = /hit your (?:[\w-]+ )?limit|\blimit reached\b/i;
const LIMIT_TEXT_CHARS = 200;
// The start steps, the machine first as the console adds it, and what each is called when a start fails at it.
const STEPS = ['machine', ...START_STEPS];
const STEP_WORDS = {
  machine: 'getting a machine',
  container: 'starting the container',
  settings: 'fetching its settings',
  home: 'restoring the Claude home',
  branch: 'checking out the branch',
  databases: 'getting its databases',
  env: 'writing the env files and the prompt',
  claude: 'opening the agent',
};

function shown(message) {
  return Object.assign(new Error(message), { shown: true });
}

function cut(text, chars) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > chars ? `${s.slice(0, chars - 1)}…` : s;
}

/**
 * A relay's address as the allowlist and a device keep it: http(s), no credentials, query or fragment, no trailing slash.
 * @returns {string|null}
 */
export function relayUrl(text) {
  let url;
  try {
    url = new URL(String(text ?? '').trim());
  } catch {
    return null;
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * @param {string|undefined} value  WOODSHED_PUSH_RELAYS: comma-separated; unset is the default relay, empty is none
 * @returns {string[]}  the relays a phone may name
 */
export function parseRelays(value) {
  const listed = (value === undefined || value === null ? DEFAULT_RELAY : String(value)).split(',').map((s) => s.trim()).filter(Boolean);
  const relays = [];
  for (const text of listed) {
    const url = relayUrl(text);
    if (url) relays.push(url);
    else console.warn('push: a relay in WOODSHED_PUSH_RELAYS is not an http(s) address, left out', { relay: text.slice(0, 100) });
  }
  return [...new Set(relays)];
}

/**
 * Seals a body for one phone: AES-256-GCM with a random 12-byte nonce, as base64 of nonce, ciphertext and the 16-byte tag.
 * @param {Buffer} key  32 bytes, the phone's
 * @param {object} body
 * @returns {string}
 */
export function seal(key, body) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const text = Buffer.concat([cipher.update(JSON.stringify(body), 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, text, cipher.getAuthTag()]).toString('base64');
}

/** @returns {Record<string, boolean>}  each kind on or off: what was given, else what it was, else the default */
function kindsFrom(given, base = null) {
  return Object.fromEntries(KINDS.map((k) => [k, typeof given?.[k] === 'boolean' ? given[k] : base?.[k] ?? !OFF_BY_DEFAULT.has(k)]));
}

function checkKinds(kinds) {
  if (kinds !== undefined && (typeof kinds !== 'object' || kinds === null || Array.isArray(kinds))) throw shown('kinds must be an object of true and false');
}

function checkName(name) {
  if (name === undefined) return undefined;
  if (typeof name !== 'string' || !name.trim() || name.length > NAME_CHARS || /[\p{C}]/u.test(name)) throw shown(`name must be one line of at most ${NAME_CHARS} characters`);
  return name.trim();
}

function checkTimeZone(timeZone) {
  if (timeZone === undefined) return undefined;
  if (!validTimeZone(timeZone)) throw shown('timeZone must be an IANA time zone, such as America/Los_Angeles');
  return timeZone;
}

/** @returns {{id: string, name: string, timeZone: string, kinds: object, createdAt: string}}  never the handle or key */
function publicDevice({ id, name, timeZone, kinds, createdAt }) {
  return { id, name, timeZone, kinds: kindsFrom(kinds), createdAt };
}

/**
 * Whose a session's notifications are: a private session's owner, a shared one's assignee. A question from Slack, a QA
 * run and a review run are nobody's: each reports on its own, and nobody answers it.
 * @returns {string|null}
 */
export function recipientOf(session) {
  if (!session || isAsk(session) || isQa(session) || isReview(session)) return null;
  return session.owner ?? session.assignee ?? null;
}

/** @returns {string}  the step a start failed at: the one after the last it reported */
export function failedStep(session) {
  const done = STEPS.reduce((last, step, i) => (session.startSteps?.[step] ? i : last), -1);
  return STEPS[Math.min(done + 1, STEPS.length - 1)];
}

/**
 * Whether a turn ended on the plan's limit: a window of the plan usage the session reports is used up and resets later,
 * or claude's last message is Claude Code's own "hit your limit". Only a private session reports its plan's usage
 * (sessions.mjs, statusUpdate).
 * @returns {{resetsAt: string|null}|null}
 */
export function planLimitOf(session, now) {
  const usage = session.planUsage;
  const windows = [usage?.fiveHour, usage?.sevenDay].filter((w) => w?.resetsAt && Date.parse(w.resetsAt) > now);
  const full = windows.filter((w) => w.usedPercent >= 100);
  const message = session.lastMessage;
  const said = message?.role === 'claude' && String(message.text ?? '').length <= LIMIT_TEXT_CHARS && LIMIT_TEXT_RE.test(message.text);
  if (!full.length && !said) return null;
  // The window that holds it longest is the one it waits for; with only the message, the fullest one.
  const holding = full.length ? full.sort((a, b) => Date.parse(b.resetsAt) - Date.parse(a.resetsAt))[0]
    : windows.sort((a, b) => b.usedPercent - a.usedPercent)[0];
  return { resetsAt: holding?.resetsAt ?? null };
}

/**
 * @param {{store: {state: object, save: () => void}, relays?: string[], sessions?: () => object[],
 *          admins?: () => string[], now?: () => number, fetch?: typeof fetch}} deps
 *   `relays`: the allowlist (parseRelays); `sessions`: the fleet's; `admins`: who hears of someone asking to join
 */
export function createPush({ store, relays = [], sessions = () => [], admins = () => [], now = Date.now, fetch: fetchImpl = globalThis.fetch }) {
  const allowed = new Set(relays);
  // Each session's turn, for `waiting`: whether it worked since it was last told, since when it has been idle, and
  // whether this idle turn was told. Not kept: after a restart a session's first read starts from what state.json says.
  const turns = new Map();
  // When each person last read each session, `<login>\n<id>`.
  const reads = new Map();
  // Sends in flight, so a test can wait for them; nothing else waits on the relay.
  const inFlight = new Set();
  // Each alert the relay has not answered yet, `<ref>\n<device id>`: one dealt with meanwhile is taken down once it lands.
  const alerts = new Map();

  function data() {
    const push = (store.state.push ??= {});
    push.devices ??= [];
    push.notes ??= [];
    push.watches ??= [];
    return push;
  }

  const devicesOfLogin = (login) => data().devices.filter((d) => sameLogin(d.login, login));
  const deviceById = (id) => data().devices.find((d) => d.id === id) ?? null;
  const newId = () => randomBytes(8).toString('hex');
  const readKey = (login, id) => `${String(login ?? '').toLowerCase()}\n${id}`;

  // Never throws: a phone's notification must not get in the way of what the console was doing.
  function guarded(what, fn) {
    try {
      return fn();
    } catch (err) {
      console.warn(`push: ${what} failed`, { message: String(err?.message ?? err).split('\n')[0] });
      return null;
    }
  }

  function track(promise) {
    inFlight.add(promise);
    promise.finally(() => inFlight.delete(promise));
    return promise;
  }

  /** @returns {Promise<boolean>}  true when the relay took it; false otherwise, logged */
  async function post(device, payload, what) {
    if (!allowed.has(device.relay)) {
      console.warn('push: the device\'s relay is no longer allowed, not sent', { device: device.id, login: device.login, what });
      return false;
    }
    try {
      const res = await fetchImpl(`${device.relay}/v1/push`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handle: device.handle, ...payload }),
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      });
      if (res.status === 410) {
        console.log('push: the relay says the device is gone, dropped', { device: device.id, login: device.login });
        dropDevice(device.id);
        return false;
      }
      if (!res.ok) {
        console.warn('push: the relay refused a push', { device: device.id, what, status: res.status });
        return false;
      }
      return true;
    } catch (err) {
      console.warn('push: the relay did not answer', { device: device.id, what, message: String(err?.message ?? err).split('\n')[0] });
      return false;
    }
  }

  // ---- Phones ----------------------------------------------------------------------------------------------------

  /**
   * @param {string} login
   * @param {{handle: unknown, key: unknown, relay: unknown, name?: unknown, timeZone?: unknown, kinds?: unknown}} body
   * @returns {{id: string}}
   * @throws {Error}  with a message the app can show
   */
  function register(login, body) {
    const handle = body?.handle;
    if (typeof handle !== 'string' || !HANDLE_RE.test(handle)) throw shown('handle must be the relay\'s handle for this phone');
    const key = typeof body?.key === 'string' && /^[A-Za-z0-9+/_-]+={0,2}$/.test(body.key) ? Buffer.from(body.key, 'base64') : null;
    if (key?.length !== 32) throw shown('key must be 32 bytes, as base64');
    const relay = relayUrl(body?.relay);
    // Only a relay the console allows: anything else would have the console post wherever a request said.
    if (!relay || !allowed.has(relay)) throw shown('that relay is not one this console sends to');
    const name = checkName(body?.name) ?? 'Phone';
    const timeZone = checkTimeZone(body?.timeZone) ?? 'UTC';
    checkKinds(body?.kinds);
    const push = data();
    // The same handle again is the same phone, registered again: it keeps its id, and moves to whoever registers it.
    const earlier = push.devices.find((d) => d.handle === handle) ?? null;
    if (!earlier && devicesOfLogin(login).length >= MAX_DEVICES) throw shown(`at most ${MAX_DEVICES} phones each: remove one first`);
    const device = {
      id: earlier?.id ?? newId(), login, handle, key: key.toString('base64'), relay, name, timeZone,
      kinds: kindsFrom(body?.kinds), createdAt: earlier && sameLogin(earlier.login, login) ? earlier.createdAt : new Date(now()).toISOString(),
    };
    if (earlier && !sameLogin(earlier.login, login)) dropDevice(earlier.id);
    push.devices = [...push.devices.filter((d) => d.id !== device.id), device];
    store.save();
    console.log('push: device registered', { login, device: device.id, again: Boolean(earlier), timeZone });
    return { id: device.id };
  }

  /** @returns {object[]}  the person's phones, without handle or key */
  function devicesOf(login) {
    return devicesOfLogin(login).map(publicDevice);
  }

  /** @returns {object|null}  the device after the change, or null when the person has none with that id */
  function updateDevice(login, id, body) {
    const device = deviceById(id);
    if (!device || !sameLogin(device.login, login)) return null;
    checkKinds(body?.kinds);
    const name = checkName(body?.name);
    const timeZone = checkTimeZone(body?.timeZone);
    if (body?.kinds !== undefined) device.kinds = kindsFrom(body.kinds, kindsFrom(device.kinds));
    if (name !== undefined) device.name = name;
    if (timeZone !== undefined) device.timeZone = timeZone;
    store.save();
    console.log('push: device changed', { login, device: id });
    return publicDevice(device);
  }

  function dropDevice(id) {
    const push = data();
    push.devices = push.devices.filter((d) => d.id !== id);
    for (const note of push.notes) delete note.targets[id];
    push.notes = push.notes.filter((n) => Object.keys(n.targets).length);
    store.save();
  }

  /** @returns {boolean}  whether the person had a phone with that id */
  function removeDevice(login, id) {
    const device = deviceById(id);
    if (!device || !sameLogin(device.login, login)) return false;
    dropDevice(id);
    console.log('push: device removed', { login, device: id });
    return true;
  }

  // ---- Looking ---------------------------------------------------------------------------------------------------

  /** Whoever is signed in read one of the session's pages or routes: they have it open, and its notifications are dealt with. */
  function saw(login, sessionId) {
    if (!login || !sessionId) return;
    reads.set(readKey(login, sessionId), now());
    guarded('opened', () => resolve(data().notes.filter((n) => n.session === sessionId && sameLogin(n.login, login)), 'opened'));
  }

  /** @returns {boolean}  whether the person read the session in the last LOOKING_MS */
  function isLooking(login, sessionId) {
    const at = reads.get(readKey(login, sessionId));
    return at !== undefined && now() - at <= LOOKING_MS;
  }

  // ---- Notifications ---------------------------------------------------------------------------------------------

  function bodyFor(note, device) {
    if (note.kind === 'planLimit') {
      return note.resetsAt ? `${note.body} Resets ${clockText(Date.parse(note.resetsAt), device.timeZone, now())}.` : note.body;
    }
    return note.body;
  }

  function sendAlert(note, device, reminder) {
    const sealed = seal(Buffer.from(device.key, 'base64'), {
      v: 1, kind: note.kind, id: note.ref, session: note.session, title: note.title, body: cut(bodyFor(note, device), BODY_CHARS), url: note.url, reminder,
    });
    const payload = {
      type: 'alert', collapseId: note.collapseId, threadId: note.threadId, ...(note.kind === 'waiting' ? { timeSensitive: true } : {}), sealed,
    };
    const key = `${note.ref}\n${device.id}`;
    const sent = post(device, payload, `${note.kind} ${reminder}`).then((ok) => {
      if (alerts.get(key) === sent) alerts.delete(key);
      // Dealt with while the relay answered: resolve has its clear waiting on this.
      const target = note.targets[device.id];
      if (!ok || !target || !data().notes.includes(note)) return ok;
      target.shown = true;
      store.save();
      return ok;
    });
    alerts.set(key, sent);
    return track(sent);
  }

  function sendClear(device, ids) {
    const sealed = seal(Buffer.from(device.key, 'base64'), { v: 1, kind: 'clear', ids });
    return track(post(device, { type: 'clear', sealed }, 'clear'));
  }

  /**
   * Notes that are dealt with: their reminders go, and each phone that showed one is told to take it down.
   * @param {object[]} notes
   */
  function resolve(notes, why) {
    if (!notes.length) return;
    const push = data();
    push.notes = push.notes.filter((n) => !notes.includes(n));
    store.save();
    const shownOn = new Map();
    for (const note of notes) {
      for (const [id, target] of Object.entries(note.targets)) {
        const landing = alerts.get(`${note.ref}\n${id}`);
        if (target.shown) shownOn.set(id, [...(shownOn.get(id) ?? []), note.ref]);
        else if (landing) {
          // Still on its way: taken down once the relay has it, so the clear cannot pass it.
          track(landing.then((ok) => {
            const device = ok && deviceById(id);
            if (device) return sendClear(device, [note.ref]);
          }));
        }
      }
      console.log('push: notification dealt with', { ref: note.ref, kind: note.kind, session: note.session, why });
    }
    for (const [id, refs] of shownOn) {
      const device = deviceById(id);
      if (device) sendClear(device, refs);
    }
  }

  /**
   * A notification to one person's phones, those with its kind on. Nothing when they have none, or have its session open.
   * @param {{login: string, kind: string, session?: string|null, title: string, body: string, url: string,
   *          collapseId: string, threadId: string, pauseAt?: number|null, resetsAt?: string|null, subject?: string|null}} args
   * @returns {object|null}  the note
   */
  function notify({ login, kind, session = null, title, body, url, collapseId, threadId, pauseAt = null, resetsAt = null, subject = null }) {
    const devices = devicesOfLogin(login).filter((d) => kindsFrom(d.kinds)[kind]);
    if (!devices.length) return null;
    if (session && isLooking(login, session)) {
      console.log('push: not sent, they have the session open', { login, kind, session });
      return null;
    }
    const push = data();
    // An earlier one with the same collapse id is replaced on the phone by this one, so it goes without a clear.
    push.notes = push.notes.filter((n) => !(sameLogin(n.login, login) && n.collapseId === collapseId));
    const at = now();
    const targets = Object.fromEntries(devices.map((d) => {
      const times = reminderTimes(kind, { at, pauseAt }, d.timeZone).slice(0, MAX_REMINDERS);
      return [d.id, { times, count: 0, nextAt: times.length ? afterQuietHours(times[0], d.timeZone) : null, snoozed: false, shown: false }];
    }));
    const note = {
      ref: newId(), login, kind, session, subject, title: cut(title, TITLE_CHARS), body: cut(body, BODY_CHARS), url, collapseId, threadId,
      resetsAt, createdAt: new Date(at).toISOString(), targets,
    };
    push.notes.push(note);
    store.save();
    console.log('push: notification', { ref: note.ref, login, kind, session, devices: devices.length });
    for (const device of devices) sendAlert(note, device, 0);
    return note;
  }

  const sessionTitle = (session) => session.title || `Session ${session.id}`;

  function notifySession(session, kind, fields) {
    const login = recipientOf(session);
    if (!login) return null;
    return notify({
      login, kind, session: session.id, title: sessionTitle(session), url: `/s/${session.id}`,
      collapseId: `${session.id}:${kind}`, threadId: session.id, ...fields,
    });
  }

  function planLimit(session, limit) {
    const login = recipientOf(session);
    if (!login) return;
    const note = notifySession(session, 'planLimit', { body: 'Stopped on your plan\'s limit.', resetsAt: limit.resetsAt });
    // planReset follows, at the reset, whether or not this one went out: a phone may have planLimit off.
    if (!limit.resetsAt) return note;
    const push = data();
    push.watches = [...push.watches.filter((w) => w.session !== session.id), { kind: 'planReset', login, session: session.id, at: limit.resetsAt }];
    store.save();
    return note;
  }

  /**
   * A status read of a running session (fleet.mjs, readStatus). `waiting` goes out once per idle turn: after claude
   * worked, its state is done or needs-you, and has stayed so for IDLE_SETTLE_MS. A turn that ended on the plan's
   * limit is `planLimit` instead.
   * @param {object} session  after the read
   * @param {{wasState?: string|null, pauseAt?: number|null}} [args]  the state before the read; when the idle pause comes
   */
  function statusRead(session, { wasState = null, pauseAt = null } = {}) {
    return guarded('status read', () => {
      let turn = turns.get(session.id);
      if (!turn) {
        turn = { worked: wasState === 'working', idleSince: null, told: false };
        turns.set(session.id, turn);
      }
      if (session.state === 'working') {
        Object.assign(turn, { worked: true, idleSince: null, told: false });
        return null;
      }
      if (!IDLE_STATES.has(session.state)) {
        turn.idleSince = null;
        return null;
      }
      if (!turn.worked || turn.told) return null;
      turn.idleSince ??= now();
      if (now() - turn.idleSince < IDLE_SETTLE_MS) return null;
      Object.assign(turn, { told: true, worked: false });
      const limit = planLimitOf(session, now());
      if (limit) return planLimit(session, limit);
      const text = session.lastMessage?.role === 'claude' ? session.lastMessage.text : '';
      const body = session.state === 'needs-you'
        ? `Needs your permission${text ? `: ${text}` : '.'}`
        : text || 'Waiting for you.';
      return notifySession(session, 'waiting', { body, pauseAt });
    });
  }

  /**
   * Any change to a session (fleet.mjs, update): what it makes dealt with goes. A new turn ends `waiting` and the plan's
   * notes; stopping ends `waiting`; a closed pull request ends `prReady` and `prStuck`; starting again ends
   * `startFailed`; a session now someone else's ends all of its notes for whoever had it.
   */
  function sessionChanged(session) {
    return guarded('session change', () => {
      const gone = !ACTIVE_STATUSES.has(session.status);
      if (gone) turns.delete(session.id);
      const notes = data().notes.filter((n) => n.session === session.id);
      if (!notes.length) return;
      const recipient = recipientOf(session);
      const working = session.status === 'running' && session.state === 'working';
      const done = notes.filter((n) => !sameLogin(n.login, recipient)
        || (n.kind === 'waiting' && (gone || working))
        || ((n.kind === 'planLimit' || n.kind === 'planReset') && working)
        || ((n.kind === 'prReady' || n.kind === 'prStuck') && session.prClosedAt)
        || (n.kind === 'startFailed' && !gone));
      resolve(done, 'dealt with');
    });
  }

  /** The session started after waiting in line (fleet.mjs, readStatus, on its first read as running). */
  function started(session) {
    return guarded('started', () => {
      // In line since it was made, or since its last resume.
      const since = Math.max(...[session.createdAt, session.resumedAt, session.queuedAt].map((t) => Date.parse(t ?? '')).filter(Number.isFinite));
      const waited = Date.parse(session.startedAt) - since;
      if (!(waited >= QUEUED_MS)) return null;
      return notifySession(session, 'started', { body: 'Started: it was waiting in line.' });
    });
  }

  /** The session failed to start: its launch, its container, or its start timeout. */
  function startFailed(session) {
    return guarded('start failed', () => {
      const step = failedStep(session);
      const why = session.error || session.stopReason || '';
      return notifySession(session, 'startFailed', { body: `Did not start: it failed at ${STEP_WORDS[step] ?? step}${why ? `. ${why}` : '.'}` });
    });
  }

  /** Someone other than the assignee assigned them the session. */
  function assigned(session, by) {
    return guarded('assigned', () => {
      if (!session.assignee || session.owner || sameLogin(session.assignee, by)) return null;
      return notifySession(session, 'assigned', { body: `@${by} assigned it to you.` });
    });
  }

  /**
   * Its pull request passed its gates, as prAnnouncer posted it.
   * @param {{number: number, title?: string|null}} pull
   */
  function prReady(session, { number, title = null }) {
    return guarded('pull request ready', () => notifySession(session, 'prReady', {
      body: `#${number} is ready${title ? `: ${title}` : '.'}`,
    }));
  }

  /**
   * Its pull request needs a person: the approval wait gave up, or the session left a `Needs a human:` comment.
   * @param {{number: number, why: 'gave up'|'needs a human'}} pull
   */
  function prStuck(session, { number, why }) {
    return guarded('pull request stuck', () => notifySession(session, 'prStuck', {
      body: why === 'needs a human'
        ? `It asked for a person on #${number}.`
        : `#${number} was not approved with green checks in time.`,
    }));
  }

  /** Someone asks to join: every admin with a phone hears of it. */
  function joinRequest(login) {
    return guarded('join request', () => {
      for (const admin of admins()) {
        notify({
          login: admin, kind: 'joinRequest', subject: `join:${login}`, title: `@${login} asks to join`, body: 'Accept or decline on People.',
          url: '/people', collapseId: `join:${login}`, threadId: 'join',
        });
      }
    });
  }

  /** The request was accepted, declined or taken back. */
  function joinSettled(login) {
    return guarded('join settled', () => resolve(data().notes.filter((n) => n.subject && n.subject.toLowerCase() === `join:${String(login).toLowerCase()}`), 'settled'));
  }

  /** @returns {boolean}  false when the person has no notification with that ref */
  function seen(login, ref) {
    const note = ID_RE.test(String(ref)) ? data().notes.find((n) => n.ref === ref && sameLogin(n.login, login)) : null;
    if (!note) return false;
    resolve([note], 'seen');
    return true;
  }

  /**
   * The next reminder comes in `minutes`, whatever quiet hours and the cap say.
   * @returns {boolean}  false when the person has no notification with that ref
   * @throws {Error}  for minutes out of range
   */
  function snooze(login, ref, minutes) {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_SNOOZE_MINUTES) throw shown(`minutes must be a whole number from 1 to ${MAX_SNOOZE_MINUTES}`);
    const note = ID_RE.test(String(ref)) ? data().notes.find((n) => n.ref === ref && sameLogin(n.login, login)) : null;
    if (!note) return false;
    for (const target of Object.values(note.targets)) Object.assign(target, { nextAt: now() + minutes * 60_000, snoozed: true });
    store.save();
    console.log('push: notification snoozed', { ref, login, minutes });
    return true;
  }

  // ---- The loop --------------------------------------------------------------------------------------------------

  function remind(note, at) {
    for (const [id, target] of Object.entries(note.targets)) {
      if (target.nextAt === null || target.nextAt > at) continue;
      const device = deviceById(id);
      if (!device) {
        delete note.targets[id];
        continue;
      }
      if (note.session && isLooking(note.login, note.session)) return resolve([note], 'opened');
      if (!target.snoozed && target.count >= MAX_REMINDERS) {
        target.nextAt = null;
        continue;
      }
      target.count += 1;
      target.snoozed = false;
      const next = target.count < MAX_REMINDERS ? target.times.map((t) => afterQuietHours(t, device.timeZone)).find((t) => t > at) : undefined;
      target.nextAt = next ?? null;
      store.save();
      console.log('push: reminder', { ref: note.ref, kind: note.kind, device: id, reminder: target.count });
      sendAlert(note, device, target.count);
    }
  }

  function planResetDue(watch) {
    const session = sessions().find((s) => s.id === watch.session);
    // Going again, or gone: the reset has nobody waiting on it.
    if (!session || ['queued', 'starting'].includes(session.status) || (session.status === 'running' && session.state === 'working')) return;
    resolve(data().notes.filter((n) => n.session === session.id && n.kind === 'planLimit'), 'the plan reset');
    notifySession(session, 'planReset', { body: 'Your plan has reset: it can go on.' });
  }

  /** Due reminders, plan resets, and notes whose session is gone or that are too old. Every 30 s (installation.mjs). */
  function tick() {
    return guarded('tick', () => {
      const at = now();
      const push = data();
      const known = new Set(sessions().map((s) => s.id));
      resolve(push.notes.filter((n) => n.session && !known.has(n.session)), 'the session is gone');
      const old = push.notes.filter((n) => at - Date.parse(n.createdAt) > NOTE_TTL_MS);
      if (old.length) {
        push.notes = push.notes.filter((n) => !old.includes(n));
        store.save();
      }
      for (const note of [...push.notes]) remind(note, at);
      const due = push.watches.filter((w) => Date.parse(w.at) <= at);
      if (due.length) {
        push.watches = push.watches.filter((w) => !due.includes(w));
        store.save();
        for (const watch of due) planResetDue(watch);
      }
      for (const [key, readAt] of reads) if (at - readAt > LOOKING_MS) reads.delete(key);
    });
  }

  /** @returns {Promise<void>}  once every push sent so far has its answer */
  async function idle() {
    while (inFlight.size) await Promise.allSettled([...inFlight]);
  }

  return {
    get available() { return allowed.size > 0; },
    register, devicesOf, updateDevice, removeDevice, saw, isLooking, seen, snooze,
    statusRead, sessionChanged, started, startFailed, assigned, prReady, prStuck, joinRequest, joinSettled, tick, idle,
  };
}
