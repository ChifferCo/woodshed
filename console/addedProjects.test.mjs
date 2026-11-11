import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAddedProjects, repoChecker } from './addedProjects.mjs';
import { liveConfig } from './consoleSettings.mjs';

const base = {
  repo: 'acme/app', githubApp: { installationId: '100' },
  projects: [{ name: 'app', repo: 'acme/app', default: true }],
  limits: { idleMs: 1, lifetimeMs: 1 },
};

function setup({ sessions = [], check } = {}) {
  const store = { state: { sessions }, saves: 0, save() { this.saves += 1; } };
  const config = liveConfig(base, store);
  const checked = [];
  const added = createAddedProjects({
    store, config, now: () => 0,
    check: check ?? (async (repo) => { checked.push(repo); return { installationId: '100' }; }),
  });
  return { store, config, added, checked };
}

test('an added repo joins the live config at once, after the installation\'s own, and survives a reload of the state', async () => {
  const { store, config, added } = setup();
  assert.deepEqual(config.projects.map((p) => p.name), ['app']);
  const project = await added.add({ repo: 'acme/API-Server', by: 'octocat' });
  assert.deepEqual(project, { name: 'api-server', repo: 'acme/API-Server', default: false, addedBy: 'octocat', addedAt: '1970-01-01T00:00:00.000Z' });
  assert.deepEqual(config.projects.map((p) => [p.name, p.default]), [['app', true], ['api-server', false]]);
  assert.equal(store.saves, 1);
  assert.deepEqual(liveConfig(base, store).projects.map((p) => p.name), ['app', 'api-server'], 'a restart reads it back from the state');
  assert.deepEqual(base.projects.map((p) => p.name), ['app'], 'the environment\'s list is not changed');
});

test('a GitHub URL or a name the admin chose is taken as typed', async () => {
  const { added } = setup();
  assert.equal((await added.add({ repo: 'https://github.com/acme/tools.git', name: 'dev-tools', by: 'a' })).repo, 'acme/tools');
  assert.equal(added.view().find((p) => p.repo === 'acme/tools').name, 'dev-tools');
});

test('a repo on another installation keeps its number; one on the console\'s own does not', async () => {
  const { added, config } = setup({ check: async (repo) => ({ installationId: repo === 'other/lib' ? '200' : '100' }) });
  await added.add({ repo: 'other/lib', by: 'a' });
  await added.add({ repo: 'acme/web', by: 'a' });
  assert.equal(config.projects.find((p) => p.name === 'lib').installationId, '200');
  assert.equal(config.projects.find((p) => p.name === 'web').installationId, undefined);
});

test('a bad repo, a bad name, a repo already there or a name in use is refused before GitHub is asked', async () => {
  const { added, checked, store } = setup();
  const refused = (args, message) => assert.rejects(added.add({ ...args, by: 'a' }), (err) => err.shown && message.test(err.message));
  await refused({ repo: 'acme' }, /owner\/name/);
  await refused({ repo: '' }, /owner\/name/);
  await refused({ repo: 'acme/x', name: 'Bad Name' }, /lowercase/);
  await refused({ repo: 'ACME/App' }, /already a project, named app/);
  await refused({ repo: 'acme/other', name: 'app' }, /used by acme\/app/);
  assert.deepEqual(checked, []);
  assert.equal(store.saves, 0);
  await added.add({ repo: 'acme/other', by: 'a' });
  await refused({ repo: 'acme/OTHER' }, /already a project/);
});

test('a repo GitHub refuses is not kept', async () => {
  const { added, store, config } = setup({ check: async () => { throw Object.assign(new Error('The GitHub App is not installed'), { shown: true }); } });
  await assert.rejects(added.add({ repo: 'acme/x', by: 'a' }), /not installed/);
  assert.equal(store.saves, 0);
  assert.equal(config.projects.length, 1);
});

