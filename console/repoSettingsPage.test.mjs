// A repo's settings page (public/repoSettings.js), run the way a page loads it on a tiny DOM, against the real JSON API
// (repoSettings.mjs) over an in-memory secret store: what the page draws is what the console answers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import { createRepoSettings, createRepoSettingsApi, repoSettingsRoute } from './repoSettings.mjs';
import { createSlack } from './slack.mjs';
import { trusted } from './settingsMarkup.mjs';
import { parseProject } from '../shared/project.mjs';

const rowsSource = fs.readFileSync(new URL('./public/settingsRows.js', import.meta.url), 'utf8');
const layersSource = fs.readFileSync(new URL('./public/repoLayers.js', import.meta.url), 'utf8');
const source = fs.readFileSync(new URL('./public/repoSettings.js', import.meta.url), 'utf8');
const pickerSource = fs.readFileSync(new URL('./public/slackSetup.js', import.meta.url), 'utf8');
const SECRET_MARK = 'zq9-page-value';

const PROJECTS = [{ name: 'app', repo: 'acme/app', default: true }, { name: 'tools', repo: 'acme/tools', default: false }];
const APP_FILE = parseProject({
  version: 1, env: { NODE_ENV: 'development' }, rules: '.woodshed/rules.md',
  envFiles: [
    { path: 'api/.env', secret: 'api-env', defaults: ['LOG_LEVEL=info'], overrides: ['PORT={{PORT}}', 'ANTHROPIC_API_KEY={{ANTHROPIC_API_KEY?}}'] },
    { path: 'web/.env.local' },
  ],
});

