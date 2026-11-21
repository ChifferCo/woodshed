import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createAddedProjects, createHostProjects, repoChecker, repoLister } from './addedProjects.mjs';
import { createCliSignIn } from './cliSignIn.mjs';
import { liveConfig } from './consoleSettings.mjs';
import { createHostedMembers } from './hostedMembers.mjs';
import { createHandler } from './server.mjs';

const REPOS = '/api/cli/repos';
const GRANT = 'https://github.com/organizations/acme/settings/installations/1';
const INSTALL = 'https://github.com/apps/woodshed-example/installations/new';

async function consoleFor(t, { hosted = false, roster = true } = {}) {
  const app = {
    repos: new Set(['acme/app', 'acme/web', 'acme/private']),
    installations: async () => [{ id: '1', account: 'acme', settingsUrl: GRANT }],
    async installationRepos() { return [...this.repos].map((repo) => ({ repo, private: repo === 'acme/private' })); },
    async installationOf(repo) { return this.repos.has(repo.toLowerCase()) ? '1' : null; },
  };
  const base = {
    host: '127.0.0.1', publicUrl: 'http://localhost', extraHosts: [], repo: 'acme/app', limits: { idleMs: 1, lifetimeMs: 1 },
    projects: [{ name: 'app', repo: 'acme/app', default: true }, { name: 'old', repo: 'acme/old' }],
  };
  const calls = [];
  const store = { state: { sessions: [] }, save() {} };
  const hostProjects = hosted ? createHostProjects() : null;
  const config = liveConfig(base, store, { hostProjects });
  const host = hosted ? {
    names: false,
    async list() { return { repos: [...app.repos], grant: [{ account: 'acme', href: GRANT }], install: null }; },
    async add(args) {
      calls.push(['add', args]);
      if (!app.repos.has(args.repo)) throw Object.assign(new Error('Give the App access and try again.'), { shown: true, link: { href: GRANT } });
      return { name: 'website', repo: args.repo };
    },
    async remove(args) { calls.push(['remove', args]); },
  } : null;
  const appSlug = async () => 'woodshed-example';
  const addedProjects = createAddedProjects({ store, config, hostProjects, host,
    check: repoChecker({ appApi: app, appSlug }), list: repoLister({ appApi: app, appSlug }),
  });
  let now = 0;
  const people = [{ login: 'octocat', role: 'owner' }, { login: 'mia-dev', role: 'member' }];
  const members = hosted ? roster ? createHostedMembers({ hook: { list: async () => people }, store, now: () => now }) : null : {
    hasAdmin: () => true, isAdmin: (login) => login === 'octocat',
  };
  await members?.load?.();
  const cli = createCliSignIn({ store, canWrite: async (login) => login !== 'former-writer' });
  const tokens = Object.fromEntries(['octocat', 'mia-dev', 'former-writer'].map((login) => {
    const { deviceCode, userCode } = cli.start({ name: `${login}-laptop` });
    cli.decide({ code: userCode, login, approve: true });
    return [login, cli.poll(deviceCode).token];
  }));
  const handle = createHandler({
    config, cli, members, addedProjects, fleet: { sessions: () => [] },
    auth: hosted ? null : { enabled: () => true, sessionFor: async () => null },
    trusted: hosted ? { userFor: () => ({ login: 'octocat', role: 'owner' }) } : null,
    repoSettings: { async forget(name) { calls.push(['forget', name]); } },
    projectAccess: { view: async () => ({ projects: [{ name: 'app', repo: 'acme/app' }] }) },
  });
  const server = http.createServer((req, res) => { handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  async function request(path = REPOS, { login = 'octocat', method = 'GET', body, headers } = {}) {
    const reply = await fetch(`http://localhost:${server.address().port}${path}`, {
      method, headers: { ...(login && { authorization: `Bearer ${tokens[login]}` }), ...headers },
      body: body && JSON.stringify(body),
    });
    return { code: reply.status, body: await reply.json() };
  }
  const change = (repo, { remove, body, ...options } = {}) => request(remove ? `${REPOS}/remove` : REPOS, {
    method: 'POST', body: { repo, ...body }, ...options,
  });
  return { request, change, app, calls, people, store, tick: (ms) => { now += ms; } };
}

test('admins see both connected and addable repos and their GitHub App access', async (t) => {
  const c = await consoleFor(t);
  const { code, body } = await c.request();
  assert.equal(code, 200);
  assert.deepEqual(body, {
    canChange: true,
    projects: [
      { repo: 'acme/app', name: 'app', removable: false, githubAppAccess: true },
      { repo: 'acme/old', name: 'old', removable: false, githubAppAccess: false },
    ],
    available: [{ repo: 'acme/private', githubAppAccess: true }, { repo: 'acme/web', githubAppAccess: true }],
  });
});

test('the authenticated routes reject browser calls, other methods, lost write access, and member writes', async (t) => {
  const c = await consoleFor(t);
  assert.deepEqual((await c.request(REPOS, { login: 'mia-dev' })).body, {
    canChange: false, available: null, projects: [{ name: 'app', repo: 'acme/app', removable: false, githubAppAccess: null }],
  });
  assert.equal((await c.change('acme/web', { login: 'mia-dev' })).code, 403);
  assert.equal((await c.change('acme/old', { login: 'mia-dev', remove: true })).code, 403);
  assert.equal((await c.request(REPOS, { login: 'former-writer' })).code, 401);
  assert.equal((await c.request(REPOS, { login: null })).code, 401);
  assert.equal((await c.request(REPOS, { headers: { origin: '' } })).code, 403);
  assert.equal((await c.change('acme/web', { headers: { origin: 'https://example.test' } })).code, 403);
  assert.equal((await c.request(REPOS, { method: 'DELETE' })).code, 405);
  assert.equal((await c.request(`${REPOS}/remove`)).code, 405);
  assert.equal((await c.request(`${REPOS}/other`)).code, 404);
  assert.equal((await c.request('/api/console-settings/projects/repos')).code, 403);
  assert.equal((await c.change('https://github.com/acme/web')).code, 400);
  assert.equal(c.store.state.addedProjects, undefined);
});

test('repo add returns the install or access URL and succeeds when GitHub grants the repo', async (t) => {
  const c = await consoleFor(t);
  for (const [repo, url] of [['elsewhere/new', INSTALL], ['acme/new', GRANT]]) {
    const refused = await c.change(repo);
    assert.equal(refused.code, 409);
    assert.equal(refused.body.status, 'needs-github-app');
    assert.equal(refused.body.url, url);
  }
  c.app.repos.add('acme/new');
  const added = await c.change('acme/new', { body: { name: 'website', by: 'mia-dev' } });
  assert.deepEqual(added, { code: 200, body: { repo: 'acme/new', name: 'website' } });
  assert.equal(c.store.state.addedProjects[0].addedBy, 'octocat');
  c.store.state.sessions.push({ project: 'website', status: 'running' });
  assert.equal((await c.change('ACME/NEW', { remove: true })).code, 409);
  assert.deepEqual(c.calls, []);
  c.store.state.sessions.pop();
  assert.deepEqual(await c.change('ACME/NEW', { remove: true }), added);
  assert.deepEqual(c.calls, [['forget', 'website']]);
});

test('hosted changes go through the repos hook and require the token holder to still be an owner', async (t) => {
  const c = await consoleFor(t, { hosted: true });
  const waiting = await c.change('acme/missing');
  assert.equal(waiting.body.status, 'needs-github-app');
  assert.equal(waiting.body.url, GRANT);
  const added = await c.change('acme/web');
  assert.deepEqual(added, { code: 200, body: { repo: 'acme/web', name: 'website' } });
  assert.equal((await c.request()).body.projects.at(-1).githubAppAccess, true);
  assert.equal((await c.change('acme/app', { remove: true })).code, 409, 'default project stays');
  assert.deepEqual(await c.change('acme/web', { remove: true }), added);
  c.people[0].role = 'member';
  c.tick(6_000);
  assert.equal((await c.change('acme/web')).code, 403);
  assert.equal(c.store.state.addedProjects, undefined);
  assert.deepEqual(c.calls, [
    ['add', { repo: 'acme/missing', by: 'octocat' }], ['add', { repo: 'acme/web', by: 'octocat' }],
    ['forget', 'website'], ['remove', { name: 'website', repo: 'acme/web', by: 'octocat' }],
  ]);
});

test('a hosted console without an admin roster refuses CLI changes even with browser identity headers', async (t) => {
  const c = await consoleFor(t, { hosted: true, roster: false });
  assert.equal((await c.change('acme/web')).code, 403);
  assert.deepEqual(c.calls, []);
});
