// My settings' Remote Control login card (public/claudeLoginCard.js), run the way the page loads it on a tiny DOM,
// against the console's real handler (server.mjs) and userSettings.mjs over an in-memory secret store. Made-up values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import vm from 'node:vm';

import { createHandler } from './server.mjs';
import { createUserSettings } from './userSettings.mjs';

const source = fs.readFileSync(new URL('./public/claudeLoginCard.js', import.meta.url), 'utf8');
const LOGIN = { accessToken: 'fake-access-zq6', refreshToken: 'fake-refresh-zq6', expiresAt: 1000, scopes: ['user:inference'] };

function element(tag) {
  return {
    tag, attrs: {}, listeners: {}, children: [], className: '', disabled: false,
    classList: { add() {}, remove() {} },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(k, fn) { this.listeners[k] = fn; },
    append(c) { this.children.push(c); },
    get textContent() { return textOf(this); },
    set textContent(v) { this.children = [String(v)]; },
  };
}
const textOf = (el) => (typeof el === 'string' ? el : el.children.map(textOf).join(''));
const walk = (el, out = []) => {
  if (typeof el === 'string') return out;
  out.push(el);
  el.children.forEach((c) => walk(c, out));
  return out;
};
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 5)); };

function h(tag, attrs, ...children) {
  const el = element(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(typeof c === 'object' ? c : String(c));
  return el;
}

async function loadPage(t, { sessions }) {
  const values = new Map();
  const secrets = { async read(n) { return values.get(n) ?? null; }, async save(n, v) { values.set(n, v); }, async remove(n) { values.delete(n); } };
  const store = { state: { people: { octocat: { claudeTokenAt: '2026-11-01T00:00:00.000Z' } } }, save() {} };
  const userSettings = createUserSettings({ store, secrets });
  const fleet = { sessions: () => sessions, find: () => null };
  const auth = { enabled: () => true, available: () => true, sessionFor: async () => ({ login: 'octocat' }) };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const handle = createHandler({ config, fleet, auth, userSettings });
  const server = http.createServer((req, res) => { handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const answers = [];
  const call = (method, path, body) => new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path,
      headers: { host: `localhost:${port}`, origin: `http://localhost:${port}`, 'x-woodshed': '1', 'content-type': 'application/json', cookie: 'woodshed_session=x' },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        answers.push(raw);
        const parsed = JSON.parse(raw);
        return res.statusCode >= 400 ? reject(new Error(parsed.error)) : resolve(parsed);
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });

  let me = await call('GET', '/api/my');
  const app = element('div');
  const asked = [];
  const window = { Woodshed: { h, when: (iso) => `at ${iso}`, postJson: (path, body) => call('POST', path, body) }, confirm: (text) => { asked.push(text); return true; } };
  vm.runInContext(source, vm.createContext({ window, console }));
  let card = null;
  const render = () => { if (card) app.children = [card.card()].filter(Boolean); };
  card = window.WoodshedClaudeLoginCard.create({ me: () => me, setMe: (answer) => { me = answer; }, render });
  const reload = async () => { me = await call('GET', '/api/my'); render(); };
  render();
  return { app, asked, values, answers, logins: userSettings.claudeLogin, reload };
}

const pillOf = (app) => walk(app).find((e) => e.className?.startsWith('pill'));

test('the card says when nothing is saved, then saved, refreshed and in use by which session, and Forget takes it all', async (t) => {
  const sessions = [{ id: 'aaaa1111', status: 'running', owner: 'octocat' }];
  const { app, asked, values, answers, logins, reload } = await loadPage(t, { sessions });
  assert.equal(textOf(pillOf(app)), 'Not saved');
  assert.equal(walk(app).filter((e) => e.tag === 'button').length, 0, 'nothing to forget');
  assert.match(textOf(app), /30 days after the first/);

  await logins.writeBack('octocat', { sessionId: 'aaaa1111', fresh: true, value: { claudeAiOauth: LOGIN } });
  await reload();
  assert.equal(textOf(pillOf(app)), 'In use');
  assert.equal(pillOf(app).className, 'pill is-work');
  assert.match(textOf(app), /In use by session aaaa1111/);
  assert.equal(walk(app).find((e) => e.tag === 'a')?.attrs.href, '/s/aaaa1111');
  assert.match(textOf(app), /Saved at 20\d\d-/);

  await logins.writeBack('octocat', { sessionId: 'aaaa1111', generation: 1, value: { claudeAiOauth: { ...LOGIN, expiresAt: 2000 } } });
  sessions[0].status = 'stopped';
  await reload();
  assert.equal(textOf(pillOf(app)), 'Saved');
  assert.match(textOf(app), /No session is using it/);

  walk(app).find((e) => e.tag === 'button' && textOf(e) === 'Forget').listeners.click();
  await settle();
  assert.match(asked[0], /Forget your saved Claude login/);
  assert.equal(textOf(pillOf(app)), 'Not saved');
  assert.match(textOf(app), /Forgotten\./);
  assert.equal(values.has('users/octocat/claude-login'), false);
  assert.ok(!answers.some((a) => a.includes('fake-access-zq6') || a.includes('fake-refresh-zq6')), 'the page is never sent the login');
});
