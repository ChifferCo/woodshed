import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSlack, plainText, prMessage, splitMarkdown, SLACK_TOKEN_SECRET } from './slack.mjs';

function storeWith(channel) {
  return { state: channel ? { settings: { slackChannel: channel } } : {}, saves: 0, save() { this.saves += 1; } };
}

function fakes({ token = 'xoxb-1', answer = { ok: true }, status = 200 } = {}) {
  const calls = { reads: [], posts: [] };
  const secrets = { async read(name) { calls.reads.push(name); return token; } };
  async function fetchImpl(url, opts) {
    calls.posts.push({ url, headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : null });
    return { status, async json() { return answer; } };
  }
  return { calls, secrets, fetchImpl };
}

test('prMessage is the title, a dash and the link, with Slack markup escaped in both', () => {
  assert.equal(prMessage({ title: 'Add <GTM> & more', url: 'https://github.com/o/r/pull/7' }),
    'Add &lt;GTM&gt; &amp; more - https://github.com/o/r/pull/7');
  assert.equal(prMessage({ title: 't', url: 'https://x/pull/7> <!channel>' }), 't - https://x/pull/7&gt; &lt;!channel&gt;');
});

test('the post ends with the Merge risk tier as a coloured dot, or says none was posted', () => {
  const pr = { title: 'Add GTM', url: 'https://github.com/o/r/pull/7' };
  assert.equal(prMessage({ ...pr, tier: 'Low' }), 'Add GTM - https://github.com/o/r/pull/7 - 🟢 Low risk');
  assert.equal(prMessage({ ...pr, tier: 'Medium' }), 'Add GTM - https://github.com/o/r/pull/7 - 🟡 Medium risk');
  assert.equal(prMessage({ ...pr, tier: 'High' }), 'Add GTM - https://github.com/o/r/pull/7 - 🔴 High risk');
  assert.equal(prMessage({ ...pr, tier: null }), 'Add GTM - https://github.com/o/r/pull/7 - ⚪ Risk not posted');
});

test('quoted text cannot become a Slack link or mention, and shows no entity', () => {
  assert.equal(plainText('Add <GTM> & more'), 'Add ‹GTM› & more');
  assert.equal(plainText('<!channel> <@U123|x> <https://evil|ok>'), '‹!channel› ‹@\u200bU123|x› ‹https://evil|ok›');
  assert.equal(plainText('see [docs](https://evil)'), 'see [docs] (https://evil)', 'no Markdown link hides its target');
  assert.equal(plainText('ping @here'), 'ping @\u200bhere');
});

test('a post goes to the channel as the bot, with the token read for that post', async () => {
  const { calls, secrets, fetchImpl } = fakes();
  const slack = createSlack({ store: storeWith('C0123456789'), secrets, fetchImpl });
  assert.deepEqual(await slack.postPr({ title: 'Add GTM', url: 'https://github.com/o/r/pull/7' }), { channel: 'C0123456789', ts: null });
  assert.deepEqual(calls.reads, [SLACK_TOKEN_SECRET]);
  assert.equal(calls.posts[0].url, 'https://slack.com/api/chat.postMessage');
  assert.equal(calls.posts[0].headers.authorization, 'Bearer xoxb-1');
  assert.deepEqual(calls.posts[0].body, { channel: 'C0123456789', text: 'Add GTM - https://github.com/o/r/pull/7' });
});

test('the decision brief is a reply in the thread of the pull request\'s post', async () => {
  const { calls, secrets, fetchImpl } = fakes({ answer: { ok: true, ts: '1730000000.000100' } });
  const slack = createSlack({ store: storeWith('C0123456789'), secrets, fetchImpl });
  assert.deepEqual(await slack.postPr({ title: 'Add GTM', url: 'https://github.com/o/r/pull/7', brief: '**Merge risk:** Low: docs' }), { channel: 'C0123456789', ts: '1730000000.000100' });
  assert.deepEqual(calls.posts.map((p) => p.body), [
    { channel: 'C0123456789', text: 'Add GTM - https://github.com/o/r/pull/7' },
    { channel: 'C0123456789', thread_ts: '1730000000.000100', markdown_text: '**Merge risk:** Low: docs', unfurl_links: false },
  ]);
});

