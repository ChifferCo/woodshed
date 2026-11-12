// The Console settings page's Repos card, run from public/consoleSettings.js the way a page loads it, on a tiny DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./public/consoleSettings.js', import.meta.url), 'utf8');

function element(tag) {
  return {
    tag, attrs: {}, listeners: {}, children: [], className: '',
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(k, fn) { this.listeners[k] = fn; },
    append(c) { this.children.push(c); },
    replaceChildren(...c) { this.children = c; },
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

async function loadPage(answer, { repos } = {}) {
  const app = element('div');
  const posted = [];
  const confirms = [];
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
    h, nav: () => element('nav'), providerWords: {},
    getJson: async (path) => {
      if (path === '/api/console-settings/projects/repos' && repos) {
        if (repos instanceof Error) throw repos;
        return structuredClone(typeof repos === 'function' ? repos() : repos);
      }
      return structuredClone(answer);
    },
    postJson: async (path, body) => {
      posted.push({ path, body });
      if (posted.hold) await posted.hold;
      if (posted.refuse) throw posted.refuse;
      if (posted.reply) return posted.reply(path, body);
      return { projects: answer.projects.map((p) => (p.name === body.name ? { ...p, slackChannel: body.channel } : p)) }; },
    confirmChange: (opts) => { confirms.push(opts); },
    errorParts: (err) => [err.message, ...(err.link ? [' ', h('a', { href: err.link.href, target: '_blank' }, `${err.link.text} ↗`)] : [])],
  };
  const context = vm.createContext({
    window: { Woodshed: W }, console, setInterval: () => 0, Date,
    document: { getElementById: () => app, activeElement: null },
  });
  vm.runInContext(source, context);
  await tick();
  return { app, posted, confirms };
}

const ANSWER = {
  settings: [],
  slack: { channel: 'C0CONSOLE01', canPost: true },
  projects: [
    { name: 'r', repo: 'acme/app', default: true, removable: false, sessions: 0, slackChannel: '' },
    { name: 'api', repo: 'acme/api', default: false, removable: true, addedBy: 'mia-dev', sessions: 0, slackChannel: 'C0APIPRS01' },
  ],
  data: null,
};

const channelInputs = (app) => walk(app).filter((e) => e.tag === 'input' && /^Slack channel for /.test(e.attrs['aria-label'] ?? ''));

test('each repo on the Repos card has its own channel field, saying where its pull requests go', async () => {
  const { app } = await loadPage(ANSWER);
  const inputs = channelInputs(app);
  assert.deepEqual(inputs.map((i) => [i.attrs['aria-label'], i.attrs.value]), [['Slack channel for acme/app', ''], ['Slack channel for acme/api', 'C0APIPRS01']]);
  const text = textOf(app);
  assert.match(text, /PRs to the Slack card's channel/);
  assert.match(text, /PRs to C0APIPRS01/);
});

test('a channel typed into a row is saved for that repo on its Save, with no typed confirm, and a name is refused before it', async () => {
  const { app, posted, confirms } = await loadPage(ANSWER);
  const [own] = channelInputs(app);
  own.listeners.input({ target: { value: '#acme-prs' } });
  const [bad] = channelInputs(app);
  assert.equal(bad.attrs['aria-invalid'], 'true');
  const saveOf = () => walk(app).find((e) => e.tag === 'button' && textOf(e) === 'Save');
  assert.equal(saveOf().attrs.disabled, '', 'Save is off for a name');

  channelInputs(app)[0].listeners.input({ target: { value: ' C0ACMEPRS1 ' } });
  assert.equal(saveOf().attrs.disabled, undefined);
  saveOf().listeners.click();
  await tick();
  assert.equal(confirms.length, 0, 'a channel is changed back as easily: no typed confirm');
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{ path: '/api/console-settings/projects/slack-channel', body: { name: 'r', channel: 'C0ACMEPRS1' } }]);
  assert.match(textOf(app), /PRs to C0ACMEPRS1/);
  assert.match(textOf(app), /Its next pull request goes to C0ACMEPRS1/);
});

