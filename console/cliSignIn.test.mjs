import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import http from 'node:http';

import { parseTrustedProxies } from './clientAddress.mjs';
import { CLI_TOKEN_TTL_MS, createCliDevices, createCliSignIn, createWriteAccess, handleCliApi, handleCliPage, MAX_PENDING_PER_CLIENT, normalUserCode } from './cliSignIn.mjs';

function signIn({ allowed, canWrite } = {}) {
  let clock = Date.parse('2026-11-20T10:00:00Z');
  let saves = 0;
  const store = { state: {}, save() { saves += 1; } };
  const cli = createCliSignIn({ store, now: () => clock, allowed, canWrite });
  return { cli, store, tick: (ms) => { clock += ms; }, saves: () => saves };
}

const whoIs = async (cli, token) => (await cli.authenticate({ authorization: `Bearer ${token}` })).signedIn;

test('a code waits for the person, says slow down to a CLI that asks too often, and hands its token out once', async () => {
  const { cli, store, tick } = signIn();
  const { deviceCode, userCode, interval } = cli.start({ name: 'mia-laptop\u0007', from: '10.0.0.4' });
  assert.equal(interval, 5);
  assert.deepEqual(cli.waiting(userCode.toLowerCase().replace('-', ' ')), { userCode, name: 'mia-laptop', from: '10.0.0.4', createdAt: '2026-11-20T10:00:00.000Z' }, 'typed any way, and the name printable');
  assert.equal(cli.poll(deviceCode).status, 'pending');
  tick(1000);
  assert.equal(cli.poll(deviceCode).status, 'slow_down');
  tick(5000);
  assert.equal(cli.poll(deviceCode).status, 'pending');
  assert.equal(cli.decide({ code: userCode, login: 'mia-dev', approve: true }), true);
  assert.equal(cli.waiting(userCode), null, 'answered: the page no longer offers it');
  const got = cli.poll(deviceCode);
  assert.equal(got.status, 'approved');
  assert.match(got.token, /^wsc_[0-9a-f]{64}$/);
  assert.equal(got.login, 'mia-dev');
  assert.equal(cli.poll(deviceCode).status, 'expired', 'once only');
  assert.ok(!JSON.stringify(store.state).includes(got.token), 'state.json keeps only its hash');
  assert.equal((await whoIs(cli, got.token)).login, 'mia-dev');
  tick(CLI_TOKEN_TTL_MS);
  assert.equal(await whoIs(cli, got.token), null, 'it ends after 90 days');
  assert.deepEqual(cli.list('mia-dev'), []);
});

test('a code nobody answers expires, a denied one is refused, and an approval by someone since removed is refused', () => {
  const people = new Set(['mia-dev']);
  const { cli, tick } = signIn({ allowed: (login) => people.has(login) });
  const ignored = cli.start({ name: 'a' });
  tick(10 * 60_000);
  assert.equal(cli.poll(ignored.deviceCode).status, 'expired');
  assert.equal(cli.waiting(ignored.userCode), null);

  const denied = cli.start({ name: 'b' });
  cli.decide({ code: denied.userCode, login: 'mia-dev', approve: false });
  assert.equal(cli.poll(denied.deviceCode).status, 'denied');

  const late = cli.start({ name: 'c' });
  cli.decide({ code: late.userCode, login: 'mia-dev', approve: true });
  people.delete('mia-dev');
  assert.equal(cli.poll(late.deviceCode).status, 'denied');
  assert.equal(cli.poll('not a code').status, 'expired');
});

test('each computer is a sign-in of its own, revoked alone or all together; a person keeps at most 20', async () => {
  const { cli, tick } = signIn();
  const make = (login, name) => {
    const { deviceCode, userCode } = cli.start({ name });
    cli.decide({ code: userCode, login, approve: true });
    tick(1000);
    return cli.poll(deviceCode);
  };
  const laptop = make('mia-dev', 'laptop');
  const desktop = make('mia-dev', 'desktop');
  make('sam-ops', 'sam');
  assert.deepEqual(cli.list('mia-dev').map((t) => t.name), ['desktop', 'laptop'], 'newest first');
  assert.equal(cli.revoke('sam-ops', laptop.id), false, 'nobody revokes another person\'s');
  assert.equal(cli.revoke('mia-dev', laptop.id), true);
  assert.equal(await whoIs(cli, laptop.token), null);
  assert.ok(await whoIs(cli, desktop.token));
  const approved = cli.start({ name: 'not collected yet' });
  cli.decide({ code: approved.userCode, login: 'mia-dev', approve: true });
  cli.revokeAll('mia-dev', 'test');
  assert.deepEqual(cli.list('mia-dev'), []);
  assert.equal(cli.poll(approved.deviceCode).status, 'denied', 'an approval not collected yet goes with them');
  assert.equal(cli.list('sam-ops').length, 1);
  for (let i = 0; i < 21; i++) make('ana-k', `box ${i}`);
  const kept = cli.list('ana-k');
  assert.equal(kept.length, 20);
  assert.ok(!kept.some((t) => t.name === 'box 0'), 'the oldest ended');
});

