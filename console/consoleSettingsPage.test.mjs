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

// `updates` may be a function, called on each read (throwing as a console that does not answer); `clock.now` stands in
// for Date.now, and `timers` collects what the page schedules, so a test can run them.
async function loadPage(answer, { repos, updates = null, clock = null, timers = null } = {}) {
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
      // The Woodshed card's own read: a console that runs from no git clone answers 404.
      if (path === '/api/console-settings/updates') {
        if (!updates) throw Object.assign(new Error('this console does not run from a git clone'), { status: 404 });
        return structuredClone(typeof updates === 'function' ? updates() : updates);
      }
      return structuredClone(answer);
    },
    ago: () => '5 min ago',
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
    window: { Woodshed: W }, console, setInterval: () => 0, setTimeout: (fn) => { timers?.push(fn); return 0; }, clearTimeout: () => {},
    Date: clock ? Object.assign(class extends Date {}, { now: () => clock.now }) : Date,
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
  assert.deepEqual(walk(card).filter((e) => e.tag === 'a' && textOf(e) !== 'Settings').map((a) => [a.attrs.href, a.attrs.target]), [
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

const UPDATES = {
  clone: '/home/me/.woodshed/src', upstream: 'origin/main', remote: 'https://github.com/ChifferCo/woodshed.git', supervisor: 'setting',
  checkedAt: '2026-11-12T00:00:00.000Z', error: null, head: '0ca189f', behindBy: 2, aheadBy: 0, more: 0,
  commits: [{ sha: 'bbbbbbb', title: 'newer', author: 'Octo Cat', date: null }, { sha: 'aaaaaaa', title: 'older', author: 'Hu Bot', date: null }],
  job: null, last: null,
};
const button = (app, words) => walk(app).find((e) => e.tag === 'button' && textOf(e) === words);

test('the Woodshed card lists the newer commits, and Update shows the update\'s steps', async () => {
  const { app, posted } = await loadPage(ANSWER, { updates: UPDATES });
  await tick();
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

test('the Woodshed card: up to date, a clone of its own, nothing to restart it, and no clone at all', async () => {
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

test('each repo on the Repos card links to its own settings page, the installation\'s repos too', async () => {
  const { app } = await loadPage(ANSWER);
  const links = walk(app).filter((e) => e.tag === 'a' && textOf(e) === 'Settings');
  assert.deepEqual(links.map((a) => [a.attrs.href, a.attrs['aria-label']]), [
    ['/console-settings/repos/r', 'Settings of acme/app: env files and instructions'],
    ['/console-settings/repos/api', 'Settings of acme/api: env files and instructions'],
  ]);
});
