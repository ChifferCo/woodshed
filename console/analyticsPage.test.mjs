// The Analytics page (public/analytics.js) on a tiny DOM: Show more and Show all change the rows shown, picking a person
// starts the lists again, a repo picks the pull requests below it, and the human-review filters keep people, drop none
// and leave out those whose reviews were not all read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import { analyticsReport } from './analytics.mjs';

const read = (f) => fs.readFileSync(new URL(`./public/${f}`, import.meta.url), 'utf8');
const NOW = Date.now();
const DAY = 86_400_000;

function element(tag) {
  return {
    tag, attrs: {}, listeners: {}, children: [], className: '', value: '', style: {}, hidden: false,
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(k, fn) { this.listeners[k] = fn; },
    append(c) { this.children.push(c); },
    replaceChildren(...c) { this.children = c; },
  };
}
const textOf = (el) => (typeof el === 'string' ? el : el.children.map(textOf).join(''));
function walk(el, out = []) {
  if (typeof el === 'string') return out;
  out.push(el);
  for (const c of el.children) walk(c, out);
  return out;
}

// 60 pull requests on two repos by two people: every third reviewed by a person, every fifth with reviews not all read.
function report() {
  const repos = ['o/api', 'o/web'];
  const pulls = repos.map((repo) => ({ project: repo.split('/')[1], repo, pulls: Array.from({ length: 60 }, (_, i) => ({
    number: i + 1, url: `https://github.com/${repo}/pull/${i + 1}`, title: `Change ${i + 1}`, author: i % 2 ? 'ana' : 'bo', bot: false,
    createdAt: new Date(NOW - (i % 20) * DAY - 3_600_000).toISOString(), mergedAt: null, closedAt: null, state: 'open', additions: 5, deletions: 1,
    branch: `b${i}`, headRepo: repo, tier: null,
    humanReviewers: i % 3 === 0 ? ['cy'] : [], botReviewers: [], reviewsPartial: i % 3 !== 0 && i % 5 === 0,
  })) }));
  const records = Array.from({ length: 70 }, (_, i) => ({
    id: `aaaa${String(i).padStart(4, '0')}`, project: 'api', repo: 'o/api', kind: 'work', login: i % 2 ? 'ana' : 'bo', private: false, agent: 'claude',
    createdAt: new Date(NOW - i * 3_600_000).toISOString(), title: `S${i}`, branch: null, prUrls: [], status: 'stopped',
  }));
  return { ...analyticsReport({ records, pulls, members: ['ana', 'bo'], days: 30, now: NOW }), windows: [7, 30, 90], projects: ['api', 'web'], failed: [], truncated: false };
}

