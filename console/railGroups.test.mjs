// The rail's groups (session.js, W.railGroups): the sessions started as pieces of another's work, under it on Mine.
// Read from public/common.js the way a page loads it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function loadCommon() {
  const window = { WoodshedLogins: require('./public/logins.cjs'), WoodshedSetup: require('./public/setupSteps.cjs') };
  const context = vm.createContext({
    window, console,
    document: { addEventListener() {}, createElement: () => ({}) },
    matchMedia: () => ({}),
    fetch: () => new Promise(() => {}),
  });
  vm.runInContext(fs.readFileSync(new URL('./public/common.js', import.meta.url), 'utf8'), context);
  return window.Woodshed;
}

const W = loadCommon();
const at = (n) => new Date(Date.UTC(2026, 10, 24, 12, n)).toISOString();
const mine = (id, extra = {}) => ({ id, title: id, kind: 'task', owner: 'me', status: 'running', state: 'working', createdAt: at(0), ...extra });
// The page's arrays and objects are another realm's: copied here before they are compared.
const ids = (list) => Array.from(list, (s) => s.id);

test('a piece of a live session\'s work nests under it, needing you first, then live, then newest', () => {
  const main = mine('main');
  const listed = [
    main,
    mine('done', { startedFrom: 'main', state: 'done', createdAt: at(1) }),
    mine('asks', { startedFrom: 'main', state: 'needs-you', createdAt: at(2) }),
    mine('stopped', { startedFrom: 'main', status: 'stopped', state: null, createdAt: at(3) }),
    mine('newer', { startedFrom: 'main', state: 'working', createdAt: at(4) }),
    mine('apart', { startedFrom: 'main', startedApart: true }),
    mine('alone'),
  ];
  const g = W.railGroups(listed);
  assert.deepEqual(ids(g.top), ['main', 'apart', 'alone'], 'a separate session and one nobody started stay at the top');
  assert.deepEqual(ids(g.kids.get('main')), ['asks', 'newer', 'done', 'stopped']);
  assert.equal(W.needsYou(listed[1]), true, 'the console\'s needsYou counts a live session that is done');
  assert.equal(W.asksPerson(listed[1]), false, 'a group does not: a finished piece is no call for the person');
  assert.equal(g.parentOf.get('asks').id, 'main');
  assert.deepEqual(JSON.parse(JSON.stringify(W.groupCounts('main', g.kids))), { count: 4, needs: 1 });
});

test('groups nest all the way down, and the counts with them', () => {
  const g = W.railGroups([mine('a'), mine('b', { startedFrom: 'a' }), mine('c', { startedFrom: 'b', state: 'needs-you' })]);
  assert.deepEqual(ids(g.top), ['a']);
  assert.deepEqual(ids(g.kids.get('b')), ['c']);
  assert.deepEqual(JSON.parse(JSON.stringify(W.groupCounts('a', g.kids))), { count: 2, needs: 1 });
});

test('no group under a stopped session, another person\'s, one not listed, or a loop', () => {
  const stoppedMain = W.railGroups([mine('m', { status: 'stopped', state: null }), mine('k', { startedFrom: 'm' })]);
  assert.deepEqual(ids(stoppedMain.top), ['m', 'k'], 'a live session never hides under a stopped one');
  const other = W.railGroups([mine('m', { owner: 'ana' }), mine('k', { startedFrom: 'm' })]);
  assert.deepEqual(ids(other.top), ['m', 'k']);
  const shared = W.railGroups([mine('m', { owner: null }), mine('k', { startedFrom: 'm' })]);
  assert.deepEqual(ids(shared.top), ['m', 'k']);
  const gone = W.railGroups([mine('k', { startedFrom: 'm' })]);
  assert.deepEqual(ids(gone.top), ['k']);
  const loop = W.railGroups([mine('x', { startedFrom: 'y' }), mine('y', { startedFrom: 'x' })]);
  assert.deepEqual(ids(loop.top).sort(), ['x', 'y'], 'neither of a loop nests');
});

test('a session that asked its starter a question reads as asking its person, and counts so in its group', () => {
  const asked = mine('asked', { startedFrom: 'main', state: 'done', askedAt: at(5) });
  const st = W.displayStatus(asked);
  assert.deepEqual([st.key, st.word], ['needs-you', 'asked a question']);
  assert.equal(W.asksPerson(asked), true);
  const g = W.railGroups([mine('main'), mine('plain', { startedFrom: 'main', state: 'done', createdAt: at(9) }), asked]);
  assert.deepEqual(ids(g.kids.get('main')), ['asked', 'plain']);
  assert.deepEqual(JSON.parse(JSON.stringify(W.groupCounts('main', g.kids))), { count: 2, needs: 1 });
  assert.equal(W.displayStatus(mine('working', { askedAt: at(5), state: 'working' })).key, 'working', 'at work again, it is working');
});

test('Details lists a session\'s messages newest first, naming a session no longer on the list', () => {
  const s = mine('main', { messages: [
    { at: at(3), dir: 'in', with: 'kid', question: true, text: 'Developers or customers?' },
    { at: at(2), dir: 'out', with: 'gone', question: false, text: 'Use cents.' },
  ] });
  const lines = JSON.parse(JSON.stringify(W.messageLines(s, [s, mine('kid', { title: 'README summary' })])));
  assert.deepEqual(lines.map((m) => [m.dir, m.question, m.other.title, m.text]), [
    ['in', true, 'README summary', 'Developers or customers?'],
    ['out', false, 'a session no longer on the list', 'Use cents.'],
  ]);
  assert.equal(lines[1].other.id, null);
  assert.equal(JSON.parse(JSON.stringify(W.messageLines(mine('u', { messages: [{ at: at(1), dir: 'out', with: 'x', unconfirmed: true, text: 'Maybe.' }] }), [])))[0].unconfirmed, true);
});
