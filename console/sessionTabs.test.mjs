import { test } from 'node:test';
import assert from 'node:assert/strict';

import tabs from './public/sessionTabs.cjs';

// sessionStorage, as a browser tab has it.
function storage(initial = {}) {
  const items = { ...initial };
  return { items, getItem: (k) => (k in items ? items[k] : null), setItem: (k, v) => { items[k] = String(v); } };
}

test('a session reopens on the tab it was last left on, and the address wins over it', () => {
  const store = storage();
  const memory = tabs.memory(store, 'octocat');
  assert.equal(memory.asked('aaaa1111', null), null, 'nothing kept yet: the page decides (Agent, or Review for a review)');
  memory.remember('aaaa1111', 'review');
  memory.remember('bbbb2222', 'diff');
  assert.equal(memory.asked('aaaa1111', null), 'review', 'back from another session through the rail');
  assert.equal(memory.asked('bbbb2222', null), 'diff');
  assert.equal(memory.asked('aaaa1111', 'agent'), 'agent', '?tab=agent asks for Agent itself');
  assert.equal(memory.asked('aaaa1111', 'terminal'), 'terminal');
  assert.equal(memory.asked(null, null), null, 'not a session page');

  const reloaded = tabs.memory(store, 'octocat');
  assert.equal(reloaded.asked('aaaa1111', null), 'review', 'a reload of the browser tab keeps it');
});

test("another login reads none of what was kept, and its own choices replace it", () => {
  const store = storage();
  tabs.memory(store, 'octocat').remember('aaaa1111', 'review');
  const other = tabs.memory(store, 'hubot');
  assert.equal(other.asked('aaaa1111', null), null, "octocat's private session is not hubot's to see");
  other.remember('cccc3333', 'terminal');
  assert.doesNotMatch(store.items[tabs.KEY], /aaaa1111/, "hubot's write drops octocat's sessions");
  assert.equal(tabs.memory(store, 'octocat').asked('aaaa1111', null), null);
});

test('storage that is broken, missing or throws keeps nothing and breaks nothing', () => {
  for (const store of [
    storage({ [tabs.KEY]: 'not json' }),
    storage({ [tabs.KEY]: '{"aaaa1111":"review"}' }),
    { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } },
  ]) {
    const memory = tabs.memory(store, 'octocat');
    assert.equal(memory.asked('aaaa1111', null), null);
    memory.remember('aaaa1111', 'diff');
  }
});

test('a tab the page does not know is Agent', () => {
  assert.equal(tabs.known('review'), 'review');
  assert.equal(tabs.known('applog'), 'applog');
  for (const name of [null, undefined, '', 'nonsense', '__proto__']) assert.equal(tabs.known(name), 'agent');
});

test('a remembered tab the session cannot show now falls back to Agent', () => {
  const running = { status: 'running', branch: 'woodshed/x' };
  const stopped = { status: 'stopped', branch: 'woodshed/x' };
  assert.equal(tabs.shown('diff', running, true), 'diff');
  assert.equal(tabs.shown('diff', stopped, true), 'agent', 'a stopped session has no checkout to diff');
  assert.equal(tabs.shown('applog', stopped, true), 'agent');
  assert.equal(tabs.shown('diff', { ...running, kind: 'ask' }, true), 'agent', 'a question has no diff');
  assert.equal(tabs.shown('review', stopped, false), 'review', 'a stopped session with a branch keeps its review');
  assert.equal(tabs.shown('review', { status: 'running' }, true), 'agent', 'no branch, no review');
  assert.equal(tabs.shown('terminal', running, false), 'agent', 'no shell');
  assert.equal(tabs.shown('terminal', running, true), 'terminal');
});

test('a tab the kept snapshot cannot show is held until the route\'s lookup answers, then shown if it can be', () => {
  const starting = { status: 'starting', branch: 'woodshed/x' };
  const running = { status: 'running', branch: 'woodshed/x' };
  // A reload of ?tab=diff: the rail draws from the snapshot kept in the browser tab, where the session was starting.
  let at = tabs.settle({ tab: 'diff', held: null, pending: true, s: starting, hasShell: true });
  assert.deepEqual(at, { tab: 'agent', held: 'diff', fellBack: false }, 'Agent meanwhile, Diff held, nothing rewritten');
  // Another render before the answer (a timer, the rail) keeps holding it.
  at = tabs.settle({ tab: at.tab, held: at.held, pending: true, s: starting, hasShell: true });
  assert.deepEqual(at, { tab: 'agent', held: 'diff', fellBack: false });
  // The answer: the session runs, so Diff shows.
  at = tabs.settle({ tab: at.tab, held: at.held, pending: false, s: running, hasShell: true });
  assert.deepEqual(at, { tab: 'diff', held: null, fellBack: false });
});

