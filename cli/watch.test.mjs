import { test } from 'node:test';
import assert from 'node:assert/strict';

import { kindOf } from './sessions.mjs';
import { changes, endOf, eventDetail, herdrClear, herdrRecord, parseEvery, parseKinds, phaseOf } from './watch.mjs';

const fail = (message) => new Error(message);

test('phaseOf reads a session as the page words it', () => {
  assert.equal(phaseOf({ status: 'queued', owner: 'mia' }), 'pending');
  assert.equal(phaseOf({ status: 'starting' }), 'pending');
  assert.equal(phaseOf({ status: 'running', state: 'starting' }), 'working');
  assert.equal(phaseOf({ status: 'running', state: 'working' }), 'working');
  assert.equal(phaseOf({ status: 'running', state: 'needs-you' }), 'needs-you');
  assert.equal(phaseOf({ status: 'running', state: 'done' }), 'done');
  assert.equal(phaseOf({ status: 'running', state: null }), 'done', 'its agent exited: it waits for a message');
  assert.equal(phaseOf({ status: 'stopping' }), 'stopping');
  assert.equal(phaseOf({ status: 'failed' }), 'failed');
  assert.equal(phaseOf({ status: 'stopped', owner: 'mia', stopReason: 'did not start in time' }), 'failed');
  assert.equal(phaseOf({ status: 'stopped', owner: 'mia', stopReason: 'idle for 2 h' }), 'ended');
  assert.equal(phaseOf({ status: 'stopped', kept: true, prClosedAt: 'x', prMerged: true }), 'ended');
});

test('changes tells nothing on the first read, and each move into a phase that matters once', () => {
  const review = { id: 'r', trigger: 'review', review: {}, status: 'running', state: 'working' };
  const work = { id: 'w', owner: 'mia', status: 'running', state: 'working' };
  const first = changes(null, [review, work], { kindOf });
  assert.deepEqual(first.events, []);
  const second = changes(first.phases, [{ ...review, state: 'done' }, { ...work, state: 'done' }], { kindOf });
  assert.deepEqual(second.events.map((e) => [e.event, e.session.id]), [['done', 'w']], 'a review\'s turn is its own');
  const third = changes(second.phases, [{ ...review, status: 'stopping' }, { ...work, state: 'done' }], { kindOf });
  assert.deepEqual(third.events, [], 'stopping is not yet finished, and nothing moved for the other');
  const fourth = changes(third.phases, [{ ...review, status: 'stopped', review: { conclusion: 'APPROVE', reported: true } }], { kindOf });
  assert.deepEqual(fourth.events.map((e) => e.event), ['finished']);
  // One that appeared and failed between two reads, and one already ended when first seen after the first read.
  const fifth = changes(fourth.phases, [{ id: 'n', status: 'failed' }, { id: 'o', status: 'stopped', kept: false }], { kindOf });
  assert.deepEqual(fifth.events.map((e) => [e.event, e.why ?? null, e.session.id]), [['failed', null, 'n'], ['stopped', 'other', 'o']]);
  // Straight from in line to needing its person: it started, and needs them.
  const sixth = changes(new Map([['q', 'pending']]), [{ id: 'q', status: 'running', state: 'needs-you' }], { kindOf });
  assert.deepEqual(sixth.events.map((e) => e.event), ['started', 'needs-you']);
});

test('--kind and --every are checked', () => {
  assert.equal(parseKinds(undefined, fail), null);
  assert.deepEqual([...parseKinds('Review, qa', fail)], ['review', 'qa']);
  assert.throws(() => parseKinds(',', fail), /--kind takes/);
  assert.equal(parseEvery(undefined, fail), 15_000);
  assert.equal(parseEvery('5', fail), 5000);
  assert.throws(() => parseEvery('601', fail), /from 5 to 600/);
  assert.throws(() => parseEvery('soon', fail), /from 5 to 600/);
});

