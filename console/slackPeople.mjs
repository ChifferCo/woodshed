// Which Slack user each GitHub handle is, so the console can DM people later. Kept in state.json under
// `slackAccounts`, by lowercase handle, apart from `people` (userSettings.mjs) which Remove My Woodshed deletes:
//   { slackId, name, how: 'email' | 'manual', checkedAt }
// A link is made when someone signs in, from the email on their GitHub account (`users.lookupByEmail`, which needs
// the bot's `users:read.email` scope), or set by hand on the People page. A link set by hand is never touched by the
// automatic match. Nothing here fails a sign-in, and nothing here sends a message.

import logins from './public/logins.cjs';
const { loginKey } = logins;

const REFRESH_MS = 24 * 3_600_000;
// A Slack member ID, as the profile's "Copy member ID" gives it. A digit is required so a name such as `william` is not one.
const ID_RE = /^[UW](?=[A-Z0-9]*\d)[A-Z0-9]{6,}$/i;
const HANDLE_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/i;

function shown(message) {
  return Object.assign(new Error(message), { shown: true });
}

/**
 * @param {{store: {state: object, save: () => void}, slack: {person: Function, personByEmail: Function, personByHandle: Function}|null,
 *          now?: () => number}} deps  `slack` is null where the console has no Slack
 */
export function createSlackPeople({ store, slack, now = Date.now }) {
  function accounts() {
    store.state.slackAccounts ??= {};
    return store.state.slackAccounts;
  }

  const keyOf = loginKey;

  /** @returns {string|null}  the Slack user ID, for a direct message (assigneePings.mjs) */
  function slackUserFor(login) {
    return (login && accounts()[keyOf(login)]?.slackId) || null;
  }

  /** @returns {Record<string, {slackId: string, name: string|null, how: string}>}  the links of these handles */
  function links(logins) {
    const out = {};
    for (const login of logins) {
      const known = accounts()[keyOf(login)];
      if (known?.slackId) out[login] = { slackId: known.slackId, name: known.name ?? null, how: known.how };
    }
    return out;
  }

  /**
   * Looks the person up by the emails on their GitHub account, at most once a day. Never throws.
   * @param {{login: string, emails: () => Promise<string[]>}} args  `emails` is only called when a look is due
   * @returns {Promise<'linked'|'unmatched'|'manual'|'skipped'>}
   */
  async function matchOnSignIn({ login, emails }) {
    const key = keyOf(login);
    const known = accounts()[key];
    if (known?.how === 'manual') return 'manual';
    if (!slack) return 'skipped';
    if (known && now() - known.checkedAt < REFRESH_MS) return 'skipped';
    try {
      const { found, inactive } = await lookUpByEmails(await emails());
      // A link saved by hand while Slack was being asked wins.
      if (accounts()[key]?.how === 'manual') return 'manual';
      if (found) {
        accounts()[key] = { slackId: found.id, name: found.name, how: 'email', checkedAt: now() };
        store.save();
        console.log('slackPeople: linked by email', { login });
        return 'linked';
      }
      // No answer keeps an earlier link, as a missing scope looks like no match; a bot or deactivated account drops it.
      accounts()[key] = known?.slackId && !inactive ? { ...known, checkedAt: now() } : { checkedAt: now() };
      store.save();
      console.log('slackPeople: no Slack user for the email', { login, inactive });
      return 'unmatched';
    } catch (err) {
      console.warn('slackPeople: match not made', { login, message: String(err?.message ?? err).split('\n')[0] });
      return 'unmatched';
    }
  }

  async function lookUpByEmails(emails) {
    let inactive = false;
    for (const email of emails) {
      const user = await slack.personByEmail(email);
      if (user?.reachable) return { found: user, inactive };
      if (user) inactive = true;
    }
    return { found: null, inactive };
  }

  /**
   * A link by hand, which automatic matching never overwrites. An empty value takes the link away, so the next
   * sign-in matches again.
   * @param {{login: string, value: string, by: string}} args  `value` is a member ID or an @handle
   * @returns {Promise<{slackId: string, name: string|null}|null>}
   * @throws {Error}  `shown` for a value Slack does not know; anything else when Slack could not be reached
   */
  async function setManual({ login, value, by }) {
    const key = keyOf(login);
    const text = String(value ?? '').trim();
    if (!text) {
      delete accounts()[key];
      store.save();
      console.log('slackPeople: link removed', { login, by });
      return null;
    }
    if (!slack) throw shown('this console has no Slack');
    const user = await resolve(text);
    if (!user?.reachable) throw shown(`Slack has no active user ${text}: give a member ID such as U01ABC2DEF3 (profile, "Copy member ID") or an @handle`);
    accounts()[key] = { slackId: user.id, name: user.name, how: 'manual', checkedAt: now() };
    store.save();
    console.log('slackPeople: linked by hand', { login, by });
    return { slackId: user.id, name: user.name };
  }

  async function resolve(text) {
    const bare = text.replace(/^@/, '');
    if (ID_RE.test(text)) return slack.person(text.toUpperCase());
    if (text.startsWith('@') && HANDLE_RE.test(bare)) return slack.personByHandle(bare);
    if (ID_RE.test(bare)) return slack.person(bare.toUpperCase());
    return null;
  }

  /**
   * @returns {Promise<{found: {id: string, name: string|null, handle: string|null}[], truncated: boolean}>}  Slack members matching part of a name
   * @throws {Error}  `shown` when Slack would not list its members
   */
  async function search({ query }) {
    if (!slack) throw shown('this console has no Slack');
    const result = await slack.search(query);
    if (!result) throw shown('Slack would not list its members: the bot needs the users:read scope');
    return result;
  }

  return { slackUserFor, links, matchOnSignIn, setManual, search };
}
