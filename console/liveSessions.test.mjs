import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createLiveSessions, DEBOUNCE_MS, diffList, MAX_AGE_MS, SWEEP_MS } from './liveSessions.mjs';

const list = (sessions, extra = {}) => ({ login: 'joel', running: sessions.filter((s) => s.state === 'working').length, ...extra, sessions });

test('a patch carries the list\'s changed fields, each changed session whole, and the order only when it changed', () => {
  const a = { id: 'aaaa1111', state: 'done', title: 'One' };
  const b = { id: 'bbbb2222', state: 'done', title: 'Two' };
  const { sent } = diffList(null, list([a, b]));
  assert.equal(diffList(sent, list([a, b])).patch, null, 'nothing changed: nothing sent');

  const working = { ...b, state: 'working' };
  assert.deepEqual(diffList(sent, list([a, working])).patch, { top: { running: 1 }, sessions: [{ id: 'bbbb2222', state: 'working' }] }, 'only what changed in it');

  const c = { id: 'cccc3333', state: 'done', title: 'Three' };
  assert.deepEqual(diffList(sent, list([c, a])).patch, { sessions: [c], ids: ['cccc3333', 'aaaa1111'] }, 'one came whole, one went');

  const { title, ...untitled } = a;
  assert.deepEqual(diffList(sent, list([untitled, b])).patch, { unset: { aaaa1111: ['title'] } }, 'a field it no longer has');
});

function fakeTimers() {
  const timers = [];
  return {
    later: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    cancel: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    run(ms) {
      const due = timers.filter((t) => t.ms === ms);
      for (const t of due) timers.splice(timers.indexOf(t), 1);
      for (const t of due) t.fn();
      return due.length;
    },
    pending: () => timers.map((t) => t.ms),
  };
}

function fakeResponse() {
  const res = new EventEmitter();
  Object.assign(res, { head: null, chunks: [], ended: false });
  res.writeHead = (status, headers) => { res.head = { status, headers }; };
  res.write = (chunk) => { res.chunks.push(chunk); };
  res.end = () => { res.ended = true; res.emit('close'); };
  res.events = () => res.chunks.join('').split('\n\n').filter((e) => e.startsWith('event:')).map((e) => {
    const [, event] = /^event: (\w+)/.exec(e);
    return { event, data: JSON.parse(e.slice(e.indexOf('data: ') + 6)) };
  });
  return res;
}

function setup(sessions) {
  const timers = fakeTimers();
  let clock = 0;
  let listener = null;
  const asked = [];
  const live = createLiveSessions({
    bodyFor: (login) => { asked.push(login); return list(sessions.map((s) => ({ ...s }))); },
    onChange: (fn) => { listener = fn; },
    later: timers.later, cancel: timers.cancel, now: () => clock,
  });
  const open = (login = 'joel', opts = {}) => {
    const res = fakeResponse();
    live.handle(new EventEmitter(), res, login, opts);
    return res;
  };
  return { live, timers, open, asked, changed: () => listener(), advance: (ms) => { clock += ms; } };
}

test('a page gets the whole list first, then each change within a moment of the fleet making it', async () => {
  const sessions = [{ id: 'aaaa1111', state: 'done' }];
  const { live, open, timers, changed, asked } = setup(sessions);
  const res = open();
  assert.equal(res.head.status, 200);
  assert.equal(res.head.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.equal(res.head.headers['x-accel-buffering'], 'no', 'a proxy in front would hold the events back');
  assert.deepEqual(res.events(), [{ event: 'full', data: list([{ id: 'aaaa1111', state: 'done' }]) }]);
  assert.deepEqual(asked, ['joel'], 'the list that login may see');

  sessions[0].state = 'working';
  changed();
  changed();
  assert.equal(timers.run(DEBOUNCE_MS), 1, 'many changes at once, one patch');
  await live.settled();
  assert.deepEqual(res.events().slice(1), [{ event: 'patch', data: { top: { running: 1 }, sessions: [{ state: 'working', id: 'aaaa1111' }] } }]);
});

test('what changes outside the fleet is found by the sweep, and a quiet list sends nothing', async () => {
  const sessions = [{ id: 'aaaa1111', state: 'done', pr: null }];
  const { live, open, timers } = setup(sessions);
  const res = open();
  timers.run(SWEEP_MS);
  await live.settled();
  assert.equal(res.events().length, 1);
  sessions[0].pr = { state: 'open' };
  timers.run(SWEEP_MS);
  await live.settled();
  assert.deepEqual(res.events().at(-1), { event: 'patch', data: { sessions: [{ pr: { state: 'open' }, id: 'aaaa1111' }] } });
  assert.ok(timers.pending().includes(SWEEP_MS), 'and goes on');
});

test('a stream ends after five minutes, for the browser to open it again signed in afresh, and all end at the stop', async () => {
  const { live, open, timers, advance } = setup([{ id: 'aaaa1111', state: 'done' }]);
  const old = open();
  advance(MAX_AGE_MS);
  const fresh = open();
  timers.run(SWEEP_MS);
  await live.settled();
  assert.equal(old.ended, true);
  assert.equal(fresh.ended, false);
  assert.equal(live.open(), 1);
  live.closeAll();
  assert.equal(fresh.ended, true);
  assert.equal(live.open(), 0);
  assert.deepEqual(timers.pending(), [], 'nothing keeps running');
});

test('a page that went is not written to again', async () => {
  const sessions = [{ id: 'aaaa1111', state: 'done' }];
  const { live, open, timers, changed } = setup(sessions);
  const res = open();
  res.emit('close');
  assert.equal(live.open(), 0);
  sessions[0].state = 'working';
  changed();
  timers.run(DEBOUNCE_MS);
  await live.settled();
  assert.equal(res.events().length, 1);
});

test('a stream whose sign-in no longer lets it in gets nothing more, and ends', async () => {
  const sessions = [{ id: 'aaaa1111', state: 'done' }];
  const { live, open, timers, changed } = setup(sessions);
  let member = true;
  const res = open('joel', { stillAllowed: async () => member });
  member = false;
  sessions[0].state = 'working';
  changed();
  timers.run(DEBOUNCE_MS);
  await live.settled();
  assert.equal(res.events().length, 1, 'only the list it had when it was let in');
  assert.equal(res.ended, true);
  assert.equal(live.open(), 0);
});
