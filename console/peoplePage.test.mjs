// The People page (public/people.js) behind a hosting proxy, on a tiny DOM: the program's note beside each person, and
// what its add says it did in place of the hint that nothing is sent. Both are drawn as text, never as markup.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import { ROLES, roleDiffers, roleOf } from './peopleRoles.mjs';

const source = fs.readFileSync(new URL('./public/people.js', import.meta.url), 'utf8');
const rowsSource = fs.readFileSync(new URL('./public/settingsRows.js', import.meta.url), 'utf8');

function element(tag) {
  return {
    tag, attrs: {}, listeners: {}, children: [], className: '', value: '', hidden: false,
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(k, fn) { this.listeners[k] = fn; },
    append(c) { this.children.push(c); },
    replaceChildren(...c) { this.children = c; },
    focus() {},
  };
}

const textOf = (el) => (typeof el === 'string' ? el : el.children.map(textOf).join(''));
function walk(el, out = []) {
  if (typeof el === 'string') return out;
  out.push(el);
  for (const c of el.children) walk(c, out);
  return out;
}

const person = (login, role, fields = {}) => ({ login, role, admin: role === 'owner', githubSessions: true, assignable: false, ...fields });

async function loadPage({ members, addReply, hosted = true, requests = [], confirm = () => true, names = {} }) {
  const asked = [];
  const app = element('div');
  const h = (tag, attrs, ...children) => {
    const el = element(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    // As common.js's h: anything that is not an element becomes a text node, so markup in a string stays text.
    for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(typeof c === 'object' ? c : String(c));
    return el;
  };
  // As /api/people answers: each member's role from their switches, and the roles with what each gives.
  const withRoles = (reply) => (reply && Array.isArray(reply.members)
    ? { ...reply, roles: ROLES.map(({ id, label, explain, privateSessions, admin, githubSessions, assignable }) => ({ id, label, explain, privateSessions, admin, githubSessions, assignable })), members: reply.members.map((m) => ({ ...m, access: roleOf(m), accessDiffers: roleDiffers(m) })) }
    : reply);
  const list = withRoles({ members, requests, hosted, names, slack: null });
  const posted = [];
  const heard = {};
  const W = {
    h, settingsTabs: () => element('nav'), scopePill: () => element('span'), sameLogin: (a, b) => String(a).toLowerCase() === String(b).toLowerCase(),
    personText: (l) => `@${l}`, ago: () => 'just now', shell: { toast() {} },
    settingsPage: (_match, start) => start(app, { nav: () => element('nav'), interval: () => {}, on: (_target, name, fn) => { heard[name] = fn; } }),
    getJson: async (path) => (path === '/api/me' ? { login: 'ana-owner' } : list),
    postJson: async (path, body) => { posted.push([path, body]); return withRoles(await addReply(body)); },
  };
  const context = vm.createContext({ window: { Woodshed: W, confirm: (text) => { asked.push(text); return confirm(text); }, alert() {} }, document: { activeElement: null } });
  vm.runInContext(rowsSource, context);
  vm.runInContext(source, context);
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  const find = (pred) => walk(app).find(pred);
  // The form is in the box's last row, which opens in place.
  const openInvite = () => { if (!find((e) => e.attrs.id === 'invite-form')) find((e) => e.attrs.id === 'invite-card-head').listeners.click(); };
  async function add(login) {
    openInvite();
    find((e) => e.attrs.id === 'invite').value = login;
    await find((e) => e.attrs.id === 'invite-form').listeners.submit({ preventDefault() {} });
  }
  const hint = () => { openInvite(); return textOf(find((e) => e.attrs.id === 'add-hint')); };
  const rowOf = (login) => find((e) => e.tag === 'tr' && textOf(e).includes(`@${login}`));
  return { asked, app, add, hint, rowOf, posted, find, heard };
}

const CORE_HINT = 'They can sign in straight away. Nothing is sent to them: tell them the link.';

test('a note from the program is shown under the person, muted, as text', async () => {
  const { rowOf } = await loadPage({
    members: [person('ana-owner', 'owner'), person('lee-dev', 'member', { note: 'hasn\'t signed in yet' }), person('bo-dev', 'member', { note: '<img src=x onerror=alert(1)>' })],
    addReply: () => null,
  });
  const meta = (login) => walk(rowOf(login)).find((e) => e.className === 'meta');
  assert.equal(textOf(meta('lee-dev')), 'hasn\'t signed in yet');
  assert.deepEqual(meta('bo-dev').children, ['<img src=x onerror=alert(1)>'], 'one text child, no element made from it');
  assert.equal(textOf(meta('ana-owner')), '', 'nothing for someone the program notes nothing about');
});

test('after an add, what the program says it did stands in for core\'s hint; with nothing said, core\'s hint stays', async () => {
  let told = 'We emailed them a link.';
  const members = [person('ana-owner', 'owner')];
  const { add, hint, posted } = await loadPage({
    members,
    addReply: (body) => ({ members: [...members, person(body.login, body.role)], requests: [], hosted: true, names: {}, slack: null, told }),
  });
  assert.equal(hint(), CORE_HINT, 'before any add');
  await add('lee-dev');
  assert.deepEqual([posted[0][0], posted[0][1].login], ['/api/people/add', 'lee-dev']);
  assert.equal(hint(), 'They can sign in straight away. We emailed them a link.');
  told = '<script>alert(1)</script>';
  await add('bo-dev');
  assert.match(hint(), /<script>alert\(1\)<\/script>$/, 'as text, since h makes a text node of it');
  told = null;
  await add('cy-dev');
  assert.equal(hint(), CORE_HINT, 'an add the program said nothing about');
});

test('after a failed add, the previous add\'s sentence is gone: core\'s hint shows with the error', async () => {
  const members = [person('ana-owner', 'owner')];
  let refuse = false;
  const { add, hint, app } = await loadPage({
    members,
    addReply: (body) => {
      if (refuse) throw new Error('Your plan has room for 2 people.');
      return { members: [...members, person(body.login, body.role)], requests: [], hosted: true, names: {}, slack: null, told: 'We emailed them a link.' };
    },
  });
  await add('lee-dev');
  assert.match(hint(), /We emailed them a link\.$/);
  refuse = true;
  await add('bo-dev');
  assert.equal(hint(), CORE_HINT, 'not the sentence about the add before');
  const error = walk(app).find((e) => e.className === 'form-error');
  assert.deepEqual([error.textContent, error.hidden], ['Your plan has room for 2 people.', false], 'the error shows beside it');
});

test('the page is groups: a plain row per person asking, the table in Members\' box, and inviting as its last row', async () => {
  const members = [{ login: 'ana-owner', admin: true, addedBy: null, addedAt: '2026-11-01T00:00:00.000Z', how: 'first to sign in' }];
  const { app, find, posted, heard } = await loadPage({
    members, hosted: false, requests: [{ login: 'lee-dev', askedAt: '2026-11-19T00:00:00.000Z' }],
    addReply: () => ({ members, requests: [], hosted: false, names: {}, slack: null }),
  });
  const group = (id) => find((e) => e.attrs.id === id && e.className === 'set-group');
  assert.match(textOf(group('requests')), /^Asking to join · 1/);
  const asking = find((e) => e.attrs.id === 'request-lee-dev');
  assert.equal(asking.className, 'set-fold is-plain', 'nothing to open: its answer is on the row');
  assert.deepEqual(walk(asking).filter((e) => e.tag === 'button').map(textOf), ['Accept', 'Decline']);
  const box = walk(group('members')).find((e) => e.className === 'set-rows-box');
  assert.deepEqual(box.children.map((c) => c.className), ['table-scroll', 'set-fold'], 'the table, then the row that invites');
  assert.equal(find((e) => e.attrs.id === 'invite-form'), undefined, 'the form is drawn once its row is open');
  assert.match(textOf(find((e) => e.attrs.id === 'invite-card')), /^Invite someone/);
  // The search names the row: it opens.
  heard['woodshed:settings-reveal']({ detail: { id: 'invite-card' } });
  assert.equal(find((e) => e.attrs.id === 'invite-card').className, 'set-fold is-open');
  assert.ok(find((e) => e.attrs.id === 'invite-form'));
  await walk(asking).find((e) => textOf(e) === 'Accept').listeners.click({ currentTarget: {} });
  assert.equal(JSON.stringify(posted), JSON.stringify([['/api/people/accept', { login: 'lee-dev' }]]));
  assert.equal(walk(app).find((e) => e.attrs.id === 'requests'), undefined, 'the group goes when nobody asks');
});

test('each member has a Role select and what that role can do; picking one posts it, and Add someone takes one', async () => {
  const members = [person('ana-owner', 'owner'), person('lee-dev', 'member'), person('bo-dev', 'member', { githubSessions: false })];
  const { rowOf, posted, find, add, hint } = await loadPage({
    members,
    addReply: (body) => (body.access ? { members: members.map((m) => (m.login === body.login ? { ...m, assignable: true } : m)), requests: [], hosted: true, names: {}, slack: null } : null),
  });
  const head = walk(find((e) => e.tag === 'thead')).filter((e) => e.tag === 'th').map(textOf);
  assert.deepEqual(head, ['Member', 'Role', 'What they can do', 'Remove'], 'one Role column in place of a tick per switch');
  const select = (login) => walk(rowOf(login)).find((e) => e.tag === 'select');
  assert.deepEqual(select('lee-dev').children.map(textOf), ['Owner', 'Member', 'Contributor', 'Private only']);
  const picked = (login) => textOf(select(login).children.find((o) => 'selected' in o.attrs));
  assert.deepEqual(['ana-owner', 'lee-dev', 'bo-dev'].map(picked), ['Owner (partly)', 'Contributor', 'Private only']);
  const can = (login) => textOf(walk(rowOf(login)).find((e) => e.className === 'role-can'));
  assert.match(can('lee-dev'), /^Starts sessions from GitHub and sees Everyone, but is never assigned/);
  assert.match(can('bo-dev'), /^Their own My Woodshed sessions only/);
  assert.equal(can('ana-owner'), 'Opens these settings pages, starts sessions from GitHub, never assigned a shared session', 'an owner with a switch off says what they have');

  await select('lee-dev').listeners.change({ currentTarget: { value: 'member', disabled: false } });
  assert.equal(JSON.stringify(posted.at(-1)), JSON.stringify(['/api/people/access', { login: 'lee-dev', access: 'member' }]));
  assert.equal(picked('lee-dev'), 'Member', 'drawn from the answer');

  hint();
  const picker = find((e) => e.attrs.id === 'add-role');
  const pickRows = () => walk(find((e) => e.attrs.id === 'add-role')).filter((e) => e.tag === 'tr');
  assert.deepEqual(pickRows().map((tr) => tr.children.slice(0, 5).map(textOf)), [
    ['Role', 'Private sessions', 'Settings pages', 'Sessions from GitHub', 'Can be assigned'],
    [' Owner', 'Yes', 'Yes', 'Yes', 'Yes'], [' Member', 'Yes', 'No', 'Yes', 'Yes'], [' Contributor', 'Yes', 'No', 'Yes', 'No'], [' Private only', 'Yes', 'No', 'No', 'No'],
  ], 'the roles as a table, each power a word');
  assert.match(textOf(pickRows()[3]), /never assigned a shared session$/, 'and what the role can do, in words');
  assert.ok(picker);
  const pickedRow = () => pickRows().findIndex((tr) => tr.className === 'is-picked');
  assert.equal(pickedRow(), 3, 'someone new behind a proxy starts as a Contributor, as before roles');
  pickRows()[2].listeners.click();
  assert.equal(pickedRow(), 2, 'a click on a row picks it');
  await add('cy-dev');
  assert.equal(JSON.stringify(posted.at(-1)), JSON.stringify(['/api/people/add', { login: 'cy-dev', access: 'member' }]));
});

test('on a console of its own, someone invited starts as Private only unless another role is picked', async () => {
  const members = [{ login: 'ana-owner', admin: true, addedBy: null, addedAt: '2026-11-01T00:00:00.000Z', how: 'first to sign in' }];
  const { add, posted } = await loadPage({ members, hosted: false, addReply: () => ({ members, requests: [], hosted: false, names: {}, slack: null }) });
  await add('lee-dev');
  assert.equal(JSON.stringify(posted.at(-1)), JSON.stringify(['/api/people/invite', { login: 'lee-dev', access: 'private' }]));
});

test('an owner whose switches are not all on reads as Owner (partly), and picking Owner sends the change', async () => {
  const first = { login: 'ana-owner', admin: true, addedBy: null, addedAt: '2026-11-01T00:00:00.000Z', how: 'first to sign in' };
  const { rowOf, posted } = await loadPage({
    members: [first], hosted: false,
    addReply: () => ({ members: [{ ...first, githubSessions: true, assignable: true }], requests: [], hosted: false, names: {}, slack: null }),
  });
  const select = () => walk(rowOf('ana-owner')).find((e) => e.tag === 'select');
  const picked = () => select().children.filter((o) => 'selected' in o.attrs).map(textOf);
  assert.deepEqual(select().children.map(textOf), ['Owner (partly)', 'Owner', 'Member', 'Contributor', 'Private only']);
  assert.deepEqual(picked(), ['Owner (partly)'], 'not Owner, so Owner can be picked');
  await select().listeners.change({ currentTarget: { value: 'owner', disabled: false } });
  assert.equal(JSON.stringify(posted.at(-1)), JSON.stringify(['/api/people/access', { login: 'ana-owner', access: 'owner' }]));
  assert.deepEqual(picked(), ['Owner'], 'a full Owner now, with no partly');
  assert.equal(select().children.length, 4);
});

test('making yourself anything but an owner is asked first; a no leaves the select and sends nothing', async () => {
  let answer = false;
  const members = [person('ana-owner', 'owner', { assignable: true }), person('lee-dev', 'owner', { assignable: true })];
  const { rowOf, posted, asked } = await loadPage({
    members, confirm: () => answer,
    addReply: (body) => ({ members: members.map((m) => (m.login === body.login ? { ...m, admin: false, role: 'member' } : m)), requests: [], hosted: true, names: {}, slack: null }),
  });
  const select = (login) => walk(rowOf(login)).find((e) => e.tag === 'select');
  const mine = { value: 'member', disabled: false };
  await select('ana-owner').listeners.change({ currentTarget: mine });
  assert.deepEqual(asked, ['Make yourself a Member? You stop being an owner at once and lose these settings pages. Only another owner can make you one again.']);
  assert.equal(posted.length, 0, 'nothing sent on a no');
  assert.deepEqual([mine.value, mine.disabled], ['owner', false], 'and the select is back on Owner');

  answer = true;
  await select('ana-owner').listeners.change({ currentTarget: { value: 'contributor', disabled: false } });
  assert.match(asked.at(-1), /^Make yourself a Contributor\?/);
  assert.equal(JSON.stringify(posted.at(-1)), JSON.stringify(['/api/people/access', { login: 'ana-owner', access: 'contributor' }]), 'sent on a yes');

  await select('lee-dev').listeners.change({ currentTarget: { value: 'member', disabled: false } });
  assert.equal(asked.length, 2, 'someone else\'s role is not asked about');
  assert.equal(posted.length, 2);
});

test('members are grouped by role in the roles\' order, by name within each, with their personal tokens', async () => {
  const member = (login, fields) => person(login, 'member', { assignable: true, ...fields });
  const { app } = await loadPage({
    hosted: false,
    members: [
      person('sam-ops', 'private', { githubSessions: false, signIns: [] }),
      member('zed-qa', { signIns: ['Codex'] }),
      person('mia-dev', 'contributor', { signIns: ['GitHub'] }),
      member('constructor', { signIns: [] }),
      person('ana-owner', 'owner', { assignable: true, signIns: ['Claude', 'Codex', 'GitHub'] }),
      member('bo-dev', { signIns: ['Claude', 'Grok Build', 'OpenCode'] }),
      member('Abe', { signIns: [] }),
    ],
    // Named people sort by their name, the rest by handle: Bo Zhang after @Abe and before @constructor.
    names: { 'bo-dev': 'Bo Zhang', 'zed-qa': 'Ada Zed' },
    addReply: () => null,
  });
  const table = walk(app).find((e) => e.className === 'people-table');
  const bodies = table.children.filter((c) => c.tag === 'tbody');
  const heads = bodies.map((b) => walk(b).find((e) => e.tag === 'th'));
  assert.deepEqual(heads.map(textOf), ['Owner · 1', 'Member · 4', 'Contributor · 1', 'Private only · 1'], 'one body per role, in the select\'s order');
  assert.ok(heads.every((th) => th.attrs.scope === 'rowgroup'), 'each heading names the rows of its own body');
  const loginOf = (row) => walk(row).find((e) => e.tag === 'select').attrs['aria-label'].replace('Role: @', '');
  const logins = (body) => body.children.filter((r) => r.className !== 'role-head').map(loginOf);
  assert.deepEqual(bodies.map(logins), [['ana-owner'], ['Abe', 'zed-qa', 'bo-dev', 'constructor'], ['mia-dev'], ['sam-ops']]);

  const columns = walk(table.children.find((c) => c.tag === 'thead')).filter((e) => e.tag === 'th').map(textOf);
  assert.ok(columns.includes('Personal tokens'));
  const tokens = (login) => {
    const row = bodies.flatMap((b) => b.children).find((r) => r.className !== 'role-head' && loginOf(r) === login);
    const cell = row.children.find((c) => c.className === 'sign-ins');
    return walk(cell).filter((e) => e.className === 'pill is-ok').map(textOf).join(', ') || textOf(cell);
  };
  assert.deepEqual(['ana-owner', 'bo-dev', 'zed-qa', 'mia-dev', 'constructor', 'sam-ops'].map(tokens),
    ['Claude, Codex, GitHub', 'Claude, Grok Build, OpenCode', 'Codex', 'GitHub', 'None', 'None']);
});

test('with no personal tokens in the reply (no My settings), there is no column for them', async () => {
  const { app } = await loadPage({ members: [person('ana-owner', 'owner')], addReply: () => null });
  const thead = walk(app).find((e) => e.tag === 'thead' && textOf(e).includes('Member'));
  assert.ok(!textOf(thead).includes('Personal tokens'));
});

test('a saved name equal to the handle still shows as the name, with the handle under it', async () => {
  const { rowOf } = await loadPage({ members: [person('ana-owner', 'owner'), person('lee', 'member')], names: { lee: 'lee' }, addReply: () => null });
  const cell = rowOf('lee').children[0];
  assert.equal(textOf(walk(cell).find((e) => e.tag === 'b')), 'lee');
  assert.equal(textOf(walk(cell).find((e) => e.className === 'meta')), '@lee');
});
