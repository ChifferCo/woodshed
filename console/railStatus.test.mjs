// The rail's status word, read from public/common.js the way a page loads it: a script that sets window.Woodshed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const read = (name) => fs.readFileSync(new URL(`./public/${name}`, import.meta.url), 'utf8');

function loadCommon() {
  const window = { WoodshedLogins: require('./public/logins.cjs'), WoodshedSetup: require('./public/setupSteps.cjs') };
  const context = vm.createContext({
    window, console,
    document: { addEventListener() {}, createElement: () => ({}) },
    matchMedia: () => ({}),
    fetch: () => new Promise(() => {}),
  });
  vm.runInContext(read('common.js'), context);
  return window.Woodshed;
}

const W = loadCommon();
const PR = 'https://github.com/o/r/pull/9';
const running = (extra) => ({ status: 'running', state: 'done', ...extra });

test('a finished turn with a shell still running on a pull request reads waiting on a job, and needs nobody yet', () => {
  const s = running({ shells: 2, prUrl: PR });
  const { key, word } = W.displayStatus(s);
  assert.deepEqual({ key, word }, { key: 'job', word: 'waiting on a job' });
  assert.equal(W.needsYou(s), false);
  assert.equal(W.group(s), 'working');
});

test('done stays done with no shell, with no pull request, or once it is in Slack for review', () => {
  assert.equal(W.displayStatus(running({ shells: 0, prUrl: PR })).key, 'done');
  // A dev server on a branch with no pull request yet is not CI.
  assert.equal(W.displayStatus(running({ shells: 1 })).key, 'done');
  assert.equal(W.needsYou(running({ shells: 1 })), true);
  assert.equal(W.displayStatus(running({ shells: 1, prUrl: PR, slackWaiting: true })).key, 'review');
});

test('a turn that needs a person is not hidden by a shell', () => {
  assert.equal(W.displayStatus({ status: 'running', state: 'needs-you', shells: 1, prUrl: PR }).key, 'needs-you');
});

test('the app buttons\' title names the project\'s own ports, and the servers alone when statusd gave none', () => {
  const servers = { frontend: true, backend: false };
  assert.equal(W.serversTitle({ appServers: { ...servers, frontendPort: 5173, backendPort: 8080 } }), ' Backend :8080 down, frontend :5173 up.');
  assert.equal(W.serversTitle({ appServers: { ...servers, frontendPort: null, backendPort: null } }), ' Backend down, frontend up.');
  assert.equal(W.serversTitle({ appServers: null }), '');
});

test('a merged or closed pull request shows only while no newer one came after it', () => {
  const states = { 1: 'merged', 2: 'open', 3: 'closed', 4: 'draft', 5: 'merged' };
  const shown = (numbers) => [...W.shownPrs({ prs: numbers.map((n) => ({ url: `${n}`, pr: states[n] ? { state: states[n] } : null })) }).map((p) => p.url)];
  assert.deepEqual(shown([]), []);
  assert.deepEqual(shown([1]), ['1'], 'the only one stays, merged');
  assert.deepEqual(shown([1, 2]), ['2'], 'a newer one hides the merged one');
  assert.deepEqual(shown([2, 1]), ['2', '1'], 'an older open one stays beside the newest');
  assert.deepEqual(shown([1, 3, 5]), ['5'], 'all settled: only the newest');
  assert.deepEqual(shown([2, 3, 4]), ['2', '4']);
  assert.deepEqual(shown([9, 1, 2]), ['9', '2'], 'one not read yet counts as open');
  assert.deepEqual([...W.shownPrs({ prUrl: PR, pr: { state: 'merged' } }).map((p) => p.url)], [PR], 'a console from before the list');
  assert.equal(W.shownPrs({ prUrl: null }).length, 0);
});

// common.js with a stand-in document whose elements keep their attributes and text, for what builds chips.
function loadCommonWithElements() {
  class Node {}
  class El extends Node {
    constructor(tag) { super(); this.tag = tag; this.attrs = {}; this.text = ''; }
    setAttribute(key, value) { this.attrs[key] = value; }
    addEventListener() {}
    append(child) { this.text += child.text ?? ''; }
  }
  const window = { WoodshedLogins: require('./public/logins.cjs'), WoodshedSetup: require('./public/setupSteps.cjs') };
  const context = vm.createContext({
    window, console, Node,
    document: { addEventListener() {}, createElement: (tag) => new El(tag), createTextNode: (text) => ({ text }) },
    matchMedia: () => ({}),
    fetch: () => new Promise(() => {}),
  });
  vm.runInContext(read('common.js'), context);
  return window.Woodshed;
}

test('past the cap, the older pull requests fold into one +N chip, the newest shown', () => {
  const prs = [1, 2, 3, 4].map((n) => ({ url: `https://github.com/o/r/pull/${n}`, pr: null }));
  const W2 = loadCommonWithElements();
  const chips = W2.prChips({ prs }, { max: 2 });
  assert.deepEqual([...chips.map((c) => c.text)], ['+2', 'PR #3', 'PR #4']);
  assert.match(chips[0].attrs.title, /2 more pull requests:\n#1\n#2/);
  assert.deepEqual([...W2.prChips({ prs: prs.slice(0, 2) }, { max: 2 }).map((c) => c.text)], ['PR #1', 'PR #2'], 'at the cap, nothing folds');
});
