// My settings' repo rows (public/myRepoSettings.js), run the way the page loads it on a tiny DOM, against the
// real JSON API (repoSettings.mjs) over an in-memory secret store, as a person who can write to some repos and not others.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import { createRepoSettings, createRepoSettingsApi, repoSettingsRoute } from './repoSettings.mjs';
import { parseProject } from '../shared/project.mjs';

const layersSource = fs.readFileSync(new URL('./public/repoLayers.js', import.meta.url), 'utf8');
const source = fs.readFileSync(new URL('./public/myRepoSettings.js', import.meta.url), 'utf8');
const SECRET_MARK = 'zq9-my-page-value';

const PROJECTS = [
  { name: 'app', repo: 'acme/app', default: true },
  { name: 'tools', repo: 'acme/tools', default: false },
  { name: 'infra', repo: 'acme/infra', default: false },
];
const FILES = {
  app: parseProject({
    version: 1, env: { NODE_ENV: 'development' }, rules: '.woodshed/rules.md',
    envFiles: [
      { path: 'api/.env', secret: 'api-env', defaults: ['LOG_LEVEL=info'], overrides: ['PORT={{PORT}}'] },
      { path: 'web/.env.local' },
    ],
  }),
  tools: parseProject({ version: 1, envFiles: [{ path: 'tools/.env' }] }),
  infra: parseProject({ version: 1, envFiles: [{ path: 'infra/.env' }] }),
};

function element(tag) {
  return {
    tag, attrs: {}, listeners: {}, children: [], className: '', value: '', disabled: false, readOnly: false,
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(k, fn) { this.listeners[k] = fn; },
    append(c) { this.children.push(c); },
    replaceChildren(...c) { this.children = c; },
    focus() {},
    get textContent() { return textOf(this); },
    set textContent(v) { this.children = [String(v)]; },
  };
}

function textOf(el) {
  return typeof el === 'string' ? el : el.children.map(textOf).join('');
}

function walk(el, out = []) {
  if (typeof el === 'string') return out;
  out.push(el);
  for (const c of el.children) walk(c, out);
  return out;
}

const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 8; i += 1) await tick(); };

function memorySecrets() {
  const values = new Map();
  return {
    values,
    async read(name) { return values.has(name) ? values.get(name) : null; },
    async save(name, value) { values.set(name, value); },
    async remove(name) { values.delete(name); },
  };
}

async function call(api, { method, path, body, login }) {
  const route = repoSettingsRoute(path);
  if (!route) throw Object.assign(new Error('not found'), { status: 404 });
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = { method, async *[Symbol.asyncIterator]() { if (raw) yield raw; }, resume() {} };
  const res = { status: 0, text: '', writeHead(code) { this.status = code; }, end(t) { this.text = t; } };
  await api(req, res, { route, login });
  const answer = JSON.parse(res.text);
  if (res.status >= 400) throw Object.assign(new Error(answer.error), { status: res.status });
  return answer;
}

/**
 * The rows as sam-ops, who can write to app and tools but not infra (New session's check), with the person's own
 * default project `defaultProject`. `opened` is the repo whose row is open from the start (null for none, as the page
 * loads), and `part` the part of each open repo to show once it is read.
 */
