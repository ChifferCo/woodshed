// The rail's hover card (session.js railPeek): what it says about a session, read from public/common.js the way a page
// loads it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function loadCommon() {
  const window = { WoodshedLogins: require('./public/logins.cjs'), WoodshedSetup: require('./public/setupSteps.cjs'), WoodshedAgents: require('../shared/agents.cjs') };
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
const data = { login: 'me', idleHours: 1, askIdleHours: 1, myIdleHours: null };
const minutesAgo = (n) => new Date(Date.now() - n * 60_000).toISOString();
const PR = 'https://github.com/o/r/pull/9';
const shared = (extra) => ({
  id: 's1', title: 'Fix the export', kind: 'task', status: 'running', state: 'done', startedBy: 'ana', assignee: 'me',
  branch: 'woodshed/s1', startedAt: minutesAgo(120), lastActiveAt: minutesAgo(20), owner: null, ...extra,
});
const rows = (v) => Object.fromEntries(v.rows);

test('a running session says its status, when it pauses, the branch, agent, last activity and who has it', () => {
  const v = W.peekView(shared({ options: { agent: 'claude', model: 'opus', effort: 'high' } }), data);
  assert.equal(v.word, 'Done');
  assert.equal(v.key, 'done');
  assert.match(v.next, /^pauses at .+, in 40 min$/);
  assert.equal(rows(v).Branch, 'woodshed/s1');
  assert.equal(rows(v).Agent, 'Claude · opus, high effort');
  assert.equal(rows(v)['Last activity'], '20 min ago');
  assert.equal(rows(v).Started, '@ana, 2 h ago');
  assert.equal(rows(v)['Assigned to'], '@me');
});

test('a working session never pauses for idling, and its last activity is now', () => {
  const v = W.peekView(shared({ state: 'working' }), data);
  assert.equal(v.word, 'Working');
  assert.equal(v.next, 'never pauses while it works');
  assert.equal(rows(v)['Last activity'], 'Working now');
});

test('the console\'s own pause wins over the page\'s idle hours, and a lifetime says stops', () => {
  const v = W.peekView(shared({ state: 'working', pause: { at: new Date(Date.now() + 90 * 60_000).toISOString(), why: 'lifetime' } }), data);
  assert.match(v.next, /^stops at .+, in 2 h$/);
});

test('each pull request is listed with its state, checks and review', () => {
  const v = W.peekView(shared({
    prUrl: PR,
    prs: [{ url: PR, pr: { title: 'Fix the export', state: 'open', checks: { total: 5, fail: 1, pending: 0 }, review: 'changes' } }],
  }), data);
  assert.deepEqual({ ...v.prs[0] }, { number: '#9', title: 'Fix the export', state: 'Open', checks: '1 of 5 checks failing', level: 'fail', review: 'changes requested' });
});

test('a pull request the console has not read yet is its number alone', () => {
  const v = W.peekView(shared({ prUrl: PR, prs: [{ url: PR, pr: null }] }), data);
  assert.deepEqual({ ...v.prs[0] }, { number: '#9', title: null, state: null, checks: null, level: null, review: null });
});

test('the agent\'s last line is named after the agent, and cut to a few lines', () => {
  const v = W.peekView(shared({ options: { agent: 'codex' }, lastMessage: { role: 'assistant', text: 'x '.repeat(400) } }), data);
  assert.equal(v.last.who, 'Codex');
  assert.equal(v.last.text.length, 280);
  assert.ok(v.last.text.endsWith('…'));
});

test('a failed session says why, as an error, and has no last activity', () => {
  const v = W.peekView(shared({ status: 'failed', state: null, error: 'The container did not start.' }), data);
  assert.equal(v.word, 'Failed');
  assert.deepEqual({ ...v.last }, { who: null, text: 'The container did not start.', error: true });
  assert.equal(rows(v)['Last activity'], undefined);
});

test('a paused private session says since when and why, with no Started by or assignee', () => {
  const v = W.peekView(shared({ owner: 'me', assignee: null, status: 'stopped', state: null, stoppedAt: minutesAgo(180), stopReason: 'idle for 1 h' }), data);
  assert.equal(v.word, 'Paused');
  assert.equal(v.next, '3 h ago · idle 1 h');
  assert.equal(rows(v).Started, '2 h ago');
  assert.equal(rows(v)['Assigned to'], undefined);
});

test('a session started on an issue says which, and the project only when the rail shows more than one', () => {
  const v = W.peekView(shared({ kind: 'issue', number: 42 }), data, { project: 'example-api' });
  assert.equal(rows(v)['Works on'], '#42');
  assert.equal(rows(v).Project, 'example-api');
  assert.equal(rows(W.peekView(shared({ kind: 'issue', number: 42 }), data)).Project, undefined);
});

test('a session started on the pull request it shows does not say it twice', () => {
  const v = W.peekView(shared({ kind: 'pr', number: 9, prUrl: PR, prs: [{ url: PR, pr: null }] }), data);
  assert.equal(rows(v)['Works on'], undefined);
});

test('an unassigned shared session says Nobody; a review run has no assignee row', () => {
  assert.equal(rows(W.peekView(shared({ assignee: null }), data))['Assigned to'], 'Nobody');
  assert.equal(rows(W.peekView(shared({ assignee: null, trigger: 'review' }), data))['Assigned to'], undefined);
});

test('every pull request it opened is listed, a merged one the chips no longer show too', () => {
  const old = 'https://github.com/o/r/pull/8';
  const v = W.peekView(shared({
    prUrl: PR,
    prs: [{ url: old, pr: { title: 'First try', state: 'merged' } }, { url: PR, pr: { title: 'Second', state: 'open' } }],
  }), data);
  assert.deepEqual(v.prs.map((p) => `${p.number} ${p.state}`), ['#8 Merged', '#9 Open']);
});
