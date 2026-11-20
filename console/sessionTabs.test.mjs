import { test } from 'node:test';
import assert from 'node:assert/strict';

import tabs from './public/sessionTabs.cjs';

// sessionStorage, as a browser tab has it.
function storage(initial = {}) {
  const items = { ...initial };
  return {
    items,
    getItem: (k) => (k in items ? items[k] : null),
    setItem: (k, v) => { items[k] = String(v); },
    removeItem: (k) => { delete items[k]; },
  };
}

test('a session reopens on the tab it was last left on, and the address wins over it', () => {
  const store = storage();
  const memory = tabs.memory(store, 'octocat');
  assert.equal(memory.asked('aaaa1111', null), null, 'nothing kept yet: the page decides (TUI, or Review for a review)');
  memory.remember('aaaa1111', 'review');
  memory.remember('bbbb2222', 'diff');
  assert.equal(memory.asked('aaaa1111', null), 'review', 'back from another session through the rail');
  assert.equal(memory.asked('bbbb2222', null), 'diff');
  assert.equal(memory.asked('aaaa1111', 'tui'), 'tui', '?tab=agent asks for TUI itself');
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

test('a tab the page does not know is Chat, the default, and agent is TUI\'s old name', () => {
  assert.equal(tabs.known('review'), 'review');
  assert.equal(tabs.known('applog'), 'applog');
  assert.equal(tabs.known('chat'), 'chat');
  assert.equal(tabs.known('tui'), 'tui');
  assert.equal(tabs.known('agent'), 'tui', 'an old link, or a tab remembered before the rename');
  for (const name of [null, undefined, '', 'nonsense', '__proto__', 'constructor']) assert.equal(tabs.known(name), 'chat');
  // A tab remembered as agent before the rename reads as TUI.
  const store = storage({ [tabs.KEY]: JSON.stringify({ login: 'octocat', tabs: { aaaa1111: 'agent' } }) });
  assert.equal(tabs.memory(store, 'octocat').asked('aaaa1111', null, null), 'tui');
});

test('a remembered tab the session cannot show now falls back to TUI', () => {
  const running = { status: 'running', branch: 'woodshed/x' };
  const stopped = { status: 'stopped', branch: 'woodshed/x' };
  assert.equal(tabs.shown('diff', running, true), 'diff');
  assert.equal(tabs.shown('diff', stopped, true), 'tui', 'a stopped session has no checkout to diff');
  assert.equal(tabs.shown('applog', stopped, true), 'tui');
  assert.equal(tabs.shown('diff', { ...running, kind: 'ask' }, true), 'tui', 'a question has no diff');
  assert.equal(tabs.shown('review', stopped, false), 'review', 'a stopped session with a branch keeps its review');
  assert.equal(tabs.shown('review', { status: 'running' }, true), 'diff', 'no branch: Review\'s other view, as the bar\'s tab opens');
  assert.equal(tabs.shown('review', { status: 'stopped' }, true), 'tui', 'no branch and no checkout to diff');
  assert.equal(tabs.shown('review', { status: 'running', kind: 'ask' }, true), 'tui', 'a question has neither');
  assert.equal(tabs.shown('terminal', running, false), 'applog', 'no shell: Terminal\'s other view, as the bar\'s tab opens');
  assert.equal(tabs.shown('terminal', stopped, false), 'tui', 'no shell and no app running');
  assert.equal(tabs.shown('terminal', running, true), 'terminal');
});

test('a tab the kept snapshot cannot show is held until the route\'s lookup answers, then shown if it can be', () => {
  const starting = { status: 'starting', branch: 'woodshed/x' };
  const running = { status: 'running', branch: 'woodshed/x' };
  // A reload of ?tab=diff: the rail draws from the snapshot kept in the browser tab, where the session was starting.
  let at = tabs.settle({ tab: 'diff', held: null, pending: true, s: starting, hasShell: true });
  assert.deepEqual(at, { tab: 'tui', held: 'diff', fellBack: false }, 'TUI meanwhile, Diff held, nothing rewritten');
  // Another render before the answer (a timer, the rail) keeps holding it.
  at = tabs.settle({ tab: at.tab, held: at.held, pending: true, s: starting, hasShell: true });
  assert.deepEqual(at, { tab: 'tui', held: 'diff', fellBack: false });
  // The answer: the session runs, so Diff shows.
  at = tabs.settle({ tab: at.tab, held: at.held, pending: false, s: running, hasShell: true });
  assert.deepEqual(at, { tab: 'diff', held: null, fellBack: false });
});

test('once the route\'s lookup answers, a tab the session cannot show falls back to TUI for good', () => {
  const stopped = { status: 'stopped', branch: 'woodshed/x' };
  let at = tabs.settle({ tab: 'diff', held: null, pending: true, s: stopped, hasShell: false });
  assert.deepEqual(at, { tab: 'tui', held: 'diff', fellBack: false });
  at = tabs.settle({ tab: at.tab, held: at.held, pending: false, s: stopped, hasShell: false });
  assert.deepEqual(at, { tab: 'tui', held: null, fellBack: true }, 'the page then drops ?tab and remembers TUI');
  // Moving between sessions: the list is the last answer, the lookup pending, and it can show the tab already.
  assert.deepEqual(tabs.settle({ tab: 'review', held: null, pending: true, s: stopped, hasShell: false }),
    { tab: 'review', held: null, fellBack: false });
  assert.deepEqual(tabs.settle({ tab: 'diff', held: null, pending: false, s: stopped, hasShell: false }),
    { tab: 'tui', held: null, fellBack: true }, 'with the answer in, at once');
});

test('a failed lookup confirms nothing: the tab stays held until one answers', () => {
  const starting = { status: 'starting', branch: 'woodshed/x' };
  const running = { status: 'running', branch: 'woodshed/x' };
  // The previous page's list has the session starting; the lookup fails, so the page renders that list again, pending.
  let at = tabs.settle({ tab: 'diff', held: null, pending: true, s: starting, hasShell: true });
  at = tabs.settle({ tab: at.tab, held: at.held, pending: true, s: starting, hasShell: true });
  assert.deepEqual(at, { tab: 'tui', held: 'diff', fellBack: false }, 'nothing erased on the failure');
  at = tabs.settle({ tab: at.tab, held: at.held, pending: false, s: running, hasShell: true });
  assert.deepEqual(at, { tab: 'diff', held: null, fellBack: false }, 'the retry that answers shows Diff');
});

test('clicking the tab already showing is a choice when it stands in for another', () => {
  assert.equal(tabs.picks({ tab: 'tui', next: 'review', held: null, landOnReview: false }), true, 'another tab');
  assert.equal(tabs.picks({ tab: 'tui', next: 'tui', held: null, landOnReview: false }), false, 'nothing to change');
  assert.equal(tabs.picks({ tab: 'tui', next: 'tui', held: 'diff', landOnReview: false }), true,
    'TUI while Diff is held for the lookup: TUI replaces it');
  assert.equal(tabs.picks({ tab: 'tui', next: 'tui', held: null, landOnReview: true }), true,
    'TUI on a starting review-only session: it no longer switches to Review once it runs');
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
  let at = tabs.settle({ tab: 'tui', held: 'diff', pending: !order.fresh(poll), s: running, hasShell: true });
  assert.deepEqual(at, { tab: 'diff', held: null, fellBack: false });
  // The opening one (starting) lands after: dropped, so the page renders nothing new from it and Diff stands.
  assert.equal(order.fresh(opening), false);
});

test('a newer lookup that failed does not make an older answer stale', () => {
  const order = tabs.lookups();
  const opening = order.start(); // the move's lookup, still in flight
  const poll = order.start(); // the poll's, which fails first
  assert.equal(order.stale(poll), false, 'the failure is not stale, so the page shows its error state as before');
  assert.equal(order.fresh(opening), true, 'the opening answer that comes back after it still applies');
  // A failure older than an applied answer is dropped.
  const late = order.start();
  const newer = order.start();
  assert.equal(order.fresh(newer), true);
  assert.equal(order.stale(late), true);
});

test('Back to an entry gives the tab it showed, over what the session was left on since', () => {
  const memory = tabs.memory(storage(), 'octocat');
  // On TUI at the bare /s/<id>; the palette's Open the diff pushes ?tab=diff, which is remembered.
  memory.remember('aaaa1111', 'diff');
  assert.equal(memory.asked('aaaa1111', null, 'tui'), 'tui', 'Back: the entry left on TUI');
  assert.equal(memory.asked('aaaa1111', 'diff', 'tui'), 'diff', 'the address wins over the entry');
  assert.equal(memory.asked('aaaa1111', null, null), 'diff', 'a new entry (the rail) has none: the memory');
  assert.equal(memory.asked(null, null, 'diff'), null, 'not a session page');
});

test('an entry keeps the tab it shows, and none while a review-only session is still to land on Review', () => {
  assert.equal(tabs.leftOn({ tab: 'diff', held: null, reviewPending: false }), 'diff');
  assert.equal(tabs.leftOn({ tab: 'tui', held: null, reviewPending: false }), 'tui',
    'a regular session on TUI, picked or not: Back after Open the diff comes back to TUI');
  assert.equal(tabs.leftOn({ tab: 'tui', held: 'diff', reviewPending: false }), 'diff', 'the held tab, not its stand-in');
  assert.equal(tabs.leftOn({ tab: 'tui', held: null, reviewPending: true }), tabs.LANDS_ON_REVIEW,
    'a starting review-only session: coming back lands it on Review once it runs, as TUI was not picked');
  // Back to that entry asks for nothing, so the page lands it on Review again.
  assert.equal(tabs.memory(storage(), 'octocat').asked('aaaa1111', null, tabs.LANDS_ON_REVIEW), null);
});

test('Forward to a visit left by Back gives the tab it showed, though a later pick changed the memory', () => {
  // Nothing kept. Visit A (TUI, stamped as drawn), B, A again (TUI, stamped as drawn); Back twice to the first A,
  // which picks Diff; Forward twice to the second A.
  const memory = tabs.memory(storage(), 'octocat');
  const secondVisit = tabs.leftOn({ tab: 'tui', held: null, reviewPending: false });
  memory.remember('aaaa1111', 'diff');
  assert.equal(memory.asked('aaaa1111', null, secondVisit), 'tui');
});

test('once sign-out starts, a page still answering writes nothing back', () => {
  const store = storage();
  let out = false;
  const memory = tabs.memory(store, 'octocat', () => !out);
  memory.remember('aaaa1111', 'review');
  // Sign out: the form drops the key, and the page is told to write no more.
  delete store.items[tabs.KEY];
  out = true;
  // A lookup lands before the sign-out answer and a fallback remembers TUI.
  memory.remember('aaaa1111', 'tui');
  memory.remember('bbbb2222', 'diff');
  assert.equal(store.items[tabs.KEY], undefined, "the former person's sessions are not put back");
});

test("Back to a review-only visit still to land on Review lands it, though a later visit picked TUI", () => {
  // Empty storage. First visit, starting: nothing picked, the entry keeps LANDS_ON_REVIEW. Another session. Second
  // visit: TUI clicked while it starts, so TUI is remembered. Back twice to the first visit.
  const memory = tabs.memory(storage(), 'octocat');
  const firstVisit = tabs.leftOn({ tab: 'tui', held: null, reviewPending: true });
  memory.remember('aaaa1111', 'tui');
  assert.equal(memory.asked('aaaa1111', null, firstVisit), null, 'nothing asked: the page lands it on Review');
  assert.equal(memory.asked('aaaa1111', 'diff', firstVisit), 'diff', 'an address with a tab still wins');
  assert.equal(memory.asked('aaaa1111', null, null), 'tui', 'a new entry (the rail) gets the memory');
});

test('an entry left before its session was drawn keeps no tab, so Back lands a review-only session on Review', () => {
  // A bare link to a review-only session the cached list lacks; another session clicked before the lookup answers.
  assert.equal(tabs.leftOn({ tab: 'tui', held: null, reviewPending: false, drawn: false }), null, 'nothing stamped');
  assert.equal(tabs.leftOn({ tab: 'tui', held: 'diff', reviewPending: false, drawn: false }), null);
  // Back to it: no entry tab and nothing remembered, so nothing is asked and the page lands it on Review once it runs.
  assert.equal(tabs.memory(storage(), 'octocat').asked('aaaa1111', null, null), null);
});

test("another login's tabs, left by a Sign out in another browser tab, are deleted when read", () => {
  const store = storage();
  tabs.memory(store, 'alice').remember('aaaa1111', 'review');
  // Alice signs out in another browser tab; Bob signs in in this one.
  tabs.memory(store, 'bob');
  assert.equal(store.items[tabs.KEY], undefined, "Alice's private session ids are gone, not just unread");
  // The same login's tabs stay.
  tabs.memory(store, 'bob').remember('bbbb2222', 'diff');
  tabs.memory(store, 'bob');
  assert.match(store.items[tabs.KEY], /bbbb2222/);
});

test('a lookup that answers for another login than the page was drawn for is an account change', () => {
  assert.equal(tabs.otherLogin('alice', 'bob'), true, 'Bob signed in in another browser tab: nothing kept as Alice');
  assert.equal(tabs.otherLogin('alice', 'alice'), false);
  assert.equal(tabs.otherLogin(null, 'bob'), false, 'a page drawn with no sign-in names nobody');
  assert.equal(tabs.otherLogin('alice', undefined), false, 'a console that sends no login');
});

test("a history entry's tab is read back only by the login that drew it", () => {
  // Alice leaves a shared session on TUI at its bare address; Bob signs in in the same browser tab, picks Diff on
  // a later visit, then goes Back to Alice's entry.
  const alices = tabs.withEntryTab(null, 'tui', 'alice');
  assert.equal(tabs.entryTab(alices, 'alice'), 'tui');
  assert.equal(tabs.entryTab(alices, 'bob'), null, "Bob's Back does not take Alice's entry as his choice");
  const bobs = tabs.memory(storage(), 'bob');
  bobs.remember('aaaa1111', 'diff');
  assert.equal(bobs.asked('aaaa1111', null, tabs.entryTab(alices, 'bob')), 'diff', "so Bob's own Diff stands");
  // Older entries kept no login: read by nobody.
  assert.equal(tabs.entryTab({ tab: 'review' }, 'bob'), null);
  assert.equal(tabs.entryTab(null, 'bob'), null);
});

test("on another login's entry, only the ?tab it arrived with still asks", () => {
  // Alice reopened a session from the rail with Review remembered: the page wrote ?tab=review, she followed no link.
  const written = { tab: 'review', login: 'alice', linkedTab: tabs.linkedTab(null, null) };
  assert.equal(tabs.addressTab(written, 'bob', 'review'), null, "Bob's Back: Alice's choice, not a link");
  const bobs = tabs.memory(storage(), 'bob');
  bobs.remember('aaaa1111', 'diff');
  assert.equal(bobs.asked('aaaa1111', tabs.addressTab(written, 'bob', 'review'), tabs.entryTab(written, 'bob')), 'diff');
  // Alice followed a link to ?tab=review: a deep link still opens Review for whoever comes back to it.
  const linked = { tab: 'review', login: 'alice', linkedTab: tabs.linkedTab(null, 'review') };
  assert.equal(tabs.addressTab(linked, 'bob', 'review'), 'review');
  // Alice followed a link to ?tab=diff, then picked Review (the address says review now): Bob still gets the link.
  const linkedThenPicked = { tab: 'review', login: 'alice', linkedTab: 'diff' };
  assert.equal(tabs.addressTab(linkedThenPicked, 'bob', 'review'), 'diff');
  assert.equal(tabs.addressTab(linkedThenPicked, 'bob', null), 'diff', 'or picked TUI, which drops ?tab');
  // The reader's own entries, new ones and older pages' always count as their address says.
  assert.equal(tabs.addressTab(linkedThenPicked, 'alice', 'review'), 'review');
  assert.equal(tabs.addressTab(written, 'alice', 'review'), 'review');
  assert.equal(tabs.addressTab(null, 'bob', 'review'), 'review');
  assert.equal(tabs.addressTab({ tab: 'review' }, 'bob', 'review'), 'review');
  assert.equal(tabs.addressTab(written, 'bob', null), null);
  // An entry keeps the ?tab it arrived with.
  assert.equal(tabs.linkedTab({ linkedTab: 'review', tab: 'diff' }, 'diff'), 'review');
  assert.equal(tabs.linkedTab({ tab: 'diff' }, 'diff'), null);
});

test('the memory takes the tab a session is left on, not one an address arrived with', () => {
  const bobs = tabs.memory(storage(), 'bob');
  bobs.remember('aaaa1111', 'diff');
  // Bob comes back through sign-in to /s/aaaa1111?tab=review (Alice's tab, carried through the server's redirect).
  // The page shows Review; arriving remembers nothing.
  assert.equal(bobs.asked('aaaa1111', 'review', null), 'review');
  assert.equal(bobs.asked('aaaa1111', null, null), 'diff', 'his own Diff still stands');
  // He leaves the session while it shows Review: now it is his.
  const left = tabs.leaving({ tab: 'review', held: null, reviewPending: false, drawn: true });
  assert.equal(left, 'review');
  bobs.remember('aaaa1111', left);
  assert.equal(bobs.asked('aaaa1111', null, null), 'review');
  // Left before it was drawn, or a review-only session still to land on Review: nothing to remember.
  assert.equal(tabs.leaving({ tab: 'tui', held: null, reviewPending: false, drawn: false }), null);
  assert.equal(tabs.leaving({ tab: 'tui', held: null, reviewPending: true, drawn: true }), null);
  // Left while a link's Diff waits for the lookup (TUI standing in): Diff never showed, so the memory keeps its own.
  assert.equal(tabs.leaving({ tab: 'tui', held: 'diff', reviewPending: false, drawn: true }), null, 'a held tab never showed');
  assert.equal(tabs.leftOn({ tab: 'tui', held: 'diff', reviewPending: false, drawn: true }), 'diff', 'its entry keeps it for Back');
});

test('a fallback corrects the memory only when the memory holds the tab that cannot show', () => {
  // Diff remembered; reloaded before the lookup, so the entry asked Diff; the session turns out stopped.
  assert.equal(tabs.correctsMemory('diff', 'diff'), true, 'TUI replaces the remembered Diff, so a fresh visit does not try it again');
  // Review remembered; a link asked Diff on the stopped session: the memory keeps Review.
  assert.equal(tabs.correctsMemory('review', 'diff'), false);
  assert.equal(tabs.correctsMemory(null, 'diff'), false, 'nothing remembered, nothing to correct');
});

test("a page going away puts its tab aside; the next page keeps it unless it is a reload of that visit", () => {
  // Review remembered; a Diff link opened; the page goes away on Diff.
  let store = storage();
  tabs.memory(store, 'local').remember('aaaa1111', 'review');
  tabs.stashLeaving(store, 'local', 'aaaa1111', 'diff');
  // A reload of the visit: nothing is kept, the memory stays Review.
  assert.equal(tabs.takeLeaving(store, 'local', true), null);
  assert.equal(tabs.memory(store, 'local').asked('aaaa1111', null, null), 'review');
  assert.equal(store.items[tabs.LEAVING_KEY], undefined, 'taken once');
  // Left for My settings and back: kept.
  tabs.stashLeaving(store, 'local', 'aaaa1111', 'diff');
  assert.deepEqual(tabs.takeLeaving(store, 'local', false), { id: 'aaaa1111', tab: 'diff' });
  assert.equal(tabs.takeLeaving(store, 'local', false), null, 'only once');
  // Another login's, or something that is not a tab, is dropped.
  store = storage();
  tabs.stashLeaving(store, 'alice', 'aaaa1111', 'diff');
  assert.equal(tabs.takeLeaving(store, 'bob', false), null);
  store = storage({ [tabs.LEAVING_KEY]: '{"login":"bob","id":"aaaa1111","tab":"__proto__"}' });
  assert.equal(tabs.takeLeaving(store, 'bob', false), null);
});

test("this login's own entry shows the tab it showed, over the link its address keeps", () => {
  const memory = tabs.memory(storage(), 'local');
  memory.remember('aaaa1111', 'diff');
  // Opened through ?tab=review, TUI picked: the address keeps the link, the entry says TUI. A reload shows TUI.
  assert.equal(tabs.ask(memory, 'aaaa1111', 'review', 'tui'), 'tui');
  // A new entry (a link followed, the way back through sign-in) has no state: its address asks.
  assert.equal(tabs.ask(memory, 'aaaa1111', 'review', null), 'review');
  // No address, no entry: the memory.
  assert.equal(tabs.ask(memory, 'aaaa1111', null, null), 'diff');
  // An entry still to land on Review asks for nothing.
  assert.equal(tabs.ask(memory, 'aaaa1111', null, tabs.LANDS_ON_REVIEW), null);
});

test('an action naming the address showing opens its tab again when another tab was picked since', () => {
  // ?tab=agent (Resume), Diff picked: the address still says agent. Open the agent asks for that very address.
  assert.equal(tabs.opensAgain({ sameAddress: true, sameSession: true, asked: 'tui', showing: 'diff' }), true);
  // ?tab=diff link, Review picked, Open the diff.
  assert.equal(tabs.opensAgain({ sameAddress: true, sameSession: true, asked: 'diff', showing: 'review' }), true);
  // Already showing it: nothing to do, as before.
  assert.equal(tabs.opensAgain({ sameAddress: true, sameSession: true, asked: 'tui', showing: 'tui' }), false);
  // Another address is a new entry anyway; no ?tab asks for nothing.
  assert.equal(tabs.opensAgain({ sameAddress: false, sameSession: true, asked: 'diff', showing: 'review' }), false);
  assert.equal(tabs.opensAgain({ sameAddress: true, sameSession: true, asked: null, showing: 'review' }), false);
  assert.equal(tabs.opensAgain({ sameAddress: true, sameSession: false, asked: 'diff', showing: 'review' }), false);
});

test('a page kept from earlier writes over nothing another page changed since', () => {
  const store = storage();
  // Session A's page, then My settings, then a fresh shell page that moves session B to Review.
  const pageA = tabs.memory(store, 'local');
  pageA.remember('aaaa1111', 'diff');
  const fresh = tabs.memory(store, 'local');
  fresh.remember('bbbb2222', 'review');
  // Back to A's page, restored from the back-forward cache with its start not run again: it picks TUI on A.
  pageA.remember('aaaa1111', 'tui');
  const now = tabs.memory(store, 'local');
  assert.equal(now.asked('bbbb2222', null, null), 'review', "B's Review, picked in the other page, stands");
  assert.equal(now.asked('aaaa1111', null, null), 'tui');
  // And A's page reads B's change too.
  assert.equal(pageA.asked('bbbb2222', null, null), 'review');
});

test('Chat on a session that is not running is not a fallback: it comes back once the session runs', () => {
  assert.equal(tabs.shown('chat', { status: 'starting', branch: 'woodshed/x' }, false), 'chat');
  assert.equal(tabs.shown('chat', { status: 'stopped' }, false), 'chat');
});
