// The Slack card on Console settings and its Set up Slack dialog: whether a bot is connected and who it is, the
// manifest that makes this console's own Slack app, and saving its keys. The keys stay the two secrets slack.mjs and
// the webhook receivers read (`slack-bot-token`, `slack-signing-secret`), written here instead of on the Secrets page,
// so nothing that reads them changes. Neither value is ever handed back: the card shows who the token is, by
// `auth.test`, and whether the signing secret is set.

import { CHANNEL_SCOPES, SLACK_SIGNING_SECRET, SLACK_TOKEN_SECRET } from './slack.mjs';

/** What the console asks of its bot: posts, replies and reactions, who an asker is, and listing channels to pick. */
export const BOT_SCOPES = ['app_mentions:read', 'channels:history', 'channels:read', 'chat:write', 'groups:history', 'groups:read', 'reactions:write', 'users:read', 'users:read.email'];

// A Bot User OAuth Token; a user token (xoxp-) would post as a person.
const BOT_TOKEN_RE = /^xoxb-[A-Za-z0-9-]{10,}$/;
// Slack's signing secret is a hex string, under the app's Basic Information.
const SIGNING_SECRET_RE = /^[0-9a-f]{16,128}$/i;
// A token saved somewhere this page does not see (a store that gives no change time) is asked about again after this.
const RECHECK_MS = 10 * 60_000;
// Slack's limits for an app's name and its bot's.
const APP_NAME_MAX = 35;
const BOT_NAME_MAX = 80;

const shown = (message, status) => Object.assign(new Error(message), { shown: true, ...(status && { status }) });

// What Slack's refusal of a token means, in the page's words.
const TOKEN_ERRORS = {
  invalid_auth: 'Slack does not know this token: copy the Bot User OAuth Token again from OAuth & Permissions',
  not_authed: 'Slack does not know this token: copy the Bot User OAuth Token again from OAuth & Permissions',
  account_inactive: 'Slack says this token\'s app was uninstalled or its workspace closed: install the app again and copy its new token',
  token_revoked: 'Slack says this token was revoked: install the app again and copy its new token',
  token_expired: 'Slack says this token has expired: turn off token rotation for the app, reinstall it and copy its new token',
};

/**
 * The app manifest Slack's "Create New App → From a manifest" takes, in YAML: the bot's scopes, the Messages tab its
 * direct messages need, and, when the console knows it, its events Request URL for questions.
 * @param {{name: string, eventsUrl: string|null}} args
 * @returns {string}
 */