async function loadCard({ search = '', before = null, defaultProject = 'app', admin = false, files = FILES, opened = 'app', part = 'env' } = {}) {
  const store = { state: { sessions: [] }, save() {} };
  const secrets = memorySecrets();
  const config = { projects: PROJECTS, repo: 'acme/app' };
  const readerOf = (name) => ({ async repoLayer() { const f = files[name]; return { envFiles: f.envFiles, env: f.env ?? {}, rules: f.rules ?? null, setup: null }; } });
  const repoSettings = createRepoSettings({ store, secrets, config, readerOf });
  if (before) await before({ repoSettings, store, secrets });
  const writes = ['app', 'tools'];
  const projectAccess = {
    view: async () => ({ projects: PROJECTS.filter((p) => writes.includes(p.name)).map(({ name, repo }) => ({ name, repo })), defaultProject }),
    forStart: async (_login, name) => (writes.includes(name) ? PROJECTS.find((p) => p.name === name) : null),
  };
  const api = createRepoSettingsApi({ repoSettings, config, projectAccess });
  const calls = [];
  const consoleCall = (method, path, body) => {
    calls.push({ method, path, ...(body !== undefined && { body: JSON.parse(JSON.stringify(body)) }) });
    return call(api, { method, path, body, login: 'sam-ops' });
  };
  const app = element('div');
  const asked = [];
  const h = (tag, attrs, ...children) => {
    const el = element(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(typeof c === 'object' ? c : String(c));
    return el;
  };
  const W = {
    h, when: (iso) => `at ${iso}`, isAdmin: () => admin,
    getJson: (path) => consoleCall('GET', path),
    postJson: (path, body) => consoleCall('POST', path, body),
  };
  const location = { pathname: '/settings', search, href: `http://console.test/settings${search}` };
  const history = { urls: [], replaceState(_s, _t, url) { this.urls.push(String(url)); } };
  const window = { Woodshed: W, confirm: (text) => { asked.push(text); return true; } };
  const context = vm.createContext({
    window, console, location, history, URL, URLSearchParams, TextEncoder,
    document: { getElementById: () => null, activeElement: null },
  });
  vm.runInContext(layersSource, context);
  vm.runInContext(source, context);
  // The page: My settings draws the rows among its others on each render, and keeps which are open (mySettings.js).
  const open = new Set(opened ? [`repo-${opened}`] : []);
  let card = null;
  const draw = () => { if (card) app.replaceChildren(...card.rows()); };
  const row = ({ id, title, value, pill, onOpen }, ...body) => h('section', { id, class: 'row' },
    h('button', { type: 'button', 'aria-expanded': String(open.has(id)), onclick: () => { if (open.has(id)) open.delete(id); else { open.add(id); onOpen?.(); } draw(); } }, title),
    h('span', { class: 'row-value' }, value), h('span', { class: 'row-pill' }, pill), open.has(id) ? body : null);
  card = window.WoodshedMyRepoSettings.create({ render: draw, row, isOpen: (id) => open.has(id), setOpen: (id) => open.add(id) });
  draw();
  await settle();
  if (part) await showPart(app, part);
  return { app, calls, asked, history, store, secrets, repoSettings };
}

const PARTS = { instructions: 'Instructions', env: 'Env files', files: 'Your files' };
/** Shows that part of every open repo. */
async function showPart(app, part) {
  for (const b of walk(app).filter((e) => e.tag === 'button' && textOf(e).replace(' •', '') === PARTS[part] && e.attrs['aria-pressed'] === 'false')) b.listeners.click();
  await settle();
}
const rowOf = (app, project) => walk(app).find((e) => e.attrs.id === `repo-${project}`);
const pillOf = (app, project) => textOf(rowOf(app, project).children.find((c) => c.className === 'row-pill'));
const valueOf = (app, project) => textOf(rowOf(app, project).children.find((c) => c.className === 'row-value'));

const buttons = (app, text) => walk(app).filter((e) => e.tag === 'button' && textOf(e).trim() === text);
const button = (app, text) => buttons(app, text)[0];
const editorOf = (app, id) => walk(app).find((e) => e.tag === 'textarea' && e.attrs.id === id);
// The key table's rows, as [key, repo, installation, yours, session, wins].
const tableRows = (app) => walk(app).filter((e) => e.tag === 'tbody').flatMap((b) => b.children.map((tr) => tr.children.map((td) => textOf(td))));
const tableHead = (app) => walk(app).filter((e) => e.tag === 'th').map(textOf);

async function type(app, id, text) {
  const editor = editorOf(app, id);
  editor.value = text;
  editor.listeners.input();
}

test('a row for each repo the person can write to, read only once it is opened, with the layers in order', async () => {
  const shut = await loadCard({ opened: null });
  assert.deepEqual(buttons(shut.app, 'acme/app').map((b) => b.attrs['aria-expanded']), ['false']);
  assert.deepEqual(shut.calls.map((c) => c.path), ['/api/my/repos'], 'no repo is read until its row is opened');
  assert.equal(pillOf(shut.app, 'app'), 'None of yours');

  const { app, calls } = await loadCard();
  assert.deepEqual(buttons(app, 'acme/app').map((b) => b.attrs['aria-expanded']), ['true']);
  assert.deepEqual(buttons(app, 'acme/tools').map((b) => b.attrs['aria-expanded']), ['false']);
  assert.equal(buttons(app, 'acme/infra').length, 0, 'a repo they cannot write to is not there');
  assert.deepEqual(calls.map((c) => c.path), ['/api/my/repos', '/api/my/repos/app']);
  const tags = walk(app).filter((e) => e.className === 'layer-tag').map(textOf);
  assert.deepEqual(tags.slice(0, 4), ['Repo', 'Installation', 'Person', 'Session'], 'the person\'s layer between the installation\'s and the session\'s');
  assert.match(textOf(app), /Your values/);
  assert.deepEqual(tableHead(app), ['Key', 'Repo', 'Installation', 'Yours', 'Session', 'Wins']);
  assert.deepEqual(tableRows(app), [['LOG_LEVEL', '✓', '', '', '', 'Repo'], ['PORT', '', '', '', '✓', 'Session']]);
  assert.ok(editorOf(app, 'my-env-app-api-env'), 'nothing of theirs yet: the editor is open');
});

test('saving your own values posts them to your repo settings, and the table shows Yours', async () => {
  const { app, calls, secrets, store } = await loadCard();
  await type(app, 'my-env-app-api-env', `LOG_LEVEL=debug\nAPI_TOKEN=${SECRET_MARK}\n`);
  button(app, 'Save').listeners.click();
  await settle();
  assert.deepEqual(calls.at(-1), { method: 'POST', path: '/api/my/repos/app/env/api-env', body: { text: `LOG_LEVEL=debug\nAPI_TOKEN=${SECRET_MARK}\n` } });
  assert.equal(secrets.values.get('users/sam-ops/repos/app/env/api-env'), `LOG_LEVEL=debug\nAPI_TOKEN=${SECRET_MARK}\n`);
  assert.deepEqual(tableRows(app), [
    ['LOG_LEVEL', '✓', '', '✓', '', 'Yours'],
    ['API_TOKEN', '', '', '✓', '', 'Yours'],
    ['PORT', '', '', '', '✓', 'Session'],
  ]);
  assert.ok(!textOf(walk(app).find((e) => e.tag === 'table')).includes(SECRET_MARK));
  assert.match(textOf(app), /Saved\. Your next private session on acme\/app writes them into api\/\.env/);
  assert.equal(pillOf(app, 'app'), 'Yours');
  assert.equal(valueOf(app, 'app'), 'Your values for 1 env file', 'the repo\'s row says what is kept');
  assert.equal(buttons(app, 'Env files •').length, 1, 'and its part is marked');
  assert.ok(!JSON.stringify(store.state).includes(SECRET_MARK));
});

test('env files that share a key are one tab naming both paths, and your values are written to both', async () => {
  const shared = parseProject({
    version: 1, env: {},
    envFiles: [
      { path: 'api/.env', secret: 'app-env', defaults: ['LOG_LEVEL=info'], overrides: ['PORT=8080'] },
      { path: 'worker/.env', secret: 'app-env', overrides: ['ROLE=worker'] },
    ],
  });
  const { app, calls, secrets } = await loadCard({ files: { ...FILES, app: shared } });
  assert.match(textOf(app), /app-env → api\/\.env, worker\/\.env/);
  assert.match(textOf(app), /These values are written to both files, api\/\.env, worker\/\.env, which name the secret app-env\./);
  await type(app, 'my-env-app-app-env', 'LOG_LEVEL=debug\n');
  button(app, 'Save').listeners.click();
  await settle();
  assert.deepEqual(calls.at(-1), { method: 'POST', path: '/api/my/repos/app/env/app-env', body: { text: 'LOG_LEVEL=debug\n' } });
  assert.deepEqual([...secrets.values.keys()], ['users/sam-ops/repos/app/env/app-env'], 'one value for both files');
  assert.match(textOf(app), /writes them into api\/\.env and worker\/\.env;/);
  assert.deepEqual(tableRows(app), [
    ['LOG_LEVEL in api/.env', '✓', '', '✓', '', 'Yours'],
    ['LOG_LEVEL in worker/.env', '', '', '✓', '', 'Yours'],
    ['PORT in api/.env', '', '', '', '✓', 'Session'],
    ['ROLE in worker/.env', '', '', '', '✓', 'Session'],
  ]);
});

test('the installation\'s values are read only, behind Show, and one read fills both layers', async () => {
  const { app, calls } = await loadCard({
    before: async ({ repoSettings }) => {
      await repoSettings.saveInstallation({ project: 'app', key: 'api-env', text: `API_URL=http://inst\nSHARED=${SECRET_MARK}\n`, by: 'mia-dev' });
      await repoSettings.saveOwn({ login: 'sam-ops', project: 'app', key: 'api-env', text: 'LOG_LEVEL=debug\n' });
    },
  });
  assert.ok(!textOf(app).includes(SECRET_MARK));
  assert.equal(editorOf(app, 'my-env-app-api-env'), undefined, 'theirs, saved, is hidden too');
  assert.match(textOf(app), /Saved at .* · by @mia-dev · \d+ bytes · 2 keys/);
  button(app, 'Show').listeners.click();
  await settle();
  assert.deepEqual(calls.at(-1), { method: 'GET', path: '/api/my/repos/app/env/api-env' });
  const pre = walk(app).find((e) => e.tag === 'pre' && textOf(e).includes('API_URL'));
  assert.equal(textOf(pre), `API_URL=http://inst\nSHARED=${SECRET_MARK}\n`);
  assert.equal(walk(app).filter((e) => e.tag === 'textarea' && textOf(e).includes('API_URL')).length, 0, 'not an editor');
  assert.equal(editorOf(app, 'my-env-app-api-env').value, 'LOG_LEVEL=debug\n');
  assert.deepEqual(tableRows(app)[0], ['LOG_LEVEL', '✓', '', '✓', '', 'Yours']);
  assert.match(textOf(app), /Set by your admins, for every session on this repo\./);
});

test('Clear mine asks first and empties your layer', async () => {
  const { app, asked, secrets } = await loadCard({
    before: ({ repoSettings }) => repoSettings.saveOwn({ login: 'sam-ops', project: 'app', key: 'api-env', text: 'A=1\n' }),
  });
  button(app, 'Show and edit').listeners.click();
  await settle();
  button(app, 'Clear mine').listeners.click();
  await settle();
  assert.deepEqual(asked, ['Clear your own values for api/.env? Your sessions then get this installation\'s alone.']);
  assert.equal(secrets.values.has('users/sam-ops/repos/app/env/api-env'), false);
  assert.match(textOf(app), /Cleared\. Your sessions get the repo's defaults and this installation's values alone\./);
});

test('your instructions: the installation\'s are shown read only, yours are counted, saved, and a credential is refused', async () => {
  const { app, secrets, calls } = await loadCard({
    part: 'instructions',
    before: ({ repoSettings }) => repoSettings.saveInstallation({ project: 'app', text: 'Keep pull requests small.\n', by: 'mia-dev' }),
  });
  assert.deepEqual(calls.map((c) => c.path), ['/api/my/repos', '/api/my/repos/app', '/api/my/repos/app/instructions'], 'read on load, as the admin page does');
  assert.ok(walk(app).some((e) => e.tag === 'pre' && textOf(e) === 'Keep pull requests small.\n'));
  await type(app, 'my-instructions-app', 'Explain each change.\n');
  assert.match(textOf(app), /21 of 16,384 bytes/);
  const instructionsSave = () => button(app, 'Save');
  instructionsSave().listeners.click();
  await settle();
  assert.equal(secrets.values.get('users/sam-ops/repos/app/instructions'), 'Explain each change.\n');
  assert.match(textOf(app), /Saved\. Your next private session on this repo has them in its prompt/);

  await type(app, 'my-instructions-app', `Use sk-ant-${'a'.repeat(40)} for it.\n`);
  instructionsSave().listeners.click();
  await settle();
  const error = walk(app).find((e) => e.className === 'form-error');
  assert.match(textOf(error), /put secrets in an env file's values instead/);
  assert.ok(!textOf(error).includes('sk-ant-'));
});

test('?repo= opens that repo\'s row, and ?file= its env file; opening another puts it in the URL, and both stay open', async () => {
  const { app, history, calls } = await loadCard({ search: '?repo=tools', opened: null });
  assert.deepEqual(buttons(app, 'acme/tools').map((b) => b.attrs['aria-expanded']), ['true']);
  assert.deepEqual(buttons(app, 'acme/app').map((b) => b.attrs['aria-expanded']), ['false']);
  assert.match(textOf(app), /tools\/\.env/);
  assert.ok(calls.some((c) => c.path === '/api/my/repos/tools'));
  assert.ok(!calls.some((c) => c.path === '/api/my/repos/app'));
  button(app, 'acme/app').listeners.click();
  await settle();
  assert.deepEqual(history.urls, ['http://console.test/settings?repo=app']);
  assert.deepEqual(['app', 'tools'].map((name) => button(app, `acme/${name}`).attrs['aria-expanded']), ['true', 'true']);
  await showPart(app, 'env');
  assert.match(textOf(rowOf(app, 'tools')), /tools\/\.env/, 'the first repo is still open on its own file');
  button(app, 'web/.env.local').listeners.click();
  assert.equal(history.urls.at(-1), 'http://console.test/settings?repo=app&file=web-env-local');

  const linked = await loadCard({ search: '?repo=app&file=web-env-local', opened: null, part: null });
  assert.deepEqual(buttons(linked.app, 'web/.env.local').map((b) => b.attrs['aria-pressed']), ['true'], 'a link to an env file opens on Env files');
});

test('a link to a repo they cannot write to opens no row, and reads nothing of it', async () => {
  const { app, calls } = await loadCard({ search: '?repo=infra', defaultProject: 'tools', opened: null });
  assert.deepEqual(walk(app).filter((e) => e.tag === 'button').map((b) => b.attrs['aria-expanded']), ['false', 'false']);
  assert.deepEqual(calls.map((c) => c.path), ['/api/my/repos']);
});

test('an env file with no installation value names no Terraform secret on the installation\'s layer', async () => {
  const { app } = await loadCard();
  assert.doesNotMatch(textOf(app), /Terraform secret/);
});

test('an admin is pointed at the repo\'s page on Console settings for the installation\'s values', async () => {
  const { app } = await loadCard({ admin: true });
  const link = walk(app).find((e) => e.tag === 'a' && textOf(e) === 'change it in Settings');
  assert.equal(link.attrs.href, '/console-settings/repos/app');
});

const inputOf = (app, id) => walk(app).find((e) => e.attrs.id === id);

test('your files are each repo\'s own: added, opened, removed, and another repo\'s row has none of them', async () => {
  const { app, calls, secrets, asked } = await loadCard({ part: 'files' });
  assert.match(textOf(app), /Your files/);
  assert.match(textOf(app), /Whole files your private sessions on acme\/app write into its checkout/);
  assert.ok(!calls.some((c) => c.path.endsWith('/files')), 'with none listed, nothing is read');
  inputOf(app, 'own-file-path-app').value = 'app/.env.production';
  editorOf(app, 'own-file-text-app').value = `NOTION_TOKEN=${SECRET_MARK}\n`;
  buttons(app, 'Save').at(-1).listeners.click();
  await settle();
  assert.deepEqual(calls.at(-1), { method: 'POST', path: '/api/my/repos/app/files', body: { path: 'app/.env.production', text: `NOTION_TOKEN=${SECRET_MARK}\n` } });
  assert.deepEqual(JSON.parse(secrets.values.get('users/sam-ops/repos/app/files')), { 'app/.env.production': `NOTION_TOKEN=${SECRET_MARK}\n` });
  assert.match(textOf(app), /Saved app\/\.env\.production\. Your next private session on acme\/app writes it/);
  assert.deepEqual(buttons(app, 'app/.env.production').map((b) => b.attrs['aria-pressed']), ['true'], 'the saved file is open');
  assert.equal(inputOf(app, 'own-file-path-app').readOnly, true, 'a saved file keeps its path');
  assert.equal(pillOf(app, 'app'), 'Yours');
  assert.equal(valueOf(app, 'app'), 'Your 1 file');

  button(app, 'acme/tools').listeners.click();
  await settle();
  await showPart(app, 'files');
  const tools = { children: [rowOf(app, 'tools')] };
  assert.equal(buttons(tools, 'app/.env.production').length, 0, 'the tools repo has none of app\'s files');
  assert.equal(inputOf(app, 'own-file-path-tools').value, '');
  assert.equal(editorOf(app, 'own-file-text-tools').value, '');
  assert.equal(editorOf(app, 'own-file-text-app').value, `NOTION_TOKEN=${SECRET_MARK}\n`, 'app, still open beside it, keeps its file');
  button(app, 'Remove').listeners.click();
  await settle();
  assert.match(asked.at(-1), /Remove app\/\.env\.production\? Your next sessions on acme\/app no longer write it/);
  assert.equal(secrets.values.has('users/sam-ops/repos/app/files'), false);
  assert.match(textOf(app), /Removed app\/\.env\.production\./);
});

test('saved files are read when the repo\'s files are shown, and a refused path says why', async () => {
  const { app, calls } = await loadCard({
    part: 'files',
    before: ({ repoSettings }) => repoSettings.saveOwnFile({ login: 'sam-ops', project: 'app', path: '.mcp.local.json', text: '{}' }),
  });
  assert.ok(calls.some((c) => c.path === '/api/my/repos/app/files'));
  assert.equal(editorOf(app, 'own-file-text-app').value, '{}', 'the first file is open');
  button(app, '+ Add a file').listeners.click();
  inputOf(app, 'own-file-path-app').value = 'api/.env';
  editorOf(app, 'own-file-text-app').value = 'X=1';
  buttons(app, 'Save').at(-1).listeners.click();
  await settle();
  assert.match(textOf(walk(app).find((e) => e.className === 'form-error')), /api\/\.env is one of acme\/app's env files/);
  button(app, '+ Add a file').listeners.click();
  inputOf(app, 'own-file-path-app').value = 'a.txt';
  editorOf(app, 'own-file-text-app').value = '  ';
  const before = calls.length;
  buttons(app, 'Save').at(-1).listeners.click();
  await settle();
  assert.equal(calls.length, before, 'an empty file is not sent');
  assert.match(textOf(app), /Write the file's text first/);
});