test('a token\'s last use is written down at most once an hour', async () => {
  const { cli, tick, saves } = signIn();
  const { deviceCode, userCode } = cli.start({ name: 'x' });
  cli.decide({ code: userCode, login: 'mia-dev', approve: true });
  const { token } = cli.poll(deviceCode);
  const before = saves();
  for (let i = 0; i < 5; i++) await whoIs(cli, token);
  assert.equal(saves(), before);
  tick(60 * 60_000);
  await whoIs(cli, token);
  assert.equal(saves(), before + 1);
  assert.equal(cli.list('mia-dev')[0].lastUsedAt, '2026-11-20T11:00:00.000Z');
});

test('write access is asked at a token\'s first use and then hourly, and GitHub not answering lets the call through', async () => {
  let clock = 0;
  let answer = true;
  const asked = [];
  const revoked = [];
  const access = createWriteAccess({
    canWrite: async (login) => {
      asked.push(login);
      if (answer === 'down') throw new Error('gh: 502');
      return answer;
    },
    revokeAll: (login, by) => revoked.push([login, by]),
    now: () => clock,
  });
  assert.equal(await access.allowed('mia'), true);
  const together = await Promise.all([access.allowed('mia'), access.allowed('mia')]);
  assert.deepEqual([together, asked.length], [[true, true], 1], 'one ask for the hour');
  answer = false;
  clock += 59 * 60_000;
  assert.equal(await access.allowed('mia'), true, 'within the hour, as a browser\'s sign-in');
  clock += 2 * 60_000;
  answer = 'down';
  assert.equal(await access.allowed('mia'), true, 'GitHub down does not shut everyone out');
  assert.equal(await access.allowed('mia'), true);
  assert.equal(asked.length, 2, 'and is not asked again until the retry');
  clock += 5 * 60_000;
  answer = false;
  assert.equal(await access.allowed('mia'), false);
  assert.deepEqual(revoked, [['mia', 'write access gone']]);
  assert.equal(await createWriteAccess({ canWrite: null, revokeAll() {} }).allowed('mia'), true, 'no GitHub sign-in, nothing to ask');
});

