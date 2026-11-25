// What the rail's Mine lists (public/common.js, inMine), read from common.js the way a page loads it: your private
// sessions, and the shared ones you started or that are assigned to you. A label or a /woodshed comment you made starts
// a shared session that runs on your Claude plan, so it is yours to find under Mine, whoever has it now.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function common() {
  const window = { WoodshedLogins: require('./public/logins.cjs'), WoodshedAgents: require('../shared/agents.cjs'), WoodshedSetup: require('./public/setupSteps.cjs') };
  const context = vm.createContext({
    window, console, fetch: () => new Promise(() => {}),
    document: { addEventListener() {}, querySelector() {}, createElement: () => ({}), createTextNode: () => ({}) },
    matchMedia: () => ({}),
  });
  vm.runInContext(fs.readFileSync(new URL('./public/common.js', import.meta.url), 'utf8'), context);
  return window.Woodshed;
}

test('Mine holds your private sessions and the shared ones you started or have, and nobody else\'s', () => {
  const W = common();
  const cases = [
    [{ owner: 'allen', startedBy: 'allen' }, true, 'your private session'],
    [{ owner: 'mia', startedBy: 'mia' }, false, 'someone else\'s private session'],
    [{ owner: null, startedBy: 'allen', assignee: null }, true, 'a label you added, nobody has it'],
    [{ owner: null, startedBy: 'Allen', assignee: null }, true, 'GitHub\'s capitals are the same person'],
    [{ owner: null, startedBy: 'allen', assignee: 'mia' }, true, 'you started it and handed it over: it still runs on your plan'],
    [{ owner: null, startedBy: 'mia', assignee: 'allen' }, true, 'assigned to you'],
    [{ owner: null, startedBy: 'mia', assignee: null }, false, 'someone else\'s, nobody has it: Everyone'],
    [{ owner: null, startedBy: 'mia', assignee: 'sam' }, false, 'someone else\'s, someone else has it'],
  ];
  for (const [s, mine, why] of cases) assert.equal(W.inMine(s, 'allen'), mine, why);
  assert.equal(W.inMine({ owner: null, startedBy: null, assignee: null }, null), false, 'no login, no shared session is anyone\'s');
});

test('a review or QA the console ran on a pull request is no one\'s to take: it goes to its own zone, never Unassigned', () => {
  const W = common();
  const shared = { owner: null, startedBy: 'allen', assignee: null, kind: 'pr', status: 'running', state: 'working' };
  assert.equal(W.isPullCheck({ ...shared, trigger: 'review' }), true, 'a review session');
  assert.equal(W.isPullCheck({ ...shared, trigger: 'qa' }), true, 'a QA session');
  assert.equal(W.isPullCheck({ ...shared, trigger: 'label' }), false, 'a label starts work, not a check');
  assert.equal(W.isUnassigned({ ...shared, trigger: 'review' }), false, 'nobody takes a review');
  assert.equal(W.isUnassigned({ ...shared, trigger: 'label' }), true, 'a label nobody has is still Unassigned');
});