test('only an added repo is removed, and not while a session is running on it or kept to resume', async () => {
  const { added, config, store } = setup({ sessions: [{ id: 'aaaaaaaa', project: 'api', repo: 'acme/api', status: 'running' }] });
  await added.add({ repo: 'acme/api', by: 'a' });
  assert.equal(added.view().find((p) => p.name === 'api').sessions, 1);
  assert.throws(() => added.remove({ name: 'api', by: 'a' }), (err) => err.shown && /1 session is still running, or listed to resume/.test(err.message));
  assert.throws(() => added.remove({ name: 'app', by: 'a' }), /set in the installation's configuration/);
  assert.throws(() => added.remove({ name: 'nope', by: 'a' }), /no project called nope/);
  store.state.sessions = [{ id: 'aaaaaaaa', project: 'api', repo: 'acme/api', status: 'stopped', kept: false }];
  added.remove({ name: 'api', by: 'a' });
  assert.deepEqual(config.projects.map((p) => p.name), ['app']);
  store.state.sessions = [{ id: 'bbbbbbbb', project: 'app', repo: 'acme/app', status: 'stopped', kept: true }];
  assert.equal(added.view()[0].sessions, 1, 'a kept shared session counts too');
});

test('the view says which repos can be removed', async () => {
  const { added } = setup();
  await added.add({ repo: 'acme/api', by: 'octocat' });
  assert.deepEqual(added.view().map((p) => [p.name, p.default, p.removable, p.addedBy]), [['app', true, false, null], ['api', false, true, 'octocat']]);
});

test('with the App, the repo must have it installed; without, gh must read the repo', async () => {
  const appApi = { installationOf: async (repo) => (repo === 'acme/yes' ? '300' : null) };
  assert.deepEqual(await repoChecker({ appApi })('acme/yes'), { installationId: '300' });
  await assert.rejects(repoChecker({ appApi })('acme/no'), (err) => err.shown && /App is not installed on acme\/no/.test(err.message));
  await assert.rejects(repoChecker({ appApi })('acme/no'), (err) => !err.link, 'no link while the App\'s slug is unknown');
  await assert.rejects(repoChecker({ appApi, appSlug: async () => 'woodshed-acme' })('acme/no'),
    (err) => err.shown && /App is not installed on acme\/no/.test(err.message)
      && err.link.href === 'https://github.com/apps/woodshed-acme/installations/new' && err.link.text === 'Install woodshed-acme on GitHub');
  await assert.rejects(repoChecker({ appApi, appSlug: async () => { throw new Error('down'); } })('acme/no'), (err) => err.shown && !err.link);
  const down = { installationOf: async () => { throw new Error('HTTP 502'); } };
  await assert.rejects(repoChecker({ appApi: down })('acme/x'), (err) => err.shown && /did not answer/.test(err.message));
  assert.deepEqual(await repoChecker({ appApi: null, read: async () => 'main' })('acme/x'), { installationId: null });
  await assert.rejects(repoChecker({ appApi: null, read: async () => { throw new Error('404'); } })('acme/x'), (err) => err.shown && /cannot read acme\/x/.test(err.message));
});

test('a stopped My Woodshed session still on its owner\'s list holds its repo, since Resume would fall back to the default', async () => {
  const { added, store } = setup({ sessions: [{ id: 'aaaaaaaa', project: 'api', repo: 'acme/api', status: 'stopped', owner: 'bob' }] });
  await added.add({ repo: 'acme/api', by: 'a' });
  assert.throws(() => added.remove({ name: 'api', by: 'a' }), /still running, or listed to resume/);
  store.state.sessions = [];
  added.remove({ name: 'api', by: 'a' });
});

test('two adds of one repo at once keep one, and a link with a trailing slash or .git is read', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { added, config } = setup({ check: async () => { await gate; return { installationId: '100' }; } });
  const first = added.add({ repo: 'https://github.com/acme/api.git/', by: 'a' });
  const second = added.add({ repo: 'acme/api', by: 'b' });
  release();
  const results = await Promise.allSettled([first, second]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.deepEqual(config.projects.map((p) => p.repo), ['acme/app', 'acme/api']);
});

test('a dot-only part is not a repo', async () => {
  const { added } = setup();
  for (const repo of ['x/..', '../..', './x']) await assert.rejects(added.add({ repo, by: 'a' }), /owner\/name/);
});

test('an added repo the installation names later is left out of the live list, and a hand-made config keeps its default', () => {
  const store = { state: { addedProjects: [{ name: 'api', repo: 'acme/api', default: false }, { name: 'web', repo: 'acme/web', default: false }] } };
  const later = liveConfig({ ...base, projects: [...base.projects, { name: 'other', repo: 'ACME/api', default: false }] }, store);
  assert.deepEqual(later.projects.map((p) => p.name), ['app', 'other', 'web']);
  assert.equal(later.projects, later.projects, 'the same list until the added ones change');
  const byHand = liveConfig({ repo: 'acme/app', limits: base.limits }, store);
  assert.deepEqual(byHand.projects.map((p) => [p.name, p.default]), [['app', true], ['api', false], ['web', false]]);
});
