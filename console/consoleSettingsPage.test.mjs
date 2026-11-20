// The Settings page's groups of rows, run from public/consoleSettings.js the way a page loads it, on a tiny DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./public/consoleSettings.js', import.meta.url), 'utf8');
const rowsSource = fs.readFileSync(new URL('./public/settingsRows.js', import.meta.url), 'utf8');

// What the page put the focus on, last one last.
const focused = [];

function element(tag) {
  return {
    tag, attrs: {}, listeners: {}, children: [], className: '',
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(k, fn) { this.listeners[k] = fn; },
    append(c) { this.children.push(c); },
    replaceChildren(...c) { this.children = c; },
    focus() { focused.push(this); },
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

const byId = (app, id) => walk(app).find((e) => e.attrs.id === id);
// A row's head, which opens and closes it, and whether the row is open.
const headOf = (app, id) => byId(app, `${id}-head`);
const isOpen = (app, id) => headOf(app, id).attrs['aria-expanded'] === 'true';
// Opens every row there is, as someone reading the whole page would.
function openAll(app) {
  for (;;) {
    const head = walk(app).find((e) => e.className === 'set-fold-head' && e.attrs['aria-expanded'] === 'false');
    if (!head) return;
    head.listeners.click();
  }
}

// `updates` may be a function, called on each read (throwing as a console that does not answer); `clock.now` stands in
// for Date.now, and `timers` collects what the page schedules, so a test can run them. Every row is opened once the
// page has loaded, unless `opened` is false; `hash` is the link the page was opened by.
async function loadPage(answer, { repos, updates = null, clock = null, timers = null, slack = null, opened = true, hash = '' } = {}) {
  const app = element('div');
  const posted = [];
  const confirms = [];
  // What the Slack card asked of slackSetup.js: each dialog it opened, and each channel picker it made.
  const dialogs = [];
  const pickers = [];
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
    h, nav: () => element('nav'), settingsTabs: () => element('nav'), scopePill: () => element('span'), providerWords: {},
    settingsPage: (_match, start) => start(app, { nav: () => element('nav'), interval: (fn, ms) => context.setInterval?.(fn, ms), timeout: (fn, ms) => context.setTimeout(fn, ms), on: (target, type, fn) => target.addEventListener?.(type, fn) }),
    getJson: async (path) => {
      if (path === '/api/console-settings/projects/repos' && repos) {
        if (repos instanceof Error) throw repos;
        return structuredClone(typeof repos === 'function' ? repos() : repos);
      }
      // The Slack card's own read: a console that posts nothing to Slack answers 404, and has no card.
      if (path === '/api/console-settings/slack') {
        if (!slack) throw Object.assign(new Error('this console posts nothing to Slack'), { status: 404 });
        return structuredClone(slack);
      }
      // The Woodshed card's own read: a console that runs from no git clone answers 404.
      if (path === '/api/console-settings/updates') {
        if (!updates) throw Object.assign(new Error('this console does not run from a git clone'), { status: 404 });
        return structuredClone(typeof updates === 'function' ? updates() : updates);
      }
      return structuredClone(answer);
    },
    ago: () => '5 min ago',
    ref: (r) => `#${r.number}`,
    resumeSharedButton: () => h('button', { type: 'button' }, 'Resume'),
    deleteSharedButton: () => h('button', { type: 'button' }, 'Delete now'),
    postJson: async (path, body) => {
      posted.push({ path, body });
      if (posted.hold) await posted.hold;
      if (posted.refuse) throw posted.refuse;
      if (posted.reply) return posted.reply(path, body);
      return { projects: answer.projects.map((p) => (p.name === body.name ? { ...p, slackChannel: body.channel } : p)) }; },
    confirmChange: (opts) => { confirms.push(opts); },
    when: (iso) => `on ${iso.slice(0, 10)}`,
    openSlackSetup: (opts) => { dialogs.push(opts); },
    slackChannelPicker: (opts) => {
      const picker = { opts, picked: opts.value, el: element('div'), value: () => picker.picked, problem: () => null };
      pickers.push(picker);
      return picker;
    },
    errorParts: (err) => [err.message, ...(err.link ? [' ', h('a', { href: err.link.href, target: '_blank' }, `${err.link.text} ↗`)] : [])],
  };
  const location = { hash, reload: () => {} };
  const events = {};
  const lookups = [];
  const context = vm.createContext({
    window: { Woodshed: W, location, addEventListener: (type, fn) => { (events[type] ??= []).push(fn); } }, location, console, URL, setInterval: () => 0, setTimeout: (fn) => { timers?.push(fn); return 0; }, clearTimeout: () => {},
    Date: clock ? Object.assign(class extends Date {}, { now: () => clock.now }) : Date,
    document: { getElementById: (id) => { lookups.push(id); return app; }, activeElement: null },
  });
  vm.runInContext(rowsSource, context);
  vm.runInContext(source, context);
  await tick();
  await tick();
  if (opened) openAll(app);
  return { app, posted, confirms, dialogs, pickers, location, events, lookups };
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

// The fields a row had for its channel before it moved to the repo's own page.
const channelInputs = (app) => walk(app).filter((e) => e.tag === 'input' && (/^channel-/.test(e.attrs.id ?? '') || /^Slack channel for /.test(e.attrs['aria-label'] ?? '')));
// A group or a row of the page, by a short name.
const PARTS = { projects: 'card-projects', sessions: 'card-sessions', slack: 'card-slack', questions: 'slack-questions', webhooks: 'card-webhooks', mcp: 'mcp-servers', updates: 'card-updates', data: 'card-data' };
const cardOf = (app, name) => byId(app, PARTS[name]);
const channelHints = (app) => walk(cardOf(app, 'projects')).filter((e) => e.tag === 'a' && /^PRs to /.test(textOf(e)));

test('a repo\'s row has no channel field, and says where its pull requests go with a link to change it', async () => {
  const { app } = await loadPage(ANSWER);
  assert.deepEqual(channelInputs(app), []);
  assert.deepEqual(channelHints(app).map((a) => [textOf(a), a.attrs.href]), [
    ['PRs to the console\'s channel', '/console-settings/repos/r#slack'],
    ['PRs to C0APIPRS01', '/console-settings/repos/api#slack'],
  ]);
  const card = cardOf(app, 'projects');
  assert.match(textOf(headOf(app, 'repo-r')), /^acme\/app rDefault project · no sessions running · PRs to the console's channel/, 'the closed row says it too');
  assert.deepEqual(['repo-r', 'repo-api'].map((id) => walk(byId(app, id)).filter((e) => (e.tag === 'button' && e.className !== 'set-fold-head') || (e.tag === 'a' && e.className === 'btn btn-plain')).map((e) => textOf(e))),
    [['Repo settings ›'], ['Repo settings ›', 'Remove']], 'each row: its settings, and Remove where it may go');
  assert.match(textOf(byId(app, 'repo-r')), /Set in the installation's configuration, so it is removed there\./);
  assert.equal(walk(card).filter((e) => e.className === 'set-fold-head').length, 3, 'a row per repo, then Add a repo');
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

test('with no Slack on the console, the rows say nothing of a channel', async () => {
  const { app } = await loadPage({ ...ANSWER, slack: null });
  assert.deepEqual(channelHints(app), []);
});

const SETTING = { key: 'maxRunning', label: 'Shared sessions at once', help: 'At most this many.', group: 'sessions', min: 1, max: 20, step: 1, unit: 'sessions', defaultValue: 4, value: 4 };
const WITH_SETTINGS = { ...ANSWER, settings: [SETTING] };
const sessionsSave = (app) => walk(app).find((e) => e.tag === 'button' && /^(Save|Saving…)$/.test(textOf(e)) && e.className === 'btn btn-open');

test('a row of numbers saves its values on the click, with no typed confirm, and says what changed', async () => {
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

const SLACK_OFF = { available: true, connected: false, bot: null, signingSecret: false, channel: '', channelName: null, eventsUrl: 'https://hooks.example/slack', manifest: 'display_information: …', install: null, canDisconnect: false };
const SLACK_ON = {
  ...SLACK_OFF, connected: true, signingSecret: true, channel: 'C0CONSOLE01', channelName: 'app-prs', lastMention: null,
  bot: { ok: true, team: 'Acme', name: 'shed-bot', url: 'https://acme.slack.com/', error: null, setBy: 'mia-dev', setAt: '2026-11-18T10:00:00.000Z' },
};
const QUESTION_SETTING = { key: 'maxAsks', label: 'Questions running at once', help: 'The rest wait.', group: 'questions', min: 1, max: 10, step: 1, unit: 'sessions', defaultValue: 3, value: 3 };
const WAIT_SETTING = { key: 'slackGiveUpDays', label: 'Stop waiting for the review and the suite after', help: 'Then never posted.', group: 'slack', min: 1, max: 30, step: 1, unit: 'days', defaultValue: 7, value: 7 };
const WEBHOOKS = { receiving: true, github: { off: false }, slack: { off: false } };
const WITH_SLACK = { ...ANSWER, settings: [SETTING, QUESTION_SETTING, WAIT_SETTING], webhooks: WEBHOOKS };
const buttonIn = (el, text) => walk(el).find((e) => e.tag === 'button' && textOf(e) === text);

test('Slack not set up: one sentence and Set up Slack, nothing about questions, and the dialog opens at the own app\'s steps', async () => {
  const { app, dialogs } = await loadPage(WITH_SLACK, { slack: SLACK_OFF });
  const card = cardOf(app, 'slack');
  assert.match(textOf(card), /^SlackSlack Not set upPost each pull request a shared session opens to a channel, and answer questions people ask the bot\.Set up Slack$/, 'one line, with its button on it');
  assert.equal(walk(card).filter((e) => e.className === 'set-fold-head').length, 0, 'nothing to open yet');
  assert.equal(cardOf(app, 'questions'), undefined, 'no Questions row');
  buttonIn(card, 'Set up Slack').listeners.click();
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].mode, 'own', 'with no install option, straight to the own app');
});

test('where the embedding program offers an install, Set up Slack opens on the choice', async () => {
  const install = { label: 'Install the team app', description: 'One click.', available: false, href: null, installed: false };
  const { app, dialogs } = await loadPage(WITH_SLACK, { slack: { ...SLACK_OFF, install } });
  buttonIn(cardOf(app, 'slack'), 'Set up Slack').listeners.click();
  assert.equal(dialogs[0].mode, 'choose');
});

test('a console with no secret store says where to choose one instead of offering Set up Slack', async () => {
  const { app } = await loadPage(WITH_SLACK, { slack: { ...SLACK_OFF, available: false } });
  const card = cardOf(app, 'slack');
  assert.equal(buttonIn(card, 'Set up Slack'), undefined);
  assert.match(textOf(card), /no secret store to keep Slack's keys in/);
});

test('Slack connected: the bot, the pull requests\' channel and questions, each with its action, and Replace keys opens the dialog', async () => {
  const { app, dialogs } = await loadPage(WITH_SLACK, { slack: SLACK_ON });
  const card = cardOf(app, 'slack');
  const text = textOf(card);
  assert.match(text, /Connected to Acme/);
  assert.match(text, /Bot@shed-bot, your own app\. Set by @mia-dev on 2026-11-18\./);
  assert.match(text, /Pull requestsPosted to #app-prs · gives up after 7 days/);
  assert.match(text, /QuestionsMentions of @shed-bot are answered/);
  assert.equal(buttonIn(card, 'Disconnect Slack'), undefined, 'a store that cannot make the secrets again offers no Disconnect');
  const toggle = walk(card).find((e) => e.attrs.role === 'switch');
  assert.equal(toggle.attrs['aria-checked'], 'true');
  buttonIn(card, 'Replace keys').listeners.click();
  assert.equal(dialogs[0].mode, 'replace');
});

test('a Slack row\'s limits are in the row, with no fold of their own, and save as a row of numbers does', async () => {
  const { app, posted } = await loadPage(WITH_SLACK, { slack: SLACK_ON, opened: false });
  posted.reply = (path, body) => ({ settings: [SETTING, { ...QUESTION_SETTING, value: body.values.maxAsks }, WAIT_SETTING] });
  assert.equal(byId(app, 'set-maxAsks'), undefined, 'not drawn while the row is closed');
  assert.deepEqual(walk(cardOf(app, 'slack')).filter((e) => e.tag === 'button' && /^Limits/.test(textOf(e))), [], 'no Limits button');
  headOf(app, 'slack-questions').listeners.click();
  assert.equal(walk(cardOf(app, 'slack')).filter((e) => e.attrs['aria-expanded'] === 'true').length, 1);
  byId(app, 'set-maxAsks').listeners.input({ target: { value: '5' } });
  assert.match(textOf(headOf(app, 'slack-questions')), /Not saved/, 'the row says a number waits for its Save');
  buttonIn(byId(app, 'slack-limits-questions'), 'Save').listeners.click();
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{ path: '/api/console-settings', body: { values: { maxAsks: 5 } } }]);
  assert.match(textOf(cardOf(app, 'slack')), /Saved\. Questions running at once: 3 sessions → 5 sessions\./);
  headOf(app, 'slack-pulls').listeners.click();
  assert.ok(byId(app, 'set-slackGiveUpDays'), 'the pull requests\' limits are in their row');
});

test('the Pull requests row opens on the picker, on the saved channel, and its Save sends the pick alone', async () => {
  const { app, posted, pickers } = await loadPage(WITH_SLACK, { slack: SLACK_ON, opened: false });
  assert.equal(pickers.length, 0, 'no picker while the row is closed');
  assert.match(textOf(headOf(app, 'slack-pulls')), /Posted to #app-prs.*#app-prs/, 'the closed row names the channel');
  headOf(app, 'slack-pulls').listeners.click();
  assert.equal(pickers.length, 1);
  assert.equal(pickers[0].opts.value, 'C0CONSOLE01');
  pickers[0].picked = 'C0NEWCHAN01';
  posted.reply = () => ({ ...SLACK_ON, channel: 'C0NEWCHAN01', channelName: 'new-prs' });
  buttonIn(cardOf(app, 'slack'), 'Save channel').listeners.click();
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{ path: '/api/console-settings/slack', body: { channel: 'C0NEWCHAN01' } }]);
  assert.match(textOf(cardOf(app, 'slack')), /Posted to #new-prs\./);
  assert.match(textOf(byId(app, 'slack-pulls')), /Saved\. The next pull request goes to the new channel\./, 'said on the row that changed');
  assert.equal(pickers.at(-1).opts.value, 'C0NEWCHAN01', 'the picker starts again on the saved channel');
  // Closing the row is its Cancel: the picker is dropped, and made again on the next open.
  headOf(app, 'slack-pulls').listeners.click();
  assert.equal(buttonIn(cardOf(app, 'slack'), 'Save channel'), undefined);
});

test('the Questions row is only where questions are answered, and has their switch', async () => {
  const none = await loadPage({ ...WITH_SLACK, webhooks: { ...WEBHOOKS, slack: null } }, { slack: SLACK_ON });
  assert.doesNotMatch(textOf(cardOf(none.app, 'slack')), /Questions/);
  const { app, posted } = await loadPage(WITH_SLACK, { slack: SLACK_ON });
  posted.reply = () => ({ webhooks: { ...WEBHOOKS, slack: { off: true, at: '2026-11-19T09:00:00.000Z', by: 'mia-dev', dropped: 0 } } });
  walk(cardOf(app, 'slack')).find((e) => e.attrs.role === 'switch').listeners.click();
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{ path: '/api/console-settings/webhooks', body: { source: 'slack', off: true } }]);
  assert.match(textOf(cardOf(app, 'slack')), /Off since on 2026-11-19, by mia-dev: the console drops each mention of its Slack bot/);
});

test('GitHub\'s webhooks are a line with the switch on it, applied as it is turned', async () => {
  const { app, posted } = await loadPage(WITH_SLACK, { slack: SLACK_ON });
  const line = cardOf(app, 'webhooks');
  assert.equal(line.className, 'set-line', 'nothing to open: the switch is on the row');
  assert.deepEqual(walk(line).filter((e) => e.attrs.role === 'switch').map((e) => [e.attrs['aria-label'], e.attrs['aria-checked']]), [['GitHub webhooks', 'true']]);
  assert.doesNotMatch(textOf(line), /Slack questions/);
  assert.equal(walk(line).find((e) => e.tag === 'a').attrs.href, '/events');
  posted.reply = () => ({ webhooks: { ...WEBHOOKS, github: { off: true, at: '2026-11-19T09:00:00.000Z', by: 'mia-dev', dropped: 2 } } });
  walk(line).find((e) => e.attrs.role === 'switch').listeners.click();
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{ path: '/api/console-settings/webhooks', body: { source: 'github', off: true } }]);
  assert.match(textOf(cardOf(app, 'webhooks')), /Off since on 2026-11-19, by mia-dev: the console drops each GitHub delivery \(2 so far\)/);
  const none = await loadPage({ ...WITH_SLACK, webhooks: { receiving: false, github: { off: false }, slack: null } });
  assert.equal(cardOf(none.app, 'webhooks'), undefined, 'no line where no webhook reaches the console');
});

test('Disconnect is offered where the store can make the secrets again, behind the typed confirm', async () => {
  const { app, confirms, posted } = await loadPage(WITH_SLACK, { slack: { ...SLACK_ON, canDisconnect: true } });
  buttonIn(cardOf(app, 'slack'), 'Disconnect Slack').listeners.click();
  assert.equal(confirms[0].word, 'slack');
  posted.reply = () => SLACK_OFF;
  await confirms[0].run();
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{ path: '/api/console-settings/slack/disconnect', body: { confirm: 'slack' } }]);
  assert.match(textOf(cardOf(app, 'slack')), /Not set up/);
});

