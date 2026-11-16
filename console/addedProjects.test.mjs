import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAddedProjects, createHostProjects, ghRepoLister, repoChecker, repoLister } from './addedProjects.mjs';
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
  await assert.rejects(added.remove({ name: 'api', by: 'a' }), (err) => err.shown && /1 session is still running, or listed to resume/.test(err.message));
  await assert.rejects(added.remove({ name: 'app', by: 'a' }), /set in the installation's configuration/);
  await assert.rejects(added.remove({ name: 'nope', by: 'a' }), /no project called nope/);
  store.state.sessions = [{ id: 'aaaaaaaa', project: 'api', repo: 'acme/api', status: 'stopped', kept: false }];
  await added.remove({ name: 'api', by: 'a' });
  assert.deepEqual(config.projects.map((p) => p.name), ['app']);
  store.state.sessions = [{ id: 'bbbbbbbb', project: 'app', repo: 'acme/app', status: 'stopped', kept: true }];
  assert.equal(added.view()[0].sessions, 1, 'a kept shared session counts too');
});

test('the view says which repos can be removed', async () => {
  const { added } = setup();
  await added.add({ repo: 'acme/api', by: 'octocat' });
  assert.deepEqual(added.view().map((p) => [p.name, p.default, p.removable, p.addedBy, p.source]), [['app', true, false, null, 'installation'], ['api', false, true, 'octocat', 'added']]);
});