function element(tag) {
  return {
    tag, attrs: {}, listeners: {}, children: [], className: '', value: '', disabled: false, readOnly: false,
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(k, fn) { this.listeners[k] = fn; },
    append(c) { this.children.push(c); },
    replaceChildren(...c) { this.children = c; },
    focus() { this.focused = true; },
    scrollIntoView(opts) { this.scrolledTo = opts; },
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
const settle = async () => { for (let i = 0; i < 5; i += 1) await tick(); };

function memorySecrets() {
  const values = new Map();
  return {
    values, fail: null,
    async read(name) { if (this.fail) throw this.fail; return values.has(name) ? values.get(name) : null; },
    async save(name, value) { if (this.fail) throw this.fail; values.set(name, value); },
    async remove(name) { values.delete(name); },
  };
}

// The console's answer to one call, as common.js's getJson and postJson see it: the body, or an Error with its status.
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

const CHANNEL_PATH = '/api/console-settings/projects/slack-channel';
const TRIGGERS_PATH = '/api/console-settings/projects/triggers';
const TRIGGERS = { label: 'woodshed', consoleLabel: 'woodshed', labelSet: false, labels: true, comments: false };
const CHANNELS = {
  found: [
    { id: 'C0APPPRS01', name: 'app-prs', private: false, member: true },
    { id: 'G0RELEASE1', name: 'releases', private: true, member: true },
    { id: 'C0GENERAL1', name: 'general', private: false, member: false },
  ],
  truncated: false, total: 3,
};

// The repo's Slack channel as the server adds it to the view, and its save as the server answers it: Console settings'
// view, the repo's channel in its row.
function slackOf(slack) {
  return (name) => ({ channel: slack.projectChannel(name), consoleChannel: slack.view().channel, canPost: slack.view().canPost });
}

function channelCall(slack, body) {
  try {
    slack.setProjectChannel({ project: body.name, channel: body.channel, by: 'mia-dev' });
  } catch (err) {
    if (err.shown) return Promise.reject(Object.assign(new Error(err.message), { status: 400 }));
    throw err;
  }
  return Promise.resolve({ slack: slack.view(), projects: PROJECTS.map((p) => ({ ...p, slackChannel: slack.projectChannel(p.name) })) });
}

/**
 * The page for `project`, signed in as an admin unless `admin` is false (the server's ADMIN_API_RE answers 403 then).
 * `triggers` is the repo's label and switches as repoTriggers.mjs answers them; left out, the page has no GitHub group.
 * `slack` is the console's Slack settings, {consoleChannel, channels: {<project>: channel}}; left out, it has none.
 * The page is rows that open in place: `opened` is 'all' to open every row once it is drawn, as most tests read a
 * row's body, or the ids of the rows to open ([] leaves the page as a link to it finds it).
 * @returns the page's root, the calls it made, and the console's state and secrets
 */
async function loadPage({ project = 'app', search = '', hash = '', file = APP_FILE, admin = true, before = null, confirmAnswer = true, slack: slackSettings = null, channels = CHANNELS, opened = 'all', triggers = null, triggersFail = null, hostGroups = null } = {}) {
  const store = { state: { sessions: [] }, save() {} };
  const secrets = memorySecrets();
  const config = { projects: PROJECTS, repo: 'acme/app' };
  const readerOf = () => ({
    async repoLayer() {
      if (file instanceof Error) throw file;
      return { envFiles: file.envFiles, env: file.env ?? {}, rules: file.rules ?? null, setup: file.setup ?? null };
    },
  });
  const repoSettings = createRepoSettings({ store, secrets, config, readerOf });
  if (before) await before({ repoSettings, store, secrets });
  store.state.settings = { slackChannel: slackSettings?.consoleChannel ?? '', projectSlackChannels: { ...slackSettings?.channels } };
  const slack = slackSettings && createSlack({ store, secrets });
  // The repo's label and switches, changed as the Repos card's API changes them.
  let now = triggers && { ...triggers };
  const api = createRepoSettingsApi({ repoSettings, config, slackOf: slack ? slackOf(slack) : null, triggersOf: () => now, hostGroups });
  const calls = [];
  const consoleCall = (method, path, body) => {
    // The page's objects are of its own realm: copied, so they compare as plain ones.
    calls.push({ method, path, ...(body !== undefined && { body: JSON.parse(JSON.stringify(body)) }) });
    if (!admin) return Promise.reject(Object.assign(new Error('only an admin can do this'), { status: 403 }));
    if (path === TRIGGERS_PATH) {
      if (triggersFail) return Promise.reject(Object.assign(new Error(triggersFail), { status: 400 }));
      const { name: _name, ...change } = body;
      if ('label' in change) now = { ...now, label: change.label ?? now.consoleLabel, labelSet: change.label !== null };
      else now = { ...now, ...change };
      return Promise.resolve({ triggers: { ...now } });
    }
    if (path === CHANNEL_PATH) return slack ? channelCall(slack, body) : Promise.reject(Object.assign(new Error('this console posts nothing to Slack'), { status: 404 }));
    // The channel picker's list, as GET /api/console-settings/slack/channels answers it (slackSetup.mjs).
    if (path.startsWith('/api/console-settings/slack/channels')) return Promise.resolve(structuredClone(channels));
    return call(api, { method, path, body, login: 'mia-dev' });
  };
  const app = element('div');
  const confirms = [];
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
    h, nav: () => element('nav'), scopePill: () => element('span'), when: (iso) => `at ${iso}`, providerWords: {},
    settingsPage: (_match, start) => start(app, { nav: () => element('nav'), interval: (fn, ms) => context.setInterval?.(fn, ms), timeout: (fn, ms) => context.setTimeout(fn, ms), on: (target, type, fn) => target.addEventListener?.(type, fn) }),
    getJson: (path) => consoleCall('GET', path),
    postJson: (path, body) => consoleCall('POST', path, body),
    confirmChange: (opts) => { confirms.push(opts); },
  };
  const location = { pathname: `/console-settings/repos/${project}`, search, hash, href: `http://console.test/console-settings/repos/${project}${search}${hash}` };
  const history = { urls: [], replaceState(_s, _t, url) { this.urls.push(String(url)); } };
  // A program's markup is put in through a template, which keeps it as the text it was given here; hostRows.js wires it.
  const wired = [];
  const revealed = [];
  const events = [];
  const template = () => ({ set innerHTML(text) { this.content = { tag: '#markup', attrs: {}, children: [], markup: text }; } });
  const context = vm.createContext({
    window: {
      Woodshed: W, location, confirm: (text) => { asked.push(text); return confirmAnswer; },
      WoodshedHostRows: { wire: (node, opts) => wired.push({ node, opts }), reveal: (node, id) => revealed.push({ node, id }) },
      dispatchEvent: (e) => events.push({ type: e.type, inPage: walk(app).includes(e.detail?.node) }),
    }, console, location, history, URL, URLSearchParams, TextEncoder,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    document: { getElementById: (id) => walk(app).find((e) => e.attrs.id === id) ?? null, activeElement: null, createElement: (tag) => (tag === 'template' ? template() : element(tag)) },
    setTimeout: (fn) => setImmediate(fn), clearTimeout: () => {},
  });
  vm.runInContext(pickerSource, context);
  vm.runInContext(rowsSource, context);
  vm.runInContext(layersSource, context);
  vm.runInContext(source, context);
  await settle();
  if (opened === 'all') {
    for (let head = closedHead(app); head; head = closedHead(app)) head.listeners.click();
  } else {
    for (const id of opened) openRow(app, id);
  }
  await settle();
  return { app, calls, confirms, asked, history, store, secrets, repoSettings, wired, revealed, events, context };
}

// A row is a section with its id; its head is the button that opens and closes it.
const rowOf = (app, id) => walk(app).find((e) => e.tag === 'section' && e.attrs.id === id);
const headOf = (app, id) => walk(app).find((e) => e.attrs.id === `${id}-head`);
const closedHead = (app) => walk(app).find((e) => e.tag === 'button' && e.className === 'set-fold-head' && e.attrs['aria-expanded'] === 'false');
const openRow = (app, id) => headOf(app, id).listeners.click();
const isOpen = (app, id) => headOf(app, id)?.attrs['aria-expanded'] === 'true';
// The Env files group's rows, by the name each shows.
const fileRows = (app) => walk(groupOf(app, 'env-files')).filter((e) => e.tag === 'section').map((e) => textOf(walk(e).find((x) => x.className === 'set-name')));
const groupOf = (app, id) => walk(app).find((e) => e.className === 'set-group' && e.attrs.id === id);
// What a closed row says: its name, its value and its status word.
const headText = (app, id) => walk(rowOf(app, id)).filter((e) => ['set-name', 'set-help'].includes(e.className) || e.className?.startsWith('pill')).map(textOf);

const buttons = (app, text) => walk(app).filter((e) => e.tag === 'button' && textOf(e).trim() === text);
const button = (app, text) => buttons(app, text)[0];
const instructionsSave = (app) => buttons(rowOf(app, 'instructions'), 'Save')[0];
const editorOf = (app, id) => walk(app).find((e) => e.tag === 'textarea' && e.attrs.id === id);
// The key table's rows, as [key, repo, installation, session, wins].
const tableRows = (app) => walk(app).filter((e) => e.tag === 'tbody').flatMap((b) => b.children.map((tr) => tr.children.map((td) => textOf(td))));

async function type(app, id, text) {
  const editor = editorOf(app, id);
  editor.value = text;
  editor.listeners.input();
}

test('an env file shows its key and path, the repo\'s defaults, the session\'s wiring and which layer wins each key', async () => {
  const { app } = await loadPage();
  const text = textOf(app);
  assert.match(text, /acme\/app/);
  assert.match(text, /api\/\.env/);
  assert.match(text, /key api-env/);
  assert.match(text, /LOG_LEVEL=info/);
  assert.match(text, /Change it in \.woodshed\/project\.yaml/);
  const link = walk(app).find((e) => e.tag === 'a' && textOf(e).startsWith('.woodshed/project.yaml'));
  assert.equal(link.attrs.href, 'https://github.com/acme/app/blob/HEAD/.woodshed/project.yaml');
  assert.match(text, /Its overrides: PORT\./);
  assert.match(text, /Only when the session has a value for it: ANTHROPIC_API_KEY\./);
  assert.match(text, /The project file's env, set in every process: NODE_ENV\./);
  assert.deepEqual(tableRows(rowOf(app, 'file-api-env')), [
    ['LOG_LEVEL', '✓', '', '', 'Repo'],
    ['PORT', '', '', '✓', 'Session'],
    ['ANTHROPIC_API_KEY', '', '', '✓ if set', 'Session, if set'],
  ]);
  assert.deepEqual(fileRows(app), ['api/.env', 'web/.env.local'], 'a row an env file');
  assert.ok(editorOf(app, 'env-api-env'), 'nothing saved yet: the editor is open, empty');
});

// api/.env and worker/.env both name app-env, each with overrides of its own; web/.env.local is keyed by its path.
const SHARED_FILE = parseProject({
  version: 1, env: {},
  envFiles: [
    { path: 'api/.env', secret: 'app-env', defaults: ['LOG_LEVEL=info'], overrides: ['PORT=8080', 'SQL_URL={{PG_URL}}'] },
    { path: 'worker/.env', secret: 'app-env', overrides: ['ROLE=worker', 'SQL_URL={{PG_URL}}'] },
    { path: 'web/.env.local', overrides: ['PORT=5173'] },
  ],
});

test('env files that share a key are one row naming both paths, with a note, each file\'s defaults and overrides, and its rows where they differ', async () => {
  const { app, calls, secrets } = await loadPage({ file: SHARED_FILE, envFiles: [] });
  assert.deepEqual(fileRows(app), ['app-env → api/.env, worker/.env', 'web/.env.local']);
  const text = textOf(rowOf(app, 'file-app-env'));
  assert.match(text, /These values are written to both files, api\/\.env, worker\/\.env, which name the secret app-env\. Each keeps its own defaults and overrides\./);
  assert.match(text, /From the repoapi\/\.envLOG_LEVEL=infoworker\/\.envNo defaults\./, 'each file\'s defaults under its path');
  assert.match(text, /api\/\.envIts overrides: PORT, SQL_URL\.worker\/\.envIts overrides: ROLE, SQL_URL\./);
  assert.deepEqual(tableRows(rowOf(app, 'file-app-env')), [
    ['LOG_LEVEL in api/.env', '✓', '', '', 'Repo'],
    ['PORT in api/.env', '', '', '✓', 'Session'],
    ['SQL_URL', '', '', '✓', 'Session'],
    ['ROLE in worker/.env', '', '', '✓', 'Session'],
  ]);

  await type(app, 'env-app-env', 'LOG_LEVEL=warn\n');
  button(app, 'Save').listeners.click();
  await settle();
  assert.deepEqual(calls.at(-1), { method: 'POST', path: '/api/console-settings/repos/app/env/app-env', body: { text: 'LOG_LEVEL=warn\n' } });
  assert.deepEqual([...secrets.values.keys()], ['repos/app/env/app-env'], 'one value for both files');
  assert.match(textOf(app), /writes them into api\/\.env and worker\/\.env;/);
  assert.deepEqual(tableRows(app).slice(0, 2), [['LOG_LEVEL in api/.env', '✓', '✓', '', 'Installation'], ['LOG_LEVEL in worker/.env', '', '✓', '', 'Installation']]);
  assert.deepEqual(headText(app, 'file-app-env').slice(2), ['1 key set'], 'the row says what this installation sets');

  assert.doesNotMatch(textOf(rowOf(app, 'file-web-env-local')), /These values are written to/, 'a key of one file has no note');
});

test('saving a value posts it, and the table follows what the console answers', async () => {
  const { app, calls, secrets } = await loadPage();
  assert.equal(button(app, 'Save').disabled, true, 'nothing typed yet');
  await type(app, 'env-api-env', `LOG_LEVEL=warn\nAPI_TOKEN=${SECRET_MARK}\nPORT=1\n`);
  assert.equal(button(app, 'Save').disabled, false);
  button(app, 'Save').listeners.click();
  await settle();
  assert.deepEqual(calls.at(-1), { method: 'POST', path: '/api/console-settings/repos/app/env/api-env', body: { text: `LOG_LEVEL=warn\nAPI_TOKEN=${SECRET_MARK}\nPORT=1\n` } });
  assert.equal(secrets.values.get('repos/app/env/api-env'), `LOG_LEVEL=warn\nAPI_TOKEN=${SECRET_MARK}\nPORT=1\n`);
  assert.deepEqual(tableRows(rowOf(app, 'file-api-env')), [
    ['LOG_LEVEL', '✓', '✓', '', 'Installation'],
    ['API_TOKEN', '', '✓', '', 'Installation'],
    ['PORT', '', '✓', '✓', 'Session'],
    ['ANTHROPIC_API_KEY', '', '', '✓ if set', 'Session, if set'],
  ]);
  assert.ok(!textOf(walk(app).find((e) => e.tag === 'table')).includes(SECRET_MARK), 'the table names keys, never values');
  assert.match(textOf(app), /Saved\. The next session on acme\/app writes them into api\/\.env/);
  assert.match(textOf(app), /Saved at .* · by @mia-dev · 47 bytes · 3 keys/);
});

test('a saved value stays hidden until Show and edit, which reads it from the console', async () => {
  const { app, calls } = await loadPage({
    before: ({ repoSettings }) => repoSettings.saveInstallation({ project: 'app', key: 'api-env', text: `API_TOKEN=${SECRET_MARK}\n`, by: 'mia-dev' }),
  });
  assert.equal(editorOf(app, 'env-api-env'), undefined);
  assert.ok(!textOf(app).includes(SECRET_MARK));
  assert.match(textOf(app), /•••••••••••• 1 key, hidden/);
  assert.ok(!calls.some((c) => c.path.endsWith('/env/api-env')), 'nothing read before Show');
  button(app, 'Show and edit').listeners.click();
  await settle();
  assert.deepEqual(calls.at(-1), { method: 'GET', path: '/api/console-settings/repos/app/env/api-env' });
  assert.equal(editorOf(app, 'env-api-env').value, `API_TOKEN=${SECRET_MARK}\n`);
  assert.equal(editorOf(app, 'env-api-env').focused, true, 'Show puts the caret in the editor');
  button(app, 'Hide').listeners.click();
  assert.equal(editorOf(app, 'env-api-env'), undefined);
});

test('Clear asks first, says sessions get the repo\'s defaults alone, and empties the layer', async () => {
  const { app, calls, asked, secrets } = await loadPage({
    before: ({ repoSettings }) => repoSettings.saveInstallation({ project: 'app', key: 'api-env', text: 'A=1\n', by: 'mia-dev' }),
  });
  button(app, 'Show and edit').listeners.click();
  await settle();
  button(app, 'Clear').listeners.click();
  await settle();
  assert.deepEqual(asked, ['Clear this installation\'s values for api/.env?']);
  assert.deepEqual(calls.at(-1), { method: 'POST', path: '/api/console-settings/repos/app/env/api-env', body: { text: '' } });
  assert.equal(secrets.values.has('repos/app/env/api-env'), false);
  assert.match(textOf(app), /Cleared\. Sessions get the repo's defaults alone\./);
  assert.doesNotMatch(textOf(app), /Terraform secret/);
});

test('a value the old start-time copy saved still says it was copied from Terraform, and names no secret sessions read', async () => {
  const { app } = await loadPage({
    before: async ({ repoSettings, store }) => {
      await repoSettings.saveInstallation({ project: 'app', key: 'api-env', text: 'A=1\n', by: 'mia-dev' });
      store.state.repoSettings.app.env['api-env'].by = 'terraform env_files';
    },
  });
  assert.match(textOf(app), /copied from Terraform/);
  assert.doesNotMatch(textOf(app), /Terraform secret/);
});

test('rows start closed and say what they hold; an env file\'s row is deep-linked, and opening one names it in the address', async () => {
  const closed = await loadPage({ opened: [], triggers: TRIGGERS, slack: { consoleChannel: 'C0CONSOLE01', channels: {} } });
  assert.deepEqual(['file-api-env', 'file-web-env-local', 'instructions', 'session-label-row', 'slack'].map((id) => isOpen(closed.app, id)), [false, false, false, false, false]);
  assert.deepEqual(headText(closed.app, 'file-api-env'), ['api/.env', 'The repo\'s defaults alone', 'Defaults only']);
  assert.deepEqual(headText(closed.app, 'instructions'), ['Instructions', 'None of this installation\'s: sessions on this repo get the repo\'s own rules alone', 'None']);
  assert.deepEqual(headText(closed.app, 'session-label-row'), ['The label\'s name', 'woodshed, the console\'s', 'Console\'s']);
  assert.deepEqual(headText(closed.app, 'slack'), ['Pull request channel', 'Posting to the console\'s channel, C0CONSOLE01.', 'Console\'s channel']);
  assert.equal(walk(closed.app).some((e) => e.tag === 'textarea' || e.tag === 'table'), false, 'no body is drawn');
  assert.deepEqual(closed.calls.map((c) => c.path), ['/api/console-settings/repos/app'], 'nothing else is read for a closed page');

  const { app, history } = await loadPage({ search: '?file=web-env-local', opened: [] });
  assert.deepEqual([isOpen(app, 'file-api-env'), isOpen(app, 'file-web-env-local')], [false, true]);
  assert.deepEqual({ ...rowOf(app, 'file-web-env-local').scrolledTo }, { block: 'start' });
  assert.doesNotMatch(textOf(app), /Terraform/);
  openRow(app, 'file-api-env');
  assert.deepEqual(history.urls, ['http://console.test/console-settings/repos/app?file=api-env']);
  assert.match(textOf(app), /key api-env/);
  assert.deepEqual([isOpen(app, 'file-api-env'), isOpen(app, 'file-web-env-local')], [true, true], 'several rows may be open at once');
  openRow(app, 'file-api-env');
  assert.equal(isOpen(app, 'file-api-env'), false);
});

test('a row whose file has values says how many keys this installation sets', async () => {
  const { app } = await loadPage({
    opened: [],
    before: ({ repoSettings }) => repoSettings.saveInstallation({ project: 'app', key: 'api-env', text: 'A=1\nB=2\n', by: 'mia-dev' }),
  });
  const [name, value, pill] = headText(app, 'file-api-env');
  assert.equal(name, 'api/.env');
  assert.match(value, /^This installation sets 2 keys · Saved at .* · by @mia-dev · 8 bytes · 2 keys$/);
  assert.equal(pill, '2 keys set');
  assert.equal(walk(rowOf(app, 'file-api-env')).find((e) => e.className?.startsWith('pill')).className, 'pill is-ok');
});

test('instructions: the repo\'s rules are linked, the size is counted, and a credential is refused inline', async () => {
  const { app, calls, secrets } = await loadPage();
  const rules = walk(app).find((e) => e.tag === 'a' && textOf(e).startsWith('.woodshed/rules.md'));
  assert.equal(rules.attrs.href, 'https://github.com/acme/app/blob/HEAD/.woodshed/rules.md');
  await type(app, 'instructions-text', 'Run npm test before pushing.\n');
  assert.match(textOf(app), /29 of 16,384 bytes/);
  const save = () => instructionsSave(app);
  save().listeners.click();
  await settle();
  assert.equal(secrets.values.get('repos/app/instructions'), 'Run npm test before pushing.\n');
  assert.match(textOf(app), /Saved\. The next session on this repo has them in its prompt/);

  await type(app, 'instructions-text', `Use the key ghp_${'a'.repeat(36)} for GitHub.\n`);
  save().listeners.click();
  await settle();
  const error = walk(app).find((e) => e.className === 'form-error');
  assert.match(textOf(error), /put secrets in an env file's values instead/);
  assert.ok(!textOf(error).includes('ghp_'), 'the refusal never repeats the text');
  assert.equal(secrets.values.get('repos/app/instructions'), 'Run npm test before pushing.\n', 'refused: the saved text stays');
  assert.equal(calls.filter((c) => c.method === 'POST').length, 2);
});

test('instructions over 16 KB cannot be saved, and say so before Save', async () => {
  const { app } = await loadPage();
  await type(app, 'instructions-text', 'x'.repeat(16 * 1024 + 1));
  const count = walk(app).find((e) => e.className?.startsWith('layer-count'));
  assert.equal(count.className, 'layer-count is-over');
  assert.equal(instructionsSave(app).disabled, true);
});

test('saved instructions are read when their row opens, by its head or by a link', async () => {
  const before = ({ repoSettings }) => repoSettings.saveInstallation({ project: 'app', text: 'Keep it short.\n', by: 'mia-dev' });
  const { app, calls } = await loadPage({ before, opened: [] });
  assert.deepEqual(calls.map((c) => c.path), ['/api/console-settings/repos/app'], 'not before');
  assert.deepEqual(headText(app, 'instructions').slice(2), ['15 bytes']);
  openRow(app, 'instructions');
  await settle();
  assert.deepEqual(calls.map((c) => c.path), ['/api/console-settings/repos/app', '/api/console-settings/repos/app/instructions']);
  assert.equal(editorOf(app, 'instructions-text').value, 'Keep it short.\n');
  // The read leaves the focus on the row's head: focus would scroll the page to the editor.
  assert.notEqual(editorOf(app, 'instructions-text').focused, true);

  const linked = await loadPage({ before, hash: '#instructions', opened: [] });
  assert.deepEqual(linked.calls.map((c) => c.path), ['/api/console-settings/repos/app', '/api/console-settings/repos/app/instructions']);
  assert.equal(editorOf(linked.app, 'instructions-text').value, 'Keep it short.\n');
});

test('a key the project file no longer names is listed, and Delete removes everyone\'s values for it after a typed confirm', async () => {
  const { app, confirms, secrets, calls } = await loadPage({
    file: parseProject({ version: 1, envFiles: [{ path: 'web/.env.local' }] }),
    before: async ({ repoSettings, store, secrets: s }) => {
      // Saved while the file still named it.
      store.state.repoSettings = { app: { env: { 'old-env': { savedAt: '2026-11-01T00:00:00Z', by: 'mia-dev', bytes: 4, keys: ['A'] } } } };
      s.values.set('repos/app/env/old-env', 'A=1\n');
      void repoSettings;
    },
  });
  assert.match(textOf(app), /old-env is saved but the project file no longer has it/);
  assert.deepEqual(fileRows(app), ['web/.env.local', 'old-env'], 'a row of the Env files group');
  assert.equal(headOf(app, 'file-old-env'), undefined, 'with nothing to open');
  assert.equal(textOf(walk(rowOf(app, 'file-old-env')).find((e) => e.className === 'pill is-warn')), 'Unused');
  button(app, 'Delete').listeners.click();
  assert.equal(confirms.length, 1);
  assert.equal(confirms[0].word, 'delete');
  assert.match(confirms[0].effect, /every person's own values for it, are deleted/);
  await confirms[0].run();
  assert.deepEqual(calls.at(-1), { method: 'POST', path: '/api/console-settings/repos/app/env/old-env/remove', body: {} });
  assert.equal(secrets.values.has('repos/app/env/old-env'), false);
  assert.doesNotMatch(textOf(app), /old-env is saved/);
  assert.match(textOf(app), /old-env deleted\./);
});

test('a project file that cannot be read lists the saved values by key, and a save shows the 409 inline', async () => {
  const { app } = await loadPage({
    file: new Error('the project file could not be read: GitHub answered 502'),
    before: ({ store, secrets }) => {
      store.state.repoSettings = { app: { env: { 'api-env': { savedAt: '2026-11-01T00:00:00Z', by: 'mia-dev', bytes: 4, keys: ['A'] } } } };
      secrets.values.set('repos/app/env/api-env', 'A=1\n');
    },
  });
  assert.match(textOf(app), /The project file could not be read \(the project file could not be read: GitHub answered 502\), so only the saved values are listed/);
  assert.doesNotMatch(textOf(app), /From the repo.*api-env/);
  button(app, 'Show and edit').listeners.click();
  await settle();
  await type(app, 'env-api-env', 'A=2\n');
  button(app, 'Save').listeners.click();
  await settle();
  const error = walk(app).find((e) => e.className === 'form-error');
  assert.match(textOf(error), /acme\/app's project file could not be read, so api-env cannot be checked: try again in a moment/);
});

test('a secret store that does not answer shows the 502 inline, and the typed text stays', async () => {
  const { app, secrets } = await loadPage();
  secrets.fail = new Error('connect ECONNREFUSED');
  await type(app, 'env-api-env', `A=${SECRET_MARK}\n`);
  button(app, 'Save').listeners.click();
  await settle();
  const error = walk(app).find((e) => e.className === 'form-error');
  assert.equal(textOf(error), 'The secret store did not answer: try again in a moment');
  assert.equal(editorOf(app, 'env-api-env').value, `A=${SECRET_MARK}\n`);
});

test('someone who is not an admin is told the page is an admin\'s, with no settings drawn', async () => {
  const { app, calls } = await loadPage({ admin: false });
  assert.match(textOf(app), /Only an admin can open a repo's settings\./);
  assert.equal(walk(app).some((e) => e.tag === 'textarea'), false);
  assert.deepEqual(calls.map((c) => c.path), ['/api/console-settings/repos/app']);
});

test('a project the console does not have says so', async () => {
  const { app } = await loadPage({ project: 'nope' });
  assert.match(textOf(app), /There is no project called nope\. Repos in Settings lists the ones there are\./);
});

test('a console with no secret store says nothing can be saved, and turns the editor off', async () => {
  const { app } = await loadPage({ before: ({ secrets }) => { secrets.configured = () => false; } });
  assert.match(textOf(app), /This console has no secret store, so nothing can be saved here\./);
  assert.equal(editorOf(app, 'env-api-env').disabled, true);
});

const pickerSearch = (app) => walk(app).find((e) => e.tag === 'input' && e.attrs.id === 'slack-channel');
const cardOf = (app, id) => rowOf(app, id);
const options = (app) => walk(cardOf(app, 'slack')).filter((e) => e.attrs.role === 'option');
const idField = (app) => walk(app).find((e) => e.tag === 'input' && e.attrs.id === 'slack-channel-id');

test('the Slack row says what the channel is for and where posts go now, and lists the channels to pick from', async () => {
  const { app } = await loadPage({ slack: { consoleChannel: 'C0CONSOLE01', channels: {} } });
  const card = cardOf(app, 'slack');
  const text = textOf(card);
  assert.match(text, /When a shared session on this repo opens a pull request, the console posts it to this channel once its review and checks pass, with its decision brief and a mention of whoever has the session in the post's thread\./);
  assert.match(text, /With no channel here, it goes to the channel on Settings' Slack card\./);
  assert.match(text, /invite the bot first/, 'each channel says whether the bot is in it');
  assert.match(text, /a question asked in Slack is answered in its own thread/);
  assert.match(text, /Posting to the console's channel, C0CONSOLE01\./);
  assert.equal(walk(card).find((e) => e.tag === 'a' && /Slack card/.test(textOf(e))).attrs.href, '/console-settings#card-slack');
  assert.ok(pickerSearch(app), 'a search over the channels, not an ID field');
  assert.deepEqual(options(app).map(textOf), ['#app-prsbot is in it', '#releasesprivatebot is in it', '#generalinvite the bot first']);
  assert.equal(button(card, 'Save').attrs.disabled, '', 'nothing picked yet');
  assert.equal(button(card, 'Clear').attrs.disabled, '', 'nothing saved to clear');
});

test('picking a channel saves it, and Clear sends it back to the console\'s, through the Repos card\'s API', async () => {
  const { app, calls, store } = await loadPage({ slack: { consoleChannel: 'C0CONSOLE01', channels: {} } });
  const card = () => cardOf(app, 'slack');
  options(app)[0].listeners.click();
  assert.equal(options(app)[0].attrs['aria-selected'], 'true');
  assert.equal(button(card(), 'Save').attrs.disabled, undefined);
  button(card(), 'Save').listeners.click();
  await settle();
  const saves = () => calls.filter((c) => c.path === CHANNEL_PATH);
  assert.deepEqual(saves().at(-1), { method: 'POST', path: '/api/console-settings/projects/slack-channel', body: { name: 'app', channel: 'C0APPPRS01' } });
  assert.deepEqual(store.state.settings.projectSlackChannels, { app: 'C0APPPRS01' });
  assert.match(textOf(card()), /Saved\. acme\/app's next pull request goes to C0APPPRS01\. Invite the bot to it first\./);
  assert.match(textOf(card()), /Posting to C0APPPRS01\./);
  assert.equal(button(card(), 'Save').attrs.disabled, '', 'the saved channel is the one picked now');

  button(card(), 'Clear').listeners.click();
  await settle();
  assert.deepEqual(saves().at(-1), { method: 'POST', path: '/api/console-settings/projects/slack-channel', body: { name: 'app', channel: '' } });
  assert.deepEqual(store.state.settings.projectSlackChannels, {});
  assert.match(textOf(card()), /Cleared\. acme\/app's next pull request goes to the console's channel, C0CONSOLE01\./);
});

test('an app without channels:read and groups:read falls back to the channel ID, says how to get the list, and refuses a name', async () => {
  const { app, calls } = await loadPage({ slack: { consoleChannel: '', channels: { app: 'C0APPPRS01' } }, channels: { missingScope: true, needed: ['channels:read', 'groups:read'] } });
  const card = () => cardOf(app, 'slack');
  assert.match(textOf(card()), /the app lacks the channels:read and groups:read scopes\. Add them on the app's OAuth & Permissions page, reinstall it/);
  assert.equal(idField(app).value, 'C0APPPRS01');
  idField(app).value = '#app-prs';
  idField(app).listeners.input();
  assert.match(textOf(walk(card()).find((e) => e.className === 'form-error' && textOf(e))), /Give the channel's ID, such as C0123456789, not its name\./);
  assert.equal(button(card(), 'Save').attrs.disabled, '');
  assert.equal(calls.filter((c) => c.path === CHANNEL_PATH).length, 0);
  idField(app).value = 'C0OTHER001';
  idField(app).listeners.input();
  button(card(), 'Save').listeners.click();
  await settle();
  assert.deepEqual(calls.filter((c) => c.path === CHANNEL_PATH).at(-1).body, { name: 'app', channel: 'C0OTHER001' });
});

test('a console with no Slack says so on the row, with nothing to pick', async () => {
  const { app } = await loadPage();
  const card = cardOf(app, 'slack');
  assert.match(textOf(card), /This console has no Slack, so it posts nothing and a channel cannot be set here\./);
  assert.doesNotMatch(textOf(card), /Posting to/);
  assert.equal(pickerSearch(app), undefined);
  assert.equal(headOf(app, 'slack'), undefined, 'a plain row: nothing to open');
});

test('#slack opens the channel\'s row and brings it into view, reading the channels only then', async () => {
  const { app, calls } = await loadPage({ hash: '#slack', slack: { consoleChannel: 'C0CONSOLE01', channels: {} }, opened: [] });
  assert.deepEqual({ ...rowOf(app, 'slack').scrolledTo }, { block: 'start' });
  assert.equal(isOpen(app, 'slack'), true);
  assert.ok(pickerSearch(app));
  assert.equal(isOpen(app, 'file-api-env'), false, 'and no other');

  const closed = await loadPage({ slack: { consoleChannel: 'C0CONSOLE01', channels: {} }, opened: [] });
  assert.equal(closed.calls.some((c) => c.path.startsWith('/api/console-settings/slack/channels')), false, 'a closed row reads no channel');
  assert.equal(calls.some((c) => c.path.startsWith('/api/console-settings/slack/channels')), true);
});

test('a repo with no env files says how to add one, with a link to its project file', async () => {
  const { app } = await loadPage({ file: parseProject({ version: 1 }), envFiles: [] });
  const card = groupOf(app, 'env-files');
  const text = textOf(card);
  assert.doesNotMatch(text, /The project file has no env files\./);
  assert.match(text, /This repo has no env files yet/);
  assert.match(text, /In a pull request, add an envFiles entry to \.woodshed\/project\.yaml ↗:/);
  assert.equal(textOf(walk(card).find((e) => e.tag === 'pre')), 'envFiles:\n  - path: api/.env\n    defaults:        # optional\n      - LOG_LEVEL=info');
  assert.match(text, /No secret is needed: the file's key comes from its path \(api\/\.env is api-env\)\./);
  assert.match(text, /Once it is on the default branch, a row for it appears here, to set this installation's values\./);
  assert.match(text, /docs\/reference\.md, "The project file"/);
  const link = walk(card).find((e) => e.tag === 'a');
  assert.equal(walk(card).some((e) => e.tag === 'section'), false, 'no row');
  assert.deepEqual([link.attrs.href, link.attrs.target], ['https://github.com/acme/app/blob/HEAD/.woodshed/project.yaml', '_blank']);
});

const switchOf = (app, id) => walk(rowOf(app, id)).find((e) => e.attrs.role === 'switch');

test('Sessions from GitHub: each switch is on its row and applies as it is turned, and a refusal shows with every row closed', async () => {
  const { app, calls } = await loadPage({ triggers: TRIGGERS, opened: [] });
  const group = () => groupOf(app, 'github');
  assert.match(textOf(group()), /How a shared session on acme\/app starts from GitHub\./);
  assert.deepEqual([switchOf(app, 'switch-labels').attrs['aria-checked'], switchOf(app, 'switch-comments').attrs['aria-checked']], ['true', 'false']);
  assert.equal(switchOf(app, 'switch-labels').attrs['aria-label'], 'Start sessions from the label');
  assert.match(textOf(rowOf(app, 'switch-labels')), /On: the woodshed label on an issue starts a session, or resumes the one it had\./);
  assert.match(textOf(rowOf(app, 'switch-comments')), /Off: \/woodshed … comments do nothing on this repo/);
  switchOf(app, 'switch-comments').listeners.click();
  await settle();
  assert.deepEqual(calls.at(-1), { method: 'POST', path: TRIGGERS_PATH, body: { name: 'app', comments: true } });
  assert.equal(switchOf(app, 'switch-comments').attrs['aria-checked'], 'true');
  assert.match(textOf(rowOf(app, 'switch-comments')), /On: \/woodshed … on an issue or pull request starts a session/);

  const refused = await loadPage({ triggers: TRIGGERS, triggersFail: 'the console could not save it', opened: [] });
  switchOf(refused.app, 'switch-labels').listeners.click();
  await settle();
  assert.equal(isOpen(refused.app, 'session-label-row'), false);
  assert.equal(textOf(walk(groupOf(refused.app, 'github')).find((e) => e.className === 'form-error')), 'the console could not save it');
  assert.equal(switchOf(refused.app, 'switch-labels').attrs['aria-checked'], 'true', 'as it was');
});

test('the label\'s name is a row that opens: a label of the repo\'s own is saved, said on the closed row, and sent back to the console\'s', async () => {
  const { app, calls } = await loadPage({ triggers: TRIGGERS, hash: '#github', opened: [] });
  assert.equal(isOpen(app, 'session-label-row'), true, '#github opens it');
  assert.deepEqual({ ...groupOf(app, 'github').scrolledTo }, { block: 'start' });
  const row = () => rowOf(app, 'session-label-row');
  const input = () => walk(row()).find((e) => e.tag === 'input' && e.attrs.id === 'session-label');
  assert.equal(input().value, 'woodshed');
  assert.equal(button(row(), 'Save').attrs.disabled, '', 'nothing typed yet');
  assert.equal(button(row(), 'Use the console\'s').attrs.disabled, '');
  input().value = 'a,b';
  input().listeners.input();
  assert.equal(textOf(walk(row()).find((e) => e.className === 'form-error')), 'A label cannot have a comma in it.');
  assert.equal(button(row(), 'Save').attrs.disabled, '');
  input().value = 'ai-session';
  input().listeners.input();
  button(row(), 'Save').listeners.click();
  await settle();
  assert.deepEqual(calls.at(-1), { method: 'POST', path: TRIGGERS_PATH, body: { name: 'app', label: 'ai-session' } });
  assert.match(textOf(row()), /Saved\. The ai-session label starts sessions on acme\/app from now on/);
  assert.deepEqual(headText(app, 'session-label-row'), ['The label\'s name', 'ai-session, this repo\'s own. The console\'s is woodshed.', 'Own']);
  assert.match(textOf(rowOf(app, 'switch-labels')), /On: the ai-session label/);
  button(row(), 'Use the console\'s').listeners.click();
  await settle();
  assert.deepEqual(calls.at(-1).body, { name: 'app', label: null });
  assert.match(textOf(row()), /Back to the console's label, woodshed\./);
  assert.deepEqual(headText(app, 'session-label-row').slice(1), ['woodshed, the console\'s', 'Console\'s']);
});

test('a program\'s own groups follow the repo\'s, put in as its markup, and stay the same node when the page is drawn again', async () => {
  const markup = '<div class="set-group"><h2 class="set-group-label">Project file</h2></div>';
  const page = await loadPage({ hash: '#project-file', triggers: TRIGGERS, slack: { consoleChannel: '#prs', channels: {} }, hostGroups: async () => trusted(markup) });
  const view = page.app.children[0];
  const host = walk(view).find((e) => e.className === 'host-groups');
  assert.ok(host, 'drawn');
  assert.equal(host.children[0].markup, markup, 'its markup, as the program made it');
  const groups = walk(view).filter((e) => e.className === 'set-group' || e.className === 'host-groups').map((e) => e.attrs.id ?? e.className);
  assert.equal(groups.at(-1), 'host-groups', 'after the console\'s own groups');
  assert.equal(page.wired.length, 1);
  assert.equal(page.wired[0].node, host);
  assert.deepEqual({ ...page.wired[0].opts }, { hash: false }, 'the page opens its own rows from the address');
  await settle();
  assert.deepEqual(page.revealed.map((r) => r.id), ['project-file'], 'a link to one of its rows opens it');
  // Saving the instructions draws the page again: the program's part is the same node, its rows as they were.
  page.context.window.Woodshed.postJson('/api/console-settings/repos/app/instructions', { text: 'Be brief.' });
  await settle();
  assert.ok(walk(page.app).includes(host), 'kept across a redraw');
  assert.equal(page.wired.length, 1, 'wired once');
  assert.deepEqual(page.events, [{ type: 'woodshed:host-groups', inPage: true }], 'drawn once, so said once, once its groups are in the page, for a script that wires what it finds');
});

test('the scripts a program names for its groups are loaded once, after them', async () => {
  const page = await loadPage({ hostGroups: async () => ({ markup: trusted('<div class="set-group">Session data</div>'), scripts: ['/assets/upload.js'] }) });
  const host = walk(page.app).find((e) => e.className === 'host-groups');
  const scripts = walk(host).filter((e) => e.tag === 'script');
  assert.deepEqual(scripts.map((e) => e.attrs.src), ['/assets/upload.js']);
  page.context.window.Woodshed.postJson('/api/console-settings/repos/app/instructions', { text: 'Be brief.' });
  await settle();
  assert.equal(walk(page.app).filter((e) => e.tag === 'script').length, 1, 'not loaded again by a redraw');
});

test('with no program\'s groups, or one that fails, the repo\'s page is the console\'s alone', async () => {
  const none = await loadPage({ hostGroups: async () => null });
  assert.equal(walk(none.app).some((e) => e.className === 'host-groups'), false);
  const original = console.warn;
  console.warn = () => {};
  try {
    const failed = await loadPage({ hostGroups: async () => { throw new Error('away'); } });
    assert.equal(walk(failed.app).some((e) => e.className === 'host-groups'), false);
    assert.ok(walk(failed.app).some((e) => e.attrs.id === 'env-files'), 'the console\'s groups still drawn');
  } finally {
    console.warn = original;
  }
});