// /api/cli/* over HTTP, as the console answers it, for mia-dev's token.
async function apiServer(t, { canWrite }) {
  const { cli, tick } = signIn({ canWrite });
  const server = http.createServer((req, res) => {
    handleCliApi({ req, res, url: new URL(req.url, 'http://x'), cli, publicUrl: 'https://console.example', about: () => ({ console: 'Woodshed', org: 'acme' }) });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const tokenOf = (login) => {
    const { deviceCode, userCode } = cli.start({ name: `${login}-laptop` });
    cli.decide({ code: userCode, login, approve: true });
    return cli.poll(deviceCode).token;
  };
  const call = async (pathname, token, method = 'GET') => {
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { method, headers: { authorization: `Bearer ${token}` } });
    return { status: res.status, body: await res.json() };
  };
  return { cli, tick, tokenOf, call };
}

test('/api/cli/me refuses a token whose person lost write access, and ends all their sign-ins', async (t) => {
  const writers = new Set(['mia-dev', 'octocat']);
  const asked = [];
  const c = await apiServer(t, { canWrite: async (login) => { asked.push(login); return writers.has(login); } });
  const mia = c.tokenOf('mia-dev');
  c.tokenOf('mia-dev');
  assert.equal((await c.call('/api/cli/me', mia)).body.login, 'mia-dev');
  writers.delete('mia-dev');
  assert.equal((await c.call('/api/cli/me', mia)).status, 200, 'within the hour, as a browser\'s sign-in');
  c.tick(61 * 60_000);
  const refused = await c.call('/api/cli/me', mia);
  assert.equal(refused.status, 401);
  assert.match(refused.body.error, /no longer have write access/);
  assert.deepEqual(c.cli.list('mia-dev'), [], 'both her computers\' sign-ins ended');
  assert.equal((await c.call('/api/cli/me', mia)).status, 401);
  assert.equal((await c.call('/api/cli/me', c.tokenOf('octocat'))).status, 200);
  assert.deepEqual(asked, ['mia-dev', 'mia-dev', 'octocat'], 'GitHub asked at first use and an hour on, not for each call');
});

test('logout ends a token whose person lost write access, or while GitHub does not answer', async (t) => {
  let answer = false;
  const c = await apiServer(t, { canWrite: async () => { if (answer === 'down') throw new Error('gh: 502'); return answer; } });
  const gone = c.tokenOf('mia-dev');
  assert.deepEqual(await c.call('/api/cli/logout', gone, 'POST'), { status: 200, body: { ok: true } }, 'what logout asked for is done');
  assert.deepEqual(c.cli.list('mia-dev'), []);
  answer = 'down';
  const down = c.tokenOf('octocat');
  assert.deepEqual(await c.call('/api/cli/logout', down, 'POST'), { status: 200, body: { ok: true } });
  assert.deepEqual(c.cli.list('octocat'), []);
});

test('a code is eight letters with no vowels, typed in any case, with or without its dash', () => {
  assert.equal(normalUserCode('bcdf ghjk'), 'BCDF-GHJK');
  assert.equal(normalUserCode('BCDF-GHJ'), null);
  assert.equal(normalUserCode('ABCD-EFGH'), null, 'never a vowel');
  assert.equal(normalUserCode(null), null);
});

test('consoles sharing a waiting room: the one a code is approved on makes the token, whichever the CLI asks through', async () => {
  const devices = createCliDevices();
  const context = new AsyncLocalStorage();
  const made = (name) => {
    const store = { state: {}, save() { store.savedIn.push(context.getStore()); }, savedIn: [] };
    return { store, cli: createCliSignIn({ store, devices, allowed: (login) => login !== 'gone' }) };
  };
  const front = made('front');
  const a = made('a');
  const b = made('b');
  const { deviceCode, userCode } = front.cli.start({ name: 'laptop' });
  assert.ok(a.cli.waiting(userCode) && b.cli.waiting(userCode), 'every console sharing the room sees the code');
  context.run('b', () => b.cli.decide({ code: userCode, login: 'mia-dev', approve: true, about: { console: 'Woodshed', org: 'acme' } }));
  assert.equal(a.cli.waiting(userCode), null, 'answered on b: a offers it no more');
  const got = context.run('front', () => front.cli.poll(deviceCode));
  assert.equal(got.status, 'approved');
  assert.deepEqual(got.about, { console: 'Woodshed', org: 'acme' }, 'the approving console\'s, for the CLI');
  const bearer = { authorization: `Bearer ${got.token}` };
  assert.equal(b.cli.owns(bearer), true, 'kept in b\'s state');
  assert.equal(a.cli.owns(bearer), false);
  assert.equal(front.cli.owns(bearer), false);
  assert.deepEqual(b.store.savedIn, ['b'], 'made in b\'s context, so what it logs is b\'s');
  assert.equal((await b.cli.authenticate(bearer)).signedIn.login, 'mia-dev');
  assert.equal(b.cli.owns({ authorization: 'Bearer wsc_nope' }), false);
  assert.equal('cliTokens' in a.store.state, false, 'asking a console that made no token writes nothing to its state');

  // A person's sign-ins ending on one console leaves their approval on another alone, and an approval by someone the
  // approving console no longer lets in is refused there.
  const other = front.cli.start({ name: 'desktop' });
  b.cli.decide({ code: other.userCode, login: 'mia-dev', approve: true });
  a.cli.revokeAll('mia-dev', 'test');
  assert.equal(front.cli.poll(other.deviceCode).status, 'approved');
  const late = front.cli.start({ name: 'old' });
  b.cli.decide({ code: late.userCode, login: 'gone', approve: true });
  assert.equal(front.cli.poll(late.deviceCode).status, 'denied');
});

// The /cli page and the CLI's calls on consoles sharing a room, as a program embedding them serves them: the CLI's calls
// to a front desk, the page to whichever console `route.to` names (the one the browser is in now).
async function pageServer({ about, route = { to: 'cli' } }) {
  const devices = createCliDevices();
  const front = createCliSignIn({ store: { state: {}, save() {} }, devices });
  const store = { state: {}, save() {} };
  const cli = createCliSignIn({ store, devices });
  const twin = createCliSignIn({ store: { state: {}, save() {} }, devices });
  const consoles = { cli, twin };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/cli/')) return handleCliApi({ req, res, url, cli: front, publicUrl: 'http://x', about: () => ({ console: 'nobody', org: null }) });
    if (!await handleCliPage({ req, res, url, cli: consoles[route.to], login: 'mia-dev', consoleName: 'Woodshed', about: () => about.now })) res.end('no');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, cli, twin, server };
}

