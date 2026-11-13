import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createSessionApi, sessionForAuthorization } from './sessionApi.mjs';

const SESSIONS = [
  { id: 'aaaaaaaa', status: 'running', token: 'live-token' },
  { id: 'bbbbbbbb', status: 'stopped', token: 'old-token' },
  { id: 'cccccccc', status: 'starting', token: 'new-token' },
];

test('sessionForAuthorization accepts only an active session\'s own token', () => {
  assert.equal(sessionForAuthorization('Bearer live-token', SESSIONS)?.id, 'aaaaaaaa');
  assert.equal(sessionForAuthorization('Bearer new-token', SESSIONS)?.id, 'cccccccc');
  assert.equal(sessionForAuthorization('Bearer old-token', SESSIONS), null, 'a stopped session gets nothing');
  assert.equal(sessionForAuthorization('Bearer live-tokenX', SESSIONS), null);
  assert.equal(sessionForAuthorization('live-token', SESSIONS), null);
  assert.equal(sessionForAuthorization(undefined, SESSIONS), null);
  assert.equal(sessionForAuthorization('Bearer x', [{ id: 'dddddddd', status: 'running' }]), null, 'a session without a token never matches');
});

function request(port, { method = 'POST', path = '/github-token', authorization, body }) {
  return new Promise((resolve, reject) => {
    const headers = authorization ? { authorization } : {};
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('the session API hands an active session a token, and nothing to anyone else', async (t) => {
  let minted = 0;
  const tokens = { token: async () => { minted++; return { token: 'ghs_abc', expiresAt: Date.parse('2026-10-22T11:00:00Z') }; } };
  const handle = createSessionApi({ fleet: { sessions: () => SESSIONS }, tokens });
  const server = http.createServer((req, res) => { handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  assert.deepEqual(await request(port, { authorization: 'Bearer live-token' }), {
    status: 200, body: { token: 'ghs_abc', expiresAt: '2026-10-22T11:00:00.000Z' },
  });
  assert.equal((await request(port, { authorization: 'Bearer old-token' })).status, 401);
  assert.equal((await request(port, {})).status, 401);
  assert.equal((await request(port, { method: 'GET', authorization: 'Bearer live-token' })).status, 404);
  assert.equal((await request(port, { path: '/api/sessions', authorization: 'Bearer live-token' })).status, 404);
  assert.equal(minted, 1, 'only the authorised request minted');
});

test('a private session gets its own owner\'s settings and Claude token, and a shared one nothing', async (t) => {
  const sessions = [
    { id: 'aaaaaaaa', status: 'running', token: 'shared-token', owner: null },
    { id: 'bbbbbbbb', status: 'running', token: 'joel-token', owner: 'octocat' },
    { id: 'cccccccc', status: 'starting', token: 'mia-token', owner: 'mia-dev' },
  ];
  const asked = [];
  const userSettings = {
    claudeToken: async (login) => { asked.push(login); return login === 'octocat' ? 'sk-ant-joel' : null; },
    ownFiles: async (login) => ({ 'api-env': `LOG_LEVEL=debug # ${login}`, 'web-env': null, 'tmux-conf': null }),
    ownWholeFiles: async (login) => ({ 'app/.env.production': `NOTION_TOKEN=x # ${login}` }),
    gitIdentity: (login) => (login === 'octocat' ? { name: 'Mona Octocat', email: '1+octocat@users.noreply.github.com' } : null),
  };
  const handle = createSessionApi({ fleet: { sessions: () => sessions }, tokens: { token: async () => ({}) }, userSettings });
  const server = http.createServer((req, res) => { handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const settings = (authorization) => request(port, { path: '/settings', authorization });

  assert.deepEqual(await settings('Bearer joel-token'), {
    status: 200,
    body: {
      files: { 'api-env': 'LOG_LEVEL=debug # octocat', 'web-env': null, 'tmux-conf': null },
      ownFiles: { 'app/.env.production': 'NOTION_TOKEN=x # octocat' },
      git: { name: 'Mona Octocat', email: '1+octocat@users.noreply.github.com' }, database: null, claudeToken: 'sk-ant-joel',
    },
  });
  assert.equal((await settings('Bearer shared-token')).status, 404, 'a shared session has no owner to ask for');
  assert.equal((await settings('Bearer mia-token')).status, 409, 'an owner with no token saved');
  assert.equal((await settings('Bearer nobody')).status, 401);
  assert.deepEqual(asked, ['octocat', 'mia-dev'], 'each session asked for its own owner, and only its own');
});

test('a private session gets its owner\'s own databases, and none until they are ready', async (t) => {
  const sessions = [
    { id: 'bbbbbbbb', status: 'running', token: 'joel-token', owner: 'octocat' },
    { id: 'cccccccc', status: 'running', token: 'mia-token', owner: 'mia-dev' },
  ];
  const userSettings = { claudeToken: async () => 'sk-ant-x', ownFiles: async () => ({}), gitIdentity: () => null };
  const databases = {
    available: true,
    credentials: async (login) => (login === 'octocat' ? { user: 'woodshed_octocat', password: 'ab12', name: 'woodshed_octocat' } : null),
  };
  const handle = createSessionApi({ fleet: { sessions: () => sessions }, tokens: { token: async () => ({}) }, userSettings, databases });
  const server = http.createServer((req, res) => { handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const joel = await request(port, { path: '/settings', authorization: 'Bearer joel-token' });
  assert.deepEqual(joel.body.database, { user: 'woodshed_octocat', password: 'ab12', name: 'woodshed_octocat' });
  const mia = await request(port, { path: '/settings', authorization: 'Bearer mia-token' });
  assert.equal(mia.status, 409, 'the private task definition holds no database password, so a session without its own must not start');
  assert.match(mia.body.error, /mia-dev's own databases are not ready/);
});

test('a shared session gets its own databases and nothing else, waiting while they are copied', async (t) => {
  const sessions = [
    { id: 'aaaaaaaa', status: 'starting', token: 'ready-token', owner: null },
    { id: 'bbbbbbbb', status: 'starting', token: 'copying-token', owner: null },
    { id: 'cccccccc', status: 'starting', token: 'failed-token', owner: null },
  ];
  const records = {
    aaaaaaaa: { status: 'ready', database: { user: 'woodshed__aaaaaaaa', password: 'cd34', name: 'woodshed__aaaaaaaa' }, error: null },
    bbbbbbbb: { status: 'working', database: null, error: null },
    cccccccc: { status: 'failed', database: null, error: 'the task exited with 1' },
  };
  const databases = { available: true, sessionDatabase: async (id) => records[id] };
  const handle = createSessionApi({ fleet: { sessions: () => sessions }, tokens: { token: async () => ({}) }, databases });
  const server = http.createServer((req, res) => { handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const settings = (token) => request(port, { path: '/settings', authorization: `Bearer ${token}` });

  assert.deepEqual(await settings('ready-token'), { status: 200, body: { database: records.aaaaaaaa.database } }, 'no Claude token, files or git identity');
  assert.equal((await settings('copying-token')).status, 503, 'the entrypoint asks again');
  const failed = await settings('failed-token');
  assert.equal(failed.status, 409);
  assert.match(failed.body.error, /could not be made: the task exited with 1/);

  const without = createSessionApi({ fleet: { sessions: () => sessions }, tokens: { token: async () => ({}) }, databases: { available: false } });
  const plain = http.createServer((req, res) => { without(req, res); });
  await new Promise((resolve) => plain.listen(0, '127.0.0.1', resolve));
  t.after(() => plain.close());
  assert.equal((await request(plain.address().port, { path: '/settings', authorization: 'Bearer ready-token' })).status, 404,
    'where the console makes no databases, the environment names one');
});

test('a private session whose owner connected GitHub gets their own token; anyone else the installation token', async (t) => {
  const sessions = [
    { id: 'aaaaaaaa', status: 'running', token: 'shared-token', owner: null },
    { id: 'bbbbbbbb', status: 'running', token: 'joel-token', owner: 'octocat' },
    { id: 'cccccccc', status: 'running', token: 'mia-token', owner: 'mia-dev' },
    { id: 'dddddddd', status: 'running', token: 'sam-token', owner: 'sam-ops' },
  ];
  const tokens = { token: async () => ({ token: 'ghs_installation', expiresAt: Date.parse('2026-10-23T11:00:00Z') }) };
  const githubUser = {
    tokenFor: async (login) => {
      if (login === 'octocat') return { token: 'ghu_joel', expiresAt: Date.parse('2026-10-23T18:00:00Z') };
      if (login === 'sam-ops') throw Object.assign(new Error('GitHub no longer accepts @sam-ops\'s authorization'), { shown: true });
      return null;
    },
  };
  const handle = createSessionApi({ fleet: { sessions: () => sessions }, tokens, githubUser });
  const server = http.createServer((req, res) => { handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const token = async (auth) => (await request(port, { authorization: `Bearer ${auth}` }));

  assert.deepEqual((await token('joel-token')).body, { token: 'ghu_joel', expiresAt: '2026-10-23T18:00:00.000Z' });
  assert.equal((await token('mia-token')).body.token, 'ghs_installation', 'not connected: the App, as before');
  assert.equal((await token('shared-token')).body.token, 'ghs_installation', 'a shared session never asks for anyone\'s own');
  assert.deepEqual(await token('sam-token'), { status: 409, body: { error: 'GitHub no longer accepts @sam-ops\'s authorization' } },
    'a revoked authorization stops the push rather than pushing as the App');
});

test('a private session saves its own Claude home and its owner\'s, a resume restores its own, and a shared one keeps its own', async (t) => {
  const sessions = [
    { id: 'aaaaaaaa', status: 'running', token: 'shared-token', owner: null },
    { id: 'bbbbbbbb', status: 'running', token: 'joel-token', owner: 'octocat' },
    { id: 'cccccccc', status: 'running', token: 'mia-token', owner: 'mia-dev' },
    { id: 'dddddddd', status: 'running', token: 'joel-new', owner: 'octocat' },
    { id: 'eeeeeeee', status: 'running', token: 'joel-resumed', owner: 'octocat', resumeClaude: 'a-conversation' },
  ];
  const kept = new Map();
  const noted = [];
  const homes = {
    put: async (login, stream) => { const chunks = []; for await (const c of stream) chunks.push(c); kept.set(login, Buffer.concat(chunks)); return kept.get(login).length; },
    get: async (login) => (kept.has(login) ? { stream: (await import('node:stream')).Readable.from([kept.get(login)]), bytes: kept.get(login).length } : null),
    copy: async (from, to) => { kept.set(to, kept.get(from)); },
  };
  const removed = new Set(['mia-dev']);
  const userSettings = { noteHome: (login, bytes) => noted.push([login, bytes]), view: (login) => ({ setUp: !removed.has(login) }) };
  const handle = createSessionApi({ fleet: { sessions: () => sessions }, tokens: { token: async () => ({}) }, userSettings, homes });
  const server = http.createServer((req, res) => { handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const call = (path, token, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body });

  assert.equal((await call('/home/restore', 'joel-token')).status, 404, 'a first session has nothing to restore');
  assert.equal((await call('/home', 'joel-token', 'joel-tarball')).status, 200);
  assert.deepEqual(noted, [['octocat', 12]]);
  assert.equal(kept.get('octocat/sessions/bbbbbbbb').toString(), 'joel-tarball', 'the session\'s own, for its Resume');
  assert.equal(kept.get('octocat').toString(), 'joel-tarball', 'and the owner\'s, for their next new session');
  const restored = await call('/home/restore', 'joel-new');
  assert.equal(restored.status, 200);
  assert.equal(await restored.text(), 'joel-tarball', 'a new session starts from the owner\'s latest');

  // Another of Joel's sessions stops after; a resume of the first reopens its own home, not the latest one.
  assert.equal((await call('/home?why=periodic', 'joel-new', 'mid-run-tarball')).status, 200);
  assert.equal(kept.get('octocat/sessions/dddddddd').toString(), 'mid-run-tarball', 'a periodic save keeps the session\'s own');
  assert.equal(kept.get('octocat').toString(), 'joel-tarball', 'and leaves the owner\'s to the saves at stop');
  assert.equal((await call('/home?why=stop', 'joel-new', 'newer-tarball')).status, 200);
  assert.equal(kept.get('octocat').toString(), 'newer-tarball');
  kept.set('octocat/sessions/eeeeeeee', Buffer.from('its-own-tarball'));
  assert.equal(await (await call('/home/restore', 'joel-resumed')).text(), 'its-own-tarball');
  kept.delete('octocat/sessions/eeeeeeee');
  assert.equal(await (await call('/home/restore', 'joel-resumed')).text(), 'newer-tarball', 'one saved before sessions kept their own');
  assert.equal((await call('/home/restore', 'mia-token')).status, 404, 'a teammate\'s session gets nothing of Joel\'s');
  assert.equal((await call('/home', 'mia-token', 'mia-tarball')).status, 409, 'nothing kept for someone who removed My Woodshed');
  assert.equal(kept.has('mia-dev'), false);
  assert.equal((await call('/home/restore', 'shared-token')).status, 404, 'a shared session\'s first run has nothing to restore');
  assert.equal((await call('/home', 'shared-token', 'shared-tarball')).status, 200);
  assert.equal(kept.get('_sessions/aaaaaaaa').toString(), 'shared-tarball', 'kept under the session, never under a login');
  assert.equal(await (await call('/home/restore', 'shared-token')).text(), 'shared-tarball');
  assert.deepEqual(noted, [['octocat', 12], ['octocat', 13]], 'nobody\'s My settings counts it');
  assert.equal((await call('/home', 'nobody', 'x')).status, 401);
});

test('a shared session is told it runs on its starter\'s plan only when it does, and never gets the token', async (t) => {
  const sessions = [
    { id: 'aaaaaaaa', status: 'starting', token: 'joel-plan', owner: null, startedBy: 'joel', plan: 'joel' },
    { id: 'bbbbbbbb', status: 'starting', token: 'team-key', owner: null, startedBy: 'mia', plan: null },
    { id: 'cccccccc', status: 'starting', token: 'mismatch', owner: null, startedBy: 'mia', plan: 'joel' },
    { id: 'dddddddd', status: 'starting', token: 'gone', owner: null, startedBy: 'sam', plan: 'sam' },
    { id: 'eeeeeeee', status: 'starting', token: 'switched-off', owner: null, startedBy: 'ana', plan: 'ana' },
  ];
  const ready = { status: 'ready', database: { user: 'u', password: 'p', name: 'woodshed__x' }, error: null };
  const databases = { available: true, sessionDatabase: async () => ready };
  const tokens = { joel: 'sk-ant-oat01-joel', mia: 'sk-ant-oat01-mia', ana: 'sk-ant-oat01-ana' };
  const userSettings = { claudeToken: async (login) => tokens[login] ?? null, usesOwnTokenForShared: (login) => login !== 'ana' };
  const handle = createSessionApi({ fleet: { sessions: () => sessions }, tokens: { token: async () => ({}) }, databases, userSettings });
  const server = http.createServer((req, res) => { handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const settings = (token) => request(port, { path: '/settings', authorization: `Bearer ${token}` });

  assert.deepEqual((await settings('joel-plan')).body, { database: ready.database, plan: 'joel' });
  assert.deepEqual((await settings('team-key')).body, { database: ready.database }, 'the team key: no token');
  assert.deepEqual((await settings('mismatch')).body, { database: ready.database }, 'a plan that is not the starter\'s gets nothing');
  assert.deepEqual((await settings('gone')).body, { database: ready.database }, 'a token removed since the launch: the team key');
  assert.deepEqual((await settings('switched-off')).body, { database: ready.database }, 'switched off since the launch: the team key');
});

test('a session reports its start steps; anything else is refused', async (t) => {
  const reported = [];
  const fleet = { sessions: () => SESSIONS, startStep: (session, step) => reported.push([session.id, step]) };
  const handle = createSessionApi({ fleet, tokens: { token: async () => ({}) } });
  const server = http.createServer((req, res) => { handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const call = (token, body) => fetch(`http://127.0.0.1:${port}/progress`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body });

  assert.equal((await call('new-token', '{"step":"branch"}')).status, 204);
  assert.equal((await call('new-token', '{"step":"rm -rf"}')).status, 400);
  assert.equal((await call('new-token', 'not json')).status, 400);
  assert.equal((await call('new-token', JSON.stringify({ step: 'x'.repeat(400) }))).status, 413);
  assert.equal((await call('old-token', '{"step":"branch"}')).status, 401);
  assert.deepEqual(reported, [['cccccccc', 'branch']]);
});

test('an ask session gets a read-only token, and posts its answer through /answer; no other session can', async (t) => {
  const sessions = [
    { id: 'aaaaaaaa', status: 'running', token: 'ask-token', kind: 'ask', slack: { channel: 'C1', threadTs: '1.1' } },
    { id: 'bbbbbbbb', status: 'running', token: 'issue-token', kind: 'issue' },
  ];
  const minted = [];
  const tokens = { token: async () => { minted.push('write'); return { token: 'ghs_write', expiresAt: 0 }; } };
  const askTokens = { token: async () => { minted.push('read'); return { token: 'ghs_read', expiresAt: 0 }; } };
  const answers = [];
  const asks = { async answer(session, text) { answers.push({ id: session.id, text }); return true; } };
  const handle = createSessionApi({ fleet: { sessions: () => sessions }, tokens, askTokens, asks });
  const server = http.createServer((req, res) => { handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  assert.equal((await request(port, { authorization: 'Bearer ask-token' })).body.token, 'ghs_read');
  assert.equal((await request(port, { authorization: 'Bearer issue-token' })).body.token, 'ghs_write');
  assert.deepEqual(minted, ['read', 'write']);

  const answer = (authorization, body) => request(port, { path: '/answer', authorization, body });
  assert.deepEqual(await answer('Bearer ask-token', JSON.stringify({ text: 'It retries.' })), { status: 200, body: { posted: true } });
  assert.equal((await answer('Bearer issue-token', JSON.stringify({ text: 'x' }))).status, 404);
  assert.equal((await answer('Bearer ask-token', 'not json')).status, 400);
  assert.equal((await answer('Bearer ask-token', JSON.stringify({ text: 7 }))).status, 400);
  assert.deepEqual(answers, [{ id: 'aaaaaaaa', text: 'It retries.' }]);

  // A character split across two chunks of the body arrives whole.
  const bytes = Buffer.from(JSON.stringify({ text: 'Não é.' }));
  const cut = bytes.indexOf(0xc3) + 1;
  const split = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/answer', headers: { authorization: 'Bearer ask-token' } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.write(bytes.subarray(0, cut));
    setTimeout(() => req.end(bytes.subarray(cut)), 50);
  });
  assert.equal(split, 200);
  assert.equal(answers.at(-1).text, 'Não é.');
});

test('a QA session gets a read-only token, and sends its report once through /qa-report; no other session can', async (t) => {
  const qa = { id: 'aaaaaaaa', status: 'running', token: 'qa-token', kind: 'pr', number: 7, qa: { base: 'main' } };
  const sessions = [qa, { id: 'bbbbbbbb', status: 'running', token: 'pr-token', kind: 'pr', number: 7 }];
  const tokens = { token: async () => ({ token: 'ghs_write', expiresAt: 0 }) };
  const askTokens = { token: async () => ({ token: 'ghs_read', expiresAt: 0 }) };
  const finished = [];
  const fleet = {
    sessions: () => sessions,
    async qaFinished(session, result) { finished.push({ id: session.id, ...result }); session.qa.conclusion = result.verdict.conclusion; },
  };
  const handle = createSessionApi({ fleet, tokens, askTokens });
  const server = http.createServer((req, res) => { handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  assert.equal((await request(port, { authorization: 'Bearer qa-token' })).body.token, 'ghs_read');
  assert.equal((await request(port, { authorization: 'Bearer pr-token' })).body.token, 'ghs_write');

  const report = (authorization, body) => request(port, { path: '/qa-report', authorization, body: JSON.stringify(body) });
  const verdict = { conclusion: 'failure', title: 'Fail: 1 of 2 test cases failed', status: '❌ **Fail**', total: 2 };
  const sha = 'b'.repeat(40);
  assert.equal((await report('Bearer pr-token', { verdict, report: 'r', sha })).status, 404);
  assert.equal((await report('Bearer qa-token', { verdict: { ...verdict, conclusion: 'skipped' }, report: 'r', sha })).status, 400);
  assert.equal((await report('Bearer qa-token', { verdict, report: 'r', sha: 'HEAD' })).status, 400);
  assert.equal((await report('Bearer qa-token', { verdict, report: '## TC-1: a ❌', sha, costUsd: 2.25 })).status, 204);
  assert.equal((await report('Bearer qa-token', { verdict, report: 'again', sha })).status, 409);
  assert.deepEqual(finished, [{ id: 'aaaaaaaa', verdict, report: '## TC-1: a ❌', sha, costUsd: 2.25 }]);
});

test('a review session gets a read-only token, and sends its verdict once through /review-report', async (t) => {
  const review = { id: 'rrrrrrrr', status: 'running', token: 'review-token', kind: 'pr', number: 7, review: { base: 'main' } };
  const sessions = [review, { id: 'bbbbbbbb', status: 'running', token: 'pr-token', kind: 'pr', number: 7 }];
  const tokens = { token: async () => ({ token: 'ghs_write', expiresAt: 0 }) };
  const askTokens = { token: async () => ({ token: 'ghs_read', expiresAt: 0 }) };
  const finished = [];
  const fleet = {
    sessions: () => sessions,
    async reviewFinished(session, result) { finished.push({ id: session.id, ...result }); session.review.conclusion = result.conclusion; },
  };
  const handle = createSessionApi({ fleet, tokens, askTokens });
  const server = http.createServer((req, res) => { handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  assert.equal((await request(port, { authorization: 'Bearer review-token' })).body.token, 'ghs_read', 'the review session cannot push or approve as the App');
  assert.equal((await request(port, { authorization: 'Bearer pr-token' })).body.token, 'ghs_write');

  const sha = 'b'.repeat(40);
  const send = (authorization, over) => request(port, {
    path: '/review-report', authorization,
    body: JSON.stringify({ conclusion: 'APPROVE', title: '## Claude review — APPROVE', summary: 'ok', comment: '> ok', mergeRisk: { tier: 'Low', reason: 'r', summary: 'LOW' }, sha, costUsd: 0.3, ...over }),
  });
  assert.equal((await send('Bearer pr-token', {})).status, 404, 'only a review session has a verdict to send');
  assert.equal((await send('Bearer review-token', { conclusion: 'LGTM' })).status, 400);
  assert.equal((await send('Bearer review-token', {})).status, 204);
  assert.equal((await send('Bearer review-token', {})).status, 409, 'only once');
  assert.deepEqual(finished.map((f) => [f.id, f.conclusion, f.mergeRisk.tier]), [['rrrrrrrr', 'APPROVE', 'Low']]);
});

test('a private session syncs its owner\'s shared Claude settings; a shared one, or one whose owner removed My Woodshed, cannot', async (t) => {
  const sessions = [
    { id: 'aaaaaaaa', status: 'running', token: 'shared-token', owner: null },
    { id: 'bbbbbbbb', status: 'running', token: 'joel-token', owner: 'octocat' },
    { id: 'cccccccc', status: 'running', token: 'mia-token', owner: 'mia-dev' },
  ];
  const synced = [];
  const claudeSettings = { sync: async (args) => { synced.push(args); return { version: 1 }; } };
  const userSettings = { view: (login) => ({ setUp: login !== 'mia-dev' }) };
  const handle = createSessionApi({ fleet: { sessions: () => sessions }, tokens: { token: async () => ({}) }, userSettings, claudeSettings });
  const server = http.createServer((req, res) => { handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const call = (token, body) => fetch(`http://127.0.0.1:${port}/claude-settings`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body });
  const change = JSON.stringify({ version: 0, changed: { '.claude/CLAUDE.md': 'eA==' }, removed: [] });

  const ok = await call('joel-token', change);
  assert.deepEqual([ok.status, await ok.json()], [200, { version: 1 }]);
  assert.deepEqual(synced, [{ login: 'octocat', sessionId: 'bbbbbbbb', version: 0, changed: { '.claude/CLAUDE.md': 'eA==' }, removed: [] }],
    'the owner is the session\'s, whatever the body says');
  assert.equal((await call('shared-token', change)).status, 404, 'a shared session has no owner to share with');
  assert.equal((await call('mia-token', change)).status, 409);
  assert.equal((await call('joel-token', '{"version":"1"}')).status, 400);
  assert.equal((await call('joel-token', '{"version":0,"changed":{"x":1}}')).status, 400, 'every item is a string');
  assert.equal((await call('nobody', change)).status, 401);
  assert.equal(synced.length, 1);
});

test('a session gets the files attached to it as a tar, and 204 when it has none', async (t) => {
  const sent = [];
  const attachments = {
    has: async (id) => id === 'aaaaaaaa',
    send: async (id, res) => { sent.push(id); res.writeHead(200, { 'content-type': 'application/x-tar' }); res.end('tar'); },
  };
  const sessions = [...SESSIONS, { id: 'dddddddd', status: 'running', token: 'other-token' }];
  const handle = createSessionApi({ fleet: { sessions: () => sessions }, tokens: null, attachments });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  t.after(() => server.close());
  const status = (authorization) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/attachments', headers: authorization ? { authorization } : {} }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(await status('Bearer live-token'), 200);
  assert.equal(await status('Bearer other-token'), 204);
  assert.equal(await status('Bearer old-token'), 401, 'a stopped session gets nothing');
  assert.deepEqual(sent, ['aaaaaaaa']);
});

test('a private Codex session needs no Claude token, gets its owner\'s Codex sign-in, and can keep a refreshed one', async (t) => {
  const sessions = [
    { id: 'aaaaaaaa', status: 'running', token: 'own-token', owner: 'joel', options: { agent: 'codex' } },
    { id: 'bbbbbbbb', status: 'running', token: 'team-token', owner: 'mia', options: { agent: 'codex' } },
    { id: 'cccccccc', status: 'running', token: 'claude-token', owner: 'joel', options: { agent: 'claude' } },
  ];
  const saved = [];
  const userSettings = {
    claudeToken: async () => null,
    codexAuth: async (login) => (login === 'joel' ? '{"tokens":{"refresh_token":"rt"}}' : null),
    setCodexAuth: async (login, text) => { saved.push([login, text]); },
    ownFiles: async () => ({}),
    gitIdentity: () => null,
  };
  const handle = createSessionApi({ fleet: { sessions: () => sessions }, tokens: { token: async () => ({}) }, userSettings });
  const server = http.createServer((req, res) => { handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const own = await request(port, { path: '/settings', authorization: 'Bearer own-token' });
  assert.equal(own.body.codexAuth, '{"tokens":{"refresh_token":"rt"}}');
  const team = await request(port, { path: '/settings', authorization: 'Bearer team-token' });
  assert.equal(team.status, 200);
  assert.equal(team.body.codexAuth, null, 'with none saved the session goes through the console\'s proxy');
  assert.equal((await request(port, { path: '/settings', authorization: 'Bearer claude-token' })).status, 409, 'a Claude session still needs its token');

  const back = await request(port, { path: '/codex-auth', authorization: 'Bearer own-token', body: '{"tokens":{"refresh_token":"rt2"}}' });
  assert.equal(back.status, 200);
  assert.deepEqual(saved, [['joel', '{"tokens":{"refresh_token":"rt2"}}']]);
  const older = await request(port, { path: '/codex-auth', authorization: 'Bearer own-token', body: '{"last_refresh":"2026-01-01T00:00:00Z","tokens":{"refresh_token":"old"}}' });
  assert.equal(older.status, 200, 'no last_refresh on the saved copy: nothing to compare, so it is kept');
  userSettings.codexAuth = async (login) => login !== 'joel' ? null : '{"last_refresh":"2026-02-01T00:00:00Z","tokens":{"refresh_token":"new"}}';
  const stale = await request(port, { path: '/codex-auth', authorization: 'Bearer own-token', body: '{"last_refresh":"2026-01-01T00:00:00Z","tokens":{"refresh_token":"old"}}' });
  assert.equal(stale.status, 409, 'an older login never replaces a newer one');
  assert.equal(saved.length, 2);
  assert.equal((await request(port, { path: '/codex-auth', authorization: 'Bearer team-token', body: '{}' })).status, 409, 'no sign-in saved, nothing to replace');
  assert.equal((await request(port, { path: '/codex-auth', authorization: 'Bearer claude-token', body: '{}' })).status, 404, 'not a Codex session');
});

test('a session gets the token of the project it runs on', async (t) => {
  const sessions = [
    { id: 'aaaaaaaa', status: 'running', token: 'on-app', project: 'app', repo: 'acme/app' },
    { id: 'bbbbbbbb', status: 'running', token: 'on-tools', project: 'tools', repo: 'other/tools' },
    { id: 'cccccccc', status: 'running', token: 'asking-tools', project: 'tools', repo: 'other/tools', kind: 'ask' },
  ];
  const source = (token) => ({ token: async () => ({ token, expiresAt: Date.parse('2026-11-10T13:00:00Z') }) });
  const byProject = {
    app: { project: 'app', sessions: source('ghs_app'), asks: source('ghs_app_read') },
    tools: { project: 'tools', sessions: source('ghs_tools'), asks: source('ghs_tools_read') },
  };
  const handle = createSessionApi({
    fleet: { sessions: () => sessions }, tokens: source('unused'), askTokens: source('unused'), tokensFor: (session) => byProject[session.project],
  });
  const server = http.createServer((req, res) => { handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  assert.equal((await request(port, { authorization: 'Bearer on-app' })).body.token, 'ghs_app');
  assert.equal((await request(port, { authorization: 'Bearer on-tools' })).body.token, 'ghs_tools');
  assert.equal((await request(port, { authorization: 'Bearer asking-tools' })).body.token, 'ghs_tools_read', 'an ask session gets its project\'s read-only one');
});

test('with no project file read, an owner\'s sessions push as them: their own token on the default project, scoped on another', async (t) => {
  const sessions = [
    { id: 'aaaaaaaa', status: 'running', token: 'mine-on-app', owner: 'mia', project: 'app', repo: 'acme/app' },
    { id: 'bbbbbbbb', status: 'running', token: 'mine-on-tools', owner: 'mia', project: 'tools', repo: 'other/tools' },
    { id: 'cccccccc', status: 'running', token: 'shared-on-tools', project: 'tools', repo: 'other/tools' },
    { id: 'dddddddd', status: 'running', token: 'anas-on-tools', owner: 'ana', project: 'tools', repo: 'other/tools' },
    { id: 'eeeeeeee', status: 'running', token: 'gone-on-tools', owner: 'gone', project: 'tools', repo: 'other/tools' },
  ];
  const source = (token) => ({ token: async () => ({ token, expiresAt: Date.parse('2026-11-10T13:00:00Z') }) });
  const permissions = { contents: 'write', pull_requests: 'write' };
  const byProject = {
    app: { project: 'app', default: true, repo: 'acme/app', permissions, sessions: source('ghs_app'), asks: source('ghs_app_read') },
    tools: { project: 'tools', default: false, repo: 'other/tools', permissions, sessions: source('ghs_tools'), asks: source('ghs_tools_read') },
  };
  const asked = [];
  const scopedAsks = [];
  const githubUser = {
    tokenFor: async (login) => { asked.push(login); return { token: `ghu_${login}`, expiresAt: Date.parse('2026-11-10T13:00:00Z') }; },
    scopedTokenFor: async (login, scope) => {
      scopedAsks.push([login, scope]);
      if (login === 'ana') return null;
      if (login === 'gone') throw Object.assign(new Error('GitHub no longer accepts @gone\'s authorization'), { shown: true });
      return { token: `ghu_${login}_scoped`, expiresAt: Date.parse('2026-11-10T13:00:00Z') };
    },
  };
  const handle = createSessionApi({ fleet: { sessions: () => sessions }, tokens: source('unused'), githubUser, tokensFor: (session) => byProject[session.project] });
  const server = http.createServer((req, res) => { handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  assert.equal((await request(port, { authorization: 'Bearer mine-on-app' })).body.token, 'ghu_mia', 'the default project: the owner\'s own, as before');
  assert.equal((await request(port, { authorization: 'Bearer mine-on-tools' })).body.token, 'ghu_mia_scoped', 'another project: the owner\'s, scoped to its repo');
  assert.deepEqual(scopedAsks[0], ['mia', { repo: 'other/tools', permissions }]);
  assert.deepEqual(asked, ['mia'], 'the full token is only read for the default project');
  assert.equal((await request(port, { authorization: 'Bearer shared-on-tools' })).body.token, 'ghs_tools', 'a shared session: the project\'s App token');
  assert.equal((await request(port, { authorization: 'Bearer anas-on-tools' })).body.token, 'ghs_tools', 'no scoped token: the project\'s App token, never the full one');
  const refused = await request(port, { authorization: 'Bearer gone-on-tools' });
  assert.equal(refused.status, 409, 'an owner GitHub no longer accepts is told so, as on the default project');
  assert.match(refused.body.error, /no longer accepts/);
});

test('the project file\'s githubAccess decides how far a private session\'s token reaches, on any project', async (t) => {
  const sessions = [
    { id: 'aaaaaaaa', status: 'running', token: 'on-app', owner: 'mia', project: 'app', repo: 'acme/app' },
    { id: 'bbbbbbbb', status: 'running', token: 'on-tools', owner: 'mia', project: 'tools', repo: 'other/tools' },
    { id: 'cccccccc', status: 'running', token: 'on-locked', owner: 'mia', project: 'locked', repo: 'other/locked' },
    { id: 'dddddddd', status: 'running', token: 'on-unread', owner: 'mia', project: 'unread', repo: 'other/unread' },
    { id: 'eeeeeeee', status: 'running', token: 'shared-on-locked', project: 'locked', repo: 'other/locked' },
    { id: 'ffffffff', status: 'running', token: 'ask-on-locked', project: 'locked', repo: 'other/locked', kind: 'ask' },
  ];
  const source = (token) => ({ token: async () => ({ token, expiresAt: Date.parse('2026-11-10T13:00:00Z') }) });
  const permissions = { contents: 'write' };
  const project = (name, isDefault, repo) => ({ project: name, default: isDefault, repo, permissions, sessions: source(`ghs_${name}`), asks: source(`ghs_${name}_read`) });
  const byProject = { app: project('app', true, 'acme/app'), tools: project('tools', false, 'other/tools'), locked: project('locked', false, 'other/locked'), unread: project('unread', false, 'other/unread') };
  // tools leaves githubAccess out (full); locked says repo; unread's file cannot be read.
  const files = { app: 'full', tools: 'full', locked: 'repo', unread: null };
  const githubUser = {
    tokenFor: async (login) => ({ token: `ghu_${login}`, expiresAt: Date.parse('2026-11-10T13:00:00Z') }),
    scopedTokenFor: async (login, scope) => ({ token: `ghu_${login}_scoped_${scope.repo}`, expiresAt: Date.parse('2026-11-10T13:00:00Z') }),
  };
  const handle = createSessionApi({
    fleet: { sessions: () => sessions }, tokens: source('unused'), githubUser, tokensFor: (session) => byProject[session.project],
    githubAccess: async (name) => files[name],
  });
  const server = http.createServer((req, res) => { handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const tokenOf = async (bearer) => (await request(port, { authorization: `Bearer ${bearer}` })).body.token;

  assert.equal(await tokenOf('on-app'), 'ghu_mia', 'the default project, full: the owner\'s own token');
  assert.equal(await tokenOf('on-tools'), 'ghu_mia', 'another project, githubAccess left out: full, the owner\'s own token');
  assert.equal(await tokenOf('on-locked'), 'ghu_mia_scoped_other/locked', 'githubAccess: repo scopes it to the project\'s repo');
  assert.equal(await tokenOf('on-unread'), 'ghu_mia_scoped_other/unread', 'a file that cannot be read errs toward repo off the default project');
  files.app = 'repo';
  assert.equal(await tokenOf('on-app'), 'ghu_mia_scoped_acme/app', 'repo applies on the default project too');
  assert.equal(await tokenOf('shared-on-locked'), 'ghs_locked', 'a shared session: the App\'s token, whatever the file says');
  assert.equal(await tokenOf('ask-on-locked'), 'ghs_locked_read', 'a question: the read-only App token');
});

test('a private session\'s GitHub access is logged when decided and when it changes, not on every token', async (t) => {
  const sessions = [{ id: 'aaaaaaaa', status: 'running', token: 'on-app', owner: 'mia', project: 'app', repo: 'acme/app' }];
  const source = (token) => ({ token: async () => ({ token, expiresAt: Date.parse('2026-11-10T13:00:00Z') }) });
  const own = { project: 'app', default: true, repo: 'acme/app', permissions: { contents: 'write' }, sessions: source('ghs_app'), asks: source('ghs_app_read') };
  const files = { app: 'full' };
  const githubUser = {
    tokenFor: async (login) => ({ token: `ghu_${login}`, expiresAt: Date.parse('2026-11-10T13:00:00Z') }),
    scopedTokenFor: async (login, scope) => ({ token: `ghu_${login}_scoped_${scope.repo}`, expiresAt: Date.parse('2026-11-10T13:00:00Z') }),
  };
  const logged = [];
  t.mock.method(console, 'log', (message, fields) => { if (message === 'sessionApi: github access for a private session') logged.push(fields.access); });
  const handle = createSessionApi({
    fleet: { sessions: () => sessions }, tokens: source('unused'), githubUser, tokensFor: () => own, githubAccess: async (name) => files[name],
  });
  const server = http.createServer((req, res) => { handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const tokenOf = async () => (await request(port, { authorization: 'Bearer on-app' })).body.token;

  await tokenOf();
  await tokenOf();
  await tokenOf();
  assert.deepEqual(logged, ['full'], 'three tokens, one line');
  files.app = 'repo';
  assert.equal(await tokenOf(), 'ghu_mia_scoped_acme/app');
  await tokenOf();
  assert.deepEqual(logged, ['full', 'repo'], 'a changed decision is logged again, once');
});
