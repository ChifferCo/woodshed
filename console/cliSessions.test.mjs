import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createCliSignIn } from './cliSignIn.mjs';
import { carriesCliToken, cliMayCall, createCliAccess } from './cliSessions.mjs';
import { createHandler } from './server.mjs';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// A console where mia-dev and octocat each have a private session and a shared one runs, with a command line token
// made for each of them, and cookies for the page.
async function consoleFor(t, { people = null, writers = null, claudeToken = true } = {}) {
  let clock = Date.parse('2026-11-20T10:00:00Z');
  const store = { state: {}, save() {} };
  const cli = createCliSignIn({ store, now: () => clock, allowed: (login) => !people || people.has(login) });
  const sessions = [
    { id: 'aaaa0001', owner: 'mia-dev', title: 'Mia\'s', status: 'running', token: 'statusd-secret', terminalToken: 'ttyd-secret' },
    { id: 'bbbb0002', owner: 'octocat', title: 'Octocat\'s', status: 'stopped', token: 'statusd-secret-2', options: { agent: 'codex' } },
    { id: 'cccc0003', owner: null, title: 'Shared', status: 'running', startedBy: 'octocat', assignee: 'octocat', token: 'statusd-secret-3' },
  ];
  const calls = [];
  const fleet = {
    sessions: () => sessions,
    find: (id) => sessions.find((s) => s.id === id) ?? null,
    startPrivate: async (args) => { calls.push(['start', args]); return { id: 'dddd0004', owner: args.owner, status: 'queued', token: 'new-secret' }; },
    resumePrivate: async (args) => { calls.push(['resume', args]); return { ...sessions.find((s) => s.id === args.id), status: 'queued' }; },
    removePrivateSession: async (args) => { calls.push(['remove', args]); },
    stop: async (session, reason, { by }) => { calls.push(['stop', { id: session.id, by }]); },
    // As the fleet's: a shared session's pause and stop are its assignee's alone.
    limitsOf: (session) => ({ idleMs: (session.limits?.idleHours ?? 2) * 3_600_000, lifetimeMs: 12 * 3_600_000 }),
    pauseOf: (session) => (session.status === 'running' ? { at: '2026-11-20T10:10:00.000Z', why: 'idle' } : null),
    extend: (session, by) => {
      if (!session.owner && session.assignee !== by) throw Object.assign(new Error(`only ${session.assignee}, who has this session, can change when it pauses or stops`), { shown: true, forbidden: true });
      calls.push(['extend', { id: session.id, by }]);
    },
    setLimits: (session, values, by) => {
      calls.push(['limits', { id: session.id, by, values }]);
      session.limits = values;
    },
  };
  const userSettings = { view: () => ({ claudeToken: { set: claudeToken } }), refresh: async () => {}, limitsFor: () => ({ idleMs: 2 * 3_600_000, lifetimeMs: 12 * 3_600_000 }) };
  const asked = [];
  const auth = {
    enabled: () => true, available: () => true, sessionFor: async (cookie) => (cookie ? { login: /woodshed_session=([\w-]+)/.exec(cookie)[1] } : null),
    // GitHub's answer on write access to the repo, as auth.mjs asks it.
    canWrite: async (login) => { asked.push(login); return !writers || writers.has(login); },
  };
  const config = { host: '127.0.0.1', publicUrl: 'http://pending', extraHosts: [], repo: 'acme/app', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const handle = createHandler({ config, fleet, auth, cli, userSettings });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const origin = `http://localhost:${port}`;
  config.publicUrl = origin;
  const tokenOf = (login) => {
    const { deviceCode, userCode } = cli.start({ name: `${login}-laptop` });
    cli.decide({ code: userCode, login, approve: true });
    return cli.poll(deviceCode).token;
  };
  const tokens = { 'mia-dev': tokenOf('mia-dev'), octocat: tokenOf('octocat') };
  async function call(pathname, { method = 'GET', token = tokens['mia-dev'], headers = {}, body } = {}) {
    const res = await fetch(`${origin}${pathname}`, {
      method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  return { origin, call, calls, cli, tokens, asked, tick: (ms) => { clock += ms; } };
}

test('the command line\'s routes are exactly the session ones', () => {
  for (const [method, path] of [
    ['GET', '/api/sessions'], ['GET', '/api/my/projects'], ['POST', '/api/my/sessions'],
    ['POST', '/api/my/sessions/0a1b2c3d/resume'], ['POST', '/api/my/sessions/0a1b2c3d/remove'], ['POST', '/api/sessions/0a1b2c3d/stop'],
    ['POST', '/api/sessions/0a1b2c3d/extend'], ['POST', '/api/sessions/0a1b2c3d/limits'],
  ]) assert.equal(cliMayCall(method, path), true, `${method} ${path}`);
  for (const [method, path] of [
    ['POST', '/api/sessions'], ['GET', '/api/my'], ['POST', '/api/my/claude-token'], ['POST', '/api/my/remove'], ['POST', '/api/my/tunnel-token'],
    ['GET', '/api/secrets'], ['POST', '/api/people/admin'], ['POST', '/api/sessions/0a1b2c3d/send'], ['POST', '/api/sessions/0a1b2c3d/delete'],
    ['POST', '/api/sessions/0a1b2c3d/resume'], ['GET', '/api/sessions/0a1b2c3d/transcript'], ['POST', '/api/sessions/0a1b2c3d/pin'], ['POST', '/api/sessions/0a1b2c3d/assign'], ['DELETE', '/api/sessions'], ['GET', '/api/sessions/'],
    ['POST', '/api/my/sessions/0a1b2c3d/resume/x'], ['GET', '/term/0a1b2c3d/'], ['POST', '/api/my/cli-tokens/0123456789abcdef/revoke'], ['POST', '/api/my/terminal'],
  ]) assert.equal(cliMayCall(method, path), false, `${method} ${path}`);
  assert.equal(carriesCliToken({ authorization: `Bearer wsc_${'0'.repeat(64)}` }), true);
  assert.equal(carriesCliToken({ authorization: 'Bearer wt_abc' }), false, 'the tunnel\'s token is not the command line\'s');
  assert.equal(carriesCliToken({}), false);
});

test('a command line token lists, starts, stops, resumes and removes as exactly its person', async (t) => {
  const c = await consoleFor(t);
  const listed = await c.call('/api/sessions');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.login, 'mia-dev');
  assert.deepEqual(listed.body.sessions.map((s) => s.id).sort(), ['aaaa0001', 'cccc0003'], 'her own and the shared one, never octocat\'s private one');
  assert.ok(!JSON.stringify(listed.body).includes('secret'), 'no session token in the list');

  const projects = await c.call('/api/my/projects');
  assert.deepEqual(projects, { status: 200, body: { projects: [{ name: 'app', repo: 'acme/app' }], defaultProject: 'app', saved: false } });

  const started = await c.call('/api/my/sessions', { method: 'POST', body: { prompt: 'fix the login bug', owner: 'octocat', model: 'opus' } });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal(started.body.token, undefined);
  const [, args] = c.calls.find(([kind]) => kind === 'start');
  assert.equal(args.owner, 'mia-dev', 'the token says whose it is, not the body');
  assert.equal(args.prompt, 'fix the login bug');

  assert.equal((await c.call('/api/sessions/aaaa0001/stop', { method: 'POST', body: {} })).status, 200);
  assert.deepEqual(c.calls.at(-1), ['stop', { id: 'aaaa0001', by: 'mia-dev' }]);
  assert.equal((await c.call('/api/sessions/bbbb0002/stop', { method: 'POST', body: {} })).status, 404, 'another person\'s private session is not there');
  assert.equal((await c.call('/api/my/sessions/aaaa0001/resume', { method: 'POST', body: {} })).status, 201);
  assert.deepEqual(c.calls.at(-1)[1].owner, 'mia-dev');
  assert.equal((await c.call('/api/my/sessions/bbbb0002/remove', { method: 'POST', body: {} })).status, 200);
  assert.deepEqual(c.calls.at(-1), ['remove', { owner: 'mia-dev', id: 'bbbb0002' }], 'the fleet is asked for hers alone, which it refuses for another\'s');
});

test('a command line token extends a session and sets its own limits, where the page would let its person', async (t) => {
  const c = await consoleFor(t);
  const listed = await c.call('/api/sessions');
  const mine = listed.body.sessions.find((s) => s.id === 'aaaa0001');
  assert.deepEqual([mine.pause, mine.runsOn], [{ at: '2026-11-20T10:10:00.000Z', why: 'idle' }, { idleHours: 2, lifetimeHours: 12 }], 'the list says when each pauses');

  const extended = await c.call('/api/sessions/aaaa0001/extend', { method: 'POST', body: {} });
  assert.equal(extended.status, 200);
  assert.deepEqual(extended.body.pause, { at: '2026-11-20T10:10:00.000Z', why: 'idle' });
  assert.deepEqual(c.calls.at(-1), ['extend', { id: 'aaaa0001', by: 'mia-dev' }]);
  const limited = await c.call('/api/sessions/aaaa0001/limits', { method: 'POST', body: { idleHours: 4, lifetimeHours: null } });
  assert.equal(limited.status, 200);
  assert.deepEqual(limited.body.runsOn, { idleHours: 4, lifetimeHours: 12 });
  assert.deepEqual(c.calls.at(-1), ['limits', { id: 'aaaa0001', by: 'mia-dev', values: { idleHours: 4, lifetimeHours: null } }]);

  const shared = await c.call('/api/sessions/cccc0003/extend', { method: 'POST', body: {} });
  assert.equal(shared.status, 403, 'octocat has the shared session, so its time is his to give');
  assert.match(shared.body.error, /only octocat/);
  assert.equal((await c.call('/api/sessions/cccc0003/extend', { method: 'POST', body: {}, token: c.tokens.octocat })).status, 200);
  assert.equal((await c.call('/api/sessions/bbbb0002/limits', { method: 'POST', body: { idleHours: 4 } })).status, 404, 'another person\'s private session is not there');
});

test('a command line token reaches nothing else, and no page can use one', async (t) => {
  const c = await consoleFor(t);
  for (const [path, method] of [
    ['/api/my', 'GET'], ['/api/my/claude-token', 'POST'], ['/api/my/remove', 'POST'], ['/api/my/tunnel-token', 'POST'], ['/api/secrets', 'GET'],
    ['/api/people', 'GET'], ['/api/sessions', 'POST'], ['/api/sessions/aaaa0001/send', 'POST'], ['/api/sessions/aaaa0001/transcript', 'GET'],
    ['/settings', 'GET'], ['/term/aaaa0001/', 'GET'], ['/api/my/cli-tokens/0123456789abcdef/revoke', 'POST'], ['/api/my/terminal', 'POST'],
  ]) {
    const out = await c.call(path, { method, body: method === 'POST' ? { value: 'x' } : undefined });
    assert.equal(out.status, 403, `${method} ${path}`);
    assert.match(out.body.error, /does not reach this/);
  }
  assert.equal(c.calls.length, 0, 'nothing was started, stopped or changed');

  const fromPage = await c.call('/api/sessions', { headers: { origin: c.origin } });
  assert.equal(fromPage.status, 403, 'a page\'s call with a token, even from the console\'s own origin');

  const forged = await c.call('/api/sessions', { token: `wsc_${'0'.repeat(64)}` });
  assert.equal(forged.status, 401);
  c.cli.revoke('mia-dev', c.cli.list('mia-dev')[0].id);
  assert.equal((await c.call('/api/sessions')).status, 401, 'revoked on My settings');
  assert.equal((await c.call('/api/sessions', { token: c.tokens.octocat })).status, 200, 'another person\'s token is not touched');
  c.tick(91 * 24 * 3_600_000);
  assert.equal((await c.call('/api/sessions', { token: c.tokens.octocat })).status, 401, 'expired');
});

test('a token whose person left People stops at once', async (t) => {
  const people = new Set(['mia-dev', 'octocat']);
  const c = await consoleFor(t, { people });
  assert.equal((await c.call('/api/sessions')).status, 200);
  people.delete('mia-dev');
  assert.equal((await c.call('/api/my/sessions', { method: 'POST', body: { prompt: 'go' } })).status, 401);
  assert.equal(c.calls.length, 0);
});

test('the page\'s cookie path is as it was: its writes still need x-woodshed and the console\'s origin', async (t) => {
  const c = await consoleFor(t);
  const cookie = 'woodshed_session=mia-dev';
  const bare = await c.call('/api/my/sessions', { method: 'POST', token: null, headers: { cookie }, body: { prompt: 'go' } });
  assert.equal(bare.status, 403);
  assert.equal(bare.body.error, 'missing x-woodshed header');
  const otherSite = await c.call('/api/my/sessions', { method: 'POST', token: null, headers: { cookie, 'x-woodshed': '1', origin: 'https://evil.example' }, body: { prompt: 'go' } });
  assert.equal(otherSite.status, 403);
  const page = await c.call('/api/my/sessions', { method: 'POST', token: null, headers: { cookie, 'x-woodshed': '1', origin: c.origin }, body: { prompt: 'go' } });
  assert.equal(page.status, 201);
  assert.equal((await c.call('/api/my', { token: null, headers: { cookie } })).status, 200, 'the page reads what a token may not');
  assert.equal((await c.call('/api/sessions', { token: null })).status, 401, 'no cookie and no token');
});

test('a token whose person lost write access on GitHub stops, though they are still on People, and all their sign-ins end', async (t) => {
  const writers = new Set(['octocat']);
  const c = await consoleFor(t, { people: new Set(['mia-dev', 'octocat']), writers });
  const refused = await c.call('/api/my/sessions', { method: 'POST', body: { prompt: 'go' } });
  assert.equal(refused.status, 401);
  assert.match(refused.body.error, /no longer have write access/);
  assert.equal(c.calls.length, 0, 'nothing started');
  assert.deepEqual(c.cli.list('mia-dev'), [], 'her command line sign-ins ended, as a browser\'s session does');
  assert.equal((await c.call('/api/sessions')).status, 401);

  assert.equal((await c.call('/api/sessions', { token: c.tokens.octocat })).status, 200);
  assert.equal((await c.call('/api/sessions', { token: c.tokens.octocat })).status, 200);
  assert.equal(c.asked.filter((l) => l === 'octocat').length, 1, 'asked once, then trusted for the hour');
});

test('write access is asked at a token\'s first use and then hourly, and GitHub not answering lets the call through', async () => {
  let clock = 0;
  let answer = true;
  const asked = [];
  const revoked = [];
  const access = createCliAccess({
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
  assert.equal(await createCliAccess({ canWrite: null, revokeAll() {} }).allowed('mia'), true, 'no GitHub sign-in, nothing to ask');
});

test('resume answers someone else\'s private session as it does one that does not exist, whatever it runs', async (t) => {
  const c = await consoleFor(t, { claudeToken: false });
  const theirs = await c.call('/api/my/sessions/bbbb0002/resume', { method: 'POST', body: {} });
  const none = await c.call('/api/my/sessions/99990009/resume', { method: 'POST', body: {} });
  assert.deepEqual(theirs, none, 'octocat\'s Codex session cannot be told from no session');
  assert.deepEqual(none, { status: 409, body: { error: 'no session you can open with that id' } });
  assert.equal(c.calls.length, 0, 'the fleet is never asked');
  assert.match((await c.call('/api/my/sessions/aaaa0001/resume', { method: 'POST', body: {} })).body.error, /save your Claude token/, 'her own still says what it needs');
});