const hidden = (page, name) => new RegExp(`name="${name}" value="([^"]*)"`).exec(page)[1].replaceAll('&quot;', '"');

test('the /cli page names the org it signs in to, asks again when the browser has moved to another, and the token says it', async (t) => {
  const about = { now: { console: 'Woodshed', org: 'acme' } };
  const { base, cli, server } = await pageServer({ about });
  t.after(() => server.close());
  const started = await (await fetch(`${base}/api/cli/device`, { method: 'POST', body: JSON.stringify({ name: 'laptop' }) })).json();
  const page = await (await fetch(`${base}/cli?code=${started.userCode}`)).text();
  assert.match(page, /sign in to Woodshed for <strong>acme<\/strong> as <strong>@mia-dev<\/strong>/);
  const approve = () => fetch(`${base}/cli`, {
    method: 'POST', redirect: 'manual',
    headers: { origin: base, host: new URL(base).host, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: started.userCode, login: 'mia-dev', about: hidden(page, 'about'), console: hidden(page, 'console'), decision: 'approve' }).toString(),
  });
  about.now = { console: 'Woodshed', org: 'other-co' };
  const moved = await approve();
  assert.equal(moved.status, 303, 'the page named acme, the browser is in other-co now: asked again');
  assert.equal(moved.headers.get('location'), `/cli?code=${started.userCode}`);
  assert.ok(cli.waiting(started.userCode), 'still waiting');
  about.now = { console: 'Woodshed', org: 'acme' };
  assert.equal((await approve()).status, 200);
  const token = await (await fetch(`${base}/api/cli/token`, { method: 'POST', body: JSON.stringify({ deviceCode: started.deviceCode }) })).json();
  assert.equal(token.status, 'approved');
  assert.equal(token.org, 'acme', 'the approving console\'s about, not the front\'s');
  assert.ok(cli.owns({ authorization: `Bearer ${token.token}` }));
});

test('the /cli page asks again when the browser moved to another console with the same name and org, and with none', async (t) => {
  for (const labels of [{ console: 'Woodshed', org: 'acme' }, { console: 'Woodshed', org: null }]) {
    const about = { now: labels };
    const route = { to: 'cli' };
    const { base, cli, twin, server } = await pageServer({ about, route });
    t.after(() => server.close());
    const started = await (await fetch(`${base}/api/cli/device`, { method: 'POST', body: JSON.stringify({ name: 'laptop' }) })).json();
    const page = await (await fetch(`${base}/cli?code=${started.userCode}`)).text();
    const form = (fields) => fetch(`${base}/cli`, {
      method: 'POST', redirect: 'manual',
      headers: { origin: base, host: new URL(base).host, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: started.userCode, login: 'mia-dev', decision: 'approve', ...fields }).toString(),
    });
    route.to = 'twin';
    const moved = await form({ about: hidden(page, 'about'), console: hidden(page, 'console') });
    assert.equal(moved.status, 303, `the page was cli's, the browser is in twin now, each labelled ${JSON.stringify(labels)}: asked again`);
    assert.ok(twin.waiting(started.userCode), 'twin approved nothing');
    assert.equal((await form({ about: hidden(page, 'about') })).status, 303, 'a form naming no console asks again');
    route.to = 'cli';
    assert.equal((await form({ about: hidden(page, 'about'), console: hidden(page, 'console') })).status, 200, 'back on the console the page named');
    const token = await (await fetch(`${base}/api/cli/token`, { method: 'POST', body: JSON.stringify({ deviceCode: started.deviceCode }) })).json();
    assert.ok(cli.owns({ authorization: `Bearer ${token.token}` }), 'kept by the console the page named');
    assert.equal(twin.owns({ authorization: `Bearer ${token.token}` }), false);
  }
});

