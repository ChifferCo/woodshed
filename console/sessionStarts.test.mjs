import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createSessionStarts, newStartToken, startTokenHash } from './sessionStarts.mjs';
import agents from '../shared/agents.cjs';

const NOW = Date.parse('2026-11-23T12:00:00.000Z');

// A console's session API with only these routes: a made-up fleet, and New session's start as a stand-in that records
// what it was asked and answers as server.mjs's startMine does.
async function serve({ sessions, startMine = null, allowed = () => true, canWrite = () => true, send = null, statusd = null, resumeMine = null, agentAction = null, waitMs = 60_000, noReplyMs = 60_000 } = {}) {
  const asked = [];
  const fleet = {
    sessions: () => sessions,
    find: (id) => sessions.find((s) => s.id === id) ?? null,
    sent: [],
    stopped: [],
    async send(session, text) {
      fleet.sent.push({ id: session.id, text });
      return send ? send(session, text) : 'sent';
    },
    rename(session, name) {
      if (!name.trim()) throw Object.assign(new Error('a name cannot be empty'), { shown: true });
      session.title = name.trim();
      return session;
    },
    async stop(session, reason, { by }) {
      fleet.stopped.push({ id: session.id, reason, by });
      session.status = 'stopped';
    },
  };
  let next = 0;
  const starts = createSessionStarts({
    fleet, config: { publicUrl: 'https://console.example' }, allowed, canWrite, statusd, resumeMine, agentAction, waitMs, noReplyMs, pollMs: 10,
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
  return { call, asked, starts, fleet, base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

function holder(extra = {}) {
  const token = newStartToken();
  return {
    token,
    session: {
      id: 'aaaa0001', owner: 'joel', status: 'running', kind: 'task', project: 'web', branch: 'woodshed/joel-aaaa0001',
      options: { agent: 'claude', permissionMode: 'acceptEdits' }, startTokenHash: startTokenHash(token),
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

  await api.call('POST', '/sessions', { token, body: { prompt: 'Try it in codex', agent: 'codex', project: 'api' } });
  assert.equal(api.asked[1].body.permissionMode, 'plan', 'codex has no acceptEdits, and its own policy runs commands unasked: it gets its read-only mode');
  assert.equal(api.asked[1].body.project, 'api', 'another of the console\'s repos, which New session\'s own check decides');
});

test('a session starts Grok Build and OpenCode sessions as New session does, and no agent it does not know', async (t) => {
  const { token, session } = holder();
  const api = await serve({ sessions: [session] });
  t.after(api.close);
  const grok = await api.call('POST', '/sessions', { token, body: { prompt: 'Try it in grok', agent: 'grok', model: 'grok-build', effort: 'high' } });
  assert.equal(grok.status, 201);
  assert.equal(grok.body.session.agent, 'grok');
  assert.deepEqual([api.asked[0].body.agent, api.asked[0].body.model, api.asked[0].body.effort, api.asked[0].body.permissionMode], ['grok', 'grok-build', 'high', 'acceptEdits'],
    'Grok Build has acceptEdits; its sign-in is startMine\'s check, as New session\'s');
  const opencode = await api.call('POST', '/sessions', { token, body: { prompt: 'Try it in opencode', agent: 'opencode' } });
  assert.equal(opencode.body.session.agent, 'opencode');
  assert.equal(api.asked[1].body.permissionMode, 'acceptEdits', 'OpenCode\'s acceptEdits asks before commands, as Claude Code\'s does');
  for (const agent of ['gemini', 'constructor', 7]) {
    const refused = await api.call('POST', '/sessions', { token, body: { prompt: 'go', agent } });
    assert.equal(refused.status, 400, String(agent));
    assert.match(refused.body.error, /claude, codex, grok, opencode/);
  }
  assert.equal(api.asked.length, 2);

  // Its own sign-in, refused by New session's check, is refused here the same.
  const unsaved = await serve({ sessions: [session], startMine: async () => ({ status: 409, body: { error: 'save your OpenCode sign-in on My settings first' } }) });
  t.after(unsaved.close);
  assert.deepEqual(await unsaved.call('POST', '/sessions', { token, body: { prompt: 'go', agent: 'opencode' } }), { status: 409, body: { error: 'save your OpenCode sign-in on My settings first' } });
});

test('a started session\'s mode is never looser than its starter\'s, for every pair of agents and every mode', async (t) => {
  // What each mode lets an agent do unasked (shared/agents.cjs, RANKS), written out here rather than read from the
  // registry, so a change to a rank there has to change this too.
  const unasked = {
    claude: { plan: 0, default: 1, acceptEdits: 2, auto: 4 },
    codex: { plan: 0, default: 3, auto: 4 },
    grok: { plan: 0, default: 1, acceptEdits: 2, auto: 4 },
    opencode: { plan: 0, default: 1, acceptEdits: 2, auto: 4 },
  };
  const want = {
    claude: { auto: ['auto', 'auto', 'auto', 'auto'], acceptEdits: ['acceptEdits', 'plan', 'acceptEdits', 'acceptEdits'], default: ['default', 'plan', 'default', 'default'], plan: ['plan', 'plan', 'plan', 'plan'] },
    codex: { auto: ['auto', 'auto', 'auto', 'auto'], default: ['acceptEdits', 'default', 'acceptEdits', 'acceptEdits'], plan: ['plan', 'plan', 'plan', 'plan'] },
    grok: { auto: ['auto', 'auto', 'auto', 'auto'], acceptEdits: ['acceptEdits', 'plan', 'acceptEdits', 'acceptEdits'], default: ['default', 'plan', 'default', 'default'], plan: ['plan', 'plan', 'plan', 'plan'] },
    opencode: { auto: ['auto', 'auto', 'auto', 'auto'], acceptEdits: ['acceptEdits', 'plan', 'acceptEdits', 'acceptEdits'], default: ['default', 'plan', 'default', 'default'], plan: ['plan', 'plan', 'plan', 'plan'] },
  };
  const ids = ['claude', 'codex', 'grok', 'opencode'];
  for (const fromAgent of ids) {
    assert.deepEqual(Object.keys(want[fromAgent]).sort(), [...agents.agent(fromAgent).permissionModes].sort(), `${fromAgent}: every mode it offers`);
    for (const fromMode of Object.keys(want[fromAgent])) {
      const { token, session } = holder({ options: { agent: fromAgent, permissionMode: fromMode } });
      const api = await serve({ sessions: [session] });
      t.after(api.close);
      for (const [i, agent] of ids.entries()) {
        const out = await api.call('POST', '/sessions', { token, body: { prompt: 'go', agent } });
        assert.equal(out.status, 201);
        const got = api.asked.at(-1).body.permissionMode;
        assert.equal(got, want[fromAgent][fromMode][i], `${fromAgent} ${fromMode} starting ${agent}`);
        assert.ok(agents.agent(agent).permissionModes.includes(got), `${agent} offers ${got}`);
        assert.ok(unasked[agent][got] <= unasked[fromAgent][fromMode], `${fromAgent} ${fromMode} -> ${agent} ${got} is no looser`);
        assert.equal(agents.agent(agent).modeRanks[got], unasked[agent][got], `${agent} ${got}: the registry's rank`);
      }
    }
  }
  // A starter with no mode recorded ran in auto; one with a mode its agent does not have counts as read-only.
  for (const [options, mode] of [[{ agent: 'claude' }, 'auto'], [{ agent: 'codex', permissionMode: 'acceptEdits' }, 'plan'], [{ agent: 'opencode', permissionMode: 'bypassPermissions' }, 'plan']]) {
    const { token, session } = holder({ options });
    const api = await serve({ sessions: [session] });
    t.after(api.close);
    await api.call('POST', '/sessions', { token, body: { prompt: 'go', agent: 'claude' } });
    assert.equal(api.asked[0].body.permissionMode, mode, JSON.stringify(options));
  }
});

test('it lists the sessions it started, and reads another of its person\'s too', async (t) => {
  const { token, session } = holder();
  const mine = { id: 'bbbb0002', owner: 'joel', status: 'running', state: 'done', startedFrom: session.id, title: 'CSV export', createdAt: new Date(NOW).toISOString(), lastMessage: { role: 'assistant', text: 'Done.\nThe export downloads.' } };
  const other = { id: 'cccc0003', owner: 'joel', status: 'running', title: 'Another of joel\'s', createdAt: new Date(NOW).toISOString() };
  const api = await serve({ sessions: [session, mine, other] });
  t.after(api.close);
  const list = await api.call('GET', '/sessions', { token });
  assert.deepEqual(list.body.sessions.map((s) => s.id), ['bbbb0002']);
  assert.equal(list.body.sessions[0].lastMessage, 'Done.\nThe export downloads.', 'statusd\'s {role, text}, as its text');
  assert.equal(list.body.sessions[0].token, undefined);
  assert.equal((await api.call('GET', '/sessions/bbbb0002', { token })).body.session.state, 'done');
  assert.equal((await api.call('GET', '/sessions/cccc0003', { token })).status, 200, 'another private session of the person\'s, which it did not start');
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

  // No cap of its own: past the person's limit the start is New session's, which puts it in line. Six in a row all start.
  for (let i = 0; i < 6; i++) assert.equal((await start({ prompt: `piece ${i}` })).status, 201, `start ${i + 1}`);
  sessions.splice(1);


  const gone = await serve({ sessions: [session], allowed: () => false });
  t.after(gone.close);
  assert.equal((await gone.call('POST', '/sessions', { token, body: { prompt: 'x' } })).status, 403, 'someone taken off the console starts nothing');

  // Still on People, but GitHub took their write access: on the default project, which New session's project check
  // asks nothing of, the start is refused here.
  const noWrite = await serve({ sessions: [session], canWrite: (login) => login !== 'joel' });
  t.after(noWrite.close);
  const lost = await noWrite.call('POST', '/sessions', { token, body: { prompt: 'x' } });
  assert.deepEqual([lost.status, lost.body.error], [403, '@joel no longer has write access to the repo on GitHub']);
  assert.equal(noWrite.asked.length, 0, 'it never reached New session\'s start');

  const refused = await serve({ sessions: [session], startMine: async () => ({ status: 409, body: { error: 'save your Claude token on My settings first' } }) });
  t.after(refused.close);
  const why = await refused.call('POST', '/sessions', { token, body: { prompt: 'x' } });
  assert.deepEqual([why.status, why.body.error], [409, 'save your Claude token on My settings first'], 'New session\'s refusal, as it is');
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

// The session started from the holder, and one more of the same person's that neither started.
function family() {
  const { token, session } = holder({ title: 'Plan the billing page' });
  const child = { id: 'c0c0c0c0', owner: 'joel', status: 'running', state: 'done', title: 'Move invoice totals', startedFrom: session.id, endpoint: { host: 'h', statusPort: 1 }, createdAt: new Date(NOW).toISOString() };
  const sibling = { id: 'babababa', owner: 'joel', status: 'running', state: 'done', title: 'Another of joel\'s', createdAt: new Date(NOW).toISOString() };
  const strangers = { id: 'dededede', owner: 'mia', status: 'running', state: 'done', startedFrom: session.id, createdAt: new Date(NOW).toISOString() };
  return { token, session, child, sibling, strangers, sessions: [session, child, sibling, strangers] };
}

test('a session messages the sessions it started, and they answer it, with who sent it and how to answer on top', async (t) => {
  const { token, session, child, sessions } = family();
  const api = await serve({ sessions });
  t.after(api.close);
  const sent = await api.call('POST', `/sessions/${child.id}/messages`, { token, body: { text: '  Use cents, not floats.  ' } });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.sent, true);
  assert.deepEqual(api.fleet.sent, [{ id: child.id, text: `[Message from session ${session.id} "Plan the billing page", which started this session. Answer it with: woodshed-session reply "<answer>"]\n\nUse cents, not floats.` }]);

  // The started session answers with its own start token, to the session that started it.
  const childToken = newStartToken();
  child.startTokenHash = startTokenHash(childToken);
  const listed = await api.call('GET', '/sessions', { token: childToken });
  assert.equal(listed.body.startedFrom.id, session.id, 'it is told which session started it');
  await api.call('POST', `/sessions/${session.id}/messages`, { token: childToken, body: { text: 'Done: totals are in cents.' } });
  assert.match(api.fleet.sent[1].text, /^\[Message from session c0c0c0c0 "Move invoice totals", which this session started\. Answer it with: woodshed-session send c0c0c0c0 "<answer>"\]\n\nDone: totals are in cents\.$/);

  const held = await serve({ sessions, send: async () => 'queued' });
  t.after(held.close);
  assert.equal((await held.call('POST', `/sessions/${child.id}/messages`, { token, body: { text: 'later' } })).body.held, true, 'held while it works or waits');
  assert.equal((await api.call('POST', `/sessions/${child.id}/messages`, { token, body: { text: '  ' } })).status, 400);
});

test('it reaches every private session of its person\'s, and never anyone else\'s, a shared one, a question, review or QA run', async (t) => {
  const { token, session, sibling, strangers, sessions } = family();
  const shared = { id: '5a5a5a5a', owner: null, status: 'running', state: 'done', createdAt: new Date(NOW).toISOString() };
  const ask = { id: 'a5a5a5a5', owner: 'joel', kind: 'ask', status: 'running', state: 'done', createdAt: new Date(NOW).toISOString() };
  const qa = { id: 'abcdabcd', owner: 'joel', qa: { base: 'main' }, status: 'running', state: 'done', createdAt: new Date(NOW).toISOString() };
  sessions.push(shared, ask, qa);
  const api = await serve({ sessions });
  t.after(api.close);
  const sent = await api.call('POST', `/sessions/${sibling.id}/messages`, { token, body: { text: 'Are you touching invoices too?' } });
  assert.equal(sent.status, 200, 'another session of the person\'s, which neither started');
  assert.equal(api.fleet.sent[0].text, `[Message from session ${session.id} "Plan the billing page", another session of your person's. Answer it with: woodshed-session send ${session.id} "<answer>"]\n\nAre you touching invoices too?`);
  const all = await api.call('GET', '/sessions?all=1', { token });
  assert.deepEqual(all.body.sessions.map((s) => s.id).sort(), ['babababa', 'c0c0c0c0'], 'list --all: its person\'s private sessions but itself');
  api.fleet.sent.length = 0;
  for (const other of [strangers, shared, ask, qa]) {
    for (const [method, path] of [['POST', 'messages'], ['GET', 'wait'], ['GET', 'transcript'], ['POST', 'stop'], ['POST', 'resume'], ['GET', '']]) {
      const out = await api.call(method, `/sessions/${other.id}${path ? `/${path}` : ''}`, { token, ...(method === 'POST' ? { body: { text: 'x' } } : {}) });
      assert.equal(out.status, 404, `${other.id} ${path}`);
    }
  }
  assert.equal(api.fleet.sent.length + api.fleet.stopped.length, 0);
});

test('wait answers once it worked on what was sent and is done, or says nothing took it up', async (t) => {
  const { token, child, sessions } = family();
  const api = await serve({ sessions, noReplyMs: 150 });
  t.after(api.close);
  child.state = 'done';
  setTimeout(() => { child.state = 'working'; }, 40);
  setTimeout(() => { child.state = 'done'; child.lastMessage = { role: 'assistant', text: 'Totals are in cents now.' }; }, 90);
  const replied = await api.call('GET', `/sessions/${child.id}/wait?for=reply`, { token });
  assert.equal(replied.body.session.lastMessage, 'Totals are in cents now.');
  assert.equal(replied.body.noReply, undefined);

  const none = await api.call('GET', `/sessions/${child.id}/wait?for=reply`, { token });
  assert.equal(none.body.noReply, true, 'never seen working, with nothing held');

  child.pendingMessages = ['held'];
  const quick = await serve({ sessions, waitMs: 60 });
  t.after(quick.close);
  assert.equal((await quick.call('GET', `/sessions/${child.id}/wait?for=reply`, { token })).body.waiting, true, 'answered in time, to ask again');
  child.pendingMessages = [];
  child.status = 'stopped';
  assert.equal((await api.call('GET', `/sessions/${child.id}/wait`, { token })).body.session.status, 'stopped', 'a stopped one ends the wait');
});

test('a message held behind a turn is answered by the turn after it, not by the one it waited for', async (t) => {
  const { token, child, sessions } = family();
  const api = await serve({ sessions, noReplyMs: 5000 });
  t.after(api.close);
  // Working on the last thing it was told, with this message held for after.
  Object.assign(child, { state: 'working', pendingMessages: ['held'], lastMessage: null });
  const steps = [
    () => Object.assign(child, { state: 'done', lastMessage: { role: 'assistant', text: 'The turn it was held behind.', at: new Date().toISOString() } }),
    () => Object.assign(child, { pendingMessages: [] }),
    () => Object.assign(child, { state: 'working' }),
    () => Object.assign(child, { state: 'done', lastMessage: { role: 'assistant', text: 'Its answer.', at: new Date().toISOString() } }),
  ];
  steps.forEach((step, i) => setTimeout(step, 60 * (i + 1)));
  const out = await api.call('GET', `/sessions/${child.id}/wait?for=reply`, { token });
  assert.equal(out.body.session.lastMessage, 'Its answer.');
  assert.ok(out.body.deliveredAt, 'it says from when to read its answer');
});

test('read gives what was asked and said, never a tainted session\'s', async (t) => {
  const { token, child, sessions } = family();
  const asked = [];
  const statusd = async (session, method, path) => {
    asked.push([session.id, method, path]);
    return { entries: [
      { role: 'user', text: 'Move the totals', at: '2026-11-23T11:00:00.000Z' },
      { role: 'tool', tool: 'Bash', text: 'npm test', at: '2026-11-23T11:01:00.000Z' },
      { role: 'assistant', text: 'Done.', at: '2026-11-23T11:02:00.000Z' },
    ] };
  };
  const api = await serve({ sessions, statusd });
  t.after(api.close);
  const all = await api.call('GET', `/sessions/${child.id}/transcript?limit=20`, { token });
  assert.deepEqual(all.body.entries.map((e) => [e.role, e.text]), [['user', 'Move the totals'], ['assistant', 'Done.']], 'tools left out');
  assert.deepEqual(asked, [[child.id, 'GET', '/transcript?limit=20']]);
  const since = await api.call('GET', `/sessions/${child.id}/transcript?since=2026-11-23T11:00:30.000Z`, { token });
  assert.deepEqual(since.body.entries.map((e) => e.text), ['Done.']);

  child.taintedAt = new Date(NOW).toISOString();
  assert.equal((await api.call('GET', `/sessions/${child.id}/transcript`, { token })).status, 403);
  assert.equal(asked.length, 2, 'its statusd never asked');
});

test('stop and resume, as the page\'s, and only while the person may still', async (t) => {
  const { token, session, child, sessions } = family();
  const resumed = [];
  const resumeMine = async (login, id) => {
    resumed.push([login, id]);
    sessions.find((s) => s.id === id).status = 'queued';
    return { status: 201, body: {} };
  };
  const api = await serve({ sessions, resumeMine });
  t.after(api.close);
  assert.equal((await api.call('POST', `/sessions/${child.id}/stop`, { token, body: {} })).body.session.status, 'stopped');
  assert.deepEqual(api.fleet.stopped, [{ id: child.id, reason: `stopped by session ${session.id}`, by: 'joel' }]);
  const back = await api.call('POST', `/sessions/${child.id}/resume`, { token, body: {} });
  assert.deepEqual([back.status, back.body.session.status, resumed], [201, 'queued', [['joel', child.id]]]);

  const gone = await serve({ sessions, canWrite: () => false, resumeMine });
  t.after(gone.close);
  assert.equal((await gone.call('POST', `/sessions/${child.id}/messages`, { token, body: { text: 'x' } })).status, 403);
  assert.equal(gone.fleet.sent.length, 0);
});

test('a session renames itself, and another of its person\'s, as the page does', async (t) => {
  const { token, session, child, strangers, sessions } = family();
  const api = await serve({ sessions });
  t.after(api.close);
  const self = await api.call('POST', '/rename', { token, body: { name: 'Billing page: plan and split' } });
  assert.deepEqual([self.status, session.title], [200, 'Billing page: plan and split']);
  assert.equal((await api.call('POST', `/sessions/${child.id}/rename`, { token, body: { name: 'Invoice totals in cents' } })).body.session.title, 'Invoice totals in cents');
  assert.equal((await api.call('POST', '/rename', { token, body: { name: '  ' } })).status, 400);
  assert.equal((await api.call('POST', `/sessions/${strangers.id}/rename`, { token, body: { name: 'x' } })).status, 404);
});

test('of a session that has seen production data, no route hands over what its agent wrote', async (t) => {
  const { token, child, sibling, sessions } = family();
  for (const s of [child, sibling]) Object.assign(s, { taintedAt: new Date(NOW).toISOString(), state: 'done', lastMessage: { role: 'assistant', text: 'Customer 4411 owes 1,204.50.', at: new Date(NOW).toISOString() } });
  const api = await serve({ sessions });
  t.after(api.close);
  const answers = [
    (await api.call('GET', `/sessions/${sibling.id}`, { token })).body.session,
    ...(await api.call('GET', '/sessions?all=1', { token })).body.sessions,
    ...(await api.call('GET', '/sessions', { token })).body.sessions,
    (await api.call('GET', `/sessions/${sibling.id}/wait`, { token })).body.session,
  ];
  assert.equal(answers.length, 5);
  for (const one of answers) assert.deepEqual([one.lastMessage, one.tainted], [null, true], one.id);
  assert.doesNotMatch(JSON.stringify(answers), /4411/);
});

test('a separate start is its own work: marked so, and out of the starting session\'s list', async (t) => {
  const { token, session } = holder();
  const sessions = [session];
  const api = await serve({ sessions });
  t.after(api.close);
  const part = await api.call('POST', '/sessions', { token, body: { prompt: 'A piece of this work' } });
  const apart = await api.call('POST', '/sessions', { token, body: { prompt: 'Something else', separate: true } });
  assert.equal(api.asked[0].body.startedApart, undefined);
  assert.equal(api.asked[1].body.startedApart, true);
  sessions.find((s) => s.id === apart.body.session.id).startedApart = true;
  assert.equal(part.body.session.separate, undefined);
  const list = await api.call('GET', '/sessions', { token });
  assert.deepEqual(list.body.sessions.map((s) => s.id), [part.body.session.id], 'list follows the pieces of its own work');
  const all = await api.call('GET', '/sessions?all=1', { token });
  assert.deepEqual(all.body.sessions.find((s) => s.id === apart.body.session.id).separate, true);
});

test('a session starts, messages, reads and stops the agents beside its own, through the page\'s route', async (t) => {
  const { token, session } = holder();
  const asked = [];
  // The page's + Another agent route (server.mjs agentAction): what it was given, and statusd's kind of answer.
  const agentAction = async (req, res, route, login, { body } = {}) => {
    asked.push({ method: req.method, url: req.url, route: route.slice(1), login, body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(route[2] ? { ok: true } : { agents: [], agent: { id: 'agent-2', agent: body?.agent ?? null } }));
  };
  const api = await serve({ sessions: [session], agentAction });
  t.after(api.close);
  assert.equal((await api.call('POST', '/agents', { token, body: { prompt: 'Write the tests for totals.ts', agent: 'codex', model: 'gpt-5' } })).status, 200);
  await api.call('POST', '/agents/agent-2/send', { token, body: { text: 'Also the rounding case.' } });
  await api.call('GET', '/agents/agent-2/transcript?limit=20', { token });
  await api.call('GET', '/agents', { token });
  await api.call('POST', '/agents/agent-2/stop', { token, body: {} });
  assert.deepEqual(asked.map((a) => [a.method, a.url, a.route.join(','), a.login]), [
    ['POST', '/agents', `${session.id},,`, 'joel'],
    ['POST', '/agents/agent-2/send', `${session.id},agent-2,send`, 'joel'],
    ['GET', '/agents/agent-2/transcript?limit=20', `${session.id},agent-2,transcript`, 'joel'],
    ['GET', '/agents', `${session.id},,`, 'joel'],
    ['POST', '/agents/agent-2/stop', `${session.id},agent-2,stop`, 'joel'],
  ]);
  assert.deepEqual(asked[0].body, { agent: 'codex', model: 'gpt-5', effort: '', permissionMode: 'default', prompt: '[From this session\'s own agent]\n\nWrite the tests for totals.ts' },
    'the calling session\'s mode, never looser: codex has no acceptEdits');
  assert.deepEqual(asked[1].body, { text: '[Message from this session\'s own agent]\n\nAlso the rounding case.' }, 'headed, so the agent and its Chat tell it from the person');
  assert.equal((await api.call('POST', '/agents', { token, body: { prompt: '  ' } })).status, 400);

  const gone = await serve({ sessions: [session], agentAction, canWrite: () => false });
  t.after(gone.close);
  const before = asked.length;
  assert.equal((await gone.call('POST', '/agents', { token, body: { prompt: 'x' } })).status, 403);
  assert.equal(asked.length, before, 'refused before the page\'s route');
  assert.equal((await api.call('GET', '/agents', { token: 'wst_nope' })).status, 401);
});

test('a message from the session waited on answers the wait, and is not typed in behind it', async (t) => {
  const { token, session, child, sessions } = family();
  const childToken = newStartToken();
  child.startTokenHash = startTokenHash(childToken);
  Object.assign(child, { state: 'working' });
  const api = await serve({ sessions, noReplyMs: 60_000 });
  t.after(api.close);
  // The main session waits on the child (send --wait), and the child answers with woodshed-session reply.
  const waiting = api.call('GET', `/sessions/${child.id}/wait?for=reply`, { token });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(api.starts.openWaits(), 1);
  const replied = await api.call('POST', `/sessions/${session.id}/messages`, { token: childToken, body: { text: 'For customers, I think.' } });
  assert.deepEqual([replied.status, replied.body.sent, replied.body.answeredWait], [200, true, true]);
  const answer = await waiting;
  assert.equal(answer.body.reply.text, 'For customers, I think.');
  assert.equal(answer.body.session.id, child.id);
  assert.deepEqual(api.fleet.sent, [], 'handed to the wait, never typed in behind it');
  assert.equal(api.starts.openWaits(), 0, 'the wait is gone once answered');

  // With nobody waiting, a message is typed in as before.
  await api.call('POST', `/sessions/${session.id}/messages`, { token: childToken, body: { text: 'One more thing.' } });
  assert.equal(api.fleet.sent.length, 1);
});

test('a wait on a session that waits on this one answers at once, and a wait whose caller went is cleared', async (t) => {
  const { token, session, child, sessions } = family();
  const childToken = newStartToken();
  child.startTokenHash = startTokenHash(childToken);
  child.state = 'working';
  const api = await serve({ sessions, waitMs: 60_000 });
  t.after(api.close);
  const ac = new AbortController();
  const first = fetch(`${api.base}/sessions/${child.id}/wait?for=reply`, { headers: { authorization: `Bearer ${token}` }, signal: ac.signal }).catch(() => null);
  await new Promise((r) => setTimeout(r, 40));
  const back = await api.call('GET', `/sessions/${session.id}/wait?for=reply`, { token: childToken });
  assert.deepEqual([back.status, back.body.waitingOnYou, back.body.session.id], [200, true, session.id]);
  assert.equal(api.starts.openWaits(), 1, 'the answered-at-once wait never opened');
  ac.abort();
  await first;
  for (let i = 0; i < 50 && api.starts.openWaits(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(api.starts.openWaits(), 0, 'gone once its caller went');
});

test('a reply to a wait whose command went is typed in, not lost', async (t) => {
  const { token, session, child, sessions } = family();
  const childToken = newStartToken();
  child.startTokenHash = startTokenHash(childToken);
  Object.assign(child, { state: 'working', pendingMessages: [] });
  const api = await serve({ sessions });
  t.after(api.close);
  // The waiting command goes (Ctrl-C, its own timeout) before any reply.
  const gone = new AbortController();
  const waiting = fetch(`${api.base}/sessions/${child.id}/wait?for=reply`, { headers: { authorization: `Bearer ${token}` }, signal: gone.signal }).catch(() => null);
  await new Promise((r) => setTimeout(r, 50));
  gone.abort();
  await waiting;
  await new Promise((r) => setTimeout(r, 50));
  const sent = await api.call('POST', `/sessions/${session.id}/messages`, { token: childToken, body: { text: 'Done: totals in cents.' } });
  assert.equal(sent.body.answeredWait, undefined);
  assert.equal(sent.body.sent, true);
  assert.equal(api.fleet.sent.length, 1, 'typed in at the session\'s prompt as any message');
  assert.equal(api.starts.openWaits(), 0);
});

test('a reply taken by a wait whose command goes in the same moment is typed in, not dropped', async (t) => {
  const { token, session, child, sessions } = family();
  const childToken = newStartToken();
  child.startTokenHash = startTokenHash(childToken);
  Object.assign(child, { state: 'working', pendingMessages: [] });
  const api = await serve({ sessions, waitMs: 60_000 });
  t.after(api.close);
  const gone = new AbortController();
  const waiting = fetch(`${api.base}/sessions/${child.id}/wait?for=reply`, { headers: { authorization: `Bearer ${token}` }, signal: gone.signal }).catch(() => null);
  await new Promise((r) => setTimeout(r, 50));
  // The reply is taken, and the command goes before the wait wakes to hand it over.
  const sending = api.call('POST', `/sessions/${session.id}/messages`, { token: childToken, body: { text: 'Done: totals in cents.' } });
  gone.abort();
  const sent = await sending;
  await waiting;
  await new Promise((r) => setTimeout(r, 100));
  // Whichever won the race, the reply reached the session once: typed in, since nobody is left to print it.
  assert.equal(sent.status, 200);
  assert.equal(api.fleet.sent.length, 1, `typed in once (${sent.body.answeredWait ? 'taken by the wait, then typed in' : 'typed in at once'})`);
  assert.equal(api.starts.openWaits(), 0);
});
