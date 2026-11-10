// Posts each pull request a session opens to one Slack channel, with its decision brief in the post's thread, as the bot whose token is the console's
// slack-bot-token secret. Console only, like the GitHub App key: a session never sees the token. The channel is a
// setting on the Console settings page, kept in state.json as `settings.slackChannel`.

export const SLACK_TOKEN_SECRET = 'slack-bot-token';
const POST_TIMEOUT_MS = 10_000;
// A channel's ID, as its About tab shows it: a name would be refused by Slack as channel_not_found.
const CHANNEL_RE = /^[CG][A-Z0-9]{8,}$/;
const MEMBER_RE = /^[UW][A-Z0-9]{6,}$/;

const READ_METHODS = new Set(['users.info', 'users.lookupByEmail', 'users.list']);
// Slack returns at most 1,000 members a call, so this reads two: only the first 2,000 can be found by name. A member
// ID always works.
const LIST_LIMIT = 1000;
const LIST_PAGES = 2;
// Slack's limit for one message's markdown_text is 12,000 characters.
const MARKDOWN_PART_CHARS = 11_000;

/**
 * @param {string} markdown
 * @returns {string[]}  the text in parts Slack takes, cut at a blank line where there is one
 */
export function splitMarkdown(markdown) {
  const parts = [];
  let rest = String(markdown);
  while (rest.length > MARKDOWN_PART_CHARS) {
    const cut = rest.lastIndexOf('\n\n', MARKDOWN_PART_CHARS);
    const at = cut > MARKDOWN_PART_CHARS / 2 ? cut : MARKDOWN_PART_CHARS;
    parts.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Slack reads `<`, `>` and `&` in a message's text as markup. */
function escapeText(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const TIER_TAGS = { Low: '🟢 Low risk', Medium: '🟡 Medium risk', High: '🔴 High risk' };

/**
 * @param {{title: string, url: string, tier?: 'Low'|'Medium'|'High'|null}} args  `tier` is the AI review's Merge
 *   risk; without the argument there is no tag, and null says none was posted
 * @returns {string}  `PR title - PR link - 🟢 Low risk`
 */
export function prMessage({ title, url, tier }) {
  const tag = tier === undefined ? '' : ` - ${TIER_TAGS[tier] ?? '⚪ Risk not posted'}`;
  return `${escapeText(title)} - ${escapeText(url)}${tag}`;
}

/**
 * For text quoted into a `markdown_text` message, where an HTML entity may show as typed: angle brackets become
 * look-alikes, so nothing can read as a Slack link or mention and nothing shows as `&lt;`; `](` is split, so no
 * Markdown link can hide where it goes; and a zero-width space after `@` stops `@channel` or `@here` from notifying.
 * @param {string} text
 * @returns {string}
 */
export function plainText(text) {
  return String(text ?? '').replace(/</g, '‹').replace(/>/g, '›').replace(/\]\(/g, '] (').replace(/@/g, '@\u200b');
}

/**
 * @param {{store: {state: object, save: () => void}, secrets: {read: (name: string) => Promise<string|null>}|null,
 *          fetchImpl?: typeof fetch}} deps  with no channel set, or no secret store, there is nowhere to post
 */
export function createSlack({ store, secrets, fetchImpl = fetch }) {
  const channel = () => store.state.settings?.slackChannel ?? '';

  /**
   * @param {string} value  an empty channel turns the posts off
   * @returns {string}  the channel as it would be kept
   * @throws {Error}  shown on the page, for anything but a channel ID
   */
  function checkChannel(value) {
    const next = String(value ?? '').trim();
    if (next && !CHANNEL_RE.test(next)) {
      throw Object.assign(new Error('give the channel\'s ID, such as C0123456789: it is at the bottom of the channel\'s About tab'), { shown: true });
    }
    return next;
  }

  /** @param {{channel: string, by: string}} args */
  function setChannel({ channel: value, by }) {
    const next = checkChannel(value);
    const before = channel();
    if (next === before) return;
    store.state.settings = { ...store.state.settings, slackChannel: next };
    store.save();
    console.log('slack: channel changed', { from: before || null, to: next || null, by });
  }

  /**
   * One Slack Web API call as the bot. The token is read for each, so a new one on the Secrets page takes effect
   * without a restart.
   * @param {string} method  e.g. `chat.postMessage`
   * @param {object} body
   * @returns {Promise<object|null>}  Slack's answer when it said ok; null with no token yet, or a refusal, logged
   * @throws {Error}  when Slack or Secrets Manager could not be reached, which is worth trying again
   */
  async function call(method, body) {
    if (!secrets) return null;
    const token = (await secrets.read(SLACK_TOKEN_SECRET))?.trim();
    if (!token) {
      console.log('slack: no bot token yet, nothing sent', { method });
      return null;
    }
    // Slack takes JSON for its write methods only: a read such as users.info goes as a query string.
    const res = READ_METHODS.has(method)
      ? await fetchImpl(`https://slack.com/api/${method}?${new URLSearchParams(body)}`, {
        headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      })
      : await fetchImpl(`https://slack.com/api/${method}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
    const answer = await res.json().catch(() => null);
    if (!answer?.ok) {
      console.warn('slack: call refused', { method, status: res.status, error: answer?.error ?? null });
      // Worth trying again, unlike a wrong token or a missing scope.
      if (answer?.error === 'ratelimited') throw new Error('slack: rate limited');
      return null;
    }
    return answer;
  }

  /**
   * The pull request's one line, `PR title - PR link`, then its decision brief as a reply in that post's thread. The
   * reply is best effort: once the post is in, a brief Slack refuses or rate limits must not post the line again.
   * @param {{title: string, url: string, tier?: string|null, brief?: string|null, mention?: string|null}} args  `tier`
   *   as for `prMessage`; `brief` is Markdown, its quotes already through `plainText`; `mention` is the Slack member ID
   *   of the person to tag in the thread, after the brief
   * @returns {Promise<boolean>}  whether Slack took the post
   */
  async function postPr({ title, url, tier, brief = null, mention = null }) {
    const to = channel();
    if (!to) return false;
    const posted = await call('chat.postMessage', { channel: to, text: prMessage({ title, url, tier }) });
    if (!posted) return false;
    console.log('slack: pull request posted', { url, channel: to });
    if (!brief) return true;
    if (!posted.ts) {
      console.warn('slack: no thread to reply the decision brief in', { url });
      return true;
    }
    try {
      const replied = await reply({ channel: to, threadTs: posted.ts, markdown: brief });
      console.log('slack: decision brief replied in the thread', { url, replied });
      // A mention is plain `text`: mrkdwn documents `<@U…>`, which markdown_text does not.
      if (replied && MEMBER_RE.test(mention ?? '')) {
        const tagged = await call('chat.postMessage', { channel: to, thread_ts: posted.ts, text: `<@${mention}> this one is yours to decide.` });
        console.log('slack: assignee mentioned in the thread', { url, user: mention, tagged: Boolean(tagged) });
      }
    } catch (err) {
      console.warn('slack: decision brief not replied', { url, message: String(err?.message ?? err).split('\n')[0] });
    }
    return true;
  }

  /**
   * A reply in a thread, as Markdown, which Slack renders itself. A long one goes in several replies.
   * @param {{channel: string, threadTs: string, markdown: string}} args
   * @returns {Promise<boolean>}  whether Slack took every part
   */
  async function reply({ channel: to, threadTs, markdown }) {
    const parts = splitMarkdown(markdown);
    for (const part of parts) {
      if (!(await call('chat.postMessage', { channel: to, thread_ts: threadTs, markdown_text: part, unfurl_links: false }))) return false;
    }
    console.log('slack: thread reply posted', { channel: to, threadTs, parts: parts.length, chars: markdown.length });
    return true;
  }

  /**
   * A direct message from the bot: `user` is a Slack member ID, which chat.postMessage takes as the channel of the
   * bot's own conversation with that person (its Messages tab in Slack).
   * @param {{user: string, markdown: string}} args
   * @returns {Promise<boolean>}  whether Slack took it
   */
  async function dm({ user, markdown }) {
    if (!(await call('chat.postMessage', { channel: user, markdown_text: markdown, unfurl_links: false }))) return false;
    console.log('slack: direct message sent', { user, chars: markdown.length });
    return true;
  }

  /** Best effort: a reaction that fails changes nothing else. */
  async function react({ channel: to, ts, name }) {
    try {
      await call('reactions.add', { channel: to, timestamp: ts, name });
    } catch (err) {
      console.warn('slack: reaction not added', { channel: to, name, message: String(err?.message ?? err).split('\n')[0] });
    }
  }

  function personOf(u) {
    const profile = u.profile;
    return {
      id: u.id ?? null,
      name: profile?.display_name || profile?.real_name || u.name || null,
      handle: u.name ?? null,
      member: !u.is_restricted && !u.is_ultra_restricted && !u.is_bot && !u.deleted && !u.is_stranger,
      // Someone the console can DM: a guest can be, a bot or a deactivated account cannot.
      reachable: Boolean(u.id) && !u.is_bot && !u.deleted && u.id !== 'USLACKBOT',
      team: u.team_id ?? null,
    };
  }

  /**
   * @returns {Promise<{id: string|null, name: string|null, handle: string|null, member: boolean, reachable: boolean, team: string|null}|null>}
   *   who the person is, or null when Slack would not say. `member` is a full member of the workspace: not a guest, a
   *   bot, a deactivated account, or someone from another organization in a shared channel
   * @throws {Error}  when Slack could not be reached
   */
  async function person(user) {
    const u = (await call('users.info', { user }))?.user;
    return u ? personOf(u) : null;
  }

  /**
   * Needs the `users:read.email` scope.
   * @returns {Promise<ReturnType<typeof personOf>|null>}  null when nobody has the email, or Slack refused (the
   *   scope missing, say), which `slack: call refused` says
   * @throws {Error}  when Slack could not be reached
   */
  async function personByEmail(email) {
    const u = (await call('users.lookupByEmail', { email }))?.user;
    return u ? personOf(u) : null;
  }

  /**
   * Active, non-bot members from `users.list`, at most `LIST_PAGES` calls: Slack cannot search, so the console filters
   * what it gets.
   * @returns {Promise<{list: ReturnType<typeof personOf>[], truncated: boolean}|null>}  null when Slack refused (the
   *   token or scope); `truncated` when the workspace has more members than those calls return
   * @throws {Error}  when Slack could not be reached or is rate limiting
   */
  async function people() {
    const list = [];
    let cursor = '';
    for (let page = 0; page < LIST_PAGES; page += 1) {
      const answer = await call('users.list', { limit: String(LIST_LIMIT), ...(cursor && { cursor }) });
      if (!answer) return null;
      list.push(...(answer.members ?? []).filter((u) => !u.deleted && !u.is_bot && u.id !== 'USLACKBOT').map((u) => ({
        ...personOf(u), realName: u.profile?.real_name ?? null, displayName: u.profile?.display_name ?? null,
      })));
      cursor = answer.response_metadata?.next_cursor ?? '';
      if (!cursor) break;
    }
    console.log('slack: member list read', { members: list.length, truncated: Boolean(cursor) });
    return { list, truncated: Boolean(cursor) };
  }

  /**
   * @param {string} handle  without the @; compared with the Slack username and display name, ignoring case
   * @returns {Promise<ReturnType<typeof personOf>|null>}
   * @throws {Error}  when Slack could not be reached
   */
  async function personByHandle(handle) {
    const want = String(handle).toLowerCase();
    return (await people())?.list.find((u) => [u.handle, u.displayName].some((n) => n && n.toLowerCase() === want)) ?? null;
  }

  /**
   * @param {string} query  part of a name or handle, ignoring case
   * @returns {Promise<{found: {id: string, name: string|null, handle: string|null}[], truncated: boolean}|null>}  at
   *   most 10 matches; null when Slack refused
   */
  async function search(query) {
    const want = String(query ?? '').trim().toLowerCase().replace(/^@/, '');
    const all = await people();
    if (!all) return null;
    if (!want) return { found: [], truncated: all.truncated };
    const found = all.list
      .filter((u) => [u.name, u.handle, u.realName, u.displayName].some((n) => n && n.toLowerCase().includes(want)))
      .slice(0, 10).map(({ id, name, handle }) => ({ id, name, handle }));
    return { found, truncated: all.truncated };
  }

  return {
    get available() { return Boolean(channel() && secrets); },
    canReply: Boolean(secrets),
    view: () => ({ channel: channel(), canPost: Boolean(secrets) }),
    checkChannel,
    setChannel,
    postPr,
    reply,
    dm,
    react,
    person,
    personByEmail,
    personByHandle,
    search,
  };
}