test('an app missing scopes offers Check again, which asks Slack about the saved token and says what it found', async () => {
  const { app, posted } = await loadPage(WITH_SLACK, { slack: { ...SLACK_ON, missingScopes: ['channels:read', 'groups:read'] } });
  assert.match(textOf(cardOf(app, 'slack')), /The app lacks channels:read, groups:read\. Add them on its OAuth & Permissions page and reinstall it, then Check again\./);
  posted.reply = () => ({ ...SLACK_ON, missingScopes: [] });
  buttonIn(cardOf(app, 'slack'), 'Check again').listeners.click();
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{ path: '/api/console-settings/slack/recheck', body: {} }]);
  assert.match(textOf(cardOf(app, 'slack')), /Checked: the app has every scope the console uses\./);
  assert.doesNotMatch(textOf(cardOf(app, 'slack')), /The app lacks/);
});

test('Check again says it could not tell when Slack named no scopes, never that every one is there', async () => {
  const { app, posted } = await loadPage(WITH_SLACK, { slack: { ...SLACK_ON, missingScopes: ['groups:read'] } });
  posted.reply = () => ({ ...SLACK_ON, missingScopes: null });
  buttonIn(cardOf(app, 'slack'), 'Check again').listeners.click();
  await tick();
  assert.match(textOf(cardOf(app, 'slack')), /Checked, but Slack did not say which scopes the app has\./);
  assert.doesNotMatch(textOf(cardOf(app, 'slack')), /every scope/);
});