test('endOf tells an idle pause, a stop at its lifetime or by a person, and a finish apart', () => {
  const mine = { owner: 'mia', status: 'stopped' };
  assert.deepEqual(endOf({ ...mine, stopReason: 'idle for 2 h' }, 'private'), { event: 'paused', why: 'idle' });
  assert.deepEqual(endOf({ ...mine, stopReason: 'ran for 12 h' }, 'private'), { event: 'stopped', why: 'lifetime' });
  assert.deepEqual(endOf({ ...mine, stopReason: 'idle for 2 h', stoppedBy: 'mia' }, 'private'), { event: 'stopped', why: 'person' },
    'one paused and then stopped by its person is theirs');
  assert.deepEqual(endOf({ ...mine, stopReason: 'posted to Slack' }, 'private'), { event: 'finished', why: 'posted' });
  assert.deepEqual(endOf({ status: 'stopped', kept: true, prClosedAt: 'x', prMerged: true }, 'shared'), { event: 'finished', why: 'merged' });
  assert.deepEqual(endOf({ status: 'stopped', kept: true, prClosedAt: 'x' }, 'shared'), { event: 'finished', why: 'closed' });
  assert.deepEqual(endOf({ status: 'stopped', stopReason: 'Review finished: APPROVE', review: { conclusion: 'APPROVE', reported: true } }, 'review'), { event: 'finished', why: 'reported' });
  assert.deepEqual(endOf({ status: 'stopped', stoppedBy: 'mia', stopReason: 'stopped by @mia', review: { base: 'main' } }, 'review'), { event: 'stopped', why: 'person' },
    'a review stopped before it reported is no finish');
  assert.deepEqual(endOf({ status: 'stopped', kept: true, qa: {}, stopReason: 'ran for 12 h' }, 'qa'), { event: 'stopped', why: 'lifetime' });
  assert.deepEqual(endOf({ status: 'stopped', kept: true, slackPostedAt: 'x', stopReason: 'idle for 2 h' }, 'shared'), { event: 'paused', why: 'idle' },
    'posted to Slack on an earlier run, resumed since: this stop is its idle pause');
  assert.deepEqual(endOf({ status: 'stopped', kept: true, stopReason: 'idle for 4 h' }, 'shared'), { event: 'paused', why: 'idle' });
  assert.deepEqual(endOf({ status: 'stopped', cleanedAt: 'x' }, 'shared'), { event: 'stopped', why: 'deleted' });
  assert.deepEqual(endOf({ ...mine, stopReason: 'container exited' }, 'private'), { event: 'stopped', why: 'other' });
});

test('changes tells a private session\'s whole life: in line, running, its turns, a pause, a resume, its lifetime', () => {
  const s = { id: 'p', owner: 'mia' };
  const reads = [
    [{ ...s, status: 'running', state: 'working' }],
    [{ ...s, status: 'running', state: 'done' }],
    [{ ...s, status: 'stopping' }],
    [{ ...s, status: 'stopped', stopReason: 'idle for 2 h' }],
    [{ ...s, status: 'queued' }],
    [{ ...s, status: 'starting' }],
    [{ ...s, status: 'running', state: 'needs-you' }],
    [{ ...s, status: 'stopped', stopReason: 'ran for 12 h' }],
    [{ ...s, status: 'queued' }, { id: 'n', owner: 'mia', status: 'queued' }],
    [{ ...s, status: 'failed', error: 'no machine' }, { id: 'n', owner: 'mia', status: 'running', state: 'working' }],
  ];
  let phases = null;
  const told = [];
  for (const read of reads) {
    const out = changes(phases, read, { kindOf: () => 'private' });
    phases = out.phases;
    told.push(out.events.map((e) => `${e.session.id} ${e.event}${e.why ? ` ${e.why}` : ''}`));
  }
  assert.deepEqual(told, [
    [], // the first read only learns
    ['p done'],
    [],
    ['p paused idle'],
    ['p starting'],
    [], // starting, from in line: still on its way
    ['p started', 'p needs-you'],
    ['p stopped lifetime'],
    ['p starting', 'n starting'], // a new one seen in line
    ['p failed', 'n started'],
  ]);
});

const decode = (record) => Object.fromEntries(/^\x1b\]7501;(.*)\x07$/.exec(record)[1].split(':').map((pair) => {
  const [key, value] = pair.split(/=(.*)/s);
  return [key, ['title', 'msg'].includes(key) ? Buffer.from(value, 'base64').toString('utf8') : value];
}));

