import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONSOLE_FAILED, SESSION_COOKIE, createAuth, parseCookies, signInFailure } from './auth.mjs';
import { createGitHubPeople } from './githubPeople.mjs';
import { createMembers } from './members.mjs';

// GitHub's two sign-in calls: the code for a user token, then the token for the login.
function fakeGitHub({ login = 'octo', codeOk = true, codeError = 'bad_verification_code', userStatus = 200, id = 1, name = null, emails = [{ email: 'octo@example.com', primary: true, verified: true }], emailsOk = true } = {}) {
  const calls = [];
  async function fetchImpl(url, opts = {}) {
    calls.push({ url, body: opts.body ? JSON.parse(opts.body) : null, auth: opts.headers?.authorization });
    if (url.endsWith('/login/oauth/access_token')) {
      return new Response(JSON.stringify(codeOk ? { access_token: 'ghu_user' } : { error: codeError }), { status: 200 });
    }
    if (url.endsWith('/user/emails')) return new Response(JSON.stringify(emails), { status: emailsOk ? 200 : 403 });
    if (url.endsWith('/user')) return new Response(JSON.stringify(userStatus === 200 ? { login, id, name } : {}), { status: userStatus });
    return new Response('{}', { status: 404 });
  }
  return { fetchImpl, calls };
}

function setup({ secret = 'cs', writers = ['octo'], canWrite = null, github = fakeGitHub(), clock = { now: 1_000_000 }, required = false, store = null, members = null, slackPeople = null } = {}) {
  store ??= { state: {}, saves: 0, save() { this.saves += 1; } };
  const writeChecks = [];
  const auth = createAuth({
    publicUrl: 'https://console.example',
    store,
    clientId: async () => 'Iv1.app',
    clientSecret: () => secret,
    canWrite: canWrite ?? (async (login) => { writeChecks.push(login); return writers.includes(login); }),
    fetchImpl: github.fetchImpl,
    now: () => clock.now,
    required,
    people: createGitHubPeople({ store, github: null, now: () => clock.now }),
    members: members?.(store) ?? null,
    slackPeople,
  });
  return { auth, store, github, clock, writeChecks, writers };
}

function cookiesFrom(setCookies) {
  return [setCookies].flat().map((c) => c.split(';')[0]).join('; ');
}

async function signIn(ctx, next = '/s/0a1b2c3d') {
  const started = await ctx.auth.start(next);
  const state = new URL(started.location).searchParams.get('state');
  return ctx.auth.callback({ code: 'c0de', state, cookieHeader: cookiesFrom(started.setCookie) });
}

test('the client secret makes sign-in available, and the first sign-in that works makes it required', async () => {
  const off = setup({ secret: null });
  assert.deepEqual([off.auth.available(), off.auth.enabled()], [false, false]);
  const ctx = setup();
  assert.deepEqual([ctx.auth.available(), ctx.auth.enabled()], [true, false], 'a wrong Callback URL must lock nobody out');
  await assert.rejects(signIn(setup({ github: fakeGitHub({ login: 'stranger' }) })));
  await signIn(ctx);
  assert.equal(ctx.auth.enabled(), true);
  ctx.auth.disarm();
  assert.equal(ctx.auth.enabled(), false, 'a replaced, unproven secret stops requiring sign-in');
});

test('a console that always requires sign-in requires it with no secret, an unproven one, and a replaced one', async () => {
  assert.equal(setup({ secret: null, required: true }).auth.enabled(), true, 'nobody gets in until the secret is set');
  const ctx = setup({ required: true });
  assert.deepEqual([ctx.auth.available(), ctx.auth.enabled()], [true, true]);
  await signIn(ctx);
  ctx.auth.disarm();
  assert.equal(ctx.auth.enabled(), true);
  assert.equal(ctx.store.state.authArmed, true, 'disarm leaves the stored state alone');
});