test('a saved token Slack refuses says so on the Bot row', async () => {
  const { app } = await loadPage(WITH_SLACK, { slack: { ...SLACK_ON, bot: { ok: false, error: 'invalid_auth' } } });
  assert.match(textOf(cardOf(app, 'slack')), /Token refused.*Slack refuses the saved token \(invalid_auth\): nothing is posted\./);
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
    [['', 'Choose a repo'], ['akurilin/social', 'akurilin/social (private)'], ['acme/web', 'acme/web'], [':type', 'Another repo: type owner/name']]);
  const card = cardOf(app, 'projects');
  assert.match(textOf(card), /Not listed\? Give the App access to it on GitHub: acme ↗, akurilin ↗; or install it on another account ↗\. Then List again/);
  assert.deepEqual(walk(card).filter((e) => e.tag === 'a' && textOf(e) !== 'Repo settings ›' && !/^PRs to /.test(textOf(e))).map((a) => [a.attrs.href, a.attrs.target]), [
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
  assert.equal(textOf(select()), 'No repo left in the listAnother repo: type owner/name', 'one not listed can still be typed in');
  repos = REPOS;
  walk(app).find((e) => e.tag === 'button' && textOf(e) === 'List again').listeners.click();
  await tick();
  assert.match(textOf(select()), /akurilin\/social/);
});

test('Another repo swaps the list for a typed owner/name, keeps the links to give the App access, and goes back to the list', async () => {
  const { app, posted } = await loadPage(ANSWER, { repos: REPOS });
  const field = () => walk(app).find((e) => e.attrs.id === 'repo-new');
  field().listeners.change({ target: { value: ':type' } });
  assert.equal(field().tag, 'input');
  assert.equal(focused.at(-1), app, 'the field takes the focus (the test DOM answers every id with the page)');
  assert.match(textOf(cardOf(app, 'projects')), /Not listed\? Give the App access to it on GitHub: acme ↗/, 'the grant links stay');
  field().listeners.input({ target: { value: 'acme/secret' } });
  const link = { href: 'https://github.com/organizations/acme/settings/installations/1', text: 'Give the App access to acme/secret on GitHub' };
  posted.refuse = Object.assign(new Error('The GitHub App may not reach acme/secret.'), { link });
  walk(app).find((e) => e.tag === 'button' && textOf(e) === 'Add repo').listeners.click();
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{ path: '/api/console-settings/projects', body: { repo: 'acme/secret', name: '' } }]);
  const error = walk(app).find((e) => e.className === 'form-error');
  assert.equal(walk(error).find((e) => e.tag === 'a').attrs.href, link.href);
  assert.equal(field().tag, 'input', 'still typing, to try again once access is given');
  walk(app).find((e) => e.tag === 'button' && textOf(e) === 'Choose from the list').listeners.click();
  assert.equal(field().tag, 'select');
});