async function loadPage(data, { getJson = async () => data, postJson, timers = { setTimeout, clearTimeout } } = {}) {
  const app = element('div');
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
  const location = { pathname: '/analytics', search: '?days=30', hash: '' };
  const W = {
    h, scopePill: () => element('span'), person: (l) => `@${l}`, personText: (l) => `@${l}`,
    settingsPage: (_match, start) => start(app, { nav: () => element('nav'), ended: false }),
    getJson, ...(postJson ? { postJson } : {}),
  };
  const window = { Woodshed: W, location, history: { replaceState: (_a, _b, url) => { location.search = url.includes('?') ? url.slice(url.indexOf('?')) : ''; } } };
  const context = vm.createContext({ window, document: { createElementNS: (_ns, tag) => element(tag) }, URLSearchParams, ...timers });
  for (const f of ['settingsRows.js', 'analyticsDays.js', 'analytics.js']) vm.runInContext(read(f), context);
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  const buttons = () => walk(app).filter((e) => e.tag === 'button');
  const click = (text) => {
    const b = buttons().find((x) => textOf(x).trim() === text);
    assert.ok(b, `a button "${text}"`);
    b.listeners.click();
  };
  // The tables in page order: repos, people, sessions, pull requests.
  const rows = (name) => {
    const index = { repos: 0, people: 1, sessions: 2, pulls: 3 }[name];
    return walk(app).filter((e) => e.tag === 'table')[index]?.children.find((c) => c.tag === 'tbody').children ?? [];
  };
  const pulledNumbers = () => rows('pulls').map((r) => textOf(r.children[1]).match(/#(\d+)/)[1] + '@' + textOf(r.children[1]).match(/o\/(\w+)/)?.[1]);
  return { app, click, rows, buttons, walk: () => walk(app), location, pulledNumbers };
}

test('Show more adds a page and Show all the rest, on both lists, and a person picked starts them again', async () => {
  const page = await loadPage(report());
  assert.equal(page.rows('sessions').length, 25);
  assert.equal(page.rows('pulls').length, 25);
  const more = page.buttons().filter((b) => /^Show 25 more$/.test(textOf(b).trim()));
  assert.equal(more.length, 2, 'one under each list');
  more[1].listeners.click();
  assert.equal(page.rows('pulls').length, 50, 'Show more on the pull requests');
  assert.equal(page.rows('sessions').length, 25, 'the other list as it was');
  page.click('Show all 120');
  assert.equal(page.rows('pulls').length, 120);
  page.click('Show all 70');
  assert.equal(page.rows('sessions').length, 70);
  // Pick bo from the people table: both lists start at 25 again, and only theirs.
  const bo = page.walk().find((e) => e.tag === 'button' && e.attrs.title === 'Show only their sessions and pull requests' && textOf(e).includes('@bo'));
  bo.listeners.click();
  assert.match(page.location.search, /person=bo/);
  assert.equal(page.rows('sessions').length, 25);
  assert.equal(page.rows('pulls').length, 25);
  assert.ok(page.rows('pulls').every((r) => textOf(r).includes('@bo')));
});

test('a repo picked in the by-repo table keeps only its pull requests in the list', async () => {
  const page = await loadPage(report());
  const web = page.walk().find((e) => e.tag === 'button' && e.attrs.title === 'Show only this repo\'s pull requests below' && textOf(e).includes('o/web'));
  web.listeners.click();
  assert.match(page.location.search, /repo=o%2Fweb/);
  page.click('Show all 60');
  // Every session ran on o/api, so with o/web picked there is no sessions table and the pull requests' is the last.
  const tables = page.walk().filter((e) => e.tag === 'table');
  assert.equal(tables.length, 3, 'repos, people, pull requests');
  const listed = tables.at(-1).children.find((c) => c.tag === 'tbody').children;
  assert.equal(listed.length, 60);
  assert.ok(listed.every((r) => textOf(r.children[1]).includes('o/web')));
});

test('the Repo menu narrows sessions, figures and people to one repo, and All repos puts them back', async () => {
  const page = await loadPage(report());
  const menu = () => page.walk().find((e) => e.tag === 'select' && e.attrs['aria-label'] === 'Repo');
  assert.ok(menu(), 'offered with more than one repo');
  assert.deepEqual(menu().children.map(textOf), ['All repos', 'o/api', 'o/web']);
  menu().listeners.change({ target: { value: 'o/api' } });
  assert.match(page.location.search, /repo=o%2Fapi/);
  assert.equal(page.rows('sessions').length, 25, 'o/api has all 70 sessions');
  assert.ok(page.walk().some((e) => textOf(e) === 'Sessions started · 70'));
  menu().listeners.change({ target: { value: 'o/web' } });
  assert.equal(page.walk().filter((e) => e.tag === 'table').length, 3, 'no sessions on o/web');
  menu().listeners.change({ target: { value: '' } });
  assert.equal(page.location.search.includes('repo='), false);
  assert.equal(page.walk().filter((e) => e.tag === 'table').length, 4);
});

test('a repo in the link that the report does not list filters nothing', async () => {
  const data = { ...report(), repos: ['o/api', 'o/web'] };
  const page = await loadPage(data);
  page.location.search = '?days=30&repo=o%2Fgone';
  page.click('30 days');
  assert.equal(page.walk().filter((e) => e.tag === 'table').length, 4, 'every table, as with All repos');
});

test('Human reviewed keeps those a person reviewed, No human review keeps those with none read, and those whose reviews were not all read are in neither', async () => {
  const page = await loadPage(report());
  // Of each repo's 60: i % 3 == 0 reviewed (20); the rest, with i % 5 == 0 not known (i % 15 == 5 or 10: 8); none known 32.
  page.click('Human reviewed');
  page.click('Show all 40');
  assert.equal(page.rows('pulls').length, 40);
  assert.ok(page.rows('pulls').every((r) => textOf(r).includes('@cy')));
  page.click('No human review');
  page.click('Show all 64');
  const none = page.rows('pulls');
  assert.equal(none.length, 64);
  assert.ok(none.every((r) => textOf(r).includes('No human') && !textOf(r).includes('Not known')));
  assert.equal(page.walk().filter((e) => e.tag === 'span' && textOf(e) === 'Not known').length, 0);
});

test('Refresh posts to the console, shows Refreshing… while the read runs, and returns with the new time', async () => {
  const before = { ...report(), asOf: '2026-11-01T00:00:00.000Z', refreshing: false, refreshFailed: false };
  const after = { ...before, asOf: '2026-11-02T00:00:00.000Z' };
  const answers = [{ ...before, refreshing: true }, after];
  const posts = [];
  let gets = 0;
  const queue = [];
  const page = await loadPage(before, {
    getJson: async () => { gets += 1; return gets === 1 ? before : answers.shift(); },
    postJson: async (url, body) => { posts.push([url, body]); return { started: 1 }; },
    timers: { setTimeout: (fn) => { queue.push(fn); return queue.length; }, clearTimeout() {} },
  });
  const label = () => page.buttons().map((b) => textOf(b).trim()).filter((t) => /^Refresh/.test(t));
  const asOf = () => textOf(page.walk().find((e) => /analytics-asof/.test(e.className))).replace(/\s*Refresh.*$/, '');
  const first = asOf();
  assert.deepEqual(label(), ['Refresh']);
  page.click('Refresh');
  assert.equal(JSON.stringify(posts), '[["/api/analytics/refresh",{}]]', 'the click posts to the console');
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  assert.deepEqual(label(), ['Refreshing…'], 'disabled while the console reads');
  assert.equal(page.buttons().find((b) => /^Refreshing/.test(textOf(b))).attrs.disabled, '');
  assert.equal(queue.length, 1, 'the page asks again later');
  queue.shift()();
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  assert.deepEqual(label(), ['Refresh'], 'enabled again');
  assert.ok(first.startsWith('Pull requests as of') && asOf() !== first, 'with the page showing the data as of the new read');
  assert.equal(queue.length, 0, 'and it stops asking');
});

test('the Sessions group draws the agents as a bar with a tag and count for each, and the people table a bar before each count', async () => {
  const data = report();
  data.sessions.agents = { claude: 50, codex: 20 };
  data.sessions.work = 70;
  const page = await loadPage(data);
  const bar = page.walk().find((e) => String(e.attrs['aria-label'] ?? '').startsWith('Sessions by agent'));
  assert.ok(bar, 'an agent bar');
  assert.equal(bar.attrs['aria-label'], 'Sessions by agent: Claude 50, Codex 20');
  assert.equal(bar.children.length, 2, 'a segment for each agent');
  const tags = page.walk().filter((e) => /agent-tag/.test(e.className) && /\d$/.test(textOf(e))).map((e) => textOf(e));
  assert.deepEqual(tags, ['Claude 50', 'Codex 20']);
  assert.ok(page.walk().some((e) => e.className === 'cell-bar-fill'), 'a bar in the people table');
});

test('every chart is the one component: a y axis of ticks, gridlines, more than two day labels, and a tooltip with the day, each series and the total', async () => {
  const data = report();
  data.sessions.agents = { claude: 50, codex: 20 };
  data.sessions.work = 70;
  data.sessions.recent.forEach((r, i) => { if (i % 2) r.agent = 'codex'; });
  data.pulls.recent.forEach((p, i) => { p.via = i % 2 ? 'woodshed' : 'other'; });
  const page = await loadPage(data);
  const charts = page.walk().filter((e) => e.className === 'trend');
  assert.equal(charts.length, 3, 'sessions, pull requests opened, pull requests merged');
  for (const chart of charts) {
    const all = walk(chart);
    const ticks = all.find((e) => e.className === 'trend-y mono').children.map(textOf);
    assert.ok(ticks.length >= 2 && ticks[0] === '0', `ticks from 0: ${ticks}`);
    assert.equal(all.find((e) => e.className === 'trend-grid').children.length, ticks.length, 'a gridline for each tick');
    const labels = all.find((e) => e.className === 'trend-x mono').children.map(textOf);
    assert.ok(labels.length >= 3 && labels.at(-1) === 'today', `labelled days: ${labels}`);
    assert.ok(!all.some((e) => /trend-max/.test(e.className)), 'no max in the corner');
  }
  // Sessions: stacked by agent with the Agents bar's classes, and a legend of them.
  const [sessions, opened] = charts;
  const segs = walk(sessions).filter((e) => /trend-seg/.test(e.className)).map((e) => e.className);
  assert.ok(segs.some((c) => /is-agent-claude/.test(c)) && segs.some((c) => /is-agent-codex/.test(c)), 'a segment for each agent');
  assert.ok(!segs.some((c) => /is-violet/.test(c)), 'no colour that is one agent\'s for the total');
  assert.deepEqual(walk(sessions).find((e) => e.className === 'trend-legend').children.map(textOf), ['Claude', 'Codex']);
  // Hovering a column shows its day, each series and the total.
  const col = walk(sessions).find((e) => e.className === 'trend-col' && /Claude/.test(e.attrs['aria-label']) && !/0 Claude/.test(e.attrs['aria-label']));
  col.listeners.mouseenter();
  const tip = walk(sessions).find((e) => e.className === 'trend-tip');
  assert.equal(tip.hidden, false);
  assert.match(textOf(tip), /^(From|Day of) \w+ \d+\d* .*Claude.*in all$|From .*Claude/);
  col.listeners.mouseleave();
  assert.equal(tip.hidden, true);
  const popped = walk(opened).find((e) => e.className === 'trend-col' && /[1-9]\d* through Woodshed, [1-9]\d* without/.test(e.attrs['aria-label']));
  popped.listeners.focus();
  assert.match(textOf(walk(opened).find((e) => e.className === 'trend-tip')), /Day of .*through Woodshed.*without.*in all/);
});

test('the people table gives the whole merge risk, a dash for nothing reviewed, and says what each slashed pair is', async () => {
  const data = report();
  data.people = [
    { login: 'ana', sessions: 1, activeDays: 1, lastAt: new Date(NOW).toISOString(), share: 0.5,
      woodshed: { opened: 2, merged: 1, medianMergeHours: 3, tiers: { Low: 2, Medium: 0, High: 0 }, added: 1, removed: 1 },
      other: { opened: 1, merged: 1, medianMergeHours: 5, tiers: { Low: 0, Medium: 1, High: 3 }, added: 1, removed: 1 } },
    { login: 'bo', sessions: 1, activeDays: 1, lastAt: null, share: null,
      woodshed: { opened: 0, merged: 0, medianMergeHours: null, tiers: { Low: 0, Medium: 0, High: 0 }, added: 0, removed: 0 },
      other: { opened: 1, merged: 0, medianMergeHours: null, tiers: { Low: 0, Medium: 0, High: 0 }, added: 0, removed: 0 } },
  ];
  const page = await loadPage(data);
  const [ana, bo] = page.rows('people');
  const risk = (r) => textOf(r.children[8]);
  assert.equal(risk(ana), '2 low1 med3 high');
  assert.equal(walk(ana.children[8]).find((e) => e.attrs?.role === 'img').attrs['aria-label'], 'Merge risk: 2 low, 1 medium, 3 high');
  assert.equal(risk(bo), '—');
  assert.match(walk(bo.children[8]).find((e) => e.className === 'quiet').attrs.title, /none of their pull requests was reviewed/i);
  const heads = walk(page.app).filter((e) => e.tag === 'th').map(textOf);
  assert.ok(heads.includes('Woodshed PRsopened / merged') && heads.includes('Other PRsopened / merged') && heads.includes('To mergeWoodshed / without'), heads.join('|'));
});