test('a malformed cookie on the origin is ignored, not an error', async () => {
  const ctx = setup();
  const good = cookiesFrom((await signIn(ctx)).setCookies);
  assert.deepEqual(parseCookies('other=%E0%A4%A; woodshed_session=%zz'), { other: '%E0%A4%A', woodshed_session: '%zz' });
  assert.equal(await ctx.auth.sessionFor('__Host-woodshed_session=%E0%A4%A'), null);
  assert.deepEqual(await ctx.auth.sessionFor(`junk=%E0%A4%A; ${good}`), { login: 'octo' });
});

test('a refused sign-in does not make sign-in required', async () => {
  const ctx = setup({ github: fakeGitHub({ login: 'stranger' }) });
  await assert.rejects(signIn(ctx));
  assert.equal(ctx.auth.enabled(), false);
});

test('start sends the browser to GitHub with the App, the callback and a state the browser also holds', async () => {
  const { auth } = setup();
  const { location, setCookie } = await auth.start('/events');
  const url = new URL(location);
  assert.equal(`${url.origin}${url.pathname}`, 'https://github.com/login/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'Iv1.app');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://console.example/auth/callback');
  assert.match(url.searchParams.get('state'), /^[0-9a-f]{48}$/);
  assert.equal(parseCookies(setCookie.split(';')[0])['__Host-woodshed_oauth_state'], url.searchParams.get('state'));
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
});

test('a writer signs in: the session cookie works, the file holds only its hash, and the user token is dropped', async () => {
  const ctx = setup();
  const done = await signIn(ctx);
  assert.equal(done.login, 'octo');
  assert.equal(done.next, '/s/0a1b2c3d');
  const sessionCookie = done.setCookies.find((c) => c.startsWith(`__Host-${SESSION_COOKIE}=`));
  assert.match(sessionCookie, /HttpOnly; SameSite=Lax; Secure; Max-Age=43200/);
  const id = sessionCookie.split(';')[0].split('=')[1];
  assert.deepEqual(await ctx.auth.sessionFor(cookiesFrom(sessionCookie)), { login: 'octo' });
  const stored = JSON.stringify(ctx.store.state);
  assert.ok(!stored.includes(id), 'the cookie itself is not stored');
  assert.ok(!stored.includes('ghu_user'), 'the user token is not stored');
  assert.deepEqual(ctx.github.calls[0].body, { client_id: 'Iv1.app', client_secret: 'cs', code: 'c0de', redirect_uri: 'https://console.example/auth/callback' });
  assert.equal(ctx.github.calls[1].auth, 'Bearer ghu_user');
});

test('someone without write access is refused, and no session is made', async () => {
  const ctx = setup({ github: fakeGitHub({ login: 'stranger' }) });
  await assert.rejects(signIn(ctx), (err) => err.shown && /@stranger has no write access/.test(err.message) && err.next === '/s/0a1b2c3d');
  assert.deepEqual(ctx.store.state.authSessions ?? {}, {});
});