export function slackManifest({ name, eventsUrl }) {
  const appName = String(name || 'Woodshed').trim().slice(0, APP_NAME_MAX);
  // A bot's name takes lowercase letters, digits, dots, dashes and underscores.
  const botName = appName.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, BOT_NAME_MAX) || 'woodshed';
  // JSON strings are YAML's double-quoted ones, so nothing in a name can break the file.
  const q = JSON.stringify;
  const lines = [
    'display_information:',
    `  name: ${q(appName)}`,
    `  description: ${q('Posts pull requests from shared sessions, and answers questions about the code.')}`,
    'features:',
    '  app_home:',
    '    home_tab_enabled: false',
    '    messages_tab_enabled: true',
    '    messages_tab_read_only_enabled: true',
    '  bot_user:',
    `    display_name: ${q(botName)}`,
    '    always_online: true',
    'oauth_config:',
    '  scopes:',
    '    bot:',
    ...BOT_SCOPES.map((s) => `      - ${s}`),
    'settings:',
    ...(eventsUrl ? ['  event_subscriptions:', `    request_url: ${q(eventsUrl)}`, '    bot_events:', '      - app_mention'] : []),
    '  org_deploy_enabled: false',
    '  socket_mode_enabled: false',
    '  token_rotation_enabled: false',
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Checks what a program embedding the console passed as `slackInstall` (installation.mjs).
 * @returns {object|null}
 * @throws {Error}  for a hook in the wrong shape
 */
export function checkSlackInstall(install) {
  if (install == null) return null;
  if (typeof install !== 'object') throw new Error('slackInstall must be an object');
  if (typeof install.label !== 'string' || !install.label.trim()) throw new Error('slackInstall needs a label');
  if (install.description != null && typeof install.description !== 'string') throw new Error('slackInstall.description must be text');
  if (install.available != null && typeof install.available !== 'boolean' && typeof install.available !== 'function') throw new Error('slackInstall.available must be a boolean or a function');
  if (install.href != null && (typeof install.href !== 'string' || !/^(https:\/\/|\/(?!\/))/.test(install.href))) throw new Error('slackInstall.href must be an https link or a path on the console');
  if (install.installed != null && typeof install.installed !== 'function') throw new Error('slackInstall.installed must be a function');
  return install;
}

/**
 * @param {{store: {state: object, save: () => void}, secrets: object|null, slack: ReturnType<typeof import('./slack.mjs').createSlack>,
 *          consoleName?: string, eventsUrl?: (() => Promise<string|null>)|null, install?: object|null, now?: () => number}} deps
 *   `eventsUrl` is the embedding program's hook, else the provider's; `install` the program's `slackInstall`
 */
export function createSlackSetup({ store, secrets, slack, consoleName = 'Woodshed', eventsUrl = null, install = null, now = Date.now }) {
  checkSlackInstall(install);
  // Only a store that makes a secret when it is first written can lose one and make it again. One whose secrets its
  // infrastructure made (Terraform, on AWS) would be left without the secret the webhook receiver reads. Asked each time:
  // a store chosen on the Secrets page after the console starts answers only from then on.
  const canDisconnect = () => Boolean(secrets?.createsOnWrite && typeof secrets.remove === 'function');

  async function readEventsUrl() {
    if (!eventsUrl) return null;
    try {
      const url = await eventsUrl();
      return typeof url === 'string' && /^https?:\/\//.test(url) ? url : null;
    } catch (err) {
      console.warn('slack: events URL not read', { message: String(err?.message ?? err).split('\n')[0] });
      return null;
    }
  }

  async function installView() {
    if (!install) return null;
    let available = true;
    let installed = false;
    try {
      available = typeof install.available === 'function' ? Boolean(await install.available()) : install.available !== false;
      installed = Boolean(await install.installed?.());
    } catch (err) {
      console.warn('slack: the install option not read', { message: String(err?.message ?? err).split('\n')[0] });
      available = false;
    }
    return { label: install.label, description: install.description ?? null, available, href: available ? install.href ?? null : null, installed };
  }

  /** The two secrets' state, never their values: whether each is set, and since when. */
  async function keys() {
    const listed = await secrets.list();
    const of = (name) => listed.find((s) => s.name === name) ?? null;
    return { token: of(SLACK_TOKEN_SECRET), signing: of(SLACK_SIGNING_SECRET) };
  }

  // Who the saved token is, kept in state.json under `slackBot` until the secret changes, so the page does not ask
  // Slack each time it is drawn. Reinstalling an app with new scopes keeps its token, so the card's Check again asks
  // Slack anyway (`force`).
  async function botFor(token, { force = false } = {}) {
    const kept = store.state.slackBot ?? null;
    const changedAt = token?.changedAt ?? null;
    const fresh = !force && kept && kept.changedAt === changedAt && (changedAt || now() - Date.parse(kept.checkedAt) < RECHECK_MS);
    if (fresh) return kept;
    const who = await slack.identify();
    if (!who) return null;
    const next = who.ok
      ? { ...kept, ok: true, team: who.team, teamId: who.teamId, name: who.name, userId: who.userId, url: who.url, scopes: who.scopes, error: null }
      : { ...kept, ok: false, error: who.error };
    store.state.slackBot = { ...next, changedAt, checkedAt: new Date(now()).toISOString() };
    store.save();
    return store.state.slackBot;
  }

  /**
   * @returns {Promise<object>}  what the card and the dialog show; never a value
   */
  async function view({ recheck = false } = {}) {
    const base = { eventsUrl: await readEventsUrl(), install: await installView(), canDisconnect: canDisconnect(), scopes: BOT_SCOPES, channelScopes: CHANNEL_SCOPES };
    base.manifest = slackManifest({ name: consoleName, eventsUrl: base.eventsUrl });
    const channel = slack.view().channel;
    if (!secrets || secrets.configured?.() === false) {
      return { ...base, available: false, connected: false, bot: null, signingSecret: false, channel, channelName: null };
    }
    const { token, signing } = await keys();
    const connected = Boolean(token?.set);
    let bot = null;
    if (connected) {
      try {
        bot = await botFor(token, { force: recheck });
      } catch (err) {
        console.warn('slack: bot not looked up', { message: String(err?.message ?? err).split('\n')[0] });
      }
    }
    let channelName = null;
    if (connected && channel && bot?.ok) {
      try {
        channelName = (await slack.channels({ query: channel }))?.found?.find((c) => c.id === channel)?.name ?? null;
      } catch { /* the ID is shown instead */ }
    }
    return {
      ...base,
      available: true,
      connected,
      // Slack said no to the saved token: the card says so, and Replace keys fixes it.
      bot: bot ? { ok: bot.ok, team: bot.team ?? null, name: bot.name ?? null, url: bot.url ?? null, error: bot.error ?? null, setBy: bot.setBy ?? null, setAt: bot.setAt ?? token?.changedAt ?? null } : null,
      missingScopes: bot?.ok && Array.isArray(bot.scopes) ? BOT_SCOPES.filter((s) => !bot.scopes.includes(s)) : null,
      signingSecret: Boolean(signing?.set),
      channel,
      channelName,
    };
  }

  function tokenOf(value) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    if (!BOT_TOKEN_RE.test(text)) throw shown('That is not a bot token: the Bot User OAuth Token, on the app\'s OAuth & Permissions page, starts with xoxb-.');
    return text;
  }

  /**
   * Checks a pasted token with Slack, keeping nothing.
   * @returns {Promise<{team: string|null, name: string|null, url: string|null, missingScopes: string[]|null}>}
   * @throws {Error}  `shown` with Slack's refusal in words
   */
  async function check(botToken) {
    const token = tokenOf(botToken);
    if (!token) throw shown('Paste the bot token first.');
    const who = await slack.identify(token);
    if (!who?.ok) throw shown(TOKEN_ERRORS[who?.error] ?? `Slack refused the token (${who?.error ?? 'no answer'}).`);
    return { team: who.team, name: who.name, url: who.url, missingScopes: who.scopes ? BOT_SCOPES.filter((s) => !who.scopes.includes(s)) : null };
  }

  /**
   * The dialog's save, and Change channel's: each field that is given is changed, an empty one is kept. A new token is
   * checked with Slack before anything is written, and every value is checked before any is kept.
   * @param {{botToken?: string, signingSecret?: string, channel?: string, by: string}} args
   * @returns {Promise<{changed: string[]}>}
   */
  async function save({ botToken, signingSecret, channel, by }) {
    if (!secrets || secrets.configured?.() === false) throw shown('This console has no secret store to keep Slack\'s keys in: choose one on Secrets & webhooks first.', 409);
    const token = tokenOf(botToken);
    const secret = String(signingSecret ?? '').trim();
    if (secret && !SIGNING_SECRET_RE.test(secret)) throw shown('That is not a signing secret: it is the string of letters and digits under App Credentials, on the app\'s Basic Information page.');
    const nextChannel = channel === undefined ? undefined : slack.checkChannel(channel);
    if (!token && !(await keys()).token?.set) throw shown('Paste the bot token first: nothing is kept without one.');
    let who = null;
    if (token) {
      who = await slack.identify(token);
      if (!who?.ok) throw shown(TOKEN_ERRORS[who?.error] ?? `Slack refused the token (${who?.error ?? 'no answer'}).`);
    }
    const changed = [];
    if (token) {
      await secrets.write(SLACK_TOKEN_SECRET, token);
      slack.forgetChannels();
      changed.push('botToken');
    }
    if (secret) {
      await secrets.write(SLACK_SIGNING_SECRET, secret);
      changed.push('signingSecret');
    }
    if (nextChannel !== undefined && nextChannel !== slack.view().channel) {
      slack.setChannel({ channel: nextChannel, by });
      changed.push('channel');
    }
    if (token) {
      // The store's change time for the new value is read on the next look, which then keeps this.
      store.state.slackBot = {
        ok: true, team: who.team, teamId: who.teamId, name: who.name, userId: who.userId, url: who.url, scopes: who.scopes, error: null,
        setBy: by, setAt: new Date(now()).toISOString(), changedAt: (await keys()).token?.changedAt ?? null, checkedAt: new Date(now()).toISOString(),
      };
    } else if (secret && store.state.slackBot) {
      store.state.slackBot = { ...store.state.slackBot, setBy: by, setAt: new Date(now()).toISOString() };
    }
    if (token || secret) store.save();
    console.log('slack: keys saved', { team: who?.team ?? null, bot: who?.name ?? null, botToken: Boolean(token), signingSecret: Boolean(secret), channel: nextChannel === undefined ? 'kept' : nextChannel || null, by });
    return { changed };
  }

  /**
   * Both secrets deleted: nothing is posted and no mention is answered until Slack is set up again. The channels stay,
   * for the next bot.
   */
  async function disconnect({ by }) {
    if (!canDisconnect()) throw shown('This console\'s secret store keeps its Slack secrets: replace the keys instead.', 409);
    await secrets.remove(SLACK_TOKEN_SECRET);
    await secrets.remove(SLACK_SIGNING_SECRET);
    slack.forgetChannels();
    delete store.state.slackBot;
    store.save();
    console.log('slack: disconnected', { by });
  }

  /** @returns {Promise<object|null>}  as slack.channels, with the saved token or one pasted in the dialog */
  async function channels({ query, botToken = null }) {
    const token = botToken ? tokenOf(botToken) : null;
    return slack.channels({ query, token });
  }

  /**
   * The saved token asked about again, for the card's Check again: an app reinstalled with new scopes keeps its token,
   * which the card would otherwise go on describing as it was when saved. The channel list is read again too.
   * @returns {Promise<object>}  as view()
   */
  async function recheck({ by }) {
    slack.forgetChannels();
    const next = await view({ recheck: true });
    // Slack not reached (a timeout, the network, a rate limit): view() draws the card without the bot, which must not
    // read as a check that found nothing missing.
    if (next.connected && !next.bot) throw Object.assign(new Error('Slack did not answer, so nothing was checked: try again in a moment.'), { shown: true, status: 502 });
    console.log('slack: saved token checked again', { by, ok: next.bot?.ok ?? null, missingScopes: next.missingScopes ?? null });
    return next;
  }

  return { view, check, save, disconnect, channels, recheck, get canDisconnect() { return canDisconnect(); } };
}
