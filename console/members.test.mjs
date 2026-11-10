import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMembers, parseHandle } from './members.mjs';

const store = (state = {}) => ({ state, saves: 0, save() { this.saves += 1; } });

test('a console that never had a list starts one from who is signed in and who has My Woodshed sessions', () => {
  const s = store({
    authSessions: { a: { login: 'joel', expiresAt: 2_000 }, b: { login: 'joel', expiresAt: 2_000 }, c: { login: 'gone', expiresAt: 500 } },
    sessions: [{ owner: 'mia' }, { owner: null }],
  });
  const members = createMembers({ store: s, now: () => 1_000 });
  assert.equal(members.isMember('gone'), false, 'an expired sign-in starts nobody on the list');
  assert.equal(members.isMember('joel'), true);
  assert.equal(members.isMember('MIA'), true, 'handles match whatever their case');
  assert.equal(members.isMember('sam'), false);
  assert.equal(members.claimFirst('sam'), false, 'nobody claims a list that has members');
});

test('the starting list holds a person once, however their handle was typed', () => {
  const s = store({ authSessions: { a: { login: 'Joel', expiresAt: 2_000 } }, sessions: [{ owner: 'joel' }] });
  const members = createMembers({ store: s, now: () => 1_000 });
  assert.equal(members.isMember('joel'), true);
  assert.deepEqual(Object.keys(s.state.members), ['Joel']);
});

test('with nobody to start from, the first sign-in is the first member, and its admin', () => {
  const members = createMembers({ store: store() });
  assert.equal(members.claimFirst('joel'), true);
  assert.equal(members.claimFirst('mia'), false);
  assert.deepEqual(members.view().members.map((m) => [m.login, m.how]), [['joel', 'first to sign in']]);
  assert.equal(members.isAdmin('joel'), true, 'a new console is never locked out of its own pages');
});

test('a member invites, accepts, declines and removes; nobody removes themselves', () => {
  const members = createMembers({ store: store({ members: { joel: { addedBy: null, addedAt: '2026-10-01T00:00:00Z', how: 'first to sign in' } } }) });
  assert.equal(members.invite({ login: '@ana-k', by: 'joel' }), 'ana-k');
  assert.throws(() => members.invite({ login: 'ana-k', by: 'joel' }), /already a member/);
  assert.throws(() => members.invite({ login: 'not a handle', by: 'joel' }), /not a GitHub handle/);

  members.ask({ login: 'sam' });
  members.ask({ login: 'mia' });
  assert.ok(members.requestOf('sam').askedAt);
  members.accept({ login: 'sam', by: 'ana-k' });
  assert.equal(members.isMember('sam'), true);
  assert.equal(members.requestOf('sam'), null, 'an accepted request is gone');
  members.decline({ login: 'mia', by: 'joel' });
  assert.equal(members.isMember('mia'), false);
  assert.throws(() => members.accept({ login: 'mia', by: 'joel' }), /not asking/);

  members.remove({ login: 'sam', by: 'joel' });
  assert.equal(members.isMember('sam'), false);
  assert.throws(() => members.remove({ login: 'joel', by: 'joel' }), /cannot remove yourself/);
  assert.deepEqual(members.view().members.find((m) => m.login === 'ana-k'), { login: 'ana-k', addedBy: 'joel', addedAt: members.view().members.find((m) => m.login === 'ana-k').addedAt, how: 'invited' });
});

test('a member asking is a no-op, and a request can be taken back', () => {
  const members = createMembers({ store: store({ members: { joel: { how: 'first to sign in' } } }) });
  members.ask({ login: 'joel' });
  assert.equal(members.view().requests.length, 0);
  members.ask({ login: 'sam' });
  members.withdraw({ login: 'sam' });
  assert.equal(members.requestOf('sam'), null);
});

test('parseHandle takes GitHub\'s handle rules, with an @ in front or not', () => {
  assert.equal(parseHandle(' @joel-braga '), 'joel-braga');
  assert.equal(parseHandle('-joel'), null);
  assert.equal(parseHandle('joel--braga'), null);
  assert.equal(parseHandle('a'.repeat(40)), null);
  assert.equal(parseHandle('../etc'), null);
});

test('Sessions from GitHub and Can be assigned start off; Can be assigned needs the first, and goes with it', () => {
  const members = createMembers({ store: store({ members: { joel: { addedBy: null, addedAt: '2026-10-01T00:00:00Z', how: 'first to sign in' }, ana: { addedBy: 'joel', addedAt: '2026-10-02T00:00:00Z', how: 'invited' } } }), now: () => 1_000 });
  assert.deepEqual([members.hasGithubSessions('ana'), members.isAssignable('ana')], [false, false]);
  assert.throws(() => members.setAssignable({ login: 'ana', on: true, by: 'joel' }), /needs sessions from GitHub first/);
  members.setGithubSessions({ login: 'ANA', on: true, by: 'joel' });
  members.setAssignable({ login: 'ana', on: true, by: 'joel' });
  assert.deepEqual([members.hasGithubSessions('ana'), members.isAssignable('ana')], [true, true]);
  assert.deepEqual(members.assignables(), ['ana']);
  const ana = members.view().members.find((m) => m.login === 'ana');
  assert.deepEqual([ana.githubSessionsBy, ana.assignableBy], ['joel', 'joel']);
  assert.throws(() => members.setGithubSessions({ login: 'sam', on: true, by: 'joel' }), /not a member/);
  members.setGithubSessions({ login: 'ana', on: false, by: 'joel' });
  assert.deepEqual([members.hasGithubSessions('ana'), members.isAssignable('ana')], [false, false], 'off for GitHub is off for both');
  const after = members.view().members.find((m) => m.login === 'ana');
  assert.equal('assignableBy' in after || 'githubSessionsBy' in after, false, 'turning it off leaves no trace on the record');
});

test('Admin is off for a member until it is turned on, and the last admin cannot turn it off', () => {
  const members = createMembers({ store: store({ members: { joel: { addedBy: null, addedAt: '2026-10-01T00:00:00Z', how: 'first to sign in' }, ana: { addedBy: 'joel', addedAt: '2026-10-02T00:00:00Z', how: 'invited' } } }), now: () => 1_000 });
  assert.equal(members.isAdmin('ana'), false);
  assert.equal(members.hasAdmin(), false, 'a list started from the people using the console has no admin');
  members.setAdmin({ login: 'ANA', admin: true, by: 'joel' });
  assert.equal(members.hasAdmin(), true);
  assert.equal(members.isAdmin('ana'), true);
  assert.equal(members.hasGithubSessions('ana'), false, 'Admin turns on nothing else');
  assert.equal(members.view().members.find((m) => m.login === 'ana').adminBy, 'joel');
  assert.throws(() => members.setAdmin({ login: 'sam', admin: true, by: 'joel' }), /not a member/);
  assert.throws(() => members.setAdmin({ login: 'ana', admin: false, by: 'ana' }), /needs an admin/, 'the last admin keeps it');
  members.setAdmin({ login: 'joel', admin: true, by: 'ana' });
  members.setAdmin({ login: 'ana', admin: false, by: 'ana' });
  assert.equal(members.isAdmin('ana'), false);
  assert.equal('adminBy' in members.view().members.find((m) => m.login === 'ana'), false, 'turning it off leaves no trace on the record');
});
