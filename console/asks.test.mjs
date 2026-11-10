import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAsks, questionText } from './asks.mjs';
import { createFleet } from './fleet.mjs';

const HOUR = 3_600_000;

// A real fleet on a fake launcher and statusd, and a Slack that records what it was asked to do.
// U1 and U2 are members, G1 a guest, X1 someone from another organization in a shared channel, and Slack will not
// say who anyone else is.
const PEOPLE = {
  U1: { name: 'Ana', member: true, team: 'T1' },
  U2: { name: null, member: true, team: 'T1' },
  G1: { name: 'Gus', member: false, team: 'T1' },
  X1: { name: 'Xia', member: true, team: 'T9' },
};

function setup({ replyOk = true, person = async (user) => PEOPLE[user] ?? null } = {}) {
  let clock = Date.parse('2026-10-27T10:00:00.000Z');
  const calls = { started: [], stopped: [], sent: [], replies: [], reactions: [] };
  const alive = new Set();
  const launcher = {
    kind: 'fake',
    refFor(id) { return `c-${id}`; },
    async start(id, env) { calls.started.push({ id, env }); alive.add(`c-${id}`); return { ref: `c-${id}`, host: '127.0.0.1', termPort: 1, statusPort: 2 }; },
    async taskState(ref) { return { alive: alive.has(ref) }; },
    async logTail() { return ''; },
    async stop(ref) { calls.stopped.push(ref); alive.delete(ref); },
  };
  const statuses = {};
  async function statusd(session, method, path, opts) {
    if (path === '/status') return statuses[session.id] ?? { state: 'working' };
    if (path === '/send') calls.sent.push({ id: session.id, text: opts.body.text });
    return { committed: false, head: 'abc' };
  }
  const databases = { available: true, created: [], async createForSession(id) { this.created.push(id); }, async sweep() {} };
  const store = { state: { sessions: [], github: null }, save() {} };
  const config = {
    repo: 'o/r', label: 'woodshed', publicUrl: 'https://console.test', maxRunning: 1,
    limits: { idleMs: 2 * HOUR, lifetimeMs: 8 * HOUR, startTimeoutMs: 15 * 60_000 },
    sessionEnv: { PGHOST: 'db', GH_TOKEN: 'ghp_writes' }, ghToken: null, pollMs: 30_000, fallbackPollMs: 300_000, maxPrivatePerPerson: 3,
  };
  const github = { async pull() { return { state: 'open' }; } };
  const fleet = createFleet({ config, store, launcher, github, databases, statusd, now: () => clock });
  const slack = {
    async reply(args) { calls.replies.push(args); return replyOk; },
    async react(args) { calls.reactions.push(args); },
    person,
  };
  const asks = createAsks({ store, fleet, slack, publicUrl: 'https://console.test', now: () => clock });
  return { asks, fleet, calls, store, statuses, databases, advance: (ms) => { clock += ms; } };
}

const mention = { eventId: 'Ev1', team: 'T1', channel: 'C1', user: 'U1', ts: '100.1', threadTs: null, text: '<@B1> how do retries work?' };

test('questionText drops the mention of the bot that leads the message, and nothing else', () => {
  assert.equal(questionText('<@B1> how do retries work?'), 'how do retries work?');
  assert.equal(questionText('  <@B1><@B1>\nwhy?'), 'why?');
  assert.equal(questionText('why does <@U2> see this?'), 'why does <@U2> see this?');
});

test('a mention starts an ask session on master, with no databases and the shared slots left alone', async () => {
  const { asks, fleet, calls, databases } = setup();
  await fleet.createSession({ kind: 'issue', number: 7, title: 'busy', startedBy: 'joel', trigger: 'label' });
  const result = await asks.handleMention(mention);

  assert.equal(result.outcome, 'started');
  const session = fleet.find(result.sessionId);
  assert.equal(session.kind, 'ask');
  assert.equal(session.status, 'starting', 'the one shared slot is taken, and a question still starts');
  assert.equal(session.branch, null);
  assert.equal(session.startedBy, 'slack:U1');
  assert.deepEqual(session.slack, { channel: 'C1', threadTs: '100.1', user: 'U1', name: 'Ana' });
  assert.deepEqual(databases.created, [fleet.sessions()[0].id], 'only the issue\'s session gets databases');

  const { env } = calls.started.find((s) => s.id === session.id);
  assert.equal(env.SESSION_MODE, 'ask');
  assert.equal(env.ASKED_BY, 'Ana');
  assert.equal(env.PROMPT, 'how do retries work?');
  assert.equal(env.BRANCH, undefined);
  assert.equal(env.ISSUE, undefined);
  assert.equal(env.GH_TOKEN, undefined, 'a fixed token could write');
  assert.equal(calls.started[0].env.GH_TOKEN, 'ghp_writes', 'the issue\'s session keeps it');

  assert.deepEqual(calls.reactions, [{ channel: 'C1', ts: '100.1', name: 'eyes' }]);
  assert.equal(calls.replies.length, 1);
  assert.equal(calls.replies[0].threadTs, '100.1');
  assert.match(calls.replies[0].markdown, new RegExp(`https://console.test/s/${session.id}`));
});

test('Slack sending an event twice starts one session', async () => {
  const { asks, fleet } = setup();
  await asks.handleMention(mention);
  assert.equal((await asks.handleMention(mention)).outcome, 'duplicate');
  assert.equal(fleet.sessions().length, 1);
});

