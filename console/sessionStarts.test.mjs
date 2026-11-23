import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { STARTS_PER_RUN, createSessionStarts, newStartToken, startTokenHash } from './sessionStarts.mjs';

const NOW = Date.parse('2026-11-23T12:00:00.000Z');

// A console's session API with only these routes: a made-up fleet, and New session's start as a stand-in that records
// what it was asked and answers as server.mjs's startMine does.
async function serve({ sessions, startMine = null, allowed = () => true, perHour = 10 } = {}) {
  const asked = [];
  const fleet = {
    sessions: () => sessions,
    find: (id) => sessions.find((s) => s.id === id) ?? null,
    noteSessionStarted: (s) => { s.startsThisRun = (s.startsThisRun ?? 0) + 1; },
  };
  let next = 0;
  const starts = createSessionStarts({
    fleet, config: { publicUrl: 'https://console.example', sessionStartsPerHour: perHour }, allowed, now: () => NOW,
    startMine: startMine ?? (async (login, body) => {
      asked.push({ login, body });
      const made = { id: `5e55${String(next++).padStart(4, '0')}`, owner: login, title: body.name || 'Named from the prompt', status: 'queued', branch: body.workOn || `woodshed/${login}-x`,
        project: body.project, startedFrom: body.startedFrom, createdAt: new Date(NOW).toISOString(), options: { agent: body.agent, permissionMode: body.permissionMode } };
      sessions.push(made);
      return { status: 201, body: made };
    }),
  });
  const server = http.createServer((req, res) => starts.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const call = async (method, path, { token, body, origin } = {}) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  return { call, asked, starts, close: () => server.close() };
}

function holder(extra = {}) {
  const token = newStartToken();
  return {
    token,
    session: {
      id: 'aaaa0001', owner: 'joel', status: 'running', kind: 'task', project: 'web', branch: 'woodshed/joel-aaaa0001',
      options: { agent: 'claude', permissionMode: 'acceptEdits' }, startTokenHash: startTokenHash(token), startsThisRun: 0,
      createdAt: new Date(NOW - 3 * 3_600_000).toISOString(), ...extra,
    },
  };
}

test('a session starts a session of its person\'s, as New session does, with startedFrom and no looser mode', async (t) => {
  const { token, session } = holder();
  const api = await serve({ sessions: [session] });
  t.after(api.close);
  const out = await api.call('POST', '/sessions', { token, body: { prompt: '  Add CSV export to invoices.  ', name: 'CSV export', branch: 'joel/csv' } });
  assert.equal(out.status, 201);
  assert.deepEqual(api.asked, [{ login: 'joel', body: {
    prompt: 'Add CSV export to invoices.', name: 'CSV export', workOn: 'joel/csv', agent: 'claude', model: '', effort: '', permissionMode: 'acceptEdits',
    project: 'web', startedFrom: 'aaaa0001',
  } }]);
  assert.equal(out.body.session.url, `https://console.example/s/${out.body.session.id}`);
  assert.equal(out.body.session.branch, 'joel/csv');
  assert.equal(session.startsThisRun, 1);

  await api.call('POST', '/sessions', { token, body: { prompt: 'Try it in codex', agent: 'codex', project: 'api' } });
  assert.equal(api.asked[1].body.permissionMode, 'default', 'codex has no acceptEdits: it gets the stricter mode');
  assert.equal(api.asked[1].body.project, 'api', 'another of the console\'s repos, which New session\'s own check decides');
});

test('it lists and reads only the sessions it started', async (t) => {
  const { token, session } = holder();
  const mine = { id: 'bbbb0002', owner: 'joel', status: 'running', state: 'done', startedFrom: session.id, title: 'CSV export', createdAt: new Date(NOW).toISOString(), lastMessage: 'Done.' };
  const other = { id: 'cccc0003', owner: 'joel', status: 'running', title: 'Another of joel\'s', createdAt: new Date(NOW).toISOString() };
  const api = await serve({ sessions: [session, mine, other] });
  t.after(api.close);
  const list = await api.call('GET', '/sessions', { token });
  assert.deepEqual(list.body.sessions.map((s) => s.id), ['bbbb0002']);
  assert.equal(list.body.sessions[0].lastMessage, 'Done.');
  assert.equal(list.body.sessions[0].token, undefined);
  assert.equal((await api.call('GET', '/sessions/bbbb0002', { token })).body.session.state, 'done');
  assert.equal((await api.call('GET', '/sessions/cccc0003', { token })).status, 404, 'a session it did not start is not its to read');
});

test('it refuses what it must', async (t) => {
  const { token, session } = holder();
  const sessions = [session];
  const api = await serve({ sessions });
  t.after(api.close);
  const start = (body, opts = {}) => api.call('POST', '/sessions', { token, body, ...opts });

  assert.equal((await start({ prompt: 'x' }, { origin: 'https://evil.example' })).status, 403, 'never a browser\'s call');
  assert.equal((await api.call('GET', '/sessions', { token: 'wst_nope' })).status, 401);
  assert.equal((await api.call('GET', '/sessions', { token: session.startTokenHash })).status, 401, 'the hash is no token');
  assert.equal((await start({ prompt: '   ' })).status, 400);
  assert.match((await start({ prompt: 'x', branch: session.branch })).body.error, /this session's own branch/);
  assert.equal(api.asked.length, 0, 'nothing refused reached New session\'s start');

  session.startsThisRun = STARTS_PER_RUN;
  assert.equal((await start({ prompt: 'x' })).status, 429, 'one run starts so many');
  session.startsThisRun = 0;

  for (let i = 0; i < 3; i++) sessions.push({ id: `dddd000${i}`, owner: 'joel', startedFrom: 'eeee0000', status: 'running', createdAt: new Date(NOW - 10 * 60_000).toISOString() });
  const limited = await serve({ sessions, perHour: 3 });
  t.after(limited.close);
  const hourly = await limited.call('POST', '/sessions', { token, body: { prompt: 'x' } });
  assert.equal(hourly.status, 429, 'the person\'s sessions start so many an hour, all of them together');
  assert.match(hourly.body.error, /in the last hour/);
  const off = await serve({ sessions: [session], perHour: 0 });
  t.after(off.close);
  assert.match((await off.call('POST', '/sessions', { token, body: { prompt: 'x' } })).body.error, /turns off/);

  const gone = await serve({ sessions: [session], allowed: () => false });
  t.after(gone.close);
  assert.equal((await gone.call('POST', '/sessions', { token, body: { prompt: 'x' } })).status, 403, 'someone taken off the console starts nothing');

  const refused = await serve({ sessions: [session], startMine: async () => ({ status: 409, body: { error: 'save your Claude token on My settings first' } }) });
  t.after(refused.close);
  const why = await refused.call('POST', '/sessions', { token, body: { prompt: 'x' } });
  assert.deepEqual([why.status, why.body.error], [409, 'save your Claude token on My settings first'], 'New session\'s refusal, as it is');
  assert.equal(session.startsThisRun, 0, 'a refused start counts for nothing');
});

test('only a running session of a person\'s own, never tainted, a question, review or QA run, starts sessions', async (t) => {
  for (const [extra, why] of [
    [{ status: 'stopped' }, 'stopped'],
    [{ owner: null }, 'shared'],
    [{ taintedAt: new Date(NOW).toISOString() }, 'tainted'],
    [{ kind: 'ask' }, 'a question'],
    [{ review: { base: 'main' } }, 'a review'],
    [{ qa: { base: 'main' } }, 'a QA run'],
  ]) {
    const { token, session } = holder(extra);
    const api = await serve({ sessions: [session] });
    t.after(api.close);
    assert.equal((await api.call('GET', '/sessions', { token })).status, 401, why);
    assert.equal(api.starts.owns(token), false, why);
  }
  const { token, session } = holder();
  const api = await serve({ sessions: [session] });
  t.after(api.close);
  assert.equal(api.starts.owns(token), true, 'a host routes the call to its installation by it (ownsSessionToken)');
});
