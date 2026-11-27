// The session list as it changes, pushed to each open page (GET /api/sessions/live, server-sent events), so a card on
// the rail says Working, Done or Needs you within a second or two of the console knowing it, rather than at the page's
// next poll of the whole list.
//
// A page gets the whole list first (`full`, what GET /api/sessions answers), then only what changed (`patch`): the
// list's own fields that changed, each session's fields that changed, and the order of ids when a session came, went
// or moved. Each change the fleet makes is sent within DEBOUNCE_MS; what the list carries from elsewhere (pull request
// chips, Slack's waits) is compared every SWEEP_MS. The page still polls, less often, so a stream a proxy holds back
// or cuts costs it nothing but time.
//
// Before each send the stream's own request is signed in again (`stillAllowed`, the same check every request gets): one
// person removed from People, or signed out, gets nothing more, and their stream ends. A stream also ends after
// MAX_AGE_MS and the browser opens it again. The console's stop ends them all (closeAll), so a redeploy is not held up
// by them.

export const DEBOUNCE_MS = 100;
export const SWEEP_MS = 3_000;
export const HEARTBEAT_MS = 25_000;
export const MAX_AGE_MS = 5 * 60_000;
// How soon the browser opens a stream again after it ends.
const RETRY_MS = 1_000;
// A sign-in check (an embedding program's stillSignedIn among them) that has not answered in this long is a no: the
// stream ends, and the browser opens it again, checked afresh.
export const CHECK_TIMEOUT_MS = 2_000;
// What may wait in a stream for a browser that stopped reading: past it, the stream ends, and the page polls or opens a
// new one, rather than the console holding every change for it.
export const MAX_BUFFERED_BYTES = 1024 * 1024;

/**
 * What changed between two lists, as a patch, or null when nothing did. Each session is compared field by field, and
 * sent with only its fields that changed (a working session's are mostly its usage and last activity, every read).
 * @param {{top: Map<string, string>, sessions: Map<string, Map<string, string>>, ids: string}|null} last  what was sent
 * @param {object} body  a list as GET /api/sessions answers it
 * @returns {{patch: {top?: object, sessions?: object[], unset?: object, ids?: string[]}|null, sent: object}}
 *   `sessions` holds `{id, ...changed}` for each session that changed, the whole of one that is new; `unset`, by id, the
 *   fields a session no longer has
 */
export function diffList(last, body) {
  const fields = (value) => new Map(Object.entries(value).map(([key, v]) => [key, JSON.stringify(v) ?? 'null']));
  const { sessions: list = [], ...rest } = body;
  const top = fields(rest);
  const sessions = new Map(list.map((s) => [s.id, fields(s)]));
  const ids = JSON.stringify([...sessions.keys()]);
  const sent = { top, sessions, ids };
  if (!last) return { patch: null, sent };
  const patch = {};
  const changedTop = {};
  for (const [key, json] of top) if (last.top.get(key) !== json) changedTop[key] = JSON.parse(json);
  if (Object.keys(changedTop).length) patch.top = changedTop;
  const changed = [];
  const unset = {};
  for (const s of list) {
    const before = last.sessions.get(s.id);
    const now = sessions.get(s.id);
    const delta = {};
    for (const [key, json] of now) if (before?.get(key) !== json) delta[key] = s[key];
    if (Object.keys(delta).length) changed.push({ ...delta, id: s.id });
    const gone = before ? [...before.keys()].filter((key) => !now.has(key)) : [];
    if (gone.length) unset[s.id] = gone;
  }
  if (changed.length) patch.sessions = changed;
  if (Object.keys(unset).length) patch.unset = unset;
  if (last.ids !== ids) patch.ids = [...sessions.keys()];
  return { patch: Object.keys(patch).length ? patch : null, sent };
}

/**
 * @param {{bodyFor: (login: string|null) => object, onChange?: ((fn: () => void) => void)|null,
 *          later?: (fn: () => void, ms: number) => {unref?: Function}, cancel?: (timer: any) => void,
 *          now?: () => number}} args
 *   `bodyFor` is what GET /api/sessions answers that login; `onChange` is the fleet's, called on each change it saves
 */
