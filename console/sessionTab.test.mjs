// Which tab a session page's ?tab= opens (public/common.js, sessionTab), read from common.js the way a page loads it.
// The agent's live terminal is the TUI tab; `agent`, its name before, still opens it from old links and bookmarks.

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

test('?tab=agent, the TUI tab\'s old name, opens the TUI tab', () => {
  const W = common();
  assert.equal(W.sessionTab('tui'), 'tui');
  assert.equal(W.sessionTab('agent'), 'tui');
});

test('each other tab opens itself, and none or one it does not know opens Chat', () => {
  const W = common();
  for (const name of ['terminal', 'review', 'diff', 'applog']) assert.equal(W.sessionTab(name), name);
  for (const asked of [null, '', 'chat', 'Agent', 'TUI', 'nope', 'constructor', 'toString']) assert.equal(W.sessionTab(asked), 'chat', String(asked));
});

test('the session page reads its tab through sessionTab and puts an old name right in the address', () => {
  const source = fs.readFileSync(new URL('./public/session.js', import.meta.url), 'utf8');
  assert.match(source, /tab = W\.sessionTab\(asked\);/);
  assert.match(source, /tabButton\('tui', 'TUI'/);
  assert.doesNotMatch(source, /tabButton\('agent'/);
  assert.doesNotMatch(source, /\?tab=agent`/, 'the page makes no new ?tab=agent link');
});
