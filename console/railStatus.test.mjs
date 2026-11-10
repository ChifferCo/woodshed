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
