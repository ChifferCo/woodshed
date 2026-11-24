// The Slack card's server side (slackSetup.mjs) and its routes, over a made-up Slack and an in-memory secret store:
// a token is checked with auth.test before anything is kept, an empty field keeps its value, no value is handed back,
// and channels are listed with conversations.list, falling back where the app lacks the scopes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createHandler } from './server.mjs';
import { createSlack } from './slack.mjs';
import { BOT_SCOPES, checkSlackInstall, createSlackSetup, slackManifest } from './slackSetup.mjs';

const TOKEN = 'xoxb-1111-2222-abcdefabcdef';
const OTHER = 'xoxb-3333-4444-abcdefabcdef';
const SECRET = '0123456789abcdef0123456789abcdef';

function memorySecrets({ createsOnWrite = false } = {}) {
  const values = new Map();
  const changed = new Map();
  let n = 0;
  return {
    values, createsOnWrite,
    async list() {
      return ['slack-bot-token', 'slack-signing-secret'].map((name) => ({ name, set: values.has(name), changedAt: changed.get(name) ?? null }));
    },
    async read(name) { return values.get(name) ?? null; },
    async write(name, value) { values.set(name, value); changed.set(name, `2026-11-19T10:00:0${n++}.000Z`); },
    async remove(name) { values.delete(name); changed.delete(name); },
  };
}

// Slack as the console sees it: each token's workspace and bot, and its scopes in the x-oauth-scopes header.
function fakeSlack({ scopes = BOT_SCOPES, channels = null } = {}) {
  const calls = [];
  const known = { [TOKEN]: { team: 'Acme', user: 'shed-bot' }, [OTHER]: { team: 'Other Co', user: 'other-bot' } };
  async function fetchImpl(url, opts) {
    const token = opts.headers.authorization.replace('Bearer ', '');
    const method = new URL(url).pathname.replace('/api/', '');
    calls.push({ method, token, query: Object.fromEntries(new URL(url).searchParams) });
    const headers = { get: (h) => (h === 'x-oauth-scopes' ? scopes.join(',') : null) };
    const answer = (body) => ({ status: 200, headers, async json() { return body; } });
    if (!known[token]) return answer({ ok: false, error: 'invalid_auth' });
    if (method === 'auth.test') return answer({ ok: true, team: known[token].team, team_id: 'T0ACME', user: known[token].user, user_id: 'U0BOT', url: 'https://acme.slack.com/' });
    if (method === 'conversations.list') {
      if (!scopes.includes('channels:read') || !scopes.includes('groups:read')) return answer({ ok: false, error: 'missing_scope', needed: 'channels:read' });
      return answer({ ok: true, channels: channels ?? [
        { id: 'C0GENERAL1', name: 'general', is_private: false, is_member: false },
        { id: 'C0APPPRS01', name: 'app-prs', is_private: false, is_member: true },
        { id: 'G0RELEASE1', name: 'releases', is_private: true, is_member: true },
      ] });
    }
    return answer({ ok: false, error: 'unknown_method' });
  }
  return { calls, fetchImpl };
}

function setup({ secrets = memorySecrets(), scopes, install = null, eventsUrl = async () => 'https://hooks.example/slack' } = {}) {
  const store = { state: {}, saves: 0, save() { this.saves += 1; } };
  const fake = fakeSlack({ scopes });
  const slack = createSlack({ store, secrets, fetchImpl: fake.fetchImpl });
  const slackSetup = createSlackSetup({ store, secrets, slack, consoleName: 'Team Shed', eventsUrl, install });
  return { store, secrets, slack, slackSetup, calls: fake.calls };
}

test('the manifest asks for every scope the console uses, the two channel scopes among them, and has this console\'s Request URL', () => {
  const yaml = slackManifest({ name: 'Team Shed', eventsUrl: 'https://hooks.example/slack' });
  assert.match(yaml, /^display_information:\n {2}name: "Team Shed"\n/);
  assert.match(yaml, / {4}display_name: "team-shed"\n/);
  for (const scope of ['app_mentions:read', 'channels:history', 'channels:read', 'chat:write', 'groups:history', 'groups:read', 'reactions:write', 'users:read', 'users:read.email']) {
    assert.match(yaml, new RegExp(`\\n {6}- ${scope.replace('.', '\\.')}\\n`), scope);
  }
  assert.match(yaml, /event_subscriptions:\n {4}request_url: "https:\/\/hooks\.example\/slack"\n {4}bot_events:\n {6}- app_mention\n/);
  assert.match(yaml, /messages_tab_enabled: true/, 'the assignee\'s direct messages need the Messages tab');
  assert.doesNotMatch(slackManifest({ name: 'x', eventsUrl: null }), /event_subscriptions/, 'no Request URL, no events: Slack refuses one without');
  assert.match(slackManifest({ name: 'a "quoted" name: yes', eventsUrl: null }), /name: "a \\"quoted\\" name: yes"/);
});