test('a Herdr record is one per session, in hc\'s own syntax, its words in base64, and says how to bring a machine back', () => {
  const x = { id: 'aaaa0001', kind: 'private', title: 'Fix the login: redirect loop', url: 'https://c.example/s/aaaa0001', stateWord: 'paused', verdict: null };
  assert.deepEqual(decode(herdrRecord({ event: 'paused', why: 'idle' }, x, { machine: 'woodshed-aaaa0001' })), {
    id: 'aaaa0001', state: 'done', app: 'woodshed', title: 'Fix the login: redirect loop',
    msg: 'aaaa0001 paused (idle). woodshed-aaaa0001 in Herdr is unreachable until it runs again: woodshed session herdr aaaa0001 brings it back',
  }, 'a colon in the title is no separator once it is base64');
  assert.deepEqual(decode(herdrRecord({ event: 'stopped', why: 'lifetime' }, x)).msg, 'aaaa0001 stopped (at its lifetime)', 'no machine, nothing said of one');
  const asks = decode(herdrRecord({ event: 'needs-you' }, x));
  assert.deepEqual([asks.state, asks.kind, asks.msg], ['blocked', 'question', 'aaaa0001 needs-you. https://c.example/s/aaaa0001']);
  assert.equal(decode(herdrRecord({ event: 'failed' }, { ...x, error: 'no room' })).state, 'error');
  assert.equal(decode(herdrRecord({ event: 'started' }, x)).state, 'working');
  assert.equal(decode(herdrRecord({ event: 'done' }, x)).state, 'done');
  assert.equal(decode(herdrRecord({ event: 'needs-you' }, { ...x, title: null })).title, 'private aaaa0001');
  const long = decode(herdrRecord({ event: 'failed' }, { ...x, title: 'é'.repeat(500), error: 'x'.repeat(2000) }));
  assert.equal(long.title.length, 80);
  assert.ok(long.msg.length <= 300);
  assert.equal(herdrClear('aaaa0001'), '\x1b]7501;id=aaaa0001:state=clear\x07');
});

test('eventDetail says a verdict, why it ended, or why it failed', () => {
  const x = { verdict: null, stateWord: 'merged', error: null, stopReason: null, stoppedBy: 'mia' };
  assert.equal(eventDetail({ event: 'finished', why: 'merged' }, x), 'merged');
  assert.equal(eventDetail({ event: 'finished', why: 'reported' }, { ...x, verdict: 'APPROVE' }), 'APPROVE');
  assert.equal(eventDetail({ event: 'stopped', why: 'person' }, x), 'by @mia');
  assert.equal(eventDetail({ event: 'stopped', why: 'other' }, { ...x, stopReason: 'container exited' }), 'container exited');
  assert.equal(eventDetail({ event: 'started' }, x), null);
});

test('changes tells a merge, a close or a delete marked on a session that had already ended, once', () => {
  const s = { id: 'k', owner: null, kept: true, status: 'stopped', stopReason: 'idle for 4 h' };
  let { phases } = changes(null, [s], { kindOf: () => 'shared' });
  const step = (list) => {
    const out = changes(phases, list, { kindOf: () => 'shared' });
    phases = out.phases;
    return out.events.map((e) => `${e.session.id} ${e.event} ${e.why ?? ''}`.trim());
  };
  assert.deepEqual(step([s]), []);
  assert.deepEqual(step([{ ...s, prClosedAt: 'x', prMerged: true }]), ['k finished merged'], 'its pull request merged after it stopped');
  assert.deepEqual(step([{ ...s, prClosedAt: 'x', prMerged: true }]), [], 'told once');
  assert.deepEqual(step([{ ...s, id: 'k2', cleanedAt: 'x' }, { ...s, prClosedAt: 'x', prMerged: true }]), ['k2 paused idle'], 'one first seen already ended is told as before, from its stop');
  assert.deepEqual(step([{ ...s, id: 'k2', cleanedAt: 'x' }, { ...s, prClosedAt: 'x', prMerged: true, cleanedAt: 'y' }]), [], 'merged wins over deleted: nothing new');
  const c = { id: 'c', owner: null, kept: true, status: 'stopped', stopReason: 'idle for 4 h' };
  ({ phases } = changes(null, [c], { kindOf: () => 'shared' }));
  assert.deepEqual(step([{ ...c, cleanedAt: 'x' }]), ['c stopped deleted'], 'Delete now on a stopped session');
  assert.deepEqual(step([{ ...c, id: 'c' }]), [], 'a mark that goes is nothing to tell');
});

test('back at work after a question or a turn is a quiet event, for Herdr\'s record alone', () => {
  const s = { id: 'q', owner: 'mia', status: 'running', state: 'needs-you' };
  const { phases } = changes(null, [s], { kindOf: () => 'private' });
  const { events, phases: next } = changes(phases, [{ ...s, state: 'working' }], { kindOf: () => 'private' });
  assert.deepEqual(events.map((e) => [e.event, e.quiet]), [['working', true]]);
  assert.deepEqual(changes(next, [{ ...s, state: 'done' }], { kindOf: () => 'private' }).events.map((e) => [e.event, e.quiet ?? false]), [['done', false]]);
  assert.equal(decode(herdrRecord({ event: 'working', quiet: true }, { id: 'q', kind: 'private', title: 'T', url: 'u' })).state, 'working');
  assert.deepEqual(changes(new Map([['r', 'needs-you']]), [{ id: 'r', trigger: 'review', review: {}, status: 'running', state: 'working' }], { kindOf: () => 'review' }).events.map((e) => e.event), ['working'],
    'a bare phase from an older map is still read');
});
