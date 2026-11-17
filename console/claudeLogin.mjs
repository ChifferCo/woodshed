// A person's full Claude login, the one Remote Control needs, kept between their private sessions so that
// /woodshed:remote-control signs a new session in without the browser. The value is `users/<login>/claude-login` in the
// secret store: `{"claudeAiOauth": {...}}`, from a session's ~/.claude/.credentials.json and nothing else of it. It is
// never shown on a page, never in the /settings answer, a Claude home or the settings sync, and never logged.
//
// Anthropic rotates the refresh token at each refresh (about every 8 hours) and refuses the one before, so only one
// session may use the login at a time: the lease in console state, `{sessionId, generation, takenAt}`, says which. A
// session takes it (take), sends each refreshed login back with the generation it was given (writeBack), and gives it
// up at its stop (release); the fleet frees it when a session ends any other way (sessionEnded), and a take finds a
// lease whose session is no longer running free too. A write-back is kept only from the holder, with its generation,
// and only when its expiry is later than the saved one's, so a stale copy never replaces a newer login. The refresh
// grant ends 30 days after the first sign-in whatever is done here: a session then signs in again.
//
// The person's record (userSettings.mjs) keeps `claudeLogin: {savedAt, refreshedAt, expiresAt, generation, lease}`:
// dates, a number and ids alone.

export const CLAUDE_LOGIN = 'claude-login';
const MAX_LOGIN_CHARS = 16_000;

function shown(message) {
  return Object.assign(new Error(message), { shown: true });
}

/**
 * @param {unknown} value  `{claudeAiOauth}`, as an object or its JSON, such as a whole ~/.claude/.credentials.json
 * @returns {{claudeAiOauth: object}}  the login alone: anything else the file held (MCP logins) is left out
 * @throws {Error}  with a message that never contains the value
 */
export function checkClaudeLogin(value) {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw shown('the login is not JSON');
    }
  }
  const oauth = parsed?.claudeAiOauth;
  if (typeof oauth !== 'object' || oauth === null || Array.isArray(oauth)) throw shown('there is no claudeAiOauth in it');
  const { accessToken, refreshToken, expiresAt, scopes } = oauth;
  if (typeof accessToken !== 'string' || !accessToken || typeof refreshToken !== 'string' || !refreshToken) throw shown('the login has no access or refresh token');
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) throw shown('the login has no expiresAt');
  if (!Array.isArray(scopes) || scopes.some((s) => typeof s !== 'string')) throw shown('the login has no scopes');
  const login = { claudeAiOauth: oauth };
  if (JSON.stringify(login).length > MAX_LOGIN_CHARS) throw shown('the login is too large');
  return login;
}

/**
 * @param {{record: (login: string) => object|null, touch: (login: string, fields: object) => void,
 *          secretName: (login: string) => string,
 *          secrets: {read: Function, save: Function, remove: Function}|null, now?: () => number}} deps
 *   `record` and `touch` are the person's record in userSettings.mjs
 */