test('the assignee is mentioned in the thread after the brief, as plain text Slack reads mentions in', async () => {
  const { calls, secrets, fetchImpl } = fakes({ answer: { ok: true, ts: '1.2' } });
  const slack = createSlack({ store: storeWith('C0123456789'), secrets, fetchImpl });
  await slack.postPr({ title: 't', url: 'u', tier: 'Low', brief: 'b', mention: 'U01ANA00001' });
  assert.deepEqual(calls.posts.at(-1).body, { channel: 'C0123456789', thread_ts: '1.2', text: '<@U01ANA00001> this one is yours to decide.' });
  const odd = fakes({ answer: { ok: true, ts: '1.2' } });
  await createSlack({ store: storeWith('C0123456789'), ...odd }).postPr({ title: 't', url: 'u', brief: 'b', mention: '<!channel>' });
  assert.equal(odd.calls.posts.length, 2, 'anything but a member ID is never sent');
});

test('a brief Slack rate limits still counts the post as made, so the line is not posted again', async () => {
  const calls = { posts: [] };
  const answers = [{ ok: true, ts: '1.2' }, { ok: false, error: 'ratelimited' }];
  const fetchImpl = async (url, opts) => { calls.posts.push(JSON.parse(opts.body)); return { status: 200, async json() { return answers.shift(); } }; };
  const slack = createSlack({ store: storeWith('C0123456789'), secrets: { async read() { return 'xoxb-1'; } }, fetchImpl });
  assert.deepEqual(await slack.postPr({ title: 't', url: 'u', brief: 'b' }), { channel: 'C0123456789', ts: '1.2' });
  assert.equal(calls.posts.length, 2);
});

test('with no token yet, or a refusal, nothing is sent again: the post is given up', async () => {
  const none = fakes({ token: null });
  assert.equal(await createSlack({ store: storeWith('C0123456789'), ...none }).postPr({ title: 't', url: 'u' }), null);
  assert.equal(none.calls.posts.length, 0);

  const refused = fakes({ answer: { ok: false, error: 'not_in_channel' } });
  assert.equal(await createSlack({ store: storeWith('C0123456789'), ...refused }).postPr({ title: 't', url: 'u' }), null);
});

test('without a channel there is nowhere to post', async () => {
  const { calls, secrets, fetchImpl } = fakes();
  const slack = createSlack({ store: storeWith(''), secrets, fetchImpl });
  assert.equal(slack.available, false);
  assert.equal(await slack.postPr({ title: 't', url: 'u' }), null);
  assert.equal(calls.reads.length + calls.posts.length, 0);
});

test('a project with its own channel posts there, a project without one posts to the console\'s, each logged once', async (t) => {
  const logs = t.mock.method(console, 'log', () => {});
  const { calls, secrets, fetchImpl } = fakes({ answer: { ok: true, ts: '1.2' } });
  const store = storeWith('C0CONSOLE01');
  const slack = createSlack({ store, secrets, fetchImpl });
  slack.setProjectChannel({ project: 'api', channel: 'C0APIPRS01', by: 'mia-dev' });
  assert.deepEqual(await slack.postPr({ title: 't', url: 'u', project: 'api' }), { channel: 'C0APIPRS01', ts: '1.2' });
  assert.deepEqual(await slack.postPr({ title: 't', url: 'u', project: 'web' }), { channel: 'C0CONSOLE01', ts: '1.2' });
  assert.deepEqual(calls.posts.map((p) => p.body.channel), ['C0APIPRS01', 'C0CONSOLE01']);
  const chosen = logs.mock.calls.filter((c) => c.arguments[0] === 'slack: pull request channel chosen').map((c) => c.arguments[1]);
  assert.deepEqual(chosen, [{ project: 'api', channel: 'project' }, { project: 'web', channel: 'console' }]);
});

