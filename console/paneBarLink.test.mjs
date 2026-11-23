// The pane bar's #123 link goes to the session's own repo (public/session.js), not the console's default one: a
// session on another project's repo once linked to the same number on the default repo.

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

test('issueUrl links a pull request or an issue on the repo it is given', () => {
  const W = common();
  assert.equal(W.issueUrl('acme/api', { kind: 'pr', number: 7 }), 'https://github.com/acme/api/pull/7');
  assert.equal(W.issueUrl('acme/api', { kind: 'issue', number: 7 }), 'https://github.com/acme/api/issues/7');
});

test('the pane bar links its issue or pull request on the session\'s own repo, the default only for one with none', () => {
  const source = fs.readFileSync(new URL('./public/session.js', import.meta.url), 'utf8');
  assert.match(source, /class: 'pref', href: W\.issueUrl\(s\.repo \?\? data\.repo, s\)/);
  assert.doesNotMatch(source, /class: 'pref', href: W\.issueUrl\(data\.repo/);
});
