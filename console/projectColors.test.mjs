import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import shared from './public/projectColors.cjs';
import { createProjectColors } from './projectColors.mjs';

const { PALETTE, projectColors, railProject, countByProject } = shared;

function storeWith(state = {}) {
  let saves = 0;
  return { state, save() { saves += 1; }, get saves() { return saves; } };
}

const configOf = (...names) => ({ projects: names.map((name, i) => ({ name, repo: `acme/${name}`, default: i === 0 })) });

test('the palette is six colours, each a light and a dark token in style.css', () => {
  assert.equal(PALETTE.length, 6);
  assert.equal(new Set(PALETTE).size, 6);
  const css = readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  for (const key of PALETTE) {
    assert.equal(css.match(new RegExp(`--proj-${key}: #`, 'g'))?.length, 3, `--proj-${key} in light and both dark blocks`);
    assert.equal(css.match(new RegExp(`--proj-${key}-tint: #`, 'g'))?.length, 3, `--proj-${key}-tint in light and both dark blocks`);
    assert.ok(css.includes(`.proj-${key} { --project: var(--proj-${key});`), `.proj-${key} sets --project`);
  }
});

test('a project with no colour picked takes the first free one, in the order the projects are listed', () => {
  assert.deepEqual(projectColors({ names: ['app', 'api', 'web'] }), { app: 'teal', api: 'plum', web: 'sienna' });
  assert.deepEqual(projectColors({ names: ['app', 'api', 'web'], picked: { api: 'teal' } }), { app: 'plum', api: 'teal', web: 'sienna' }, 'a pick is never taken by a default');
  assert.deepEqual(projectColors({ names: ['app', 'api', 'web', 'lib'] }).web, 'sienna', 'a repo added later leaves the earlier ones as they were');
});

test('two projects never share a colour: the first listed keeps a pick both have, and a pick outside the palette is ignored', () => {
  assert.deepEqual(projectColors({ names: ['app', 'api'], picked: { app: 'rose', api: 'rose' } }), { app: 'rose', api: 'teal' });
  assert.deepEqual(projectColors({ names: ['app'], picked: { app: 'red' } }), { app: 'teal' });
  assert.deepEqual(projectColors({ names: ['app'], picked: null }), { app: 'teal' });
});

test('past six projects the palette has run out, and the rest have no colour', () => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const colors = projectColors({ names });
  assert.deepEqual(names.slice(0, 6).map((n) => colors[n]), PALETTE);
  assert.equal(colors.g, null);
});

test('the rail\'s project filter is the one kept, unless that project is gone, which is All', () => {
  assert.equal(railProject({ saved: 'api', names: ['app', 'api'] }), 'api');
  assert.equal(railProject({ saved: 'removed', names: ['app', 'api'] }), null);
  assert.equal(railProject({ saved: null, names: ['app', 'api'] }), null);
  assert.equal(railProject({ saved: '', names: ['app', 'api'] }), null);
});

test('the filter chips count the sessions on each project', () => {
  assert.deepEqual(countByProject([{ project: 'app' }, { project: 'api' }, { project: 'app' }, {}]), { app: 2, api: 1 });
});

test('an admin\'s pick is checked against the palette and the other projects, and keeps everyone else\'s colour', () => {
  const store = storeWith();
  const colors = createProjectColors({ store, config: configOf('app', 'api', 'web') });
  assert.deepEqual(colors.view(), { app: 'teal', api: 'plum', web: 'sienna' });

  colors.set({ name: 'app', color: 'rose', by: 'mia-dev' });
  assert.deepEqual(colors.view(), { app: 'rose', api: 'plum', web: 'sienna' }, 'teal freed by app does not move api or web');
  assert.equal(store.saves, 1);

  assert.throws(() => colors.set({ name: 'web', color: 'plum', by: 'mia-dev' }), { shown: true, message: /api has plum already/ });
  assert.throws(() => colors.set({ name: 'web', color: 'red', by: 'mia-dev' }), { shown: true, message: /one of teal, plum/ });
  assert.throws(() => colors.set({ name: 'web', color: { teal: 1 }, by: 'mia-dev' }), { shown: true });
  assert.throws(() => colors.set({ name: 'nope', color: 'moss', by: 'mia-dev' }), { shown: true, message: /no project called nope/ });
  assert.throws(() => colors.set({ name: 'toString', color: 'moss', by: 'mia-dev' }), { shown: true, message: /no project called/ });

  colors.set({ name: 'api', color: 'plum', by: 'mia-dev' });
  assert.equal(store.saves, 1, 'the colour it has already is no change');
});

test('a project added after the picks takes a colour nobody has', () => {
  const store = storeWith({ projectColors: { app: 'teal', api: 'plum' } });
  const config = configOf('app', 'api');
  const colors = createProjectColors({ store, config });
  config.projects.push({ name: 'web', repo: 'acme/web', default: false });
  assert.deepEqual(colors.view(), { app: 'teal', api: 'plum', web: 'sienna' });
});

test('a removed project\'s pick is dropped, so the same name added again never takes back a colour another has now', () => {
  const store = storeWith({ projectColors: { app: 'teal', api: 'plum', web: 'sienna' } });
  const config = configOf('app', 'api', 'web');
  const colors = createProjectColors({ store, config });
  config.projects.pop();
  colors.forget({ name: 'web' });
  assert.deepEqual(store.state.projectColors, { app: 'teal', api: 'plum' });
  config.projects.push({ name: 'docs', repo: 'acme/docs', default: false });
  assert.equal(colors.view().docs, 'sienna', 'the colour web had is free');
  config.projects.push({ name: 'web', repo: 'acme/web', default: false });
  assert.deepEqual(colors.view(), { app: 'teal', api: 'plum', docs: 'sienna', web: 'rose' }, 'docs keeps sienna');

  colors.forget({ name: 'gone' });
  assert.equal(store.saves, 1, 'a name with no pick is no change');
});
