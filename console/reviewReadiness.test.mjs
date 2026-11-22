import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createCliSignIn } from './cliSignIn.mjs';
import { createProjectAccess } from './projectAccess.mjs';
import { createReviewReadiness } from './reviewReadiness.mjs';
import { createHandler } from './server.mjs';

// A reviewer App in the state `which` names: none made, made, or made and installed on acme/game.
function reviewerIn(which, calls = []) {
  const made = which !== 'none';
  if (which === 'unknown') return { ...reviewerIn('made', calls), installedOn: async () => null };
  return {
    login: () => (made ? 'acme-reviewer[bot]' : null),
    configured: () => made,
    installedOn: async (repo) => { calls.push(repo); return which === 'installed' && repo === 'acme/game'; },
    view: async () => ({ installUrl: made ? 'https://github.com/apps/acme-reviewer/installations/new' : null }),
    submitReview: async () => null,
  };
}

const PROJECTS = [{ name: 'game', repo: 'acme/game' }];

function readinessFor(which, { gates = null, own = true, calls = [], canWrite = null, runsOnName = null } = {}) {
  return createReviewReadiness({
    canWrite, runsOnName,
    publicUrl: 'https://console.example', reviewer: which === null ? null : reviewerIn(which, calls), ownReviewer: own,
    appLogin: async () => 'acme-woodshed[bot]',
    pullRequestsOf: async (name) => { if (gates instanceof Error) throw gates; assert.equal(name, 'game'); return gates; },
  });
}

test('ready: a project of the asker\'s, the reviewer App made and installed, the default branch\'s file with it', async () => {
  const gates = { review: { runner: 'woodshed', heading: '## R', rerun: '[woodshed-review]', author: 'acme-reviewer[bot]', commentAuthor: 'acme-woodshed[bot]' }, qa: null, runsOn: null };
  const answer = await readinessFor('installed', { gates }).check('Acme/Game', { projects: PROJECTS });
  assert.deepEqual(answer, {
    repo: 'acme/game', project: 'game', consoleApp: { login: 'acme-woodshed[bot]', name: null },
    reviewerApp: { made: true, login: 'acme-reviewer[bot]', installed: true, installUrl: 'https://github.com/apps/acme-reviewer/installations/new' },
    defaultBranch: { review: { runner: 'woodshed', rerun: '[woodshed-review]', heading: '## R', author: 'acme-reviewer[bot]', commentAuthor: 'acme-woodshed[bot]' }, qa: null, runsOn: null, runsHere: true, error: null },
    review: { runner: 'woodshed', rerun: '[woodshed-review]', from: 'project file' },
    missing: [],
  });
});

test('each missing step names who takes it and how', async () => {
  const none = await readinessFor('none').check('acme/game', { projects: PROJECTS });
  assert.deepEqual(none.missing.map((m) => [m.key, m.by]), [['reviewer-app', 'admin']]);
  assert.match(none.missing[0].step, /https:\/\/console\.example\/setup\/github, Create the reviewer App on GitHub/);
  const hosted = await readinessFor('none', { own: false }).check('acme/game', { projects: PROJECTS });
  assert.match(hosted.missing[0].step, /host has not made its reviewer App/);
  const noReviewer = await readinessFor(null).check('acme/game', { projects: PROJECTS });
  assert.match(noReviewer.missing[0].step, /no reviewer App, and cannot make one/);
  const made = await readinessFor('made').check('acme/game', { projects: PROJECTS });
  assert.deepEqual(made.missing.map((m) => m.key), ['reviewer-installed']);
  assert.match(made.missing[0].step, /installs the reviewer App \(acme-reviewer\[bot\]\) on acme\/game: https:\/\/github\.com\/apps\/acme-reviewer\/installations\/new/);
  const unread = await readinessFor('made', { gates: new Error('the project file could not be read: HTTP 502') }).check('acme/game', { projects: PROJECTS });
  assert.equal(unread.defaultBranch.error, 'the project file could not be read: HTTP 502');
  assert.equal(unread.review, null, 'unknown while the file is not read');
  const byDefault = await readinessFor('installed').check('acme/game', { projects: PROJECTS });
  assert.deepEqual([byDefault.defaultBranch.review, byDefault.review], [null, { runner: 'woodshed', rerun: '[woodshed-review]', from: 'default' }], 'a file that names no review, or none: every repo\'s default');
});

