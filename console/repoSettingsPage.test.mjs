// A repo's settings page (public/repoSettings.js), run the way a page loads it on a tiny DOM, against the real JSON API
// (repoSettings.mjs) over an in-memory secret store: what the page draws is what the console answers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import { createRepoSettings, createRepoSettingsApi, repoSettingsRoute } from './repoSettings.mjs';
import { createSlack } from './slack.mjs';
import { parseProject } from '../shared/project.mjs';

const layersSource = fs.readFileSync(new URL('./public/repoLayers.js', import.meta.url), 'utf8');
const source = fs.readFileSync(new URL('./public/repoSettings.js', import.meta.url), 'utf8');
const SECRET_MARK = 'zq9-page-value';

const PROJECTS = [{ name: 'app', repo: 'acme/app', default: true }, { name: 'tools', repo: 'acme/tools', default: false }];
const APP_FILE = parseProject({
  version: 1, env: { NODE_ENV: 'development' }, rules: '.woodshed/rules.md',
  envFiles: [
    { path: 'api/.env', secret: 'api-env', defaults: ['LOG_LEVEL=info'], lines: ['PORT={{PORT}}', 'ANTHROPIC_API_KEY={{ANTHROPIC_API_KEY?}}'] },
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
    focus() {},
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
 * `slack` is the console's Slack settings, {consoleChannel, channels: {<project>: channel}}; left out, it has none.
 * @returns the page's root, the calls it made, and the console's state and secrets
 */
async function loadPage({ project = 'app', search = '', hash = '', file = APP_FILE, envFiles = [{ secret: 'api-env', path: 'api/.env' }], admin = true, before = null, confirmAnswer = true, slack: slackSettings = null } = {}) {
  const store = { state: { sessions: [] }, save() {} };
  const secrets = memorySecrets();
  const config = { projects: PROJECTS, repo: 'acme/app', envFiles };
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
  const api = createRepoSettingsApi({ repoSettings, config, slackOf: slack ? slackOf(slack) : null });
  const calls = [];
  const consoleCall = (method, path, body) => {
    // The page's objects are of its own realm: copied, so they compare as plain ones.
    calls.push({ method, path, ...(body !== undefined && { body: JSON.parse(JSON.stringify(body)) }) });
    if (!admin) return Promise.reject(Object.assign(new Error('only an admin can do this'), { status: 403 }));
    if (path === CHANNEL_PATH) return slack ? channelCall(slack, body) : Promise.reject(Object.assign(new Error('this console posts nothing to Slack'), { status: 404 }));
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
    h, nav: () => element('nav'), when: (iso) => `at ${iso}`,
    getJson: (path) => consoleCall('GET', path),
    postJson: (path, body) => consoleCall('POST', path, body),
    confirmChange: (opts) => { confirms.push(opts); },
  };
  const location = { pathname: `/console-settings/repos/${project}`, search, hash, href: `http://console.test/console-settings/repos/${project}${search}${hash}` };
  const history = { urls: [], replaceState(_s, _t, url) { this.urls.push(String(url)); } };
  const context = vm.createContext({
    window: { Woodshed: W, confirm: (text) => { asked.push(text); return confirmAnswer; } }, console, location, history, URL, URLSearchParams, TextEncoder,
    document: { getElementById: () => app, activeElement: null },
  });
  vm.runInContext(layersSource, context);
  vm.runInContext(source, context);
  await settle();
  return { app, calls, confirms, asked, history, store, secrets, repoSettings };
}

const buttons = (app, text) => walk(app).filter((e) => e.tag === 'button' && textOf(e).trim() === text);
const button = (app, text) => buttons(app, text)[0];
const cardOf = (app, id) => walk(app).find((e) => e.attrs['aria-labelledby'] === `card-${id}`);
const instructionsSave = (app) => buttons(cardOf(app, 'instructions'), 'Save')[0];
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
  assert.match(text, /Its lines: PORT\./);
  assert.match(text, /Only when the session has a value for it: ANTHROPIC_API_KEY\./);
  assert.match(text, /The project file's env, set in every process: NODE_ENV\./);
  assert.deepEqual(tableRows(app), [
    ['LOG_LEVEL', '✓', '', '', 'Repo'],
    ['PORT', '', '', '✓', 'Session'],
    ['ANTHROPIC_API_KEY', '', '', '✓ if set', 'Session, if set'],
  ]);
  assert.deepEqual(buttons(app, 'api/.env').map((b) => b.attrs['aria-pressed']), ['true']);
  assert.ok(editorOf(app, 'env-api-env'), 'nothing saved yet: the editor is open, empty');
});

// api/.env and worker/.env both name app-env, each with lines of its own; web/.env.local is keyed by its path.
const SHARED_FILE = parseProject({
  version: 1, env: {},
  envFiles: [
    { path: 'api/.env', secret: 'app-env', defaults: ['LOG_LEVEL=info'], lines: ['PORT=8080', 'SQL_URL={{PG_URL}}'] },
    { path: 'worker/.env', secret: 'app-env', lines: ['ROLE=worker', 'SQL_URL={{PG_URL}}'] },
    { path: 'web/.env.local', lines: ['PORT=5173'] },
  ],
});

test('env files that share a key are one tab naming both paths, with a note, each file\'s defaults and lines, and its rows where they differ', async () => {
  const { app, calls, secrets } = await loadPage({ file: SHARED_FILE, envFiles: [] });
  assert.deepEqual(walk(app).filter((e) => e.tag === 'button' && e.attrs['aria-pressed']).map((b) => textOf(b)), ['app-env → api/.env, worker/.env', 'web/.env.local']);
  const text = textOf(app);
  assert.match(text, /These values are written to both files, api\/\.env, worker\/\.env, which name the secret app-env\. Each keeps its own defaults and lines\./);
  assert.match(text, /From the repoapi\/\.envLOG_LEVEL=infoworker\/\.envNo defaults\./, 'each file\'s defaults under its path');
  assert.match(text, /api\/\.envIts lines: PORT, SQL_URL\.worker\/\.envIts lines: ROLE, SQL_URL\./);
  assert.deepEqual(tableRows(app), [
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

  button(app, 'web/.env.local').listeners.click();
  assert.doesNotMatch(textOf(app), /These values are written to/, 'a key of one file has no note');
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
  assert.deepEqual(tableRows(app), [
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
  button(app, 'Hide').listeners.click();
  assert.equal(editorOf(app, 'env-api-env'), undefined);
});

test('Clear asks first, says the Terraform secret is read again, and empties the layer', async () => {
  const { app, calls, asked, secrets } = await loadPage({
    before: ({ repoSettings }) => repoSettings.saveInstallation({ project: 'app', key: 'api-env', text: 'A=1\n', by: 'mia-dev' }),
  });
  button(app, 'Show and edit').listeners.click();
  await settle();
  button(app, 'Clear').listeners.click();
  await settle();
  assert.deepEqual(asked, ['Clear this installation\'s values for api/.env? Sessions then read the Terraform secret api-env again.']);
  assert.deepEqual(calls.at(-1), { method: 'POST', path: '/api/console-settings/repos/app/env/api-env', body: { text: '' } });
  assert.equal(secrets.values.has('repos/app/env/api-env'), false);
  assert.match(textOf(app), /Cleared\. Sessions read the Terraform secret api-env again\./);
  assert.match(textOf(app), /No values yet: sessions still read the Terraform secret api-env\./);
});

test('an env file copied from its Terraform secret says so, with the date', async () => {
  const { app } = await loadPage({
    before: async ({ secrets, repoSettings }) => {
      secrets.values.set('api-env', 'A=1\n');
      await repoSettings.migrate();
    },
  });
  assert.match(textOf(app), /Copied from the Terraform secret api-env on at 20\d\d-.*\. Sessions read this one now\./);
  assert.match(textOf(app), /copied from Terraform/);
});

test('an env file with no Terraform secret behind it has no legacy note, and its tab is deep-linked', async () => {
  const { app, history } = await loadPage({ search: '?file=web-env-local' });
  assert.deepEqual(buttons(app, 'web/.env.local').map((b) => b.attrs['aria-pressed']), ['true']);
  assert.doesNotMatch(textOf(app), /Terraform/);
  button(app, 'api/.env').listeners.click();
  assert.deepEqual(history.urls, ['http://console.test/console-settings/repos/app?file=api-env']);
  assert.match(textOf(app), /key api-env/);
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

test('saved instructions are read when the page opens', async () => {
  const { app, calls } = await loadPage({
    before: ({ repoSettings }) => repoSettings.saveInstallation({ project: 'app', text: 'Keep it short.\n', by: 'mia-dev' }),
  });
  assert.deepEqual(calls.map((c) => c.path), ['/api/console-settings/repos/app', '/api/console-settings/repos/app/instructions']);
  assert.equal(editorOf(app, 'instructions-text').value, 'Keep it short.\n');
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
  assert.match(textOf(app), /There is no project called nope\. Repos on Console settings lists the ones there are\./);
});

test('a console with no secret store says nothing can be saved, and turns the editor off', async () => {
  const { app } = await loadPage({ before: ({ secrets }) => { secrets.configured = () => false; } });
  assert.match(textOf(app), /This console has no secret store, so nothing can be saved here\./);
  assert.equal(editorOf(app, 'env-api-env').disabled, true);
});

test('a copied value, cleared, says sessions read the Terraform secret again, not that they read the copy', async () => {
  const { app } = await loadPage({
    before: async ({ secrets, repoSettings }) => {
      secrets.values.set('api-env', 'A=1\n');
      await repoSettings.migrate();
      await repoSettings.saveInstallation({ project: 'app', key: 'api-env', text: '', by: 'mia-dev' });
      await repoSettings.migrate();
    },
  });
  assert.match(textOf(app), /No values yet: sessions still read the Terraform secret api-env\./);
  assert.doesNotMatch(textOf(app), /Sessions read this one now/);
});

const channelField = (app) => walk(app).find((e) => e.tag === 'input' && e.attrs.id === 'slack-channel');

async function typeChannel(app, text) {
  channelField(app).value = text;
  channelField(app).listeners.input();
}

test('the Slack card says what the channel is for, how to find its ID and to invite the bot, and where posts go now', async () => {
  const { app } = await loadPage({ slack: { consoleChannel: 'C0CONSOLE01', channels: {} } });
  const card = cardOf(app, 'slack');
  const text = textOf(card);
  assert.match(text, /When a shared session on this repo opens a pull request, the console posts it to this channel once its review and checks pass, with its decision brief and a mention of whoever has the session in the post's thread\./);
  assert.match(text, /With no channel here, it goes to the channel on Console settings' Slack card\./);
  assert.match(text, /the ID \(C…\) is at the bottom of its About tab/);
  assert.match(text, /Invite the Woodshed bot to the channel first/);
  assert.match(text, /a question asked in Slack is answered in its own thread/);
  assert.match(text, /Posting to the console's channel, C0CONSOLE01\./);
  assert.equal(walk(card).find((e) => e.tag === 'a' && /Slack card/.test(textOf(e))).attrs.href, '/console-settings#card-slack');
  assert.equal(channelField(app).value, '');
  assert.equal(channelField(app).disabled, false);
  assert.equal(button(card, 'Save').attrs.disabled, '', 'nothing typed yet');
  assert.equal(button(card, 'Clear').attrs.disabled, '', 'nothing saved to clear');
});

test('the Slack card saves a channel and clears it back to the console\'s, through the Repos card\'s API', async () => {
  const { app, calls, store } = await loadPage({ slack: { consoleChannel: 'C0CONSOLE01', channels: {} } });
  await typeChannel(app, ' C0APPPRS01 ');
  const card = () => cardOf(app, 'slack');
  assert.equal(button(card(), 'Save').attrs.disabled, undefined);
  button(card(), 'Save').listeners.click();
  await settle();
  assert.deepEqual(calls.at(-1), { method: 'POST', path: '/api/console-settings/projects/slack-channel', body: { name: 'app', channel: 'C0APPPRS01' } });
  assert.deepEqual(store.state.settings.projectSlackChannels, { app: 'C0APPPRS01' });
  assert.match(textOf(card()), /Saved\. acme\/app's next pull request goes to C0APPPRS01\. Invite the bot to it first\./);
  assert.match(textOf(card()), /Posting to C0APPPRS01\./);
  assert.equal(channelField(app).value, 'C0APPPRS01');

  button(card(), 'Clear').listeners.click();
  await settle();
  assert.deepEqual(calls.at(-1), { method: 'POST', path: '/api/console-settings/projects/slack-channel', body: { name: 'app', channel: '' } });
  assert.deepEqual(store.state.settings.projectSlackChannels, {});
  assert.match(textOf(card()), /Cleared\. acme\/app's next pull request goes to the console's channel, C0CONSOLE01\./);
  assert.equal(channelField(app).value, '');
});

test('a channel\'s name is refused before Save, and a refusal from the console shows on the card', async () => {
  const { app, calls } = await loadPage({ slack: { consoleChannel: '', channels: { app: 'C0APPPRS01' } } });
  const card = () => cardOf(app, 'slack');
  assert.match(textOf(card()), /Posting to C0APPPRS01\./);
  await typeChannel(app, '#app-prs');
  assert.equal(channelField(app).attrs['aria-invalid'], 'true');
  assert.match(textOf(walk(card()).find((e) => e.className === 'form-error')), /Give the channel's ID, such as C0123456789, not its name\./);
  assert.equal(button(card(), 'Save').attrs.disabled, '');
  assert.equal(calls.filter((c) => c.path === CHANNEL_PATH).length, 0);

  button(card(), 'Clear').listeners.click();
  await settle();
  assert.match(textOf(card()), /Cleared\. The console has no channel either, so nothing is posted\./);
  assert.match(textOf(card()), /Nothing is posted: neither this repo nor the console has a channel\./);
});

test('a console with no Slack says so on the card and turns the field off', async () => {
  const { app } = await loadPage();
  const card = cardOf(app, 'slack');
  assert.match(textOf(card), /This console has no Slack, so it posts nothing and a channel cannot be set here\./);
  assert.doesNotMatch(textOf(card), /Posting to/);
  assert.equal(channelField(app).disabled, true);
  assert.equal(button(card, 'Save').attrs.disabled, '');
  assert.equal(button(card, 'Clear').attrs.disabled, '');
});

test('#slack brings the Slack card\'s field into view', async () => {
  const { app } = await loadPage({ hash: '#slack', slack: { consoleChannel: 'C0CONSOLE01', channels: {} } });
  assert.deepEqual({ ...channelField(app).scrolledTo }, { block: 'center' });
  assert.equal(walk(app).find((e) => e.tag === 'section' && e.attrs.id === 'slack').attrs['aria-labelledby'], 'card-slack');
});

test('a repo with no env files says how to add one, with a link to its project file', async () => {
  const { app } = await loadPage({ file: parseProject({ version: 1 }), envFiles: [] });
  const card = cardOf(app, 'env');
  const text = textOf(card);
  assert.doesNotMatch(text, /The project file has no env files\./);
  assert.match(text, /This repo has no env files yet/);
  assert.match(text, /In a pull request, add an envFiles entry to \.woodshed\/project\.yaml ↗:/);
  assert.equal(textOf(walk(card).find((e) => e.tag === 'pre')), 'envFiles:\n  - path: api/.env\n    defaults:        # optional\n      - LOG_LEVEL=info');
  assert.match(text, /No secret is needed: the file's key comes from its path \(api\/\.env is api-env\)\./);
  assert.match(text, /Once it is on the default branch, a tab for it appears here, to set this installation's values\./);
  assert.match(text, /docs\/reference\.md, "The project file"/);
  const link = walk(card).find((e) => e.tag === 'a');
  assert.deepEqual([link.attrs.href, link.attrs.target], ['https://github.com/acme/app/blob/HEAD/.woodshed/project.yaml', '_blank']);
});