test('not set up: no bot, and the events URL and manifest for the dialog', async () => {
  const { slackSetup } = setup();
  const view = await slackSetup.view();
  assert.equal(view.available, true);
  assert.equal(view.connected, false);
  assert.equal(view.bot, null);
  assert.equal(view.eventsUrl, 'https://hooks.example/slack');
  assert.match(view.manifest, /request_url: "https:\/\/hooks\.example\/slack"/);
  assert.equal(view.install, null);
  assert.equal(view.canDisconnect, false);
});

test('an events URL that cannot be read is unknown, not an error', async () => {
  const { slackSetup } = setup({ eventsUrl: async () => { throw new Error('AccessDenied'); } });
  assert.equal((await slackSetup.view()).eventsUrl, null);
});

test('a token Slack refuses is refused, and nothing is written', async () => {
  const { slackSetup, secrets } = setup();
  await assert.rejects(slackSetup.save({ botToken: 'xoxb-9999-9999-nottokenxx', signingSecret: SECRET, channel: 'C0APPPRS01', by: 'mia-dev' }), (err) => err.shown && /Slack does not know this token/.test(err.message));
  assert.equal(secrets.values.size, 0, 'neither secret, though the signing secret was good');
  await assert.rejects(slackSetup.save({ botToken: 'xoxp-1111-user-token', by: 'mia-dev' }), /starts with xoxb-/);
  await assert.rejects(slackSetup.save({ botToken: TOKEN, signingSecret: 'not hex!', by: 'mia-dev' }), /not a signing secret/);
  await assert.rejects(slackSetup.save({ botToken: TOKEN, channel: '#app-prs', by: 'mia-dev' }), /channel's ID/);
  assert.equal(secrets.values.size, 0);
  await assert.rejects(slackSetup.save({ signingSecret: SECRET, by: 'mia-dev' }), /Paste the bot token first/);
});

test('a good token is checked, saved with the secret and the channel, and the view says who the bot is, never the values', async (t) => {
  const { slackSetup, secrets, store, calls } = setup();
  const logged = [];
  t.mock.method(console, 'log', (...args) => logged.push(JSON.stringify(args)));
  await slackSetup.save({ botToken: TOKEN, signingSecret: SECRET, channel: 'C0APPPRS01', by: 'mia-dev' });
  assert.deepEqual([...secrets.values.keys()], ['slack-bot-token', 'slack-signing-secret']);
  assert.equal(store.state.settings.slackChannel, 'C0APPPRS01');
  const view = await slackSetup.view();
  assert.equal(view.connected, true);
  assert.deepEqual({ ...view.bot }, { ok: true, team: 'Acme', name: 'shed-bot', url: 'https://acme.slack.com/', error: null, setBy: 'mia-dev', setAt: view.bot.setAt });
  assert.equal(view.signingSecret, true);
  assert.deepEqual(view.missingScopes, []);
  assert.equal(view.channelName, 'app-prs');
  const text = JSON.stringify(view) + JSON.stringify(store.state) + logged.join('\n');
  assert.ok(!text.includes(TOKEN) && !text.includes(SECRET), 'no value in the view, the state or the log');
  assert.equal(calls.filter((c) => c.method === 'auth.test').length, 1, 'the view uses what the save learned, until the secret changes');
});

test('Replace keys: an empty field keeps what is saved, and a new token is who the card says', async () => {
  const { slackSetup, secrets } = setup();
  await slackSetup.save({ botToken: TOKEN, signingSecret: SECRET, channel: 'C0APPPRS01', by: 'mia-dev' });
  await slackSetup.save({ botToken: '', signingSecret: '', by: 'ana-k' });
  assert.equal(secrets.values.get('slack-bot-token'), TOKEN);
  assert.equal(secrets.values.get('slack-signing-secret'), SECRET);
  await slackSetup.save({ botToken: OTHER, by: 'ana-k' });
  assert.equal(secrets.values.get('slack-bot-token'), OTHER);
  assert.equal(secrets.values.get('slack-signing-secret'), SECRET, 'the secret left empty is kept');
  assert.equal((await slackSetup.view()).bot.team, 'Other Co');
});

test('Check again asks Slack about the saved token: an app reinstalled with new scopes keeps its token', async () => {
  const scopes = BOT_SCOPES.filter((x) => x !== 'channels:read' && x !== 'groups:read');
  const { slackSetup } = setup({ scopes });
  await slackSetup.save({ botToken: TOKEN, by: 'mia-dev' });
  assert.deepEqual((await slackSetup.view()).missingScopes, ['channels:read', 'groups:read']);
  assert.deepEqual(await slackSetup.channels({ query: '' }), { missingScope: true, needed: ['channels:read', 'groups:read'] });
  scopes.push('channels:read', 'groups:read');
  assert.deepEqual((await slackSetup.view()).missingScopes, ['channels:read', 'groups:read'], 'the same token: the card goes on as saved');
  const next = await slackSetup.recheck({ by: 'mia-dev' });
  assert.deepEqual(next.missingScopes, []);
  assert.deepEqual((await slackSetup.view()).missingScopes, [], 'kept until the next change');
  assert.ok((await slackSetup.channels({ query: '' })).found?.length, 'the channel list is read again');
});

test('Check again with Slack not answering refuses, so nothing reads as checked', async () => {
  const store = { state: {}, save() {} };
  const secrets = memorySecrets();
  const fake = fakeSlack({ scopes: BOT_SCOPES.filter((x) => x !== 'channels:read') });
  let down = false;
  const slack = createSlack({ store, secrets, fetchImpl: (url, opts) => (down ? Promise.reject(new Error('fetch failed')) : fake.fetchImpl(url, opts)) });
  const slackSetup = createSlackSetup({ store, secrets, slack, consoleName: 'Team Shed', eventsUrl: async () => null });
  await slackSetup.save({ botToken: TOKEN, by: 'mia-dev' });
  down = true;
  await assert.rejects(slackSetup.recheck({ by: 'mia-dev' }), (err) => err.shown && err.status === 502 && /did not answer/.test(err.message));
  down = false;
  assert.deepEqual((await slackSetup.recheck({ by: 'mia-dev' })).missingScopes, ['channels:read']);
});

test('a token changed elsewhere is looked up again, and one Slack refuses shows as refused', async () => {
  const { slackSetup, secrets } = setup();
  await slackSetup.save({ botToken: TOKEN, by: 'mia-dev' });
  await secrets.write('slack-bot-token', 'xoxb-0000-revoked-token');
  const view = await slackSetup.view();
  assert.deepEqual({ ok: view.bot.ok, error: view.bot.error }, { ok: false, error: 'invalid_auth' });
});

test('check says who a pasted token is, and what scopes its app lacks, keeping nothing', async () => {
  const { slackSetup, secrets } = setup({ scopes: ['chat:write', 'app_mentions:read'] });
  const who = await slackSetup.check(TOKEN);
  assert.equal(who.team, 'Acme');
  assert.deepEqual(who.missingScopes, ['channels:history', 'channels:read', 'groups:history', 'groups:read', 'reactions:write', 'users:read', 'users:read.email']);
  assert.equal(secrets.values.size, 0);
});

test('channels: the bot\'s first, then by name, searched by name; a pasted token lists before it is saved', async () => {
  const { slackSetup, calls } = setup();
  const all = await slackSetup.channels({ query: '', botToken: TOKEN });
  assert.deepEqual(all.found.map((c) => [c.name, c.private, c.member]), [['app-prs', false, true], ['releases', true, true], ['general', false, false]]);
  const list = calls.find((c) => c.method === 'conversations.list');
  assert.deepEqual([list.query.types, list.query.exclude_archived], ['public_channel,private_channel', 'true']);
  assert.deepEqual((await slackSetup.channels({ query: '#REL', botToken: TOKEN })).found.map((c) => c.id), ['G0RELEASE1']);
  assert.equal(calls.filter((c) => c.method === 'conversations.list').length, 1, 'the list is kept a minute and searched here');
  assert.equal(await slackSetup.channels({ query: '' }), null, 'no token saved, none pasted');
});

test('an app made before the picker gets missingScope, for the page\'s channel ID field', async () => {
  const { slackSetup } = setup({ scopes: ['chat:write'] });
  assert.deepEqual(await slackSetup.channels({ query: '', botToken: TOKEN }), { missingScope: true, needed: ['channels:read', 'groups:read'] });
});

test('Disconnect follows a store chosen after the console started, with no restart', async () => {
  // The local provider's secret slot answers createsOnWrite only once a store is chosen on the Secrets page.
  const secrets = memorySecrets({ createsOnWrite: false });
  const { slackSetup } = setup({ secrets });
  assert.equal((await slackSetup.view()).canDisconnect, false);
  secrets.createsOnWrite = true;
  assert.equal((await slackSetup.view()).canDisconnect, true);
  await slackSetup.save({ botToken: TOKEN, by: 'mia-dev' });
  await slackSetup.disconnect({ by: 'mia-dev' });
  assert.equal(secrets.values.size, 0);
});

test('Disconnect only where the store makes its secrets: it deletes both, and keeps the channel', async () => {
  const fixed = setup();
  await assert.rejects(fixed.slackSetup.disconnect({ by: 'mia-dev' }), (err) => err.shown && err.status === 409);
  const { slackSetup, secrets, store } = setup({ secrets: memorySecrets({ createsOnWrite: true }) });
  await slackSetup.save({ botToken: TOKEN, signingSecret: SECRET, channel: 'C0APPPRS01', by: 'mia-dev' });
  assert.equal((await slackSetup.view()).canDisconnect, true);
  await slackSetup.disconnect({ by: 'mia-dev' });
  assert.equal(secrets.values.size, 0);
  assert.equal(store.state.slackBot, undefined);
  assert.equal((await slackSetup.view()).connected, false);
  assert.equal(store.state.settings.slackChannel, 'C0APPPRS01');
});

test('the install option is the program\'s own words, and installed shows as such', async () => {
  const install = { label: 'Add the team app', description: 'Nothing to copy.', available: true, href: 'https://apps.example/install', installed: async () => true };
  const { slackSetup } = setup({ install });
  assert.deepEqual((await slackSetup.view()).install, { label: 'Add the team app', description: 'Nothing to copy.', available: true, href: 'https://apps.example/install', installed: true });
  const later = setup({ install: { label: 'Add the team app', available: false, href: 'https://apps.example/install' } });
  assert.deepEqual((await later.slackSetup.view()).install, { label: 'Add the team app', description: null, available: false, href: null, installed: false }, 'no link while it is not available');
  assert.throws(() => checkSlackInstall({ label: '' }), /needs a label/);
  assert.throws(() => checkSlackInstall({ label: 'x', href: 'javascript:alert(1)' }), /https link or a path/);
  assert.throws(() => checkSlackInstall({ label: 'x', installed: true }), /must be a function/);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path,
      headers: { host: `localhost:${port}`, origin: `http://localhost:${port}`, 'x-woodshed': '1', 'content-type': 'application/json' },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

test('the routes: the view with the last mention, the save, the check, the channels by GET and by POST, and Disconnect\'s confirm', async (t) => {
  const { slackSetup } = setup({ secrets: memorySecrets({ createsOnWrite: true }) });
  const events = { list: () => [{ type: 'mention', handledAt: '2026-11-19T08:00:00.000Z' }, { type: 'label', handledAt: '2026-11-19T09:00:00.000Z' }, { type: 'mention', handledAt: '2026-11-19T07:00:00.000Z' }] };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const handle = createHandler({ config, fleet: { sessions: () => [] }, slackSetup, events });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const get = async (path) => { const res = await fetch(`http://127.0.0.1:${port}${path}`); return { status: res.status, body: await res.json() }; };

  const before = await get('/api/console-settings/slack');
  assert.equal(before.status, 200);
  assert.equal(before.body.connected, false);
  assert.equal(before.body.lastMention, '2026-11-19T08:00:00.000Z');
  assert.equal((await get('/api/console-settings/slack/channels?q=')).status, 409, 'no token yet');

  assert.equal((await post(port, '/api/console-settings/slack/check', { botToken: 'xoxb-9999-9999-nottokenxx' })).status, 400);
  assert.equal((await post(port, '/api/console-settings/slack/check', { botToken: TOKEN })).body.name, 'shed-bot');
  assert.equal((await post(port, '/api/console-settings/slack/channels', { q: 'app', botToken: TOKEN })).body.found[0].id, 'C0APPPRS01');
  assert.equal((await post(port, '/api/console-settings/slack', { botToken: 5 })).status, 400);
  const saved = await post(port, '/api/console-settings/slack', { botToken: TOKEN, signingSecret: SECRET, channel: 'C0APPPRS01' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.connected, true);
  assert.ok(!JSON.stringify(saved.body).includes(TOKEN));
  assert.deepEqual((await get('/api/console-settings/slack/channels?q=rel')).body.found.map((c) => c.name), ['releases']);
  assert.equal((await post(port, '/api/console-settings/slack/disconnect', { confirm: 'yes' })).status, 400);
  assert.equal((await post(port, '/api/console-settings/slack/disconnect', { confirm: 'slack' })).body.connected, false);
});