test('where the embedding program names each repo, there is no name field, and its repos say added and can be removed', async () => {
  const hosted = {
    ...ANSWER,
    repoNames: false,
    projects: [
      { name: 'app', repo: 'acme/app', default: true, source: 'host', removable: false, sessions: 0, slackChannel: '' },
      { name: 'api', repo: 'acme/api', default: false, source: 'host', removable: true, sessions: 0, slackChannel: '' },
    ],
  };
  const { app, posted } = await loadPage(hosted, { repos: { ...REPOS, via: 'host' } });
  assert.equal(walk(app).find((e) => e.attrs.id === 'repo-name'), undefined);
  const card = textOf(cardOf(app, 'projects'));
  assert.match(card, /Sessions show it by the repo's own name/);
  assert.doesNotMatch(card, /installation's configuration/);
  assert.match(card, /acme\/api apiAdded · no sessions running/);
  posted.reply = () => ({ projects: hosted.projects.slice(0, 1) });
  walk(app).find((e) => e.tag === 'button' && textOf(e) === 'Remove').listeners.click();
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{ path: '/api/console-settings/projects/remove', body: { name: 'api' } }]);
  assert.equal(byId(app, 'repo-api'), undefined, 'its row is gone');
  assert.match(textOf(byId(app, 'repo-add')), /acme\/api removed: new sessions can no longer start on it\..*Add it again to undo\./, 'said on Add a repo, which undoes it');
});