test('a sign-in keeps the account\'s id and display name, and refuses the handle once another account holds it', async () => {
  const first = setup({ github: fakeGitHub({ id: 101, name: 'Octo Cat' }) });
  await signIn(first);
  assert.deepEqual(first.store.state.githubAccounts.octo, { id: 101, name: 'Octo Cat', checkedAt: 1_000_000 });

  const taken = setup({ store: first.store, github: fakeGitHub({ id: 202, name: 'Someone Else' }) });
  const sessionsBefore = Object.keys(first.store.state.authSessions).length;
  await assert.rejects(signIn(taken), (err) => err.shown && /another GitHub account's name/.test(err.message) && err.next === '/s/0a1b2c3d');
  assert.equal(Object.keys(first.store.state.authSessions).length, sessionsBefore, 'no session for the other account');
  assert.deepEqual(first.store.state.githubAccounts.octo, { id: 101, name: 'Octo Cat', checkedAt: 1_000_000 }, 'the first account is kept');
});

test('a callback this browser did not start, or with a reused state, is refused', async () => {
  const ctx = setup();
  const started = await ctx.auth.start('/');
  const state = new URL(started.location).searchParams.get('state');
  await assert.rejects(ctx.auth.callback({ code: 'c', state, cookieHeader: '__Host-woodshed_oauth_state=someone-elses' }), /expired or was not started here/);
  // The state is spent even by a failed try, so the right browser cannot replay it either.
  await assert.rejects(ctx.auth.callback({ code: 'c', state, cookieHeader: cookiesFrom(started.setCookie) }), /expired or was not started here/);
  assert.equal(ctx.github.calls.length, 0, 'GitHub is never asked');
});

test('an expired or used code is the person\'s to fix: sign in again', async () => {
  const ctx = setup({ github: fakeGitHub({ codeOk: false }) });
  await assert.rejects(signIn(ctx), (err) => err.shown && /expired or was already used/.test(err.message) && err.next === '/s/0a1b2c3d');
});

test('the person\'s problems show their own message, and the console\'s say only to look at its log', async () => {
  async function failure(ctx) {
    try {
      await signIn(ctx);
    } catch (err) {
      return { ...signInFailure(err), step: err.step, next: err.next };
    }
    throw new Error('signed in');
  }
  const yours = [
    setup({ github: fakeGitHub({ codeOk: false }) }),
    setup({ github: fakeGitHub({ login: 'stranger' }) }),
  ];
  for (const ctx of yours) {
    const got = await failure(ctx);
    assert.equal(got.fault, 'yours');
    assert.notEqual(got.message, CONSOLE_FAILED);
  }
  const consoles = {
    'a client secret GitHub does not take': [setup({ github: fakeGitHub({ codeOk: false, codeError: 'incorrect_client_credentials' }) }), 'sign-in code'],
    'GitHub not saying who signed in': [setup({ github: fakeGitHub({ userStatus: 502 }) }), 'sign-in code'],
    'gh missing': [setup({ canWrite: async () => { throw new Error('spawn gh ENOENT'); } }), 'write access'],
    'GitHub not reached': [setup({ github: { fetchImpl: async () => { throw new TypeError('fetch failed'); }, calls: [] } }), 'sign-in code'],
  };
  for (const [why, [ctx, step]] of Object.entries(consoles)) {
    const got = await failure(ctx);
    assert.deepEqual(got, { fault: 'console', message: CONSOLE_FAILED, step, next: '/s/0a1b2c3d' }, why);
  }
  assert.equal(signInFailure(new Error('/home/woodshed/.config/gh/hosts.yml: ghu_secret')).message, CONSOLE_FAILED, 'nothing of the error reaches the page');
});

test('next only ever points at this console', async () => {
  for (const evil of ['https://evil.example/', '//evil.example/x', '/\\evil.example', '\\\\evil.example', '/\t/evil.example', 'javascript:alert(1)']) {
    const done = await signIn(setup(), evil);
    assert.equal(done.next, '/', evil);
  }
  // These resolve to a path of //evil.example on this console, which a Location header would follow off it.
  for (const evil of ['/.//evil.example', '/..//evil.example', '/a/..//evil.example/x']) {
    const { next } = await signIn(setup(), evil);
    assert.ok(!/^[/\\]{2}/.test(next), `${evil} became ${next}`);
    assert.equal(new URL(next, 'https://console.example').origin, 'https://console.example', evil);
  }
  assert.equal((await signIn(setup(), '/events?show=acted#top')).next, '/events?show=acted#top');
});

test('write access is checked again after an hour: still a writer stays, a leaver is signed out', async () => {
  const ctx = setup({ writers: ['octo'] });
  const cookie = cookiesFrom((await signIn(ctx)).setCookies);
  ctx.clock.now += 30 * 60_000;
  assert.deepEqual(await ctx.auth.sessionFor(cookie), { login: 'octo' });
  assert.deepEqual(ctx.writeChecks, ['octo'], 'no recheck within the hour');
  ctx.clock.now += 31 * 60_000;
  assert.deepEqual(await ctx.auth.sessionFor(cookie), { login: 'octo' });
  assert.equal(ctx.writeChecks.length, 2);
  ctx.writers.length = 0;
  ctx.clock.now += 61 * 60_000;
  assert.equal(await ctx.auth.sessionFor(cookie), null);
  assert.deepEqual(ctx.store.state.authSessions, {});
});

test('only the `__Host-` cookie counts on https, so a session app cannot plant one for the console', async () => {
  const ctx = setup();
  const done = await signIn(ctx);
  const id = done.setCookies.find((c) => c.startsWith('__Host-')).split(';')[0].split('=')[1];
  assert.equal(await ctx.auth.sessionFor(`${SESSION_COOKIE}=${id}`), null);
  assert.deepEqual(await ctx.auth.sessionFor(`__Host-${SESSION_COOKIE}=${id}`), { login: 'octo' });
});

test('a session ends after 12 hours, and on sign-out', async () => {
  const ctx = setup();
  const cookie = cookiesFrom((await signIn(ctx)).setCookies);
  const other = cookiesFrom((await signIn(ctx)).setCookies);
  assert.match(ctx.auth.signOut(cookie), /^__Host-woodshed_session=; .*Max-Age=0/);
  assert.equal(await ctx.auth.sessionFor(cookie), null);
  assert.deepEqual(await ctx.auth.sessionFor(other), { login: 'octo' }, 'signing out ends only that browser');
  ctx.clock.now += 12 * 3_600_000;
  assert.equal(await ctx.auth.sessionFor(other), null);
});

test('requests arriving together share one hourly check', async () => {
  const ctx = setup();
  const cookie = cookiesFrom((await signIn(ctx)).setCookies);
  ctx.clock.now += 61 * 60_000;
  const answers = await Promise.all(Array.from({ length: 5 }, () => ctx.auth.sessionFor(cookie)));
  assert.deepEqual(answers, Array(5).fill({ login: 'octo' }));
  assert.deepEqual(ctx.writeChecks, ['octo', 'octo'], 'one check at sign-in, then five requests share one');
});

test('GitHub failing during the hourly check keeps people signed in, and is asked again only after 5 minutes', async () => {
  const ctx = setup();
  const cookie = cookiesFrom((await signIn(ctx)).setCookies);
  ctx.clock.now += 61 * 60_000;
  let calls = 0;
  let down = true;
  const auth = createAuth({
    publicUrl: 'https://console.example', store: ctx.store, clientId: async () => 'x', clientSecret: () => 'cs', now: () => ctx.clock.now,
    canWrite: async () => { calls += 1; if (down) throw new Error('gh api failed: HTTP 502'); return true; },
  });
  assert.deepEqual(await auth.sessionFor(cookie), { login: 'octo' });
  for (let i = 0; i < 10; i += 1) assert.deepEqual(await auth.sessionFor(cookie), { login: 'octo' });
  assert.equal(calls, 1, 'no gh call per request while GitHub is down');
  ctx.clock.now += 5 * 60_000;
  down = false;
  assert.deepEqual(await auth.sessionFor(cookie), { login: 'octo' });
  assert.equal(calls, 2);
  assert.deepEqual(await auth.sessionFor(cookie), { login: 'octo' });
  assert.equal(calls, 2, 'a check that went through lasts the hour again');
});

test('an app code works once, for its own app, within a minute, and only for a signed-in browser', async () => {
  const ctx = setup();
  const consoleCookie = cookiesFrom((await signIn(ctx)).setCookies);
  assert.equal(await ctx.auth.appCode({ cookieHeader: 'nothing=1', appId: '0a1b2c3d' }), null, 'no console sign-in, no code');

  const code = await ctx.auth.appCode({ cookieHeader: consoleCookie, appId: '0a1b2c3d' });
  assert.equal(await ctx.auth.claimAppCode({ code, appId: 'ffffffff' }), null, 'a code for another app');
  assert.equal(await ctx.auth.claimAppCode({ code, appId: '0a1b2c3d' }), null, 'a refused claim still uses the code up');

  const again = await ctx.auth.appCode({ cookieHeader: consoleCookie, appId: '0a1b2c3d' });
  const claimed = await ctx.auth.claimAppCode({ code: again, appId: '0a1b2c3d' });
  assert.equal(claimed.login, 'octo');
  assert.match(claimed.setCookie, /^__Host-woodshed_app=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Lax; Secure; Max-Age=43200$/);
  assert.equal(await ctx.auth.claimAppCode({ code: again, appId: '0a1b2c3d' }), null, 'used once');
  assert.ok(!JSON.stringify(ctx.store.state).includes(claimed.setCookie.split(';')[0].split('=')[1]), 'the app cookie itself is not stored');

  const late = await ctx.auth.appCode({ cookieHeader: consoleCookie, appId: '0a1b2c3d' });
  ctx.clock.now += 61_000;
  assert.equal(await ctx.auth.claimAppCode({ code: late, appId: '0a1b2c3d' }), null, 'expired');
});

async function appCookieFor(ctx, consoleCookie, appId) {
  const code = await ctx.auth.appCode({ cookieHeader: consoleCookie, appId });
  return cookiesFrom((await ctx.auth.claimAppCode({ code, appId })).setCookie);
}

test('an app cookie is good for its own app only, and ends when its console session does', async () => {
  const ctx = setup();
  const consoleCookie = cookiesFrom((await signIn(ctx)).setCookies);
  const a = await appCookieFor(ctx, consoleCookie, '0a1b2c3d');
  assert.deepEqual(await ctx.auth.appSessionFor({ cookieHeader: a, appId: '0a1b2c3d' }), { login: 'octo' });
  assert.equal(await ctx.auth.appSessionFor({ cookieHeader: a, appId: 'ffffffff' }), null, 'app A\'s cookie on app B');
  assert.equal(await ctx.auth.appSessionFor({ cookieHeader: a.replace('__Host-', ''), appId: '0a1b2c3d' }), null, 'only the __Host- name counts');
  assert.equal(await ctx.auth.appSessionFor({ cookieHeader: consoleCookie, appId: '0a1b2c3d' }), null, 'the console cookie is not an app cookie');

  ctx.auth.signOut(consoleCookie);
  assert.equal(await ctx.auth.appSessionFor({ cookieHeader: a, appId: '0a1b2c3d' }), null, 'signing out of the console signs its apps out');
  assert.deepEqual(ctx.store.state.authAppSessions, {});

  const other = setup();
  const b = await appCookieFor(other, cookiesFrom((await signIn(other)).setCookies), '0a1b2c3d');
  other.writers.length = 0;
  other.clock.now += 3_600_000;
  assert.equal(await other.auth.appSessionFor({ cookieHeader: b, appId: '0a1b2c3d' }), null, 'losing write access signs the app out at the next check');
});

test('only a Connect GitHub sign-in hands its token on, and only for someone with write access', async () => {
  const kept = [];
  const github = fakeGitHub();
  const store = { state: {}, save() {} };
  const writers = ['octo'];
  const auth = createAuth({
    publicUrl: 'https://console.example', store, clientId: async () => 'Iv1.app', clientSecret: () => 'cs',
    canWrite: async (login) => writers.includes(login), fetchImpl: github.fetchImpl,
    onConnect: async ({ login, answer }) => { kept.push([login, answer.access_token]); },
  });
  const go = async (opts) => {
    const started = await auth.start('/settings', opts);
    const state = new URL(started.location).searchParams.get('state');
    return auth.callback({ code: 'c0de', state, cookieHeader: cookiesFrom(started.setCookie) });
  };
  await go();
  assert.deepEqual(kept, [], 'an ordinary sign-in drops the token');
  const connected = await go({ connect: true });
  assert.equal(connected.next, '/settings');
  assert.deepEqual(kept, [['octo', 'ghu_user']]);
  writers.length = 0;
  await assert.rejects(go({ connect: true }), /no write access/);
  assert.equal(kept.length, 1, 'nothing kept for someone who lost write access');
});

test('a writer not on the list signs in only as a visitor, until a member lets them in; removing them shuts them out at once', async () => {
  const store = { state: { members: { joel: { how: 'first to sign in' } } }, saves: 0, save() { this.saves += 1; } };
  let members;
  const ctx = setup({ store, members: (s) => (members = createMembers({ store: s })) });
  const cookie = cookiesFrom((await signIn(ctx)).setCookies);
  assert.equal(await ctx.auth.sessionFor(cookie), null, 'no page, API or terminal opens for a visitor');
  assert.deepEqual(await ctx.auth.visitorFor(cookie), { login: 'octo' });
  members.ask({ login: 'octo' });
  members.accept({ login: 'octo', by: 'joel' });
  assert.deepEqual(await ctx.auth.sessionFor(cookie), { login: 'octo' }, 'accepted, the same session lets them in');
  members.remove({ login: 'octo', by: 'joel' });
  assert.equal(await ctx.auth.sessionFor(cookie), null);
});

test('the first writer to sign in on a console with an empty list becomes its first member', async () => {
  let members;
  const ctx = setup({ members: (s) => (members = createMembers({ store: s })) });
  const cookie = cookiesFrom((await signIn(ctx)).setCookies);
  assert.deepEqual(await ctx.auth.sessionFor(cookie), { login: 'octo' });
  assert.equal(members.isMember('octo'), true);
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a sign-in matches the person on Slack by their verified emails, and a failure there never fails the sign-in', async () => {
  const asked = [];
  const slackPeople = { async matchOnSignIn({ login, emails }) { asked.push({ login, emails: await emails() }); } };
  const ctx = setup({ slackPeople, github: fakeGitHub({ emails: [
    { email: 'old@home.example', primary: false, verified: true },
    { email: 'octo@example.com', primary: true, verified: true },
    { email: 'unproven@x.example', primary: false, verified: false },
  ] }) });
  assert.equal((await signIn(ctx)).login, 'octo');
  await settle();
  assert.deepEqual(asked, [{ login: 'octo', emails: ['octo@example.com', 'old@home.example'] }], 'the primary first, never an unverified one');

  const refused = setup({ github: fakeGitHub({ emailsOk: false }), slackPeople: { async matchOnSignIn({ login, emails }) { asked.push({ login, emails: await emails() }); } } });
  await signIn(refused);
  await settle();
  assert.deepEqual(asked.at(-1).emails, [], 'GitHub refusing the emails leaves the list empty');

  const broken = setup({ slackPeople: { async matchOnSignIn() { throw new Error('slack down'); } } });
  assert.equal((await signIn(broken)).login, 'octo', 'a match that throws does not stop the sign-in');
  await settle();
});

test('someone who is not a member is not matched on Slack', async () => {
  const asked = [];
  const slackPeople = { async matchOnSignIn({ login }) { asked.push(login); } };
  const store = { state: { members: { other: { addedBy: null, addedAt: 'x', how: 'invited' } } }, saves: 0, save() { this.saves += 1; } };
  const ctx = setup({ slackPeople, store, members: (st) => createMembers({ store: st }) });
  await signIn(ctx);
  await settle();
  assert.deepEqual(asked, [], 'a writer who has to ask to join leaves no Slack entry');
});