test('a client address may have 5 sign-ins waiting, then is refused with how long until one expires, without blocking anyone else', () => {
  const { cli, tick } = signIn();
  const started = [];
  for (let i = 0; i < MAX_PENDING_PER_CLIENT; i++) {
    started.push(cli.start({ name: `try ${i}`, from: '198.51.100.9' }));
    tick(60_000);
  }
  const over = (() => { try { cli.start({ name: 'one more', from: '198.51.100.9' }); } catch (err) { return err; } return null; })();
  assert.equal(over?.status, 429);
  assert.equal(over.scope, 'client');
  assert.equal(over.retryAfter, 5 * 60, 'the oldest of its codes, started 5 minutes ago, has 5 minutes left');
  assert.match(over.message, /5 sign-ins from your address are already waiting: finish one you started, or try again in 5 minutes/);
  assert.throws(() => cli.start({ name: 'same /64', from: '::ffff:198.51.100.9' }), { status: 429 }, 'the same address however it is written');
  assert.ok(cli.start({ name: 'someone else', from: '203.0.113.7' }).deviceCode, 'another client still starts one');

  // A code collected or denied frees its place at once; an abandoned one when it expires.
  cli.decide({ code: started[0].userCode, login: 'mia-dev', approve: true });
  assert.equal(cli.poll(started[0].deviceCode).status, 'approved');
  assert.ok(cli.start({ name: 'after collecting', from: '198.51.100.9' }).deviceCode);
  tick(4 * 60_000);
  assert.throws(() => cli.start({ name: 'full again', from: '198.51.100.9' }), { status: 429, retryAfter: 120 });
  // The oldest left was started at minute 1, so it expires at minute 11.
  tick(120_000);
  assert.ok(cli.start({ name: 'after one expired', from: '198.51.100.9' }).deviceCode);
});

test('a code denied in the browser holds no place, and its CLI still hears it was denied', () => {
  const { cli } = signIn();
  const codes = Array.from({ length: MAX_PENDING_PER_CLIENT }, () => cli.start({ from: '198.51.100.9' }));
  assert.throws(() => cli.start({ from: '198.51.100.9' }), { status: 429 });
  assert.equal(cli.decide({ code: codes[0].userCode, login: 'mia-dev', approve: false }), true);
  assert.ok(cli.start({ from: '198.51.100.9' }).deviceCode, 'a place before the denied CLI polls');
  assert.equal(cli.poll(codes[0].deviceCode).status, 'denied');
});

test('refusals are logged at most once a minute for each limit, with how many since', (t) => {
  const { cli, tick } = signIn();
  const lines = [];
  t.mock.method(console, 'warn', (message, fields) => { if (message.includes('too many waiting')) lines.push(fields); });
  for (let i = 0; i < MAX_PENDING_PER_CLIENT; i++) cli.start({ from: '198.51.100.9' });
  for (let i = 0; i < 3; i++) assert.throws(() => cli.start({ from: '198.51.100.9' }), { status: 429 });
  tick(60_000);
  assert.throws(() => cli.start({ from: '198.51.100.9' }), { status: 429 });
  assert.deepEqual(lines.map((l) => [l.scope, l.lastFrom, l.refused]), [['client', '198.51.100.9', 1], ['client', '198.51.100.9', 3]]);
});

test('IPv6 clients are counted by /64, so new addresses in one do not get new places', () => {
  const { cli } = signIn();
  for (let i = 1; i <= MAX_PENDING_PER_CLIENT; i++) cli.start({ name: `v6 ${i}`, from: `2001:db8:1:2::${i}` });
  assert.throws(() => cli.start({ from: '2001:db8:1:2:ffff::1' }), { status: 429, scope: 'client' });
  assert.ok(cli.start({ from: '2001:db8:1:3::1' }).deviceCode, 'the next /64 is another client');
});