test('once the route\'s lookup answers, a tab the session cannot show falls back to Agent for good', () => {
  const stopped = { status: 'stopped', branch: 'woodshed/x' };
  let at = tabs.settle({ tab: 'diff', held: null, pending: true, s: stopped, hasShell: false });
  assert.deepEqual(at, { tab: 'agent', held: 'diff', fellBack: false });
  at = tabs.settle({ tab: at.tab, held: at.held, pending: false, s: stopped, hasShell: false });
  assert.deepEqual(at, { tab: 'agent', held: null, fellBack: true }, 'the page then drops ?tab and remembers Agent');
  // Moving between sessions: the list is the last answer, the lookup pending, and it can show the tab already.
  assert.deepEqual(tabs.settle({ tab: 'review', held: null, pending: true, s: stopped, hasShell: false }),
    { tab: 'review', held: null, fellBack: false });
  assert.deepEqual(tabs.settle({ tab: 'diff', held: null, pending: false, s: stopped, hasShell: false }),
    { tab: 'agent', held: null, fellBack: true }, 'with the answer in, at once');
});

test('a failed lookup confirms nothing: the tab stays held until one answers', () => {
  const starting = { status: 'starting', branch: 'woodshed/x' };
  const running = { status: 'running', branch: 'woodshed/x' };
  // The previous page's list has the session starting; the lookup fails, so the page renders that list again, pending.
  let at = tabs.settle({ tab: 'diff', held: null, pending: true, s: starting, hasShell: true });
  at = tabs.settle({ tab: at.tab, held: at.held, pending: true, s: starting, hasShell: true });
  assert.deepEqual(at, { tab: 'agent', held: 'diff', fellBack: false }, 'nothing erased on the failure');
  at = tabs.settle({ tab: at.tab, held: at.held, pending: false, s: running, hasShell: true });
  assert.deepEqual(at, { tab: 'diff', held: null, fellBack: false }, 'the retry that answers shows Diff');
});

test('clicking the tab already showing is a choice when it stands in for another', () => {
  assert.equal(tabs.picks({ tab: 'agent', next: 'review', held: null, landOnReview: false }), true, 'another tab');
  assert.equal(tabs.picks({ tab: 'agent', next: 'agent', held: null, landOnReview: false }), false, 'nothing to change');
  assert.equal(tabs.picks({ tab: 'agent', next: 'agent', held: 'diff', landOnReview: false }), true,
    'Agent while Diff is held for the lookup: Agent replaces it');
  assert.equal(tabs.picks({ tab: 'agent', next: 'agent', held: null, landOnReview: true }), true,
    'Agent on a starting review-only session: it no longer switches to Review once it runs');
});

test('an answer to an older lookup that lands after a newer one is stale', () => {
  const order = tabs.lookups();
  const opening = order.start(); // the move's lookup, which saw the session starting
  const poll = order.start(); // the poll's, which sees it running
  assert.equal(order.fresh(poll), true, 'the newer answer lands first and is applied');
  assert.equal(order.fresh(opening), false, 'the older one, landing after, is dropped');
  const next = order.start();
  assert.equal(order.fresh(next), true);
  // In order, every answer is applied.
  const inOrder = tabs.lookups();
  const a = inOrder.start();
  const b = inOrder.start();
  assert.equal(inOrder.fresh(a), true);
  assert.equal(inOrder.fresh(b), true);
});

test('out of order answers never confirm a fallback on the older state', () => {
  const running = { status: 'running', branch: 'woodshed/x' };
  const order = tabs.lookups();
  const opening = order.start();
  const poll = order.start();
  // The poll's answer (running) lands first: Diff shows.
  let at = tabs.settle({ tab: 'agent', held: 'diff', pending: !order.fresh(poll), s: running, hasShell: true });
  assert.deepEqual(at, { tab: 'diff', held: null, fellBack: false });
  // The opening one (starting) lands after: dropped, so the page renders nothing new from it and Diff stands.
  assert.equal(order.fresh(opening), false);
});