export function createClaudeLogins({ record, touch, secretName, secrets, now = Date.now }) {
  const iso = () => new Date(now()).toISOString();
  const kept = (login) => record(login)?.claudeLogin ?? null;
  // One change at a time per person: a take and a write-back must not both read the same lease.
  const queues = new Map();
  function inTurn(login, work) {
    const next = (queues.get(login) ?? Promise.resolve()).then(work, work);
    const settled = next.catch(() => {});
    queues.set(login, settled);
    settled.then(() => { if (queues.get(login) === settled) queues.delete(login); });
    return next;
  }

  /** @returns {string|null}  the session that holds the lease while it is running; null when it is free */
  function holder(login, isLive) {
    const sessionId = kept(login)?.lease?.sessionId;
    return sessionId && isLive(sessionId) ? sessionId : null;
  }

  /**
   * For My settings: ids and dates only.
   * @param {(sessionId: string) => boolean} isLive  the session is still running (or starting, or stopping)
   * @returns {{saved: boolean, savedAt: string|null, refreshedAt: string|null, heldBy: string|null}}
   */
  function view(login, { isLive }) {
    const saved = kept(login);
    return { saved: Boolean(saved?.savedAt), savedAt: saved?.savedAt ?? null, refreshedAt: saved?.refreshedAt ?? null, heldBy: saved?.savedAt ? holder(login, isLive) : null };
  }

  /**
   * @returns {Promise<{status: 'given', generation: number, claudeAiOauth: object}|{status: 'held', heldBy: string}|{status: 'none'}>}
   */
  function take(login, { sessionId, isLive }) {
    return inTurn(login, async () => {
      const saved = kept(login);
      if (!secrets || !saved?.savedAt) {
        console.log('claudeLogin: none saved to take', { login, sessionId });
        return { status: 'none' };
      }
      const heldBy = holder(login, isLive);
      if (heldBy && heldBy !== sessionId) {
        console.log('claudeLogin: held by another session', { login, sessionId, heldBy, generation: saved.lease.generation });
        return { status: 'held', heldBy };
      }
      if (saved.lease && !heldBy) console.log('claudeLogin: lease of an ended session freed', { login, endedSession: saved.lease.sessionId, generation: saved.lease.generation });
      const value = await secrets.read(secretName(login));
      if (!value) {
        touch(login, { claudeLogin: null });
        console.warn('claudeLogin: the secret store has none, forgotten', { login, sessionId });
        return { status: 'none' };
      }
      const generation = (saved.generation ?? 0) + 1;
      touch(login, { claudeLogin: { ...saved, generation, lease: { sessionId, generation, takenAt: iso() } } });
      console.log('claudeLogin: taken', { login, sessionId, generation });
      return { status: 'given', generation, claudeAiOauth: JSON.parse(value).claudeAiOauth };
    });
  }

  /**
   * A session's login, refreshed (`generation`, from its take) or made in it by a fresh sign-in (`fresh`), which also
   * gives it the lease: the new login is its own, so the one another session holds stays that session's.
   * @param {{sessionId: string, generation?: number, fresh?: boolean, value: unknown}} sent
   * @returns {Promise<{kept: true, generation: number}|{kept: false, why: string}>}
   * @throws {Error}  shown, when the value is not a login
   */
  function writeBack(login, { sessionId, generation, fresh = false, value }) {
    const checked = checkClaudeLogin(value);
    return inTurn(login, async () => {
      if (!secrets) return { kept: false, why: 'this console has no secret store' };
      const saved = kept(login);
      const refuse = (why) => {
        console.log('claudeLogin: write-back refused', { login, sessionId, generation: generation ?? null, fresh, why });
        return { kept: false, why };
      };
      if (!fresh && (!saved?.lease || saved.lease.sessionId !== sessionId || saved.lease.generation !== generation)) return refuse('not the holder');
      const expiresAt = checked.claudeAiOauth.expiresAt;
      if (saved?.expiresAt && !(expiresAt > saved.expiresAt)) return refuse('not newer');
      await secrets.save(secretName(login), JSON.stringify(checked), `Woodshed: @${login}'s Claude login, for their My Woodshed sessions only`);
      const at = iso();
      const next = fresh ? (saved?.generation ?? 0) + 1 : generation;
      touch(login, {
        claudeLogin: {
          savedAt: fresh ? at : saved?.savedAt ?? at, refreshedAt: at, expiresAt, generation: next,
          lease: fresh ? { sessionId, generation: next, takenAt: at } : saved.lease,
        },
      });
      console.log('claudeLogin: written back', { login, sessionId, generation: next, fresh, tookOver: Boolean(fresh && saved?.lease && saved.lease.sessionId !== sessionId) });
      return { kept: true, generation: next };
    });
  }

  /** @returns {Promise<boolean>}  the session held the lease with that generation, which is free now */
  function release(login, { sessionId, generation }) {
    return inTurn(login, async () => {
      const saved = kept(login);
      if (!saved?.lease || saved.lease.sessionId !== sessionId || saved.lease.generation !== generation) {
        console.log('claudeLogin: release ignored, not the holder', { login, sessionId, generation: generation ?? null });
        return false;
      }
      touch(login, { claudeLogin: { ...saved, lease: null } });
      console.log('claudeLogin: released', { login, sessionId, generation });
      return true;
    });
  }

  /** The fleet's, when a session stops, fails or is found gone: whatever it held is free. */
  function sessionEnded(login, sessionId) {
    if (!login || kept(login)?.lease?.sessionId !== sessionId) return Promise.resolve(false);
    return inTurn(login, async () => {
      const saved = kept(login);
      if (saved?.lease?.sessionId !== sessionId) return false;
      touch(login, { claudeLogin: { ...saved, lease: null } });
      console.log('claudeLogin: lease freed, the session ended', { login, sessionId, generation: saved.lease.generation });
      return true;
    });
  }

  /** Forget on My settings: the secret, then the record and its lease. A running holder keeps its own copy until it stops. */
  function forget(login) {
    return inTurn(login, async () => {
      if (secrets) await secrets.remove(secretName(login));
      const heldBy = kept(login)?.lease?.sessionId ?? null;
      if (record(login)) touch(login, { claudeLogin: null });
      console.log('claudeLogin: forgotten', { login, heldBy });
    });
  }

  return { view, take, writeBack, release, sessionEnded, forget };
}