test('the console-wide cap still holds as a backstop over many addresses', () => {
  const { cli, tick } = signIn();
  for (let i = 0; i < 200; i++) {
    cli.start({ from: `10.0.${Math.floor(i / 250)}.${i % 250}` });
    if (i === 0) tick(30_000);
  }
  const err = (() => { try { cli.start({ from: '203.0.113.7' }); } catch (e) { return e; } return null; })();
  assert.equal(err?.status, 429);
  assert.equal(err.scope, 'console');
  assert.equal(err.retryAfter, 600 - 30, 'until the oldest on the console expires');
});

// The device route over HTTP, its client address read as the console reads it.
async function deviceServer(t, { trustedProxies } = {}) {
  const store = { state: {}, save() {} };
  const cli = createCliSignIn({ store, trustedProxies });
  const server = http.createServer((req, res) => {
    handleCliApi({ req, res, url: new URL(req.url, 'http://x'), cli, publicUrl: 'https://console.example', about: () => ({}) });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  return (headers = {}) => fetch(`http://127.0.0.1:${port}/api/cli/device`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{"name":"x"}' });
}

test('over HTTP, a 429 carries Retry-After, and the limit counts the address a trusted proxy forwards', async (t) => {
  // The test reaches the server from loopback, as Caddy reaches the console: its X-Forwarded-For is taken.
  const device = await deviceServer(t);
  for (let i = 0; i < MAX_PENDING_PER_CLIENT; i++) assert.equal((await device({ 'x-forwarded-for': '198.51.100.9' })).status, 200);
  const refused = await device({ 'x-forwarded-for': '198.51.100.9' });
  assert.equal(refused.status, 429);
  const retryAfter = Number(refused.headers.get('retry-after'));
  assert.ok(retryAfter > 590 && retryAfter <= 600, `Retry-After ${retryAfter}`);
  assert.equal((await refused.json()).scope, 'client');
  assert.equal((await device({ 'x-forwarded-for': '203.0.113.7' })).status, 200, 'another client behind the same proxy still signs in');
  assert.equal((await device({ 'x-forwarded-for': '198.51.100.9, 203.0.113.8' })).status, 200, 'only the proxy\'s own entry counts');
});

test('over HTTP, a made-up X-Forwarded-For from a peer that is not a trusted proxy buys no new places', async (t) => {
  const device = await deviceServer(t, { trustedProxies: parseTrustedProxies('none') });
  for (let i = 0; i < MAX_PENDING_PER_CLIENT; i++) assert.equal((await device({ 'x-forwarded-for': `198.51.100.${i}` })).status, 200);
  const spoofed = await device({ 'x-forwarded-for': '198.51.100.250' });
  assert.equal(spoofed.status, 429, 'every request counted as the socket\'s own address');
  assert.ok(Number(spoofed.headers.get('retry-after')) > 0);
});

test('consoles sharing a waiting room count a client\'s places across all of them', () => {
  const devices = createCliDevices();
  const [a, b] = [0, 1].map(() => createCliSignIn({ store: { state: {}, save() {} }, devices }));
  for (let i = 0; i < MAX_PENDING_PER_CLIENT; i++) (i % 2 ? a : b).start({ from: '198.51.100.9' });
  assert.throws(() => a.start({ from: '198.51.100.9' }), { status: 429, scope: 'client' });
  assert.throws(() => b.start({ from: '198.51.100.9' }), { status: 429, scope: 'client' });
  assert.ok(b.start({ from: '203.0.113.7' }).deviceCode, 'another client still starts one');
});

test('denied codes, which hold no place, are bounded on their own: past 200 the oldest is dropped', () => {
  const { cli, tick } = signIn();
  const codes = [];
  for (let i = 0; i < 250; i++) {
    const started = cli.start({ from: '198.51.100.9' });
    assert.equal(cli.decide({ code: started.userCode, login: 'mia-dev', approve: false }), true);
    codes.push(started);
    tick(1);
  }
  assert.equal(cli.poll(codes[0].deviceCode).status, 'expired', 'the oldest denied record is gone');
  assert.equal(cli.poll(codes[49].deviceCode).status, 'expired');
  assert.equal(cli.poll(codes[50].deviceCode).status, 'denied', 'the newest 200 still say denied');
  assert.equal(cli.poll(codes[249].deviceCode).status, 'denied');
  assert.ok(cli.start({ from: '198.51.100.9' }).deviceCode, 'and none of them held a place');
});