test('only full members of the workspace may ask: a guest, another organization, or someone unknown is told so', async () => {
  const { asks, fleet, calls } = setup();
  for (const [i, user] of ['G1', 'X1', 'Z9'].entries()) {
    const result = await asks.handleMention({ ...mention, eventId: `Ev${i}`, user });
    assert.equal(result.outcome, 'ignored');
    assert.match(result.reason, /^refused: the asker is /);
  }
  assert.equal(fleet.sessions().length, 0);
  assert.deepEqual(calls.reactions, [], 'no eyes for a question that is not taken');
  assert.equal(calls.replies.length, 3);
  assert.match(calls.replies[0].markdown, /people in the company's Slack workspace/);
  assert.equal(calls.replies[0].threadTs, '100.1');
  const followUp = await asks.handleMention({ ...mention, eventId: 'Ev9', user: 'G1', threadTs: '100.1' });
  assert.equal(followUp.outcome, 'ignored', 'a guest cannot ask in a member\'s thread either');
});

test('a mention whose handling throws is handled again when the queue hands it back', async () => {
  let down = true;
  const { asks, fleet } = setup({
    person: async (user) => {
      if (down) throw new Error('ECONNRESET');
      return PEOPLE[user] ?? null;
    },
  });
  await assert.rejects(asks.handleMention(mention), /ECONNRESET/);
  down = false;
  assert.equal((await asks.handleMention(mention)).outcome, 'started');
  assert.equal((await asks.handleMention(mention)).outcome, 'duplicate');
  assert.equal(fleet.sessions().length, 1);
});

test('a mention with no question gets a hint, and starts nothing', async () => {
  const { asks, fleet, calls } = setup();
  const result = await asks.handleMention({ ...mention, text: '<@B1>  ' });
  assert.equal(result.outcome, 'ignored');
  assert.equal(fleet.sessions().length, 0);
  assert.match(calls.replies[0].markdown, /Ask me something/);
});

test('a mention in the thread is typed into its running session', async () => {
  const { asks, fleet, calls } = setup();
  const { sessionId } = await asks.handleMention(mention);
  await fleet.tick();
  const result = await asks.handleMention({ ...mention, eventId: 'Ev2', ts: '100.5', threadTs: '100.1', text: '<@B1> and for loops?' });
  assert.deepEqual(result, { outcome: 'sent', sessionId });
  assert.equal(calls.sent.length, 1);
  assert.match(calls.sent[0].text, /from the person who asked:\nand for loops\?$/);
  assert.equal(fleet.sessions().length, 1);
});

test('a mention in the thread of a stopped question resumes it, and one in a new thread starts another', async () => {
  const { asks, fleet } = setup();
  const { sessionId } = await asks.handleMention(mention);
  await fleet.tick();
  const session = fleet.find(sessionId);
  await fleet.stop(session, 'idle for 30 min');
  assert.equal(session.kept, true);

  const resumed = await asks.handleMention({ ...mention, eventId: 'Ev2', user: 'U2', ts: '100.9', threadTs: '100.1', text: '<@B1> why?' });
  assert.deepEqual(resumed, { outcome: 'resumed', sessionId });
  assert.equal(session.status, 'starting');
  assert.match(session.pendingMessages.at(-1), /from someone else:\nwhy\?$/);

  const other = await asks.handleMention({ ...mention, eventId: 'Ev3', ts: '200.1', text: '<@B1> another one' });
  assert.equal(other.outcome, 'started');
  assert.notEqual(other.sessionId, sessionId);
});

test('an answer goes to the session\'s thread; a session that is not a question has none', async () => {
  const { asks, fleet, calls } = setup();
  const { sessionId } = await asks.handleMention(mention);
  const session = fleet.find(sessionId);
  assert.equal(await asks.answer(session, '  Retries happen **three** times.  '), true);
  assert.deepEqual(calls.replies.at(-1), { channel: 'C1', threadTs: '100.1', markdown: 'Retries happen **three** times.' });
  assert.equal(session.answers, 1);

  const issue = await fleet.createSession({ kind: 'issue', number: 7, title: 't', startedBy: 'joel', trigger: 'label' });
  await assert.rejects(asks.answer(issue, 'x'), (err) => err.shown);
  await assert.rejects(asks.answer(session, '   '), (err) => err.shown);
});

test('a question that stopped before it was answered is told so in its thread, once', async () => {
  const { asks, fleet, calls } = setup();
  const { sessionId } = await asks.handleMention(mention);
  await fleet.stop(fleet.find(sessionId), 'ran for 2 h');
  await asks.tick();
  await asks.tick();
  const notices = calls.replies.filter((r) => /no answer/.test(r.markdown));
  assert.equal(notices.length, 1);
  assert.match(notices[0].markdown, /ran for 2 h/);
});

test('a question that was answered stops quietly', async () => {
  const { asks, fleet, calls } = setup();
  const { sessionId } = await asks.handleMention(mention);
  const session = fleet.find(sessionId);
  await asks.answer(session, 'It retries.');
  await fleet.stop(session, 'idle for 30 min');
  await asks.tick();
  assert.equal(calls.replies.filter((r) => /no answer/.test(r.markdown)).length, 0);
});

test('names are the Slack names of slack: askers only', async () => {
  const { asks } = setup();
  await asks.handleMention(mention);
  assert.deepEqual(asks.names(['slack:U1', 'slack:U9', 'joel']), { 'slack:U1': 'Ana' });
});