test('a repo the asker may not start on is told nothing of, and GitHub is not asked', async () => {
  const calls = [];
  const canWrite = async () => assert.fail('an unconnected repo needs no GitHub permission check');
  const answer = await readinessFor('installed', { calls, canWrite }).check('acme/secret', { projects: PROJECTS });
  assert.deepEqual([answer.project, answer.reviewerApp, answer.defaultBranch, answer.missing.map((m) => m.key)], [null, null, null, ['repo']]);
  assert.deepEqual(calls, []);
});

// The route, by cookie and by the command line's token.
async function serve(t, { readiness, projects, githubFor = () => null }) {
  const store = { state: {}, save() {} };
  const cli = createCliSignIn({ store });
  let handle = null;
  const server = http.createServer((req, res) => { handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const origin = `http://localhost:${server.address().port}`;
  const config = { host: '127.0.0.1', publicUrl: origin, extraHosts: [], repo: 'acme/game', projects, label: 'woodshed', consoleName: 'Acme', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => (cookie ? { login: /woodshed_session=([\w-]+)/.exec(cookie)[1] } : null) };
  const projectAccess = createProjectAccess({ config, githubFor });
  handle = createHandler({
    config, fleet: { sessions: () => [], find: () => null }, auth, cli, reviewReadiness: readiness, projectAccess,
  });
  const tokenFor = (login) => {
    const { deviceCode, userCode } = cli.start({ name: 'laptop' });
    cli.decide({ code: userCode, login, approve: true });
    return cli.poll(deviceCode);
  };
  const get = (p, headers = {}) => fetch(`${origin}${p}`, { headers, redirect: 'manual' });
  return { origin, get, tokenFor, projectAccess, cli };
}

test('GET /api/review-readiness answers a cookie or the command line\'s token, as that person, and nothing else', async (t) => {
  const asked = [];
  const canWrite = async (login) => { asked.push(login); return login === 'bob'; };
  const s = await serve(t, { readiness: readinessFor('made', { canWrite }) });
  const { token, id } = s.tokenFor('bob');
  const byToken = await s.get('/api/review-readiness?repo=acme/game', { authorization: `Bearer ${token}` });
  assert.equal(byToken.status, 200);
  assert.deepEqual((await byToken.json()).missing.map((m) => m.key), ['reviewer-installed']);
  assert.deepEqual(asked, ['bob'], 'access is checked for the token\'s person');
  const eve = s.tokenFor('eve').token;
  assert.equal((await (await s.get('/api/review-readiness?repo=acme/game', { authorization: `Bearer ${eve}` })).json()).project, null, 'not a repo eve may start on');

  const byCookie = await s.get('/api/review-readiness?repo=acme/game', { cookie: 'woodshed_session=bob' });
  assert.equal((await byCookie.json()).project, 'game');

  assert.equal((await s.get('/api/review-readiness?repo=acme/game', { authorization: `Bearer ${token}`, origin: s.origin })).status, 403, 'a page\'s call with the token');
  assert.equal((await s.get('/api/review-readiness?repo=not-a-repo', { authorization: `Bearer ${token}` })).status, 400);
  assert.equal((await s.get('/api/review-readiness?repo=acme/game', { authorization: `Bearer wsc_${'0'.repeat(64)}` })).status, 401);
  s.cli.revoke('bob', id);
  assert.equal((await s.get('/api/review-readiness?repo=acme/game', { authorization: `Bearer ${token}` })).status, 401);
  const post = await fetch(`${s.origin}/api/review-readiness?repo=acme/game`, { method: 'POST', headers: { authorization: `Bearer ${eve}` } });
  assert.equal(post.status, 403, 'read-only: the command line\'s gate takes a GET alone');
  for (const p of ['/api/my', '/api/people', '/api/setup/github/reviewer']) assert.notEqual((await s.get(p, { authorization: `Bearer ${eve}` })).status, 200, `${p} is not reached by a token`);
});

test('a console with no GitHub App answers 404', async (t) => {
  const s = await serve(t, { readiness: null });
  const answer = await s.get('/api/review-readiness?repo=acme/game', { cookie: 'woodshed_session=bob' });
  assert.equal(answer.status, 404);
  assert.match((await answer.json()).error, /no GitHub App/);
});

test('installation not known, and a runsOn naming another console, are each a missing step', async () => {
  const unknown = await readinessFor('unknown').check('acme/game', { projects: PROJECTS });
  assert.equal(unknown.reviewerApp.installed, null);
  assert.deepEqual(unknown.missing.map((m) => m.key), ['reviewer-installed-unknown']);
  const gates = (runsOn) => ({ review: { runner: 'woodshed', heading: '## R' }, qa: null, runsOn });
  const named = (runsOn, runsOnName = null) => readinessFor('installed', { gates: gates(runsOn), runsOnName }).check('acme/game', { projects: PROJECTS });
  assert.deepEqual((await named('acme-woodshed[bot]')).missing, []);
  assert.deepEqual((await named('acme-woodshed[bot]/prod', 'prod')).missing, []);
  assert.deepEqual((await named('acme-woodshed[bot]/prod')).missing.map((m) => [m.key, m.by]), [['runs-on', 'repo']], 'another console of the same App');
  assert.equal((await named('other[bot]')).defaultBranch.runsHere, false);
});

test('a token\'s person who lost write access to the repo reads nothing more of it, though still on People', async (t) => {
  let writes = true;
  const asked = [];
  const canWrite = async (login, project) => { asked.push([login, project.repo]); return writes; };
  const s = await serve(t, { readiness: readinessFor('installed', { canWrite }) });
  const { token } = s.tokenFor('bob');
  const read = async (headers) => (await s.get('/api/review-readiness?repo=acme/game', headers)).json();
  assert.equal((await read({ authorization: `Bearer ${token}` })).project, 'game');
  assert.deepEqual(asked, [['bob', 'acme/game']]);
  writes = false;
  const gone = await read({ authorization: `Bearer ${token}` });
  assert.deepEqual([gone.project, gone.reviewerApp, gone.defaultBranch], [null, null, null], 'the very next call, no earlier answer kept');
  assert.equal(asked.length, 2);
  const byCookie = await read({ cookie: 'woodshed_session=bob' });
  assert.deepEqual([byCookie.project, byCookie.reviewerApp, byCookie.defaultBranch], [null, null, null], 'a cookie auth.mjs has not rechecked yet gets nothing either');
  assert.equal(asked.length, 3);
  writes = true;
  assert.equal((await read({ cookie: 'woodshed_session=bob' })).project, 'game');
});

test('readiness recognizes a new write grant while the session picker still has a cached denial', async (t) => {
  const projects = [{ name: 'main', repo: 'acme/main', default: true }, ...PROJECTS];
  let writes = false;
  const asked = [];
  const canWrite = async (login, project) => { asked.push([login, project.repo]); return writes; };
  const s = await serve(t, {
    projects, readiness: readinessFor('installed', { canWrite }),
    githubFor: (project) => ({ canWrite: (login) => canWrite(login, project) }),
  });
  const { token } = s.tokenFor('bob');
  const headers = { authorization: `Bearer ${token}` };
  assert.deepEqual(await s.projectAccess.startable('bob'), [projects[0]]);
  assert.equal((await (await s.get('/api/review-readiness?repo=acme/game', headers)).json()).project, null);
  writes = true;
  assert.deepEqual(await s.projectAccess.startable('bob'), [projects[0]]);
  const answer = await s.get('/api/review-readiness?repo=Acme/Game', headers);
  assert.equal(answer.status, 200);
  assert.deepEqual((await answer.json()).missing, []);
  assert.deepEqual(asked, Array.from({ length: 3 }, () => ['bob', 'acme/game']));
});