export function createLiveSessions({ bodyFor, onChange = null, later = setTimeout, cancel = clearTimeout, now = Date.now }) {
  const streams = new Set();
  let flushTimer = null;
  let sweepTimer = null;
  let heartbeatTimer = null;

  const unref = (timer) => { timer?.unref?.(); return timer; };

  function write(stream, event, data) {
    stream.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if ((stream.res.writableLength ?? 0) > MAX_BUFFERED_BYTES) {
      console.warn('liveSessions: stream ended, its browser stopped reading', { login: stream.login, bytes: stream.res.writableLength });
      end(stream);
    }
  }

  let flushing = null;
  let flushAgain = false;
  function flush() {
    flushTimer = null;
    // One at a time: a change while the sign-ins are checked is sent once this one is done.
    if (flushing) {
      flushAgain = true;
      return flushing;
    }
    flushing = flushAll().finally(() => {
      flushing = null;
      if (flushAgain) {
        flushAgain = false;
        flush();
      }
    });
    return flushing;
  }

  // Every stream on its own: one whose sign-in check is slow holds up none of the others.
  async function flushAll() {
    await Promise.all([...streams].map(flushOne));
  }

  async function flushOne(stream) {
    if (now() - stream.openedAt >= MAX_AGE_MS) return end(stream);
    const allowed = await allows(stream.stillAllowed);
    if (!streams.has(stream)) return;
    if (!allowed) {
      console.log('liveSessions: stream ended, its sign-in no longer lets it in', { login: stream.login });
      return end(stream);
    }
    try {
      const { patch, sent } = diffList(stream.sent, bodyFor(stream.login));
      stream.sent = sent;
      if (patch) write(stream, 'patch', patch);
    } catch (err) {
      console.error('liveSessions: list not sent', { login: stream.login, message: String(err?.message ?? err).split('\n')[0] });
      end(stream);
    }
  }

  // Whether a sign-in check says yes, in time: anything but true, a throw or no answer in CHECK_TIMEOUT_MS is a no.
  async function allows(check) {
    let timer = null;
    const late = new Promise((resolve) => { timer = unref(later(() => resolve(false), CHECK_TIMEOUT_MS)); });
    try {
      return (await Promise.race([Promise.resolve().then(check), late])) === true;
    } catch {
      return false;
    } finally {
      cancel(timer);
    }
  }

  function changed() {
    if (flushTimer || !streams.size) return;
    flushTimer = unref(later(flush, DEBOUNCE_MS));
  }

  function sweep() {
    sweepTimer = null;
    if (!streams.size) return;
    flush();
    sweepTimer = unref(later(sweep, SWEEP_MS));
  }

  function heartbeat() {
    heartbeatTimer = null;
    if (!streams.size) return;
    // A comment line: proxies that close a quiet connection keep this one.
    for (const stream of streams) stream.res.write(': still here\n\n');
    heartbeatTimer = unref(later(heartbeat, HEARTBEAT_MS));
  }

  function end(stream) {
    if (!streams.delete(stream)) return;
    stream.res.end();
  }

  onChange?.(changed);

  return {
    /**
     * Opens a stream for a page that may read the list (the same check as GET /api/sessions, made by the caller).
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @param {string|null} login
     * @param {{stillAllowed?: () => boolean|Promise<boolean>}} [opts]  whether the request that opened the stream still
     *   signs in as `login`, asked before anything is sent, the opening list included, and before each send after
     * @returns {Promise<void>}
     */
    async handle(req, res, login, { stillAllowed = () => true } = {}) {
      // A hosted request signed just before the program took its person out passes the console's own check: the
      // program's is asked before the list is so much as read.
      if (!(await allows(stillAllowed))) {
        console.log('liveSessions: stream refused, its sign-in no longer lets it in', { login });
        res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: 'sign in first' }));
        return;
      }
      let body;
      try {
        body = bodyFor(login);
      } catch (err) {
        console.error('liveSessions: list not read for a new stream', { login, message: String(err?.message ?? err).split('\n')[0] });
        res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: 'the session list could not be read' }));
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        // nginx and the like would hold the events back until a buffer filled.
        'x-accel-buffering': 'no',
      });
      res.write(`retry: ${RETRY_MS}\n\n`);
      const stream = { res, login, stillAllowed, openedAt: now(), sent: diffList(null, body).sent };
      // Kept before the opening list goes, so a list too big for a browser that is not reading ends it for good.
      streams.add(stream);
      res.on('close', () => streams.delete(stream));
      req.on('error', () => streams.delete(stream));
      write(stream, 'full', body);
      if (!streams.has(stream)) return;
      sweepTimer ??= unref(later(sweep, SWEEP_MS));
      heartbeatTimer ??= unref(later(heartbeat, HEARTBEAT_MS));
    },
    /** Ends every stream: the console is stopping. */
    closeAll() {
      for (const stream of [...streams]) end(stream);
      for (const timer of [flushTimer, sweepTimer, heartbeatTimer]) if (timer) cancel(timer);
      flushTimer = sweepTimer = heartbeatTimer = null;
    },
    open: () => streams.size,
    // For tests: what is being sent now.
    settled: () => flushing ?? Promise.resolve(),
  };
}