test('a project\'s channel is a channel ID, cleared back to the console\'s, and enough to post with no console channel', async () => {
  const { calls, secrets, fetchImpl } = fakes();
  const store = storeWith('');
  const slack = createSlack({ store, secrets, fetchImpl });
  assert.throws(() => slack.setProjectChannel({ project: 'api', channel: '#acme-prs', by: 'mia-dev' }), /channel's ID/);
  assert.equal(slack.available, false);
  slack.setProjectChannel({ project: 'api', channel: ' C0APIPRS01 ', by: 'mia-dev' });
  assert.deepEqual(store.state.settings.projectSlackChannels, { api: 'C0APIPRS01' });
  assert.equal(slack.projectChannel('api'), 'C0APIPRS01');
  assert.equal(slack.available, true, 'a project\'s own channel is somewhere to post');
  assert.equal(await slack.postPr({ title: 't', url: 'u', project: 'web' }), null, 'a project without one has nowhere');
  assert.equal(calls.posts.length, 0);
  slack.setProjectChannel({ project: 'api', channel: '', by: 'mia-dev' });
  assert.deepEqual(store.state.settings.projectSlackChannels, {});
  assert.deepEqual(slack.channelFor('api'), { channel: '', from: 'console' });
});

test('the brief and the mention go in the post\'s thread even when the project\'s channel changes meanwhile', async () => {
  const store = storeWith('C0CONSOLE01');
  const posts = [];
  let slack;
  const fetchImpl = async (url, opts) => {
    posts.push(JSON.parse(opts.body));
    // The setting changes while Slack is taking the post.
    if (posts.length === 1) slack.setProjectChannel({ project: 'api', channel: 'C0OTHER001', by: 'mia-dev' });
    return { status: 200, async json() { return { ok: true, ts: '1.2' }; } };
  };
  slack = createSlack({ store, secrets: { async read() { return 'xoxb-1'; } }, fetchImpl });
  slack.setProjectChannel({ project: 'api', channel: 'C0APIPRS01', by: 'mia-dev' });
  const post = await slack.postPr({ title: 't', url: 'u', brief: 'b', mention: 'U01ANA00001', project: 'api' });
  assert.deepEqual(post, { channel: 'C0APIPRS01', ts: '1.2' });
  assert.deepEqual(posts.map((p) => [p.channel, p.thread_ts ?? null]), [['C0APIPRS01', null], ['C0APIPRS01', '1.2'], ['C0APIPRS01', '1.2']]);
});

test('the channel is a setting: set, used for the next post, and cleared to turn the posts off', async () => {
  const { calls, secrets, fetchImpl } = fakes();
  const store = storeWith('');
  const slack = createSlack({ store, secrets, fetchImpl });
  assert.deepEqual(slack.view(), { channel: '', canPost: true });
  slack.setChannel({ channel: ' C0123456789 ', by: 'joel' });
  assert.equal(store.state.settings.slackChannel, 'C0123456789');
  assert.equal(store.saves, 1);
  assert.equal(slack.available, true);
  await slack.postPr({ title: 't', url: 'u' });
  assert.equal(calls.posts[0].body.channel, 'C0123456789');
  slack.setChannel({ channel: '', by: 'joel' });
  assert.equal(slack.available, false);
});

test('a channel name, or anything but an ID, is refused with what to give instead', () => {
  const store = storeWith('C0123456789');
  const slack = createSlack({ store, secrets: fakes().secrets });
  for (const bad of ['#dev-test', 'dev-test', 'c0123456789', 'U0123456789', 'C1']) {
    assert.throws(() => slack.setChannel({ channel: bad, by: 'joel' }), (err) => err.shown && /channel's ID/.test(err.message), bad);
  }
  assert.equal(store.state.settings.slackChannel, 'C0123456789', 'a refused value changes nothing');
});

test('a thread reply is Markdown in the thread, and needs no channel setting', async () => {
  const { calls, secrets, fetchImpl } = fakes();
  const slack = createSlack({ store: storeWith(''), secrets, fetchImpl });
  assert.equal(slack.canReply, true);
  assert.equal(await slack.reply({ channel: 'C1', threadTs: '1.1', markdown: '**Yes**' }), true);
  assert.deepEqual(calls.posts[0].body, { channel: 'C1', thread_ts: '1.1', markdown_text: '**Yes**', unfurl_links: false });
});

test('splitMarkdown keeps each part within Slack\'s limit, cutting at a blank line where it can', () => {
  assert.deepEqual(splitMarkdown('short'), ['short']);
  const para = 'a'.repeat(6000);
  assert.deepEqual(splitMarkdown(`${para}\n\n${para}\n\n${para}`), [`${para}`, `${para}`, `${para}`]);
  const parts = splitMarkdown('b'.repeat(25_000));
  assert.deepEqual(parts.map((p) => p.length), [11_000, 11_000, 3000]);
});

test('a reaction that fails changes nothing, and who someone is comes from users.info as a query string', async () => {
  const { calls, secrets, fetchImpl } = fakes({ answer: { ok: true, user: { name: 'ana', team_id: 'T1', profile: { display_name: '', real_name: 'Ana Lima' } } } });
  const slack = createSlack({ store: storeWith(''), secrets, fetchImpl });
  assert.deepEqual(await slack.person('U1'), { id: null, name: 'Ana Lima', handle: 'ana', member: true, reachable: false, team: 'T1' });
  assert.equal(calls.posts[0].url, 'https://slack.com/api/users.info?user=U1');
  assert.equal(calls.posts[0].body, null);

  const broken = createSlack({ store: storeWith(''), secrets, fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  await broken.react({ channel: 'C1', ts: '1.1', name: 'eyes' });
  await assert.rejects(broken.person('U1'), /ECONNRESET/, 'Slack out of reach is worth a retry, not a refusal');
});

test('a guest, a bot, a deactivated account or a stranger in a shared channel is not a member; a refusal is no one', async () => {
  for (const flag of ['is_restricted', 'is_ultra_restricted', 'is_bot', 'deleted', 'is_stranger']) {
    const { secrets, fetchImpl } = fakes({ answer: { ok: true, user: { name: 'x', [flag]: true } } });
    assert.equal((await createSlack({ store: storeWith(''), secrets, fetchImpl }).person('U1')).member, false, flag);
  }
  const { secrets, fetchImpl } = fakes({ answer: { ok: false, error: 'missing_scope' } });
  assert.equal(await createSlack({ store: storeWith(''), secrets, fetchImpl }).person('U1'), null);
});

test('lookups by email and by handle go as reads, and a bot or deactivated user is not reachable', async () => {
  const calls = { reads: [], posts: [] };
  const answers = {
    'users.lookupByEmail': { ok: true, user: { id: 'U1', name: 'ana', profile: { real_name: 'Ana K' } } },
    'users.list': { ok: true, members: [{ id: 'U2', name: 'old', deleted: true }, { id: 'U3', name: 'Bo', profile: { display_name: 'bo' } }], response_metadata: { next_cursor: '' } },
  };
  async function fetchImpl(url, opts) {
    calls.posts.push({ url, method: opts.method ?? 'GET' });
    const method = new URL(url).pathname.split('/').pop();
    return { status: 200, async json() { return answers[method]; } };
  }
  const slack = createSlack({ store: storeWith(), secrets: { async read() { return 'xoxb-1'; } }, fetchImpl });
  const found = await slack.personByEmail('ana@example.com');
  assert.deepEqual([found.id, found.name, found.reachable], ['U1', 'Ana K', true]);
  assert.match(calls.posts[0].url, /users\.lookupByEmail\?email=ana%40example\.com$/);
  assert.equal(calls.posts[0].method, 'GET');
  assert.equal((await slack.personByHandle('BO')).id, 'U3');
  assert.equal(await slack.personByHandle('old'), null, 'a deactivated user is skipped');

  answers['users.lookupByEmail'] = { ok: true, user: { id: 'U9', is_bot: true, name: 'robot' } };
  assert.equal((await slack.personByEmail('r@example.com')).reachable, false);
  answers['users.lookupByEmail'] = { ok: false, error: 'missing_scope' };
  assert.equal(await slack.personByEmail('ana@example.com'), null);
});

test('search finds active members by part of a name or handle, leaving out bots and deactivated users', async () => {
  const answer = { ok: true, members: [
    { id: 'U1', name: 'ana.lima', profile: { real_name: 'Ana Lima', display_name: '' } },
    { id: 'U2', name: 'bo', profile: { real_name: 'Bo Ana-Maria' } },
    { id: 'U3', name: 'gone', deleted: true, profile: { real_name: 'Ana Gone' } },
    { id: 'U4', name: 'robot', is_bot: true, profile: { real_name: 'Ana Bot' } },
    { id: 'USLACKBOT', name: 'slackbot', profile: { real_name: 'Slackbot' } },
  ], response_metadata: { next_cursor: '' } };
  const { secrets, fetchImpl } = fakes({ answer });
  const slack = createSlack({ store: storeWith(), secrets, fetchImpl });
  assert.deepEqual((await slack.search('ANA')).found.map((u) => u.id), ['U1', 'U2']);
  assert.deepEqual((await slack.search('  ')).found, [], 'nothing typed, nothing listed');
  assert.deepEqual((await slack.search('@ana.l')).found.map((u) => u.id), ['U1']);
});

test('search says when Slack refuses the member list, and asks again next time', async () => {
  let answer = { ok: false, error: 'missing_scope' };
  const slack = createSlack({
    store: storeWith(), secrets: { async read() { return 'xoxb-1'; } },
    fetchImpl: async () => ({ status: 200, async json() { return answer; } }),
  });
  assert.equal(await slack.search('ana'), null);
  answer = { ok: true, members: [{ id: 'U1', name: 'ana' }], response_metadata: { next_cursor: '' } };
  assert.equal((await slack.search('ana')).found.length, 1, 'a refusal is not remembered');
});

test('a search reads at most two pages of 1,000, shows at most 10, and says when the workspace is bigger', async () => {
  const members = Array.from({ length: 12 }, (_, i) => ({ id: `U${i}`, name: `ana${i}` }));
  const calls = [];
  const slack = createSlack({
    store: storeWith(), secrets: { async read() { return 'xoxb-1'; } },
    fetchImpl: async (url) => {
      calls.push(url);
      return { status: 200, async json() { return { ok: true, members, response_metadata: { next_cursor: 'more' } }; } };
    },
  });
  const result = await slack.search('ana');
  assert.equal(result.found.length, 10);
  assert.equal(result.truncated, true);
  assert.equal(calls.length, 2, 'a third page is never read');
  assert.match(calls[0], /users\.list\?limit=1000$/);
  assert.match(calls[1], /limit=1000&cursor=more$/);

  calls.length = 0;
  const small = createSlack({
    store: storeWith(), secrets: { async read() { return 'xoxb-1'; } },
    fetchImpl: async (url) => { calls.push(url); return { status: 200, async json() { return { ok: true, members, response_metadata: { next_cursor: '' } }; } }; },
  });
  assert.equal((await small.search('ana')).truncated, false);
  assert.equal((await small.personByHandle('ana3')).id, 'U3');
  assert.equal(calls.length, 2, 'a workspace that fits in one page costs one call each');
});

test('a Slack rate limit is thrown, to try again, and not read as a refusal', async () => {
  const slack = createSlack({
    store: storeWith(), secrets: { async read() { return 'xoxb-1'; } },
    fetchImpl: async () => ({ status: 429, async json() { return { ok: false, error: 'ratelimited' }; } }),
  });
  await assert.rejects(slack.search('ana'), /rate limited/);
  await assert.rejects(slack.personByHandle('ana'), /rate limited/);
});

test('a direct message goes to the member ID as the channel, as Markdown, without link previews', async () => {
  const { calls, secrets, fetchImpl } = fakes();
  const slack = createSlack({ store: storeWith(null), secrets, fetchImpl });
  assert.equal(await slack.dm({ user: 'U01ANA00001', markdown: '*Fix it* needs you' }), true, 'no channel setting is needed');
  assert.deepEqual(calls.posts[0].body, { channel: 'U01ANA00001', markdown_text: '*Fix it* needs you', unfurl_links: false });
  const refused = fakes({ answer: { ok: false, error: 'channel_not_found' } });
  assert.equal(await createSlack({ store: storeWith(null), ...refused }).dm({ user: 'U0NOPE', markdown: 'x' }), false);
});
