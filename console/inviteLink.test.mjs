import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { safeNext } from './auth.mjs';
import { parseWorkOn } from './sessions.mjs';

const { inviteTarget, inviteUrl } = createRequire(import.meta.url)('./public/inviteLink.cjs');

test('a session with a PR invites on the PR, whether or not the branch was checked', () => {
  const s = { prUrl: 'https://github.com/o/r/pull/123', branch: 'woodshed/x' };
  assert.deepEqual(inviteTarget(s, { pushed: null }), { state: 'pr', on: 'PR #123' });
  assert.deepEqual(inviteTarget(s, { pushed: false }), { state: 'pr', on: 'PR #123' });
});

test('with no PR it invites on the branch once GitHub has it, and is not offered until then', () => {
  const s = { prUrl: null, branch: 'woodshed/x' };
  assert.deepEqual(inviteTarget(s, { pushed: true }), { state: 'branch', on: 'woodshed/x' });
  assert.equal(inviteTarget(s, { pushed: false }).state, 'unpushed');
  assert.equal(inviteTarget(s, { pushed: null }).state, 'checking');
  assert.equal(inviteTarget({ prUrl: null, branch: null }, { pushed: true }).state, 'unpushed');
});

test('the link holds only the target, survives sign-in, and the form reads it back as the same PR or branch', () => {
  const link = new URL(inviteUrl('https://console.example', 'PR #123'));
  assert.equal(link.origin, 'https://console.example');
  assert.deepEqual([...link.searchParams.keys()], ['new', 'on']);
  assert.equal(link.searchParams.get('on'), 'PR #123');
  const next = safeNext(link.pathname + link.search);
  assert.equal(new URL(next, 'http://x').searchParams.get('on'), 'PR #123');
  assert.deepEqual(parseWorkOn(link.searchParams.get('on')), { kind: 'number', number: 123, pr: true });
  const branch = new URL(inviteUrl('https://console.example', 'woodshed/sikakkar-8387f694'));
  assert.deepEqual(parseWorkOn(safeNext(branch.pathname + branch.search) && new URL(branch).searchParams.get('on')), { kind: 'branch', branch: 'woodshed/sikakkar-8387f694' });
});

test('the link carries the console\'s link query, for whatever serves the console to route it', () => {
  const link = new URL(inviteUrl('https://console.example', 'PR #123', 'place=acme'));
  assert.equal(link.searchParams.get('place'), 'acme');
  assert.equal(link.searchParams.get('on'), 'PR #123');
  assert.equal(new URL(inviteUrl('https://console.example', 'PR #123', null)).search, '?new=1&on=PR%20%23123');
});

test('the link names the session\'s project, so the form does not open on the engineer\'s own default instead', () => {
  const link = new URL(inviteUrl('https://console.example', 'PR #41', 'place=acme', 'woodshed-cloud'));
  assert.equal(link.searchParams.get('project'), 'woodshed-cloud');
  assert.equal(link.searchParams.get('on'), 'PR #41');
  assert.equal(link.searchParams.get('place'), 'acme');
});