test('with no App to ask, or GitHub not answering, Add a repo takes owner/name typed in', async () => {
  const none = await loadPage(ANSWER, { repos: { repos: null, grant: [], install: null } });
  assert.equal(walk(none.app).find((e) => e.attrs.id === 'repo-new').tag, 'input');
  assert.doesNotMatch(textOf(none.app), /Not listed/);
  const down = await loadPage(ANSWER, { repos: new Error('GitHub did not list the App\'s repos. Type the repo instead, or try again; the console log says why.') });
  assert.equal(walk(down.app).find((e) => e.attrs.id === 'repo-new').tag, 'input');
  assert.match(textOf(down.app), /GitHub did not list the App's repos\. Type the repo instead/);
});

const UPDATES = {
  clone: '/home/me/.woodshed/src', upstream: 'origin/main', remote: 'https://github.com/ChifferCo/woodshed.git', supervisor: 'setting',
  checkedAt: '2026-11-12T00:00:00.000Z', error: null, head: '0ca189f', behindBy: 2, aheadBy: 0, more: 0,
  commits: [{ sha: 'bbbbbbb', title: 'newer', author: 'Octo Cat', date: null }, { sha: 'aaaaaaa', title: 'older', author: 'Hu Bot', date: null }],
  job: null, last: null,
};
const button = (app, words) => walk(app).find((e) => e.tag === 'button' && textOf(e) === words);

test('the Woodshed row lists the newer commits, and Update shows the update\'s steps', async () => {
  const { app, posted } = await loadPage(ANSWER, { updates: UPDATES, opened: false });
  await tick();
  assert.match(textOf(headOf(app, 'card-updates')), /^WoodshedRunning 0ca189f · checked 5 min ago2 commits behind/, 'closed, the row says the version and how far behind');
  assert.equal(button(app, 'Update to latest'), undefined);
  headOf(app, 'card-updates').listeners.click();
  assert.match(textOf(app), /2 commits behind origin\/main\. Running 0ca189f/);
  assert.match(textOf(app), /bbbbbbbnewer.*aaaaaaaolder/, 'newest first');
  posted.reply = () => ({
    ...UPDATES,
    job: {
      state: 'running', from: '0ca189f', to: null, logTail: [],
      steps: [{ key: 'pull', state: 'done', detail: '0ca189f → bbbbbbb', seconds: 0 }, { key: 'starts', state: 'done', seconds: 1 }, { key: 'image', state: 'now' }, { key: 'restart', state: 'next' }],
    },
  });
  button(app, 'Update to latest').listeners.click();
  await tick();
  assert.deepEqual(posted.map((p) => p.path), ['/api/console-settings/updates/update']);
  const steps = walk(app).filter((e) => e.tag === 'li' && /^is-/.test(e.className));
  assert.deepEqual(steps.map((e) => [e.className, textOf(e)]), [
    ['is-done', '✓Pull the new commits0ca189f → bbbbbbb · 0 s'],
    ['is-done', '✓Check the new code starts1 s'],
    ['is-now', 'Build the session imagetakes a few minutes'],
    ['is-next', 'Restart the console'],
  ]);
  assert.equal(button(app, 'Updating…').attrs.disabled, '', 'no second start while it runs');
  assert.match(textOf(headOf(app, 'card-updates')), /Updating/);
  headOf(app, 'card-updates').listeners.click();
  assert.ok(isOpen(app, 'card-updates'), 'the row stays open while an update runs');
});

test('a failed update says the console runs as it did, with the build\'s last lines', async () => {
  const { app } = await loadPage(ANSWER, {
    updates: {
      ...UPDATES,
      job: {
        state: 'failed', from: '0ca189f', to: 'bbbbbbb', error: 'install.sh stopped with code 1: no space left on device', logTail: ['no space left on device'],
        steps: [{ key: 'pull', state: 'done' }, { key: 'image', state: 'failed', detail: 'install.sh stopped with code 1' }, { key: 'restart', state: 'next' }],
      },
    },
  });
  await tick();
  assert.match(textOf(app), /Failed/);
  assert.match(textOf(app), /The clone was put back on 0ca189f, so the console runs as it did/);
  assert.equal(button(app, 'Update to latest').attrs.disabled, undefined, 'it can be tried again');
});

test('the Woodshed row: up to date, a clone of its own, nothing to restart it, and no clone at all', async () => {
  const upToDate = await loadPage(ANSWER, { updates: { ...UPDATES, behindBy: 0, commits: [], last: { from: 'aaaaaaa', to: '0ca189f', by: 'mia-dev', at: '2026-11-12T00:00:00.000Z', imageBuilt: true } } });
  await tick();
  assert.match(textOf(upToDate.app), /Up to date with origin\/main/);
  assert.match(textOf(upToDate.app), /Last updated 5 min ago, from aaaaaaa to 0ca189f, by @mia-dev, with a new session image/);
  assert.equal(button(upToDate.app, 'Update to latest').attrs.disabled, '');
  const ahead = await loadPage(ANSWER, { updates: { ...UPDATES, aheadBy: 1 } });
  await tick();
  assert.match(textOf(ahead.app), /has 1 commit of its own that origin\/main does not/);
  const alone = await loadPage(ANSWER, { updates: { ...UPDATES, supervisor: null } });
  await tick();
  assert.ok(!button(alone.app, 'Update to latest'));
  assert.match(textOf(alone.app), /git -C \/home\/me\/\.woodshed\/src pull --ff-only/);
  const none = await loadPage(ANSWER);
  await tick();
  assert.ok(!/Woodshed this console runs/.test(textOf(none.app)));
  assert.equal(cardOf(none.app, 'updates'), undefined);
});

test('a console that has not come back two minutes after an update\'s restart says so, with the way back', async () => {
  const clock = { now: Date.parse('2026-11-12T01:00:00.000Z') };
  const timers = [];
  let down = false;
  const restarting = {
    ...UPDATES,
    job: {
      state: 'restarting', from: '0ca189f', to: 'bbbbbbb', error: null, logTail: [],
      steps: [{ key: 'pull', state: 'done' }, { key: 'starts', state: 'done' }, { key: 'image', state: 'done' }, { key: 'restart', state: 'now' }],
    },
  };
  const { app } = await loadPage(ANSWER, {
    clock, timers, updates: () => { if (down) throw new Error('fetch failed'); return restarting; },
  });
  await tick();
  assert.match(textOf(app), /The console is restarting on the new code/);
  const next = async () => { await timers.at(-1)(); await tick(); };
  down = true;
  clock.now += 60_000;
  await next();
  assert.match(textOf(app), /The console is restarting on the new code/, 'a minute is an ordinary restart');
  clock.now += 2 * 60_000;
  await next();
  const text = textOf(app);
  assert.match(text, /The console has not answered for 3 minutes since the update restarted it on bbbbbbb/);
  assert.match(text, /git -C \/home\/me\/\.woodshed\/src reset --keep 0ca189f/);
  assert.match(text, /This page still reloads if it comes back/);
});

test('an update that restarts between two reads, onto a console that never answers, still says so after two minutes', async () => {
  const clock = { now: Date.parse('2026-11-12T01:00:00.000Z') };
  const timers = [];
  let down = false;
  const { app, posted } = await loadPage(ANSWER, { clock, timers, updates: () => { if (down) throw new Error('fetch failed'); return UPDATES; } });
  await tick();
  // Update answers while it pulls; by the next read it has restarted, and nothing answers again.
  posted.reply = () => ({
    ...UPDATES,
    job: { state: 'running', from: '0ca189f', to: null, logTail: [], steps: [{ key: 'pull', state: 'now' }, { key: 'starts', state: 'next' }, { key: 'image', state: 'next' }, { key: 'restart', state: 'next' }] },
  });
  button(app, 'Update to latest').listeners.click();
  await tick();
  const next = async () => { await timers.at(-1)(); await tick(); };
  down = true;
  clock.now += 2_000;
  await next();
  assert.match(textOf(app), /Restarting/);
  assert.match(textOf(app), /The console is restarting on the new code/);
  clock.now += 2 * 60_000 + 30_000;
  await next();
  const text = textOf(app);
  assert.match(text, /The console has not answered for 2 minutes since the update restarted it\. Its log says why/);
  assert.match(text, /git -C \/home\/me\/\.woodshed\/src reset --keep 0ca189f/);
});

test('one failed read while the image builds is not taken for the restart once the console answers again', async () => {
  const clock = { now: Date.parse('2026-11-12T01:00:00.000Z') };
  const timers = [];
  let down = false;
  const building = {
    ...UPDATES,
    job: { state: 'running', from: '0ca189f', to: 'bbbbbbb', logTail: ['#4 building'], steps: [{ key: 'pull', state: 'done' }, { key: 'starts', state: 'done' }, { key: 'image', state: 'now' }, { key: 'restart', state: 'next' }] },
  };
  let current = UPDATES;
  const { app, posted } = await loadPage(ANSWER, { clock, timers, updates: () => { if (down) throw new Error('fetch failed'); return current; } });
  await tick();
  current = building;
  posted.reply = () => building;
  button(app, 'Update to latest').listeners.click();
  await tick();
  const next = async () => { await timers.at(-1)(); await tick(); };
  // A read lost on the way, then the console answers, still building the image, for minutes.
  down = true;
  clock.now += 2_000;
  await next();
  down = false;
  for (let i = 0; i < 4; i++) {
    clock.now += 60_000;
    await next();
  }
  const text = textOf(app);
  assert.match(text, /Updating/);
  assert.doesNotMatch(text, /Restarting/);
  assert.doesNotMatch(text, /has not answered/);
  assert.doesNotMatch(text, /reset --keep/);
});

test('each repo\'s row links to its own settings page, the installation\'s repos too', async () => {
  const { app } = await loadPage(ANSWER);
  const links = walk(app).filter((e) => e.tag === 'a' && textOf(e) === 'Repo settings ›');
  assert.deepEqual(links.map((a) => [a.attrs.href, a.attrs['aria-label']]), [
    ['/console-settings/repos/r', 'Settings of acme/app: env files, instructions and Slack channel'],
    ['/console-settings/repos/api', 'Settings of acme/api: env files, instructions and Slack channel'],
  ]);
});

const MCP_ANSWER = {
  ...ANSWER,
  servers: [{ name: 'shop', url: 'https://shop.example.com/mcp', production: false, shared: false, people: '*', repos: ['acme/api', 'acme/gone'], auth: 'header', header: 'x-api-key', headerSet: true, source: 'console', updatedBy: 'mia-dev' }],
  production: { available: false, why: 'it has no session API' }, headers: true, issuer: 'https://c.example', jwks: 'https://c.example/.well-known/jwks.json',
};
test('MCP servers: a row per server, whose form is its own; Kind is two cards, Production off with the reason here', async () => {
  const { app } = await loadPage(MCP_ANSWER, { opened: false });
  const card = cardOf(app, 'mcp');
  assert.deepEqual(walk(card).filter((e) => e.className === 'set-fold-head').map((e) => e.attrs.id), ['mcp-server-shop-head', 'mcp-add-head'], 'Add a server is the last row');
  assert.match(textOf(headOf(app, 'mcp-server-shop')), /^shopshop\.example\.com · My Woodshed sessions of everyone · repos: acme\/api, acme\/gone · X-Api-Key header · by @mia-devOrdinary/, 'closed, the row says all of it');
  assert.equal(buttonIn(card, 'Edit'), undefined, 'opening the row is its Edit');
  assert.equal(byId(app, 'mcp-server-shop-header'), undefined);
  headOf(app, 'mcp-server-shop').listeners.click();
  assert.equal(byId(app, 'mcp-server-shop-header').attrs.value, 'X-Api-Key', 'a header shows in Title-Case');
  assert.equal(byId(app, 'mcp-server-shop-name').attrs.disabled, '', 'a saved server keeps its name');
  assert.deepEqual(walk(byId(app, 'mcp-server-shop')).filter((e) => e.tag === 'button' && e.className !== 'set-fold-head').map((e) => textOf(e)), ['Save', 'Test', 'Remove']);
  headOf(app, 'mcp-add').listeners.click();
  assert.equal(byId(app, 'mcp-kind-ordinary').attrs.checked, '');
  assert.equal(byId(app, 'mcp-kind-production').attrs.disabled, '');
  assert.notEqual(byId(app, 'mcp-kind-ordinary').attrs.name, byId(app, 'mcp-server-shop-kind-ordinary').attrs.name, 'two open forms never share a radio group');
  assert.match(textOf(cardOf(app, 'mcp')), /Not on this console: it cannot lock a session down, since it has no session API\./);
});

test('MCP servers: a row closed and opened again starts from what is saved, so closing is its Cancel', async () => {
  const { app } = await loadPage(MCP_ANSWER);
  byId(app, 'mcp-server-shop-url').listeners.input({ target: { value: 'https://typed.example.com/mcp' } });
  headOf(app, 'mcp-server-shop').listeners.click();
  headOf(app, 'mcp-server-shop').listeners.click();
  assert.equal(byId(app, 'mcp-server-shop-url').attrs.value, 'https://shop.example.com/mcp');
});

test('MCP servers: one the installation sets is a line with Test alone, and Remove says so on Add a server', async () => {
  const fixed = { ...MCP_ANSWER.servers[0], name: 'warehouse', source: 'environment', production: true, auth: 'oidc', audience: 'woodshed-prod-mcp' };
  const answer = { ...MCP_ANSWER, servers: [MCP_ANSWER.servers[0], fixed] };
  const { app, posted } = await loadPage(answer);
  const row = byId(app, 'mcp-server-warehouse');
  assert.equal(row.className, 'set-line');
  assert.match(textOf(row), /^warehouse Production.*set in the installation's configurationTest$/);
  posted.reply = (path) => (path.endsWith('/remove') ? { ...answer, servers: [fixed] } : { ok: true, tools: 3 });
  buttonIn(row, 'Test').listeners.click();
  await tick();
  assert.match(textOf(byId(app, 'mcp-server-warehouse')), /Reached the server, 3 tools\./);
  buttonIn(byId(app, 'mcp-server-shop'), 'Remove').listeners.click();
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(posted.at(-1))), { path: '/api/console-settings/mcp-servers/remove', body: { name: 'shop' } });
  assert.equal(byId(app, 'mcp-server-shop'), undefined);
  assert.match(textOf(byId(app, 'mcp-add')), /shop removed: sessions started from now on do not get it/);
});

