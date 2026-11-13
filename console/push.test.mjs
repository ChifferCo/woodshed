import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, randomBytes } from 'node:crypto';
import http from 'node:http';

import { DEFAULT_RELAY, IDLE_SETTLE_MS, createPush, failedStep, parseRelays, planLimitOf, recipientOf, relayUrl, seal } from './push.mjs';

const LA = 'America/Los_Angeles';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// November: Los Angeles is on PST, UTC-8.
const la = (day, hour, minute = 0) => Date.UTC(2026, 10, day, hour + 8, minute);
const HANDLE = 'h'.repeat(43);

/** What the app's service extension does: base64, then nonce, ciphertext and tag, then AES-256-GCM. */
function unseal(key, sealed) {
  const raw = Buffer.from(sealed, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8'));
}

/** A relay that records each push and answers what `answer` says, 202 unless a test changes it. */
async function fakeRelay(t) {
  const relay = { pushes: [], answer: 202 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      relay.pushes.push({ path: req.url, method: req.method, body: JSON.parse(raw) });
      const status = typeof relay.answer === 'function' ? relay.answer() : relay.answer;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(status === 202 ? '{}' : JSON.stringify({ error: status === 410 ? 'gone' : 'no' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  relay.url = `http://127.0.0.1:${server.address().port}/push`;
  return relay;
}

async function setup(t, { sessions = [], admins = [], start = la(13, 10) } = {}) {
  const relay = await fakeRelay(t);
  let clock = start;
  const store = { state: { sessions }, saves: 0, save() { this.saves++; } };
  const push = createPush({ store, relays: [relay.url], sessions: () => sessions, admins: () => admins, now: () => clock });
  const key = randomBytes(32);
  const register = (login = 'ana', extra = {}) => push.register(login, { handle: HANDLE, key: key.toString('base64'), relay: relay.url, name: 'Ana\'s iPhone', timeZone: LA, ...extra });
  // What each push the relay got said, opened with the phone's key.
  const opened = () => relay.pushes.map((p) => ({ ...p.body, sealed: undefined, body: unseal(key, p.body.sealed) }));
  async function settle() {
    await push.idle();
  }
  return { push, relay, store, key, register, opened, settle, advance: (ms) => { clock += ms; }, at: (ms) => { clock = ms; }, now: () => clock };
}

function privateSession(fields = {}) {
  return { id: 'a1b2c3d4', owner: 'ana', title: 'Fix the login page', status: 'running', state: 'working', createdAt: new Date(la(13, 9)).toISOString(), ...fields };
}

// A turn that ends: working, then idle and settled.
function endTurn(ctx, session, { state = 'done', text = 'Done: the login page loads again.', pauseAt = null } = {}) {
  session.state = 'working';
  ctx.push.statusRead(session, { wasState: 'working', pauseAt });
  session.state = state;
  session.lastMessage = { role: 'claude', text };
  ctx.push.statusRead(session, { wasState: 'working', pauseAt });
  ctx.advance(IDLE_SETTLE_MS);
  return ctx.push.statusRead(session, { wasState: state, pauseAt });
}

test('a sealed body opens with the phone\'s key: a 12-byte nonce, the ciphertext, then the 16-byte tag', () => {
  const key = randomBytes(32);
  const body = { v: 1, kind: 'waiting', id: 'ref', session: 'a1b2c3d4', title: 'T', body: 'B', url: '/s/a1b2c3d4', reminder: 0 };
  const sealed = seal(key, body);
  const raw = Buffer.from(sealed, 'base64');
  assert.equal(raw.length, 12 + Buffer.byteLength(JSON.stringify(body)) + 16);
  assert.deepEqual(unseal(key, sealed), body);
  assert.notEqual(seal(key, body), sealed, 'a new nonce each time');
  assert.throws(() => unseal(randomBytes(32), sealed), 'another key cannot open it');
});

test('the relays a phone may name: WOODSHED_PUSH_RELAYS, the default when unset, none when empty', () => {
  assert.deepEqual(parseRelays(undefined), [DEFAULT_RELAY]);
  assert.deepEqual(parseRelays(''), []);
  assert.deepEqual(parseRelays('https://relay.example/push/, https://relay.example/push, ftp://x, http://127.0.0.1:9'), ['https://relay.example/push', 'http://127.0.0.1:9']);
  assert.equal(relayUrl('https://user:pw@relay.example/push'), null);
  assert.equal(relayUrl('https://relay.example/push?to=elsewhere'), null);
});

test('a phone registers only through an allowed relay, and the console never shows its handle or key', async (t) => {
  const ctx = await setup(t);
  const key = ctx.key.toString('base64');
  const base = { handle: HANDLE, key, relay: ctx.relay.url, timeZone: LA };
  for (const relay of ['https://evil.example/push', `${ctx.relay.url}/other`, 'http://169.254.169.254/latest', `${ctx.relay.url}?x=1`, null]) {
    assert.throws(() => ctx.push.register('ana', { ...base, relay }), { shown: true, message: 'that relay is not one this console sends to' }, String(relay));
  }
  assert.throws(() => ctx.push.register('ana', { ...base, key: randomBytes(16).toString('base64') }), /key must be 32 bytes/);
  assert.throws(() => ctx.push.register('ana', { ...base, handle: 'short' }), /handle must be/);
  assert.throws(() => ctx.push.register('ana', { ...base, timeZone: 'Mars/Olympus' }), /timeZone must be/);
  assert.throws(() => ctx.push.register('ana', { ...base, kinds: 'all' }), /kinds must be/);
  assert.deepEqual(ctx.push.devicesOf('ana'), []);

  const { id } = ctx.push.register('ana', { ...base, relay: `${ctx.relay.url}/`, name: 'Ana\'s iPhone', kinds: { prReady: false } });
  const [device] = ctx.push.devicesOf('Ana');
  assert.deepEqual(Object.keys(device).sort(), ['createdAt', 'id', 'kinds', 'name', 'timeZone']);
  assert.equal(device.id, id);
  assert.equal(device.kinds.prReady, false);
  assert.equal(device.kinds.started, false, 'started is off by default');
  assert.equal(device.kinds.waiting, true);
  assert.equal(JSON.stringify(ctx.push.devicesOf('ana')).includes(HANDLE), false);

  // The same handle again replaces it, and keeps its id.
  assert.deepEqual(ctx.push.register('ana', { ...base, name: 'Renamed' }), { id });
  assert.deepEqual(ctx.push.devicesOf('ana').map((d) => d.name), ['Renamed']);
  assert.deepEqual(ctx.push.updateDevice('ana', id, { kinds: { started: true }, timeZone: 'Europe/London' }).kinds.started, true);
  assert.equal(ctx.push.devicesOf('ana')[0].timeZone, 'Europe/London');
  assert.equal(ctx.push.updateDevice('bo', id, { name: 'x' }), null, 'only its owner changes it');
  assert.equal(ctx.push.removeDevice('bo', id), false);
  assert.equal(ctx.push.removeDevice('ana', id), true);
  assert.deepEqual(ctx.push.devicesOf('ana'), []);
});

test('waiting goes out once per idle turn, after the turn has settled, sealed, and time-sensitive', async (t) => {
  const session = privateSession();
  const ctx = await setup(t, { sessions: [session] });
  ctx.register();

  // A claude that has only opened has not worked: its first idle is no turn.
  ctx.push.statusRead({ ...session, state: 'done' }, { wasState: null });
  ctx.push.statusRead(session, { wasState: null });
  session.state = 'done';
  session.lastMessage = { role: 'claude', text: 'Done: the login page loads again.' };
  ctx.push.statusRead(session, { wasState: 'working', pauseAt: la(13, 11) });
  ctx.advance(IDLE_SETTLE_MS - 1000);
  ctx.push.statusRead(session, { wasState: 'done', pauseAt: la(13, 11) });
  await ctx.settle();
  assert.equal(ctx.relay.pushes.length, 0, 'not before it settles');
  ctx.advance(1000);
  ctx.push.statusRead(session, { wasState: 'done', pauseAt: la(13, 11) });
  ctx.push.statusRead(session, { wasState: 'done', pauseAt: la(13, 11) });
  ctx.advance(5 * MINUTE);
  ctx.push.statusRead(session, { wasState: 'done', pauseAt: la(13, 11) });
  await ctx.settle();

  assert.equal(ctx.relay.pushes.length, 1, 'once, however many reads find it idle');
  const [sent] = ctx.opened();
  assert.equal(ctx.relay.pushes[0].path, '/push/v1/push');
  assert.equal(ctx.relay.pushes[0].body.handle, HANDLE);
  assert.deepEqual({ ...sent, body: { ...sent.body, id: 'ref' } }, {
    handle: HANDLE, type: 'alert', collapseId: 'a1b2c3d4:waiting', threadId: 'a1b2c3d4', timeSensitive: true, sealed: undefined,
    body: { v: 1, kind: 'waiting', id: 'ref', session: 'a1b2c3d4', title: 'Fix the login page', body: 'Done: the login page loads again.', url: '/s/a1b2c3d4', reminder: 0 },
  });

  // A flick to working and back that does not settle is nothing; a real new turn is a new notification.
  session.state = 'working';
  ctx.push.statusRead(session, { wasState: 'done' });
  session.state = 'needs-you';
  session.lastMessage = { role: 'claude', text: 'Run the migration?' };
  ctx.push.statusRead(session, { wasState: 'working' });
  session.state = 'working';
  ctx.push.statusRead(session, { wasState: 'needs-you' });
  ctx.advance(IDLE_SETTLE_MS);
  ctx.push.statusRead(session, { wasState: 'working' });
  await ctx.settle();
  assert.equal(ctx.relay.pushes.length, 1);
  session.state = 'needs-you';
  ctx.push.statusRead(session, { wasState: 'working' });
  ctx.advance(IDLE_SETTLE_MS);
  ctx.push.statusRead(session, { wasState: 'needs-you' });
  await ctx.settle();
  assert.equal(ctx.relay.pushes.length, 2);
  assert.equal(ctx.opened()[1].body.body, 'Needs your permission: Run the migration?');
});

test('only you: a shared session\'s assignee, a private one\'s owner; a question, a QA run, a review run and an unassigned session are nobody\'s', () => {
  assert.equal(recipientOf({ owner: 'ana' }), 'ana');
  assert.equal(recipientOf({ assignee: 'bo' }), 'bo');
  assert.equal(recipientOf({ assignee: null }), null);
  assert.equal(recipientOf({ kind: 'ask', assignee: 'bo' }), null);
  assert.equal(recipientOf({ qa: { base: 'main' }, assignee: 'bo' }), null);
  assert.equal(recipientOf({ review: { base: 'main' }, assignee: 'bo' }), null);
});

test('no push for a session you have open, and opening it takes down what was shown', async (t) => {
  const session = privateSession();
  const ctx = await setup(t, { sessions: [session] });
  ctx.register();
  ctx.push.saw('ana', session.id);
  ctx.advance(10_000);
  assert.equal(ctx.push.isLooking('ana', session.id), true);
  assert.equal(ctx.push.isLooking('bo', session.id), false);
  assert.equal(endTurn(ctx, session), null);
  await ctx.settle();
  assert.equal(ctx.relay.pushes.length, 0);

  ctx.advance(60_000);
  assert.equal(ctx.push.isLooking('ana', session.id), false, 'a read older than 30 s is not looking');
  const note = endTurn(ctx, session);
  await ctx.settle();
  assert.equal(ctx.relay.pushes.length, 1);
  ctx.push.saw('ana', session.id);
  await ctx.settle();
  const clear = ctx.opened()[1];
  assert.equal(clear.type, 'clear');
  assert.equal(clear.collapseId, undefined);
  assert.deepEqual(clear.body, { v: 1, kind: 'clear', ids: [note.ref] });
  ctx.advance(HOUR);
  ctx.push.tick();
  await ctx.settle();
  assert.equal(ctx.relay.pushes.length, 2, 'its reminders went with it');
});

test('reminders: waiting at 15 minutes and 10 before the pause, at most two, then a snooze past the cap', async (t) => {
  const session = privateSession();
  const ctx = await setup(t, { sessions: [session] });
  ctx.register();
  const note = endTurn(ctx, session, { pauseAt: la(13, 11) });
  const reminders = async () => { await ctx.settle(); return ctx.opened().filter((p) => p.type === 'alert').map((p) => p.body.reminder); };
  ctx.at(la(13, 10, 14));
  ctx.push.tick();
  assert.deepEqual(await reminders(), [0]);
  ctx.at(la(13, 10, 16));
  ctx.push.tick();
  ctx.push.tick();
  assert.deepEqual(await reminders(), [0, 1]);
  ctx.at(la(13, 10, 50));
  ctx.push.tick();
  assert.deepEqual(await reminders(), [0, 1, 2]);
  ctx.at(la(13, 12));
  ctx.push.tick();
  assert.deepEqual(await reminders(), [0, 1, 2], 'two at most');
  assert.ok(ctx.opened().every((p) => p.collapseId === 'a1b2c3d4:waiting' && p.body.id === note.ref), 'a reminder replaces its original');

  assert.equal(ctx.push.snooze('ana', note.ref, 60), true);
  assert.throws(() => ctx.push.snooze('ana', note.ref, 0), /minutes must be/);
  assert.equal(ctx.push.snooze('bo', note.ref, 60), false, 'not theirs');
  ctx.at(la(13, 12, 59));
  ctx.push.tick();
  assert.deepEqual(await reminders(), [0, 1, 2]);
  ctx.at(la(13, 13));
  ctx.push.tick();
  ctx.advance(HOUR);
  ctx.push.tick();
  assert.deepEqual(await reminders(), [0, 1, 2, 3], 'the snoozed one comes, and nothing after it');
});

test('quiet hours hold a reminder on the phone\'s clock, never the first; a snooze goes through them', async (t) => {
  const session = { id: 'b2c3d4e5', assignee: 'ana', title: 'Add GTM', status: 'stopped', state: 'done', createdAt: new Date(la(13, 9)).toISOString() };
  const ctx = await setup(t, { sessions: [session], start: la(13, 21) });
  ctx.register();
  const note = ctx.push.prReady(session, { number: 12, title: 'Add GTM to the landing page' });
  await ctx.settle();
  assert.equal(ctx.opened()[0].body.body, '#12 is ready: Add GTM to the landing page');
  assert.equal(ctx.opened()[0].timeSensitive, undefined, 'only waiting is time-sensitive');
  ctx.at(la(14, 1));
  ctx.push.tick();
  ctx.at(la(14, 7, 59));
  ctx.push.tick();
  await ctx.settle();
  assert.equal(ctx.relay.pushes.length, 1, 'held through the night');
  ctx.at(la(14, 8));
  ctx.push.tick();
  await ctx.settle();
  assert.equal(ctx.relay.pushes.length, 2);
  ctx.at(la(14, 9));
  ctx.push.tick();
  await ctx.settle();
  assert.deepEqual(ctx.opened().map((p) => p.body.reminder), [0, 1, 2]);

  // Snoozed at 22:30 for an hour: 23:30 is quiet, but it was asked for.
  ctx.at(la(14, 22, 30));
  ctx.push.snooze('ana', note.ref, 60);
  ctx.at(la(14, 23, 30));
  ctx.push.tick();
  await ctx.settle();
  assert.deepEqual(ctx.opened().map((p) => p.body.reminder), [0, 1, 2, 3]);
});

test('dealt with: a new turn, a stop, a closed pull request, seen; reminders go and a clear goes to the phones that showed it', async (t) => {
  const session = privateSession();
  const ctx = await setup(t, { sessions: [session] });
  ctx.register();
  const clears = () => ctx.opened().filter((p) => p.type === 'clear').map((p) => p.body.ids);

  const first = endTurn(ctx, session);
  await ctx.settle();
  session.state = 'working';
  ctx.push.sessionChanged(session);
  await ctx.settle();
  assert.deepEqual(clears(), [[first.ref]], 'a new turn');

  const second = endTurn(ctx, session);
  await ctx.settle();
  session.status = 'stopped';
  ctx.push.sessionChanged(session);
  await ctx.settle();
  assert.deepEqual(clears().at(-1), [second.ref], 'a stop');

  const shared = { id: 'c3d4e5f6', assignee: 'ana', title: 'Add GTM', status: 'stopped', createdAt: new Date(la(13, 9)).toISOString() };
  ctx.store.state.sessions.push(shared);
  const ready = ctx.push.prReady(shared, { number: 12 });
  await ctx.settle();
  ctx.push.sessionChanged({ ...shared });
  await ctx.settle();
  assert.deepEqual(clears().at(-1), [second.ref], 'a stopped session is no reason to take down a ready pull request');
  shared.prClosedAt = new Date(ctx.now()).toISOString();
  ctx.push.sessionChanged(shared);
  await ctx.settle();
  assert.deepEqual(clears().at(-1), [ready.ref], 'its pull request closed');

  delete shared.prClosedAt;
  const stuck = ctx.push.prStuck(shared, { number: 12, why: 'needs a human' });
  await ctx.settle();
  assert.equal(ctx.opened().at(-1).body.body, 'It asked for a person on #12.');
  assert.equal(ctx.push.seen('bo', stuck.ref), false, 'not theirs');
  assert.equal(ctx.push.seen('ana', stuck.ref), true);
  await ctx.settle();
  assert.deepEqual(clears().at(-1), [stuck.ref], 'seen');
  assert.equal(ctx.push.seen('ana', stuck.ref), false, 'already dealt with');

  // Handed to someone else: the notes of whoever had it go.
  const assigned = ctx.push.assigned({ ...shared, assignee: 'ana' }, 'bo');
  await ctx.settle();
  ctx.push.sessionChanged({ ...shared, assignee: 'cy' });
  await ctx.settle();
  assert.deepEqual(clears().at(-1), [assigned.ref]);

  const total = ctx.relay.pushes.length;
  ctx.advance(24 * HOUR);
  ctx.push.tick();
  await ctx.settle();
  assert.equal(ctx.relay.pushes.length, total, 'no reminder of anything dealt with');
});

test('the relay answers 410: the phone is dropped, with its notifications', async (t) => {
  const session = privateSession();
  const ctx = await setup(t, { sessions: [session] });
  ctx.register();
  ctx.relay.answer = 410;
  endTurn(ctx, session);
  await ctx.settle();
  assert.deepEqual(ctx.push.devicesOf('ana'), []);
  assert.deepEqual(ctx.store.state.push.notes, []);
  ctx.relay.answer = 202;
  ctx.advance(HOUR);
  ctx.push.tick();
  endTurn(ctx, session);
  await ctx.settle();
  assert.equal(ctx.relay.pushes.length, 1, 'nothing more is sent to it');
});

test('a failing relay is logged and changes nothing else: the session, the reminders, and later pushes go on', async (t) => {
  const session = privateSession();
  const ctx = await setup(t, { sessions: [session] });
  ctx.register();
  ctx.relay.answer = 500;
  const before = JSON.stringify(session);
  const note = endTurn(ctx, session);
  await ctx.settle();
  assert.equal(JSON.stringify(session), JSON.stringify({ ...JSON.parse(before), state: 'done', lastMessage: session.lastMessage }));
  assert.equal(ctx.push.devicesOf('ana').length, 1);
  assert.equal(ctx.store.state.push.notes[0].ref, note.ref);
  assert.equal(Object.values(note.targets)[0].shown, false);

  // A relay that is not there at all.
  const store = { state: {}, save() {} };
  const down = createPush({ store, relays: ['http://127.0.0.1:9/push'], now: ctx.now });
  down.register('ana', { handle: HANDLE, key: ctx.key.toString('base64'), relay: 'http://127.0.0.1:9/push' });
  assert.ok(down.assigned({ id: 'd4e5f6a7', assignee: 'ana', title: 'x' }, 'bo'));
  await down.idle();
  assert.equal(store.state.push.devices.length, 1);

  ctx.relay.answer = 202;
  ctx.advance(15 * MINUTE);
  ctx.push.tick();
  await ctx.settle();
  assert.deepEqual(ctx.opened().map((p) => p.body.reminder), [0, 1], 'the reminder goes once the relay is back');
});

test('each kind\'s moment: started after a wait in line, a failed start\'s step, assigned by someone else, a stuck pull request', async (t) => {
  const session = privateSession({ status: 'running', createdAt: new Date(la(13, 9)).toISOString() });
  const ctx = await setup(t, { sessions: [session] });
  ctx.register('ana', { kinds: { started: true } });
  const kinds = async () => { await ctx.settle(); return ctx.opened().map((p) => [p.body.kind, p.body.body]); };

  assert.equal(ctx.push.started({ ...session, startedAt: new Date(la(13, 9) + 30_000).toISOString() }), null, 'half a minute is no wait');
  ctx.push.started({ ...session, startedAt: new Date(la(13, 9, 5)).toISOString() });
  ctx.push.started({ ...session, createdAt: new Date(la(12, 9)).toISOString(), resumedAt: new Date(la(13, 9, 59) + 50_000).toISOString(), startedAt: new Date(la(13, 10)).toISOString() });
  assert.deepEqual(await kinds(), [['started', 'Started: it was waiting in line.']], 'a resume waits from its resume');

  ctx.push.startFailed({ ...session, status: 'failed', startSteps: { machine: 'x', container: 'x', settings: 'x' }, error: 'PGHOST is not set' });
  ctx.push.startFailed({ ...session, id: 'e5f6a7b8', status: 'stopped', stopReason: 'did not start in time' });
  assert.deepEqual((await kinds()).slice(1), [
    ['startFailed', 'Did not start: it failed at restoring the Claude home. PGHOST is not set'],
    ['startFailed', 'Did not start: it failed at getting a machine. did not start in time'],
  ]);
  assert.equal(failedStep({ startSteps: { machine: 'x', container: 'x', settings: 'x', home: 'x', branch: 'x', databases: 'x', env: 'x', claude: 'x' } }), 'claude');

  const shared = { id: 'f6a7b8c9', title: 'Add GTM', status: 'running', assignee: 'ana' };
  assert.equal(ctx.push.assigned(shared, 'ana'), null, 'taking it yourself is no news');
  ctx.push.assigned(shared, 'bo');
  ctx.push.prStuck(shared, { number: 12, why: 'gave up' });
  ctx.push.prReady({ ...shared, assignee: null }, { number: 12 });
  assert.deepEqual((await kinds()).slice(3), [
    ['assigned', '@bo assigned it to you.'],
    ['prStuck', '#12 was not approved with green checks in time.'],
  ]);

  // A phone with a kind off does not hear it; started is off unless turned on.
  ctx.push.updateDevice('ana', ctx.push.devicesOf('ana')[0].id, { kinds: { assigned: false, started: false } });
  assert.equal(ctx.push.assigned({ ...shared, id: 'a7b8c9d0' }, 'bo'), null);
  assert.equal(ctx.push.started({ ...session, startedAt: new Date(la(13, 9, 5)).toISOString() }), null);
});

test('a turn that ends on the plan\'s limit is planLimit, with its reset on the phone\'s clock; planReset follows if it still waits', async (t) => {
  const resetsAt = new Date(la(13, 15)).toISOString();
  const session = privateSession({ planUsage: { asOf: null, fiveHour: { usedPercent: 100, resetsAt }, sevenDay: { usedPercent: 40, resetsAt: new Date(la(18, 9)).toISOString() } } });
  const ctx = await setup(t, { sessions: [session] });
  ctx.register();
  endTurn(ctx, session, { text: 'Let me check the tests.' });
  await ctx.settle();
  assert.deepEqual(ctx.opened().map((p) => [p.body.kind, p.body.body, p.collapseId]), [['planLimit', 'Stopped on your plan\'s limit. Resets 3:00 PM.', 'a1b2c3d4:planLimit']]);

  ctx.at(la(13, 14, 59));
  ctx.push.tick();
  await ctx.settle();
  assert.equal(ctx.relay.pushes.length, 1);
  session.status = 'stopped';
  ctx.at(la(13, 15));
  ctx.push.tick();
  await ctx.settle();
  // The two go out together, in either order.
  const after = ctx.opened().slice(1).map((p) => `${p.type}: ${p.body.kind === 'clear' ? p.body.ids.length : p.body.body}`).sort();
  assert.deepEqual(after, ['alert: Your plan has reset: it can go on.', 'clear: 1']);
  assert.equal(ctx.opened().find((p) => p.body.kind === 'planReset').collapseId, 'a1b2c3d4:planReset');
});

test('the plan\'s limit is read from a used-up window, or from Claude Code\'s own short message; working again needs no reset', async (t) => {
  const now = la(13, 10);
  const window = (usedPercent, hours) => ({ usedPercent, resetsAt: new Date(now + hours * HOUR).toISOString() });
  assert.deepEqual(planLimitOf({ planUsage: { fiveHour: window(100, 2), sevenDay: window(100, 50) } }, now), { resetsAt: new Date(now + 50 * HOUR).toISOString() });
  assert.equal(planLimitOf({ planUsage: { fiveHour: window(99, 2) } }, now), null);
  assert.equal(planLimitOf({ planUsage: { fiveHour: window(100, -1) } }, now), null, 'a window that already reset');
  assert.deepEqual(planLimitOf({ planUsage: { fiveHour: window(97, 2) }, lastMessage: { role: 'claude', text: 'You\'ve hit your limit · resets 3pm' } }, now), { resetsAt: new Date(now + 2 * HOUR).toISOString() });
  assert.deepEqual(planLimitOf({ lastMessage: { role: 'claude', text: '5-hour limit reached ∙ resets 2pm' } }, now), { resetsAt: null });
  assert.equal(planLimitOf({ lastMessage: { role: 'you', text: 'limit reached' } }, now), null);
  assert.equal(planLimitOf({ lastMessage: { role: 'claude', text: `The rate limit reached its cap in the test. ${'x'.repeat(300)}` } }, now), null, 'a long reply that mentions it');

  const session = privateSession({ planUsage: { fiveHour: { usedPercent: 100, resetsAt: new Date(la(13, 15)).toISOString() } } });
  const ctx = await setup(t, { sessions: [session] });
  ctx.register();
  endTurn(ctx, session);
  session.state = 'working';
  ctx.push.sessionChanged(session);
  ctx.at(la(13, 15, 1));
  ctx.push.tick();
  await ctx.settle();
  assert.deepEqual(ctx.opened().map((p) => p.body.kind), ['planLimit', 'clear'], 'working again: the limit is dealt with, and no reset follows');
});

test('someone asks to join: each admin\'s phone hears it, until it is settled', async (t) => {
  const ctx = await setup(t, { admins: ['ana', 'bo'] });
  ctx.register('ana');
  const note = ctx.push.joinRequest('newcomer');
  await ctx.settle();
  assert.equal(note, undefined);
  const [sent] = ctx.opened();
  assert.deepEqual([sent.collapseId, sent.threadId, sent.body.title, sent.body.url, sent.body.session], ['join:newcomer', 'join', '@newcomer asks to join', '/people', null]);
  ctx.push.joinSettled('NewComer');
  await ctx.settle();
  assert.equal(ctx.opened()[1].type, 'clear');
  assert.deepEqual(ctx.store.state.push.notes, []);
});

test('reminders survive a restart: they are kept in the store', async (t) => {
  const session = privateSession();
  const ctx = await setup(t, { sessions: [session] });
  ctx.register();
  endTurn(ctx, session);
  await ctx.settle();
  const again = createPush({ store: ctx.store, relays: [ctx.relay.url], sessions: () => [session], now: ctx.now });
  ctx.advance(16 * MINUTE);
  again.tick();
  await again.idle();
  assert.deepEqual(ctx.opened().map((p) => p.body.reminder), [0, 1]);
});

test('a notification whose session was removed is taken down', async (t) => {
  const session = privateSession();
  const sessions = [session];
  const ctx = await setup(t, { sessions });
  ctx.register();
  endTurn(ctx, session);
  sessions.length = 0;
  ctx.push.tick();
  await ctx.settle();
  assert.deepEqual(ctx.opened().map((p) => p.type), ['alert', 'clear']);
});