test('Add repo adds on the click, and a refusal shows under the field with the page that fixes it', async () => {
  const { app, posted, confirms } = await loadPage(ANSWER);
  const link = { href: 'https://github.com/apps/w/installations/new', text: 'Install w on GitHub' };
  const field = walk(app).find((e) => e.attrs.id === 'repo-new');
  field.listeners.input({ target: { value: 'https://github.com/acme/web' } });
  const addOf = () => walk(app).find((e) => e.tag === 'button' && /^(Add repo|Checking with GitHub…)$/.test(textOf(e)));
  posted.refuse = Object.assign(new Error('The GitHub App is not installed on acme/web.'), { link });
  addOf().listeners.click();
  await tick();
  assert.equal(confirms.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{ path: '/api/console-settings/projects', body: { repo: 'acme/web', name: '' } }]);
  const error = walk(app).find((e) => e.className === 'form-error');
  assert.match(textOf(error), /not installed on acme\/web/);
  const a = walk(error).find((e) => e.tag === 'a');
  assert.deepEqual([a.attrs.href, a.attrs.target, textOf(a)], [link.href, '_blank', 'Install w on GitHub ↗']);
});

test('with no Slack on the console, the rows have no channel field', async () => {
  const { app } = await loadPage({ ...ANSWER, slack: null });
  assert.deepEqual(channelInputs(app), []);
});

const SETTING = { key: 'maxRunning', label: 'Shared sessions at once', help: 'At most this many.', group: 'sessions', min: 1, max: 20, step: 1, unit: 'sessions', defaultValue: 4, value: 4 };
const WITH_SETTINGS = { ...ANSWER, settings: [SETTING] };
const sessionsSave = (app) => walk(app).find((e) => e.tag === 'button' && /^(Save|Saving…)$/.test(textOf(e)) && e.className === 'btn btn-open');
const cardOf = (app, id) => walk(app).find((e) => e.attrs['aria-labelledby'] === `card-${id}`);

test('a settings card saves its values on the click, with no typed confirm, and says what changed', async () => {
  const { app, posted, confirms } = await loadPage(WITH_SETTINGS);
  posted.reply = (path, body) => ({ settings: [{ ...SETTING, value: body.values.maxRunning }] });
  let release;
  posted.hold = new Promise((r) => { release = r; });
  walk(app).find((e) => e.attrs.id === 'set-maxRunning').listeners.input({ target: { value: '6' } });
  assert.equal(sessionsSave(app).attrs.disabled, undefined);
  sessionsSave(app).listeners.click();
  assert.equal(textOf(sessionsSave(app)), 'Saving…');
  assert.equal(sessionsSave(app).attrs.disabled, '', 'Saving… is off, so a second click sends nothing');
  sessionsSave(app).listeners.click();
  release();
  await tick();
  assert.equal(confirms.length, 0, 'a setting is changed back as easily: no typed confirm');
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{ path: '/api/console-settings', body: { values: { maxRunning: 6 } } }]);
  assert.match(textOf(cardOf(app, 'sessions')), /Saved\. Shared sessions at once: 4 sessions → 6 sessions\. Applies on the next check, with no restart\./);
  assert.equal(walk(app).find((e) => e.attrs.id === 'set-maxRunning').attrs.value, '6');
  assert.equal(textOf(sessionsSave(app)), 'Save');
});

test('the Slack card sends its channel with the values, and a refusal shows on the card', async () => {
  const { app, posted, confirms } = await loadPage(WITH_SETTINGS);
  const field = walk(app).find((e) => e.tag === 'input' && e.attrs.value === 'C0CONSOLE01');
  field.listeners.input({ target: { value: 'C0NEWCHAN01' } });
  posted.refuse = new Error('Slack says the bot is not in that channel.');
  walk(cardOf(app, 'slack')).find((e) => e.tag === 'button').listeners.click();
  await tick();
  assert.equal(confirms.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{ path: '/api/console-settings', body: { values: {}, slackChannel: 'C0NEWCHAN01' } }]);
  const error = walk(cardOf(app, 'slack')).find((e) => e.className === 'form-error');
  assert.equal(textOf(error), 'Slack says the bot is not in that channel.');
  assert.equal(walk(cardOf(app, 'slack')).find((e) => e.tag === 'button').attrs.disabled, undefined, 'the typed channel is kept to try again');
});