test('MCP servers: Repos is All repos and the console\'s repos, a saved one it does not list stays ticked', async () => {
  const { app } = await loadPage(MCP_ANSWER);
  assert.equal(byId(app, 'mcp-repo-all').attrs.checked, '', 'a new server is for every repo');
  assert.equal(byId(app, 'mcp-repo-0').attrs.disabled, '');
  assert.equal(byId(app, 'mcp-server-shop-repo-all').attrs.checked, undefined);
  assert.deepEqual([0, 1].map((i) => byId(app, `mcp-server-shop-repo-${i}`).attrs.checked), [undefined, '']);
  assert.equal(byId(app, 'mcp-server-shop-repo-x0').attrs.checked, '');
  assert.match(textOf(cardOf(app, 'mcp')), /acme\/gonenot a repo of this console/);
});

test('MCP servers: Save tests the form first, keeps it on a failure, and Save anyway saves untested', async () => {
  const { app, posted } = await loadPage(MCP_ANSWER);
  posted.reply = (path) => (path.endsWith('/test') ? { ok: false, status: 401, error: 'The server answered 401: it did not accept what the console added.' } : MCP_ANSWER);
  buttonIn(cardOf(app, 'mcp'), 'Save').listeners.click();
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{ path: '/api/console-settings/mcp-servers/test', body: { server: {
    name: 'shop', url: 'https://shop.example.com/mcp', production: false, shared: false, people: '*', repos: ['acme/api', 'acme/gone'], auth: 'header', header: 'X-Api-Key',
  } } }], 'no value: the console tests with the saved one');
  assert.match(textOf(byId(app, 'mcp-server-shop')), /Not saved\. The server answered 401/);
  assert.equal(byId(app, 'mcp-server-shop-url').attrs.value, 'https://shop.example.com/mcp', 'the form stays as typed');
  buttonIn(cardOf(app, 'mcp'), 'Save anyway').listeners.click();
  await tick();
  assert.deepEqual(posted.slice(1).map((p) => p.path), ['/api/console-settings/mcp-servers']);
  assert.match(textOf(byId(app, 'mcp-server-shop')), /shop saved\. Not tested\./);
});

