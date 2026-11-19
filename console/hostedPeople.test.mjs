// People behind a hosting proxy, from the embedding program's own list (createInstallation's `members`,
// hostedMembers.mjs): the page's API over a made-up program, the switches core keeps, and the fleet assigning with them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createHandler } from './server.mjs';
import { createHostedMembers } from './hostedMembers.mjs';
import { createInstallation } from './installation.mjs';
import { createFleet } from './fleet.mjs';
import { IDENTITY_HEADER, createTrustedIdentity, signIdentity } from './trustedIdentity.mjs';

const SECRET = 'the-hosts-identity-secret-0123456789abcdef';
const CONFIG = {
  host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
  maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 }, appDomain: 'woodshed.example', launcher: { kind: 'docker' }, localLogin: 'local',
  trustedIdentitySecret: SECRET,
};
const WRITE = { origin: 'https://console.example', 'x-woodshed': '1', 'content-type': 'application/json' };
const identity = (login, role) => ({ [IDENTITY_HEADER]: signIdentity({ secret: SECRET, login, role, exp: Date.now() + 60_000 }) });
const OWNER = () => identity('ana-owner', 'owner');
const MEMBER = () => identity('sam-member', 'member');

/** The program: its list, and every call made to it. `refuse` makes the next change fail as the program would. */
function fakeProgram(people = [{ login: 'ana-owner', role: 'owner' }, { login: 'Sam-Member', role: 'member' }]) {
  const program = {
    people: people.map((p) => ({ ...p })), calls: [], refuse: null, lists: 0,
    async list() { program.lists += 1; return program.people.map((p) => ({ ...p })); },
    async add(args) { program.calls.push(['add', args]); program.fail(); program.people.push({ login: args.login, role: args.role }); },
    async remove(args) { program.calls.push(['remove', args]); program.fail(); program.people = program.people.filter((p) => p.login.toLowerCase() !== args.login.toLowerCase()); },
    async setRole(args) { program.calls.push(['setRole', args]); program.fail(); program.people.find((p) => p.login.toLowerCase() === args.login.toLowerCase()).role = args.role; },
    fail() {
      const why = program.refuse;
      program.refuse = null;
      if (why === 'shown') throw Object.assign(new Error('Your plan has room for 2 people.'), { shown: true });
      if (why) throw new Error('database gone');
    },
  };
  return program;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function send(port, { method = 'GET', path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host: 'console.example', ...headers } }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { /* a page */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function hostedPeople(t, { program = fakeProgram(), withHook = true, sessions = [] } = {}) {
  t.mock.method(console, 'log', () => {});
  const store = { state: {}, save() {} };
  let clock = 1_000_000;
  const gone = [];
  const members = withHook ? createHostedMembers({ hook: program, store, now: () => clock, onGone: (login) => gone.push(login) }) : null;
  if (members) await members.refresh();
  const released = [];
  const fleet = { sessions: () => sessions, find: (id) => sessions.find((s) => s.id === id) ?? null, releaseAssignments: (args) => { released.push(args); return 0; } };
  const handle = createHandler({ config: CONFIG, fleet, trusted: createTrustedIdentity({ secret: SECRET }), members, consoleSettings: { view: () => ({}) } });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const post = (path, body, headers = OWNER()) => send(port, { method: 'POST', path, headers: { ...WRITE, ...headers }, body });
  return { port, program, store, members, released, gone, post, advance: (ms) => { clock += ms; } };
}

const row = (body, login) => body.members.find((m) => m.login.toLowerCase() === login.toLowerCase());

test('People lists the program\'s members with their role and switches, Sessions from GitHub on and Can be assigned off', async (t) => {
  const { port } = await hostedPeople(t);
  const people = await send(port, { path: '/api/people', headers: OWNER() });
  assert.equal(people.status, 200);
  assert.equal(people.body.hosted, true);
  assert.deepEqual(people.body.requests, [], 'nobody asks to join');
  assert.deepEqual(people.body.members.map((m) => [m.login, m.role, m.admin, m.githubSessions, m.assignable]), [
    ['ana-owner', 'owner', true, true, false], ['Sam-Member', 'member', false, true, false],
  ]);
  const me = (await send(port, { path: '/api/me', headers: OWNER() })).body;
  assert.deepEqual([me.admin, me.people, me.asking], [true, true, 0], 'admin from the role, and People offered as a tab');
  assert.equal((await send(port, { path: '/api/people', headers: MEMBER() })).status, 403, 'a member is no admin');
  assert.equal((await send(port, { method: 'POST', path: '/api/people/add', headers: { ...WRITE, ...MEMBER() }, body: { login: 'x', role: 'member' } })).status, 403);
});

test('Add someone, Remove and the role go to the program, with who did it, and the page shows its list after', async (t) => {
  const { program, post, released } = await hostedPeople(t);
  const added = await post('/api/people/add', { login: '@new-person', role: 'member' });
  assert.equal(added.status, 200);
  assert.ok(row(added.body, 'new-person'), 'the new list, read again after the change');
  const role = await post('/api/people/role', { login: 'new-person', role: 'owner' });
  assert.equal(row(role.body, 'new-person').role, 'owner');
  const removed = await post('/api/people/remove', { login: 'sam-member' });
  assert.equal(row(removed.body, 'sam-member'), undefined);
  assert.deepEqual(program.calls, [
    ['add', { login: 'new-person', role: 'member', by: 'ana-owner' }],
    ['setRole', { login: 'new-person', role: 'owner', by: 'ana-owner' }],
    ['remove', { login: 'Sam-Member', by: 'ana-owner' }],
  ]);
  assert.deepEqual(released, [{ login: 'sam-member', by: 'ana-owner' }], 'their shared sessions go back to Unassigned');
  assert.equal((await post('/api/people/add', { login: 'x', role: 'admin' })).status, 409, 'a role is owner or member');
  assert.equal((await post('/api/people/add', { login: 'ana-owner', role: 'member' })).status, 409, 'already in');
  for (const action of ['invite', 'accept', 'decline', 'admin']) {
    assert.equal((await post(`/api/people/${action}`, { login: 'someone', admin: true })).status, 404, action);
  }
  assert.equal(program.calls.length, 3, 'none of those reached the program');
});

test('the program\'s refusal is shown as it says it; anything else it throws is a 500', async (t) => {
  const { program, post } = await hostedPeople(t);
  program.refuse = 'shown';
  assert.deepEqual(await post('/api/people/add', { login: 'third', role: 'member' }), { status: 409, body: { error: 'Your plan has room for 2 people.' } });
  t.mock.method(console, 'error', () => {});
  program.refuse = 'boom';
  const failed = await post('/api/people/role', { login: 'sam-member', role: 'owner' });
  assert.equal(failed.status, 500);
  assert.doesNotMatch(failed.body.error, /database gone/, 'the program\'s own error stays in the log');
});

test('the last owner is neither demoted nor removed, nobody removes themselves, and someone not on the list is refused', async (t) => {
  const { program, post } = await hostedPeople(t);
  assert.match((await post('/api/people/role', { login: 'ana-owner', role: 'member' })).body.error, /needs an owner/);
  assert.match((await post('/api/people/remove', { login: 'ana-owner' })).body.error, /cannot remove yourself/);
  for (const [path, body] of [['/api/people/remove', {}], ['/api/people/role', { role: 'owner' }], ['/api/people/github-sessions', { on: false }], ['/api/people/assignable', { on: true }]]) {
    const refused = await post(path, { login: 'stranger', ...body });
    assert.deepEqual([refused.status, refused.body.error], [409, '@stranger is not a member'], path);
  }
  assert.deepEqual(program.calls, [], 'the program was never asked');
});

test('Sessions from GitHub can be turned off, which takes Can be assigned with it; Can be assigned needs it', async (t) => {
  const { members, post, store, released } = await hostedPeople(t);
  assert.equal(members.hasGithubSessions('sam-member'), true, 'on for a listed member with nothing kept');
  assert.equal(members.hasGithubSessions('stranger'), false, 'never for someone not listed');
  assert.equal(row((await post('/api/people/assignable', { login: 'sam-member', on: true })).body, 'sam-member').assignable, true);
  assert.deepEqual(members.assignables(), ['Sam-Member'], 'spelled as the program spells it');
  const off = await post('/api/people/github-sessions', { login: 'SAM-member', on: false });
  assert.deepEqual([row(off.body, 'sam-member').githubSessions, row(off.body, 'sam-member').assignable], [false, false]);
  assert.equal(row(off.body, 'sam-member').githubSessionsOffBy, 'ana-owner');
  assert.deepEqual(Object.keys(store.state.memberSwitches), ['sam-member'], 'kept by lowercased login');
  assert.deepEqual(released.map((r) => r.login), ['SAM-member']);
  assert.match((await post('/api/people/assignable', { login: 'sam-member', on: true })).body.error, /needs sessions from GitHub first/);
  await post('/api/people/github-sessions', { login: 'sam-member', on: true });
  assert.deepEqual(store.state.memberSwitches, {}, 'on again keeps nothing');
});

test('someone the program takes off elsewhere loses their switches at the next read of its list', async (t) => {
  const { program, members, post, store, gone, advance } = await hostedPeople(t);
  await post('/api/people/assignable', { login: 'sam-member', on: true });
  store.state.sessions = [{ id: '0a1b2c3d', kind: 'manual', status: 'running', assignee: 'Sam-Member' }];
  assert.equal(members.isAssignable('sam-member'), true);
  program.people = program.people.filter((p) => p.login !== 'Sam-Member');
  advance(5_001);
  // The fleet asks without waiting: the list it had answers, and a read starts behind it.
  assert.equal(members.isAssignable('sam-member'), true, 'answered from the list as last read');
  await members.load();
  assert.equal(members.isAssignable('sam-member'), false);
  assert.equal(members.isMember('sam-member'), false);
  assert.deepEqual(members.assignables(), []);
  assert.equal(store.state.memberSwitches['sam-member'], undefined, 'their switch entry is gone');
  assert.deepEqual(gone, ['Sam-Member'], 'and the installation hears of it, to give their sessions back');
});

test('the list is kept a few seconds: the fleet\'s questions do not each ask the program', async (t) => {
  const { program, members, advance } = await hostedPeople(t);
  const before = program.lists;
  for (let i = 0; i < 20; i += 1) members.hasGithubSessions('sam-member');
  assert.equal(program.lists, before);
  advance(5_001);
  members.hasGithubSessions('sam-member');
  members.hasGithubSessions('sam-member');
  await members.load();
  assert.equal(program.lists, before + 1, 'one read once it is older, however many ask');
});

test('a hosted console without the hook has no People, as before', async (t) => {
  const { port, post } = await hostedPeople(t, { withHook: false });
  assert.equal((await send(port, { path: '/api/people', headers: OWNER() })).status, 404);
  assert.equal((await post('/api/people/add', { login: 'x', role: 'member' })).status, 404);
  assert.equal((await send(port, { path: '/api/me', headers: OWNER() })).body.people, false);
});

test('shared sessions are for listed members with Sessions from GitHub', async (t) => {
  const sessions = [{ id: '0a1b2c3d', status: 'running', title: 'shared', startedBy: 'someone' }];
  const { port, post } = await hostedPeople(t, { sessions });
  const ids = async () => (await send(port, { path: '/api/sessions', headers: MEMBER() })).body.sessions.map((s) => s.id);
  assert.deepEqual(await ids(), ['0a1b2c3d'], 'on by default');
  await post('/api/people/github-sessions', { login: 'sam-member', on: false });
  assert.deepEqual(await ids(), [], 'not once it is off');
});

test('the fleet assigns a shared session to someone made assignable on a hosted console', async (t) => {
  t.mock.method(console, 'log', () => {});
  const program = fakeProgram();
  const store = { state: { sessions: [{ id: '0a1b2c3d', kind: 'manual', status: 'running', title: 'shared', startedBy: 'ana-owner' }], github: null }, save() {} };
  const members = createHostedMembers({ hook: program, store });
  await members.refresh();
  const fleet = createFleet({ config: { ...CONFIG, sessionEnv: {} }, store, launcher: {}, github: {}, members });
  assert.throws(() => fleet.assign({ id: '0a1b2c3d', by: 'sam-member', to: 'sam-member' }), /only someone who can be assigned/);
  members.setAssignable({ login: 'sam-member', on: true, by: 'ana-owner' });
  const session = fleet.assign({ id: '0a1b2c3d', by: 'sam-member', to: 'sam-member' });
  assert.deepEqual([session.assignee, session.assignedHow], ['Sam-Member', 'take it']);
});

test('the members hook is for a console behind trusted sign-in only, and needs all four calls', async () => {
  const program = fakeProgram();
  await assert.rejects(createInstallation({ config: {}, store: { state: {} }, provider: {}, members: program }), /members is for a console behind trusted sign-in/);
  await assert.rejects(createInstallation({ config: {}, store: { state: {} }, provider: {}, trusted: { userFor: () => null }, members: { list: program.list } }), /needs list, add, remove and setRole/);
});

test('someone dropped while the console was down gives their shared sessions back when it starts', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-people-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  // The program took lee off while the console was down: their switch is still stored, and a shared session is theirs.
  // Bo left earlier and their switches are gone already, but a restart cut their release short: theirs is kept too.
  const store = {
    state: {
      memberSwitches: { 'lee-dev': { assignable: { by: 'ana-owner', at: '2026-01-01T00:00:00.000Z' } } },
      sessions: [
        { id: '0a1b2c3d', kind: 'manual', status: 'stopped', title: 'lee\'s', startedBy: 'ana-owner', assignee: 'Lee-Dev' },
        { id: '1b2c3d4e', kind: 'manual', status: 'stopped', title: 'bo\'s', startedBy: 'ana-owner', assignee: 'bo-dev' },
        { id: '2c3d4e5f', kind: 'manual', status: 'stopped', title: 'sam\'s', startedBy: 'ana-owner', assignee: 'Sam-Member' },
        { id: '3d4e5f6a', kind: 'manual', status: 'stopped', title: 'private', owner: 'lee-dev', startedBy: 'lee-dev', assignee: null },
      ],
    },
    save() {},
  };
  await createInstallation({
    config: { ...CONFIG, stateDir, sessionEnv: {}, sessionApi: {} }, store, provider: { name: 'test', launcher: {} },
    trusted: createTrustedIdentity({ secret: SECRET }), members: fakeProgram(),
  });
  assert.equal(store.state.memberSwitches['lee-dev'], undefined, 'their switches cleared');
  const assigned = Object.fromEntries(store.state.sessions.map((s) => [s.title, [s.assignee, s.assignedBy ?? null]]));
  assert.deepEqual(assigned, {
    'lee\'s': [null, 'the program'], 'bo\'s': [null, 'the program'], 'sam\'s': ['Sam-Member', null], private: [null, null],
  }, 'back to Unassigned for those not listed, and the listed keep theirs');
});

test('an empty list from the program while core knows of members keeps the last one, its switches and its sessions', async (t) => {
  const warned = t.mock.method(console, 'warn', () => {});
  const { program, members, post, store, gone, advance } = await hostedPeople(t);
  await post('/api/people/assignable', { login: 'sam-member', on: true });
  store.state.sessions = [{ id: '0a1b2c3d', kind: 'manual', status: 'running', assignee: 'Sam-Member' }];
  program.people = [];
  advance(5_001);
  await members.load();
  assert.deepEqual([members.isAdmin('ana-owner'), members.isAssignable('sam-member')], [true, true], 'both still in, with their switches');
  assert.ok(store.state.memberSwitches['sam-member'].assignable);
  assert.deepEqual(gone, [], 'no session given back');
  assert.ok(warned.mock.calls.some((c) => /came back empty, kept the last one/.test(c.arguments[0])));
});

test('an empty list is taken as it is on a console that never had anyone, but not over a stored switch at start', async (t) => {
  t.mock.method(console, 'log', () => {});
  const store = { state: {}, save() {} };
  const members = createHostedMembers({ hook: fakeProgram([]), store });
  await members.load();
  assert.deepEqual(members.view().members, []);
  // With a stored switch at start, an empty first list is not taken: nobody is in until a list with someone comes.
  const stored = { state: { memberSwitches: { 'lee-dev': { assignable: { by: 'ana-owner', at: '2026-01-01T00:00:00.000Z' } } } }, save() {} };
  t.mock.method(console, 'warn', () => {});
  const kept = createHostedMembers({ hook: fakeProgram([]), store: stored });
  await kept.refresh();
  assert.equal(kept.isMember('lee-dev'), false);
  assert.ok(stored.state.memberSwitches['lee-dev'], 'the switch is kept for when the program lists them again');
});

test('behind a proxy, a person the program drops loses their database tunnel token and open tunnels at the next read', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-people-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const SAM_TOKEN = `wt_${'a'.repeat(64)}`;
  const LEE_TOKEN = `wt_${'b'.repeat(64)}`;
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const later = new Date(Date.now() + 3_600_000).toISOString();
  // Sam has a token, and so does Lee, whom the program took off while the console was down.
  const store = {
    state: { tunnelTokens: { 'sam-member': { hash: sha(SAM_TOKEN), expiresAt: later }, 'lee-dev': { hash: sha(LEE_TOKEN), expiresAt: later } } },
    save() {},
  };
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const program = fakeProgram();
  const memory = { read: async () => null, save: async () => {}, remove: async () => {} };
  const installation = await createInstallation({
    config: { ...CONFIG, stateDir, sessionEnv: {}, sessionApi: {}, tunnelTargets: { pg: '127.0.0.1:1', mongo: null } }, store,
    provider: { name: 'test', launcher: {}, secrets: memory, dbAdmin: {}, databases: ['postgres'] },
    trusted: createTrustedIdentity({ secret: SECRET }), members: program,
  });
  const { tunnel } = installation;
  const asks = async (token) => {
    let status = null;
    const res = { writeHead: (s) => { status = s; }, end() {}, setHeader() {} };
    await tunnel.connection({ headers: { authorization: `Bearer ${token}`, host: 'x' }, method: 'GET', url: '/api/tunnel/connection', socket: { remoteAddress: '127.0.0.1' } }, res);
    return status;
  };
  assert.equal(tunnel.available, true);
  assert.equal(store.state.tunnelTokens['lee-dev'], undefined, 'the one dropped while the console was down is revoked at start');
  assert.equal(await asks(SAM_TOKEN), 409, 'a listed person\'s token is accepted (409: their databases are not made here)');
  const closed = [];
  tunnel.revoke = ((revoke) => (login) => { closed.push(login); revoke(login); })(tunnel.revoke);
  program.people = program.people.filter((p) => p.login !== 'Sam-Member');
  // The program's list is read again once it is older than 5 s, when something asks (here, the token's person).
  t.mock.timers.tick(5_001);
  await asks(SAM_TOKEN);
  await new Promise((r) => setImmediate(r));
  assert.equal(store.state.tunnelTokens['sam-member'], undefined, 'the token is gone with the next read');
  assert.equal(await asks(SAM_TOKEN), 401);
  assert.deepEqual(closed, ['sam-member'], 'revoke, which closes open tunnels, ran for the one who left');
});