test('with the App, the repo must have it installed; without, gh must read the repo', async () => {
  const appApi = { installationOf: async (repo) => (repo === 'acme/yes' ? '300' : null) };
  assert.deepEqual(await repoChecker({ appApi })('acme/yes'), { installationId: '300' });
  await assert.rejects(repoChecker({ appApi })('acme/no'), (err) => err.shown && /App is not installed on acme\/no/.test(err.message));
  await assert.rejects(repoChecker({ appApi })('acme/no'), (err) => !err.link, 'no link while the App\'s slug is unknown');
  await assert.rejects(repoChecker({ appApi, appSlug: async () => 'woodshed-acme' })('acme/no'),
    (err) => err.shown && /App is not installed on acme, or acme\/no does not exist/.test(err.message)
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
  await assert.rejects(added.remove({ name: 'api', by: 'a' }), /still running, or listed to resume/);
  store.state.sessions = [];
  await added.remove({ name: 'api', by: 'a' });
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

test('on a console that started with no repo, the first one added is the default, and the next one after it', async () => {
  const empty = { githubApp: { installationId: '100' }, projects: [], limits: { idleMs: 1, lifetimeMs: 1 } };
  const store = { state: { sessions: [] }, save() {} };
  const config = liveConfig(empty, store);
  const added = createAddedProjects({ store, config, now: () => 0, check: async () => ({ installationId: '100' }) });
  assert.deepEqual(config.projects, [], 'nothing until an admin adds one');
  await added.add({ repo: 'acme/api', by: 'octocat' });
  await added.add({ repo: 'acme/web', by: 'octocat' });
  assert.deepEqual(config.projects.map((p) => [p.name, p.default]), [['api', true], ['web', false]]);
  assert.deepEqual(config.projects.map((p) => p.clonedAtStart ?? false), [true, false], 'no image holds the added default\'s checkout: its sessions clone it');
  assert.equal(store.state.addedProjects[0].default, false, 'the default is the live list\'s, not saved: a removal hands it on');
  assert.equal(store.state.addedProjects[0].clonedAtStart, undefined, 'nor is that');
  assert.deepEqual(added.view().map((p) => [p.name, p.default, p.removable]), [['api', true, true], ['web', false, true]], 'an added default can be removed like any added repo');
  await added.remove({ name: 'api', by: 'octocat' });
  assert.deepEqual(config.projects.map((p) => [p.name, p.default]), [['web', true]]);
  assert.deepEqual(liveConfig(empty, store).projects.map((p) => [p.name, p.default, p.clonedAtStart]), [['web', true, true]], 'a restart reads it back the same');
  const named = liveConfig({ ...empty, projects: [{ name: 'app', repo: 'acme/app', default: true }] }, store);
  assert.deepEqual(named.projects.map((p) => [p.name, p.default, p.clonedAtStart]), [['app', true, undefined], ['web', false, undefined]], 'the environment\'s default is the image\'s');
});

test('a repo on an account the App is on, but not given, links to that installation\'s settings, not the install page', async () => {
  const appApi = {
    installationOf: async () => null,
    installations: async () => [{ id: '7', account: 'Akurilin', settingsUrl: 'https://github.com/settings/installations/7' }],
  };
  await assert.rejects(repoChecker({ appApi, appSlug: async () => 'woodshed-ak' })('akurilin/social'),
    (err) => err.shown && /woodshed-ak is installed on Akurilin, but may not reach akurilin\/social/.test(err.message)
      && err.link.href === 'https://github.com/settings/installations/7' && err.link.text === 'Give woodshed-ak access to akurilin/social on GitHub');
  await assert.rejects(repoChecker({ appApi, appSlug: async () => 'woodshed-ak' })('other/x'),
    (err) => err.link.href === 'https://github.com/apps/woodshed-ak/installations/new', 'another account still gets the install page');
  const blind = { ...appApi, installations: async () => { throw new Error('HTTP 500'); } };
  await assert.rejects(repoChecker({ appApi: blind, appSlug: async () => 'w' })('akurilin/social'),
    (err) => err.link.href === 'https://github.com/apps/w/installations/new', 'with no installations read, the install page');
});

test('the repo list is every installation\'s repos, sorted, with where to give the App more; projects already added are left out', async () => {
  const appApi = {
    installations: async () => [
      { id: '1', account: 'acme', settingsUrl: 'https://github.com/organizations/acme/settings/installations/1' },
      { id: '2', account: 'bo', settingsUrl: 'https://github.com/settings/installations/2' },
    ],
    installationRepos: async (id) => (id === '1'
      ? [{ repo: 'acme/web', private: true }, { repo: 'acme/app', private: true }]
      : [{ repo: 'bo/Blog', private: false }]),
  };
  const list = repoLister({ appApi, appSlug: async () => 'w' });
  const store = { state: { sessions: [] }, save() {} };
  const added = createAddedProjects({ store, config: liveConfig(base, store), check: async () => ({ installationId: '1' }), list });
  assert.deepEqual(await added.choices(), {
    repos: [{ repo: 'acme/web', private: true }, { repo: 'bo/Blog', private: false }],
    grant: [{ account: 'acme', href: 'https://github.com/organizations/acme/settings/installations/1' }, { account: 'bo', href: 'https://github.com/settings/installations/2' }],
    install: 'https://github.com/apps/w/installations/new',
    via: 'app',
  }, 'acme/app is the default project already');
  assert.equal(await createAddedProjects({ store, config: liveConfig(base, store), check: async () => ({}) }).choices(), null, 'no App, no list');
  const half = repoLister({ appApi: { ...appApi, installationRepos: async (id) => { if (id === '2') throw new Error('HTTP 403'); return appApi.installationRepos(id); } } });
  assert.deepEqual((await half()).repos.map((r) => r.repo), ['acme/app', 'acme/web'], 'one refused installation leaves out its repos alone');
  const down = repoLister({ appApi: { ...appApi, installationRepos: async () => { throw new Error('HTTP 502'); } } });
  await assert.rejects(down(), (err) => err.shown && /did not list the App's repos/.test(err.message));
});

test('with no App, the list is every repo the console\'s gh login can push to, sorted, with nothing to grant', async () => {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return { stdout: 'bo/Blog\tfalse\nacme/web\ttrue\nacme/app\ttrue\nnot a repo\tfalse\n' };
  };
  const store = { state: { sessions: [] }, save() {} };
  const added = createAddedProjects({ store, config: liveConfig(base, store), check: async () => ({ installationId: null }), list: ghRepoLister({ run }) });
  assert.deepEqual(await added.choices(), {
    repos: [{ repo: 'acme/web', private: true }, { repo: 'bo/Blog', private: false }],
    grant: [], install: null, via: 'gh',
  }, 'acme/app is the default project already, and a line that is no repo is dropped');
  assert.equal(calls[0][0], 'gh');
  assert.ok(calls[0].includes('--paginate'), 'every page of the login\'s repos');
  assert.match(calls[0].join(' '), /select\(\.permissions\.push\)/, 'only the repos it can push to');
  const down = ghRepoLister({ run: async () => { throw new Error('HTTP 401'); } });
  await assert.rejects(down(), (err) => err.shown && /gh did not list your repos/.test(err.message));
});

// An embedding program that keeps the repo list itself (installation.mjs, `repos`): it lists, adds and removes, and the
// installation's projects are its list.
function hosted({ sessions = [], projects = [{ name: 'app', repo: 'acme/app', default: true }, { name: 'web', repo: 'acme/web', default: false }], host = {} } = {}) {
  const store = { state: { sessions }, saves: 0, save() { this.saves += 1; } };
  const hostProjects = createHostProjects();
  const config = liveConfig({ ...base, projects }, store, { hostProjects });
  const calls = [];
  const repos = {
    names: false,
    async list() {
      calls.push(['list']);
      return {
        repos: ['acme/app', 'acme/web', 'acme/api', 'not a repo', { repo: 'acme/lib', private: true }],
        grant: [{ account: 'acme', href: 'https://github.com/organizations/acme/settings/installations/1' }, { account: 'evil', href: 'javascript:alert(1)' }],
        install: 'http://insecure.example/install',
      };
    },
    async add(args) {
      calls.push(['add', args]);
      if (args.repo === 'acme/secret') {
        throw Object.assign(new Error('The App may not reach acme/secret.'), { shown: true, link: { href: 'https://github.com/organizations/acme/settings/installations/1', text: 'Give it access on GitHub' } });
      }
      return { name: `${args.repo.split('/')[1].toLowerCase()}-2`, repo: args.repo.toLowerCase() };
    },
    async remove(args) { calls.push(['remove', args]); },
    ...host,
  };
  const added = createAddedProjects({
    store, config, now: () => 0, host: repos, hostProjects,
    check: async () => { throw new Error('the host checks, not the console'); },
    list: async () => { throw new Error('the host lists, not the console'); },
  });
  return { store, config, added, calls };
}

test('with an embedder\'s repos hook, Add a repo offers its list, less the projects, with only its https links', async () => {
  const { added } = hosted();
  assert.deepEqual(await added.choices(), {
    repos: [{ repo: 'acme/api', private: false }, { repo: 'acme/lib', private: true }],
    grant: [{ account: 'acme', href: 'https://github.com/organizations/acme/settings/installations/1' }],
    install: null,
    via: 'host',
  });
  assert.equal(added.names, false, 'the page asks for no name where the embedder names each repo');
  const down = hosted({ host: { list: async () => { throw new Error('HTTP 502'); } } }).added;
  await assert.rejects(down.choices(), (err) => err.shown && /could not be listed\. Type the repo instead/.test(err.message));
  const none = hosted({ host: { list: undefined } }).added;
  assert.equal(await none.choices(), null, 'an embedder with no list: owner/name typed in');
});

test('with the hook, an add goes to the embedder, applies at once, and writes nothing to the console\'s own state', async () => {
  const { added, config, store, calls } = hosted();
  const project = await added.add({ repo: 'https://github.com/acme/API.git', by: 'octocat' });
  assert.deepEqual(project, { name: 'api-2', repo: 'acme/api', default: false }, 'the embedder\'s name and spelling');
  assert.deepEqual(calls.filter((c) => c[0] === 'add'), [['add', { repo: 'acme/API', by: 'octocat' }]]);
  assert.deepEqual(config.projects.map((p) => p.name), ['app', 'web', 'api-2'], 'the live list has it, with no restart');
  assert.equal(store.saves, 0);
  assert.equal(store.state.addedProjects, undefined);
  assert.deepEqual(added.view().map((p) => [p.name, p.source, p.removable]), [['app', 'host', false], ['web', 'host', true], ['api-2', 'host', true]],
    'every project is the embedder\'s, and all but the default can be removed here');
});

test('with the hook, a repo it cannot reach is refused with its link, and a name or a repo already there before it is asked', async () => {
  const { added, calls, config } = hosted();
  await assert.rejects(added.add({ repo: 'acme/secret', by: 'a' }), (err) => err.shown && err.link?.text === 'Give it access on GitHub');
  await assert.rejects(added.add({ repo: 'ACME/web', by: 'a' }), /already a project, named web/);
  await assert.rejects(added.add({ repo: 'acme/x', name: 'x', by: 'a' }), /names each repo after itself: leave the name empty/);
  await assert.rejects(added.add({ repo: 'acme', by: 'a' }), /owner\/name/);
  assert.deepEqual(calls.filter((c) => c[0] === 'add').map((c) => c[1].repo), ['acme/secret']);
  assert.deepEqual(config.projects.map((p) => p.name), ['app', 'web']);
  const named = hosted({ host: { names: true, add: async (args) => ({ name: args.name, repo: args.repo }) } }).added;
  assert.equal((await named.add({ repo: 'acme/x', name: 'tools', by: 'a' })).name, 'tools', 'an embedder that takes names gets the one typed');
});

test('with the hook, Remove takes any but the default off through it, never with sessions on it, and an added one is the console\'s', async () => {
  const { added, config, calls, store } = hosted({ sessions: [{ id: 'aaaaaaaa', project: 'web', repo: 'acme/web', status: 'running' }] });
  await assert.rejects(added.remove({ name: 'app', by: 'a' }), /acme\/app is the default project: it stays/);
  await assert.rejects(added.remove({ name: 'web', by: 'a' }), /1 session is still running/);
  await assert.rejects(added.remove({ name: 'nope', by: 'a' }), /no project called nope/);
  assert.equal(calls.filter((c) => c[0] === 'remove').length, 0, 'the embedder is not asked to remove what the console refuses');
  store.state.sessions = [];
  await added.remove({ name: 'web', by: 'octocat' });
  assert.deepEqual(calls.filter((c) => c[0] === 'remove'), [['remove', { name: 'web', repo: 'acme/web', by: 'octocat' }]]);
  assert.deepEqual(config.projects.map((p) => p.name), ['app']);
  await added.add({ repo: 'acme/web', by: 'a' });
  assert.deepEqual(config.projects.map((p) => p.name), ['app', 'web-2'], 'added back, under the name the embedder gave');

  // One added on this page before the embedder kept the list stays this page's to remove.
  store.state.addedProjects = [{ name: 'old', repo: 'acme/old', default: false, addedBy: 'bo' }];
  assert.equal(added.view().find((p) => p.name === 'old').source, 'added');
  await added.remove({ name: 'old', by: 'a' });
  assert.deepEqual(store.state.addedProjects, []);
  assert.equal(calls.filter((c) => c[0] === 'remove').length, 1);
});

test('an embedder that refuses a removal leaves the list as it was', async () => {
  const { added, config } = hosted({ host: { remove: async () => { throw Object.assign(new Error('Not now.'), { shown: true }); } } });
  await assert.rejects(added.remove({ name: 'web', by: 'a' }), /Not now/);
  assert.deepEqual(config.projects.map((p) => p.name), ['app', 'web']);
});