test('MCP servers: a test that reaches the server saves and says what it found; Test on a row says it there', async () => {
  const { app, posted } = await loadPage(MCP_ANSWER);
  posted.reply = (path) => (path.endsWith('/test') ? { ok: true, status: 200, serverInfo: { name: 'shop-mcp', version: '2.0' }, tools: 12, ms: 40 } : MCP_ANSWER);
  byId(app, 'mcp-name').listeners.input({ target: { value: 'docs' } });
  byId(app, 'mcp-url').listeners.input({ target: { value: 'https://docs.example.com/mcp' } });
  buttonIn(cardOf(app, 'mcp'), 'Add server').listeners.click();
  await tick();
  assert.deepEqual(posted.map((p) => p.path), ['/api/console-settings/mcp-servers/test', '/api/console-settings/mcp-servers']);
  assert.match(textOf(byId(app, 'mcp-add')), /docs added\. Reached shop-mcp 2\.0, 12 tools in 40 ms\./);
  assert.equal(byId(app, 'mcp-name').attrs.value, '', 'the form starts again');
  buttonIn(cardOf(app, 'mcp'), 'Test').listeners.click();
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(posted.at(-1))), { path: '/api/console-settings/mcp-servers/test', body: { name: 'shop' } });
  assert.match(textOf(byId(app, 'mcp-server-shop')), /Reached shop-mcp 2\.0, 12 tools in 40 ms\./);
});