const REPOS = {
  repos: [{ repo: 'akurilin/social', private: true }, { repo: 'acme/web', private: false }],
  grant: [{ account: 'acme', href: 'https://github.com/organizations/acme/settings/installations/1' }, { account: 'akurilin', href: 'https://github.com/settings/installations/2' }],
  install: 'https://github.com/apps/w/installations/new',
};

test('with the App, Add a repo is a list of the repos it may reach, and says where on GitHub to give it more', async () => {
  const { app, posted } = await loadPage(ANSWER, { repos: REPOS });
  const select = walk(app).find((e) => e.attrs.id === 'repo-new');
  assert.equal(select.tag, 'select');
  assert.deepEqual(walk(select).filter((e) => e.tag === 'option').map((o) => [o.attrs.value, textOf(o)]),
    [['', 'Choose a repo'], ['akurilin/social', 'akurilin/social (private)'], ['acme/web', 'acme/web']]);
  const card = cardOf(app, 'projects');
  assert.match(textOf(card), /Not listed\? Give the App access to it on GitHub: acme ↗, akurilin ↗; or install it on another account ↗\. Then List again/);
  assert.deepEqual(walk(card).filter((e) => e.tag === 'a').map((a) => [a.attrs.href, a.attrs.target]), [
    ['https://github.com/organizations/acme/settings/installations/1', '_blank'], ['https://github.com/settings/installations/2', '_blank'], ['https://github.com/apps/w/installations/new', '_blank'],
  ]);

  const addOf = () => walk(app).find((e) => e.tag === 'button' && /^(Add repo|Checking with GitHub…)$/.test(textOf(e)));
  addOf().listeners.click();
  await tick();
  assert.equal(posted.length, 0, 'nothing picked, nothing sent');
  assert.match(textOf(walk(app).find((e) => e.className === 'form-error')), /Choose a repo first/);
  walk(app).find((e) => e.attrs.id === 'repo-new').listeners.change({ target: { value: 'akurilin/social' } });
  posted.reply = () => ({ projects: ANSWER.projects });
  addOf().listeners.click();
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{ path: '/api/console-settings/projects', body: { repo: 'akurilin/social', name: '' } }]);
  assert.match(textOf(app), /akurilin\/social added/);
});

test('List again reads the App\'s repos again, so one just given on GitHub shows up', async () => {
  let repos = { ...REPOS, repos: [] };
  const { app } = await loadPage(ANSWER, { repos: () => repos });
  const select = () => walk(app).find((e) => e.attrs.id === 'repo-new');
  assert.equal(select().attrs.disabled, '');
  assert.equal(textOf(select()), 'No repo left to add');
  repos = REPOS;
  walk(app).find((e) => e.tag === 'button' && textOf(e) === 'List again').listeners.click();
  await tick();
  assert.equal(select().attrs.disabled, undefined);
  assert.match(textOf(select()), /akurilin\/social/);
});

test('with no App to ask, or GitHub not answering, Add a repo takes owner/name typed in', async () => {
  const none = await loadPage(ANSWER, { repos: { repos: null, grant: [], install: null } });
  assert.equal(walk(none.app).find((e) => e.attrs.id === 'repo-new').tag, 'input');
  assert.doesNotMatch(textOf(none.app), /Not listed/);
  const down = await loadPage(ANSWER, { repos: new Error('GitHub did not list the App\'s repos. Type the repo instead, or try again; the console log says why.') });
  assert.equal(walk(down.app).find((e) => e.attrs.id === 'repo-new').tag, 'input');
  assert.match(textOf(down.app), /GitHub did not list the App's repos\. Type the repo instead/);
});