const NUMBERS = [
  SETTING,
  { key: 'maxPrivatePerPerson', label: 'My Woodshed sessions per person', help: 'For each person.', group: 'sessions', min: 1, max: 10, step: 1, unit: 'sessions', defaultValue: 3, value: 1 },
  { key: 'idleHours', label: 'Pause a session waiting for input after', help: 'Nothing came in.', group: 'sessions', min: 0.25, max: 24, step: 0.25, unit: 'hours', defaultValue: 1, value: 1 },
  { key: 'lifetimeHours', label: 'Stop a working session after', help: 'A backstop.', group: 'sessions', min: 1, max: 24, step: 1, unit: 'hours', defaultValue: 8, value: 8 },
  { key: 'keepAfterCloseDays', label: 'Delete a merged or closed session after', help: 'From its merge.', group: 'retention', min: 0, max: 30, step: 1, unit: 'days', defaultValue: 3, value: 3 },
];
const HELD = { id: 'aaaa1111', title: 'Fix the export', sessionKind: 'issue', number: 7, stopReason: 'idle for 1 h', database: 'woodshed__aaaa1111', home: true, deletesAt: null };
const STALLED = { kind: 'databases', id: 'bbbb2222', title: 'Old one', why: 'Its databases could not be dropped.', meta: ['woodshed__bbbb2222'] };

test('the page is groups of rows: a closed row says its value and its status word, and several open at once', async () => {
  const data = { held: [HELD], stalled: [STALLED], totals: { databases: 1, homes: 1, homeBytes: 2_000_000 } };
  const { app } = await loadPage({ ...ANSWER, settings: NUMBERS, data }, { opened: false });
  assert.deepEqual(walk(app).filter((e) => e.className === 'set-group').map((e) => [e.attrs.id, textOf(e.children[0])]),
    [['card-projects', 'Repos'], ['card-sessions', 'Shared sessions'], ['set-kept', 'Kept sessions']], 'a group with no row is left out');
  assert.equal(walk(app).filter((e) => e.className === 'settings-card').length, 0, 'no card is left');
  assert.equal(textOf(headOf(app, 'sessions-running')), 'Running at once4 shared sessions · 1 My Woodshed session per personChanged▸');
  assert.equal(textOf(headOf(app, 'sessions-timeouts')), 'TimeoutsPause after 1 hour waiting for input · stop after 8 hours workingDefaults▸');
  assert.equal(textOf(headOf(app, 'card-retention')), 'RetentionDeleted 3 days after mergeDefaults▸');
  assert.equal(textOf(headOf(app, 'card-data')), 'Sessions holding data1 stopped session keeps its conversation and databases · checked every minute1 stalled▸');
  assert.equal(byId(app, 'set-idleHours'), undefined, 'a closed row draws no form');
  headOf(app, 'sessions-timeouts').listeners.click();
  headOf(app, 'card-data').listeners.click();
  assert.deepEqual(['sessions-running', 'sessions-timeouts', 'card-data'].map((id) => isOpen(app, id)), [false, true, true]);
  assert.match(textOf(byId(app, 'card-data')), /Stalled1Old oneIts databases could not be dropped\..*Drop again.*Kept, waiting to be resumed or deleted1Fix the export.*Total kept: /);
  const empty = await loadPage({ ...ANSWER, data: { held: [], stalled: [], totals: { databases: 0, homes: 0, homeBytes: 0 } } });
  assert.equal(byId(empty.app, 'card-data').className, 'set-fold is-plain', 'nothing held: a plain line');
  assert.match(textOf(byId(empty.app, 'card-data')), /^Sessions holding dataNothing is held or stalled\. Total kept: .*None$/);
});

test('Running at once and Timeouts each save their own numbers, and leave the other row\'s alone', async () => {
  const { app, posted } = await loadPage({ ...ANSWER, settings: NUMBERS });
  posted.reply = (path, body) => ({ settings: NUMBERS.map((s) => (s.key in body.values ? { ...s, value: body.values[s.key] } : s)) });
  byId(app, 'set-maxRunning').listeners.input({ target: { value: '6' } });
  byId(app, 'set-idleHours').listeners.input({ target: { value: '2' } });
  byId(app, 'set-lifetimeHours').listeners.input({ target: { value: '6' } });
  assert.equal(textOf(buttonIn(byId(app, 'sessions-timeouts'), 'Save 2 changes')), 'Save 2 changes');
  buttonIn(byId(app, 'sessions-timeouts'), 'Save 2 changes').listeners.click();
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{ path: '/api/console-settings', body: { values: { idleHours: 2, lifetimeHours: 6 } } }]);
  assert.equal(byId(app, 'set-maxRunning').attrs.value, '6', 'what was typed in the other row is kept');
  assert.match(textOf(headOf(app, 'sessions-running')), /Not saved/);
  assert.match(textOf(headOf(app, 'sessions-timeouts')), /Pause after 2 hours waiting for input · stop after 6 hours workingChanged/);
  byId(app, 'set-maxRunning').listeners.input({ target: { value: '99' } });
  assert.match(textOf(byId(app, 'sessions-running')), /Must be from 1 to 20 sessions\./);
  assert.equal(buttonIn(byId(app, 'sessions-running'), 'Save').attrs.disabled, '');
});

test('the old #slack, followed while the page is shown, lands on the Slack group', async () => {
  const { app, location, events, lookups } = await loadPage(WITH_SLACK, { slack: SLACK_ON, opened: false });
  app.scrollIntoView = () => {};
  lookups.length = 0;
  location.hash = '#slack';
  for (const fn of events.hashchange) fn();
  assert.ok(lookups.includes('card-slack'), 'the group is looked for under the name it has now');
});

test('a link that names a row opens it: the repos open on Add a repo, and the old #slack lands on Slack', async () => {
  const repos = await loadPage(ANSWER, { opened: false, hash: '#card-projects' });
  assert.ok(isOpen(repos.app, 'repo-add'));
  assert.equal(isOpen(repos.app, 'repo-r'), false);
  const data = await loadPage({ ...ANSWER, settings: NUMBERS }, { opened: false, hash: '#card-retention' });
  assert.ok(isOpen(data.app, 'card-retention'));
  const slack = await loadPage(WITH_SLACK, { slack: SLACK_ON, opened: false, hash: '#slack' });
  assert.ok(cardOf(slack.app, 'slack'), 'the group the link names is drawn');
  const none = await loadPage({ ...ANSWER, projects: [] }, { opened: false });
  assert.ok(isOpen(none.app, 'repo-add'), 'with no repo yet, Add a repo is open');
  assert.match(textOf(byId(none.app, 'repo-none')), /^No repo yetSo no session can start\. The first one added becomes the default\.$/);
});
