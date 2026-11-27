import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isolatedEnv } from '../test/isolatedEnv.mjs';
import { appStartedIn, brokenFileRefusal, marksReady, refusal, unreadRefusal } from './readyGate.mjs';
import { fixtureApp, fixtureCheckout, fixtureProject, fixtureProjectFiles } from '../shared/projectFixture.mjs';

// A repo's app as its project file would give it. The repo Woodshed is in checks its own (.woodshed/test/).
const app = fixtureApp({
  paths: ['web/'],
  logs: { api: '~/.cache/app-servers/{{CHECKOUT}}/api.log', web: '~/.cache/app-servers/{{CHECKOUT}}/web.log' },
  howToProve: 'Run `make serve` and check the page.',
});

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const APP = ['web/models/branches.ts', 'web/tests/x.spec.ts'];

test('opening a pull request for review, or marking one ready, is what it looks at; a draft is not', () => {
  assert.equal(marksReady(bash('gh pr create --title "fix(web): x" --body-file b.md')), true);
  assert.equal(marksReady(bash('git push -u origin HEAD && gh pr create -t x -F b.md')), true);
  assert.equal(marksReady(bash('gh pr ready 26686')), true);
  assert.equal(marksReady(bash('gh pr create --draft --title x')), false);
  assert.equal(marksReady(bash('gh pr create -d -t x')), false);
  assert.equal(marksReady(bash('gh pr ready 26686 --undo')), false);
  assert.equal(marksReady(bash('gh pr view 26686 --json body')), false);
  assert.equal(marksReady({ tool_name: 'mcp__github__create_pull_request', tool_input: { draft: true } }), false);
  assert.equal(marksReady({ tool_name: 'mcp__github__create_pull_request', tool_input: {} }), true);
  assert.equal(marksReady({ tool_name: 'mcp__github__update_pull_request', tool_input: { draft: false } }), true);
  assert.equal(marksReady({ tool_name: 'mcp__github__update_pull_request', tool_input: { title: 'x' } }), false);
});

test('an app change is refused when the app never started, and the reason says how to go on', () => {
  const reason = refusal({ payload: bash('gh pr create -t x'), changedFiles: APP, appStarted: false, app });
  assert.match(reason, /^Not opened: this branch changes the app \(`web\/models\/branches\.ts`, `web\/tests\/x\.spec\.ts`\)/);
  assert.match(reason, /Run `make serve` and check the page\. Put what you saw under `## Proof`/, 'the project\'s own advice');
  assert.match(reason, /write what you tried and why it failed under `## Proof` and run this again: it opens ready/);
  assert.match(reason, /Only when it cannot start at all, with nothing in its logs, open the pull request as a draft \(`gh pr create --draft`\)/);
  assert.doesNotMatch(reason, /Needs a human/);
});

test('it lets the call through when the app ran, the change is outside the app, or git could not say', () => {
  const payload = bash('gh pr create -t x');
  assert.equal(refusal({ payload, changedFiles: APP, appStarted: true, app }), null);
  assert.equal(refusal({ payload, changedFiles: ['woodshed/session/prompt.md', 'README.md'], appStarted: false, app }), null);
  assert.equal(refusal({ payload, changedFiles: null, appStarted: false, app }), null);
  assert.equal(refusal({ payload: bash('gh pr create --draft -t x'), changedFiles: APP, appStarted: false, app }), null);
});

test('a project with no app is never refused, and the refusal gives the project\'s own advice', () => {
  const payload = bash('gh pr create -t x');
  assert.equal(refusal({ payload, changedFiles: APP, appStarted: false, app: null }), null);
  const reason = refusal({ payload, changedFiles: ['src/x.js'], appStarted: false, app: { paths: ['src/'], howToProve: 'Run `make serve`.' } });
  assert.match(reason, /`src\/x\.js`/);
  assert.match(reason, /Run `make serve`\. Put what you saw under `## Proof`/);
});

test('the app counts as started once any of the project\'s app logs has something in it', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'readyGate-logs-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const repoDir = '/work/app';
  assert.equal(appStartedIn({ repoDir, app, home }), false);
  const logDir = path.join(home, '.cache', 'app-servers', 'app');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'web.log'), '');
  assert.equal(appStartedIn({ repoDir, app, home }), false, 'an empty log is not a start');
  fs.writeFileSync(path.join(logDir, 'api.log'), 'listening on 9000\n');
  assert.equal(appStartedIn({ repoDir, app, home }), true);
  assert.equal(appStartedIn({ repoDir, app: null, home }), false);
});

test('run as the hook, it blocks with exit code 2 and its reason on stderr, and stays quiet otherwise', (t) => {
  const script = fileURLToPath(new URL('./readyGate.mjs', import.meta.url));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'readyGate-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'readyGate-home-'));
  t.after(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', 'master');
  fs.mkdirSync(path.join(repo, '.woodshed'));
  fs.writeFileSync(path.join(repo, '.woodshed', 'project.yaml'), fixtureProject({
    app: fixtureApp({ paths: ['web/'], logs: { api: '~/.cache/servers/{{CHECKOUT}}/api.log' } }),
  }));
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/master', 'HEAD');
  fs.mkdirSync(path.join(repo, 'web'));
  // Not committed, not even added: a new file still counts.
  fs.writeFileSync(path.join(repo, 'web', 'page.tsx'), 'x');

  const run = (command) => spawnSync('node', [script], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: repo }),
    // Without the session's DEFAULT_BRANCH, which would name a branch the fixture repo (on master) does not have.
    env: { ...isolatedEnv(), HOME: home, DEFAULT_BRANCH: '' },
    encoding: 'utf8',
  });

  const blocked = run('gh pr create -t x -F b.md');
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /`web\/page\.tsx`/);
  assert.equal(run('gh pr create --draft -t x').status, 0);
  assert.equal(run('ls').stdout, '', 'nothing on stdout, which claude would read');

  const logDir = path.join(home, '.cache', 'servers', path.basename(repo));
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'api.log'), 'listening on 9000\n');
  const allowed = run('gh pr create -t x -F b.md');
  assert.deepEqual([allowed.status, allowed.stderr], [0, '']);

  // A branch that breaks its own project file is refused, not let through.
  fs.writeFileSync(path.join(repo, '.woodshed', 'project.yaml'), fixtureProject({ app: fixtureApp({ howToProve: undefined }) }));
  const broken = run('gh pr create -t x -F b.md');
  assert.equal(broken.status, 2);
  assert.match(broken.stderr, /^Not opened: \.woodshed\/project\.yaml: app is missing howToProve.*Fix the project file on this branch/);
  assert.equal(run('gh pr create --draft -t x').status, 0, 'a draft is still not gated');
});

test('with several apps, a change under an app\'s paths needs that app started, not another', () => {
  const payload = bash('gh pr create -t x');
  const web = { name: 'web', label: 'web', ...app, paths: ['web/'], howToProve: 'Open the web app.' };
  const admin = { name: 'admin', label: 'Admin', ...app, paths: ['admin/'], howToProve: 'Open the admin pages.' };
  const apps = (webStarted, adminStarted) => [{ ...web, started: webStarted }, { ...admin, started: adminStarted }];
  const reason = refusal({ payload, changedFiles: ['admin/users.tsx'], apps: apps(true, false) });
  assert.match(reason, /^Not opened: this branch changes the Admin app \(`admin\/users\.tsx`\), but the Admin app was never started in this session/);
  assert.match(reason, /Open the admin pages\. Put what you saw under `## Proof`/, 'that app\'s own advice');
  assert.equal(refusal({ payload, changedFiles: ['admin/users.tsx'], apps: apps(false, true) }), null, 'the app the change is in ran');
  assert.equal(refusal({ payload, changedFiles: ['README.md'], apps: apps(false, false) }), null, 'a change in neither');
  assert.match(refusal({ payload, changedFiles: ['admin/users.tsx', 'web/page.tsx'], apps: apps(false, true) }), /changes the web app \(`web\/page\.tsx`\)/,
    'a change in both needs both');
  assert.equal(refusal({ payload, changedFiles: ['admin/users.tsx', 'web/page.tsx'], apps: apps(true, true) }), null);
});

test('run as the hook on a project of several apps, it reads each app\'s own logs', (t) => {
  const script = fileURLToPath(new URL('./readyGate.mjs', import.meta.url));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'readyGate-apps-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'readyGate-apps-home-'));
  t.after(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', 'master');
  fs.mkdirSync(path.join(repo, '.woodshed'));
  fs.writeFileSync(path.join(repo, '.woodshed', 'project.yaml'), fixtureProject({
    apps: [
      { name: 'web', ...fixtureApp({ paths: ['web/'], logs: { web: '~/logs/web.log' } }) },
      { name: 'admin', ...fixtureApp({ paths: ['admin/'], logs: { admin: '~/logs/admin.log' } }) },
    ],
  }));
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/master', 'HEAD');
  fs.mkdirSync(path.join(repo, 'admin'));
  fs.writeFileSync(path.join(repo, 'admin', 'users.tsx'), 'x');
  const run = () => spawnSync('node', [script], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'gh pr create -t x' }, cwd: repo }),
    env: { ...isolatedEnv(), HOME: home, DEFAULT_BRANCH: '' },
    encoding: 'utf8',
  });
  fs.mkdirSync(path.join(home, 'logs'));
  fs.writeFileSync(path.join(home, 'logs', 'web.log'), 'listening on 3001\n');
  const blocked = run();
  assert.equal(blocked.status, 2, 'the web app ran, and the change is in admin');
  assert.match(blocked.stderr, /changes the admin app \(`admin\/users\.tsx`\)/);
  fs.writeFileSync(path.join(home, 'logs', 'admin.log'), 'listening on 3000\n');
  assert.deepEqual([run().status, run().stderr], [0, '']);
});

test('a branch that breaks its own project file is refused though the installation\'s file stands in; one the default branch broke is not', (t) => {
  assert.match(brokenFileRefusal({ project: { repoFileError: '.woodshed/project.yaml: has database' }, changedFiles: ['.woodshed/project.yaml'] }),
    /^Not opened: \.woodshed\/project\.yaml: has database\. Fix the project file on this branch/);
  assert.equal(brokenFileRefusal({ project: { repoFileError: 'x' }, changedFiles: ['web/a.ts'] }), null, 'the branch left the file alone');
  assert.equal(brokenFileRefusal({ project: { repoFileError: 'x' }, changedFiles: null }), null, 'git could not say');
  assert.equal(brokenFileRefusal({ project: {}, changedFiles: ['.woodshed/project.yaml'] }), null, 'the file reads');

  const script = fileURLToPath(new URL('./readyGate.mjs', import.meta.url));
  const scratch = (prefix) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  };
  const repo = fixtureCheckout(scratch('readyGate-broken-'), { repo: 'acme/app' });
  const files = fixtureProjectFiles(scratch('readyGate-files-'), { 'acme/app': fixtureProject() });
  const home = scratch('readyGate-broken-home-');
  const run = () => spawnSync('node', [script], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'gh pr create -t x -F b.md' }, cwd: repo }),
    env: { ...isolatedEnv(), HOME: home, DEFAULT_BRANCH: 'main', WOODSHED_PROJECT_FILES_DIR: files },
    encoding: 'utf8',
  });
  fs.mkdirSync(path.join(repo, '.woodshed'));
  fs.writeFileSync(path.join(repo, '.woodshed', 'project.yaml'), 'version: 1\ndatabase: null\n');
  const broken = run();
  assert.equal(broken.status, 2);
  assert.match(broken.stderr, /^Not opened: \.woodshed\/project\.yaml: has database, which is not a field/);

  // The same file on the default branch: this branch did not break it, and the installation's file runs the repo.
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' });
  git('add', '.woodshed');
  git('commit', '-q', '-m', 'old project file');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const allowed = run();
  assert.deepEqual([allowed.status, allowed.stderr], [0, '']);
});

test('a project file that does not read is refused only when this branch changed it, not when the default branch has it so', (t) => {
  const err = new Error('.woodshed/project.yaml: pullRequests.qa has recordings, which is not a field');
  assert.match(unreadRefusal({ err, changedFiles: ['.woodshed/project.yaml'] }), /^Not opened: \.woodshed\/project\.yaml: pullRequests\.qa has recordings.*Fix the project file on this branch/);
  assert.equal(unreadRefusal({ err, changedFiles: ['web/a.ts'] }), null, 'the branch left the file alone');
  assert.match(unreadRefusal({ err, changedFiles: null }), /^Not opened: /, 'git could not say: refused, as before');

  // Run as the hook: the default branch's file has a field this reader does not know, as a session whose image is
  // older than the default branch's file reads it. No installation file stands in.
  const script = fileURLToPath(new URL('./readyGate.mjs', import.meta.url));
  const scratch = (prefix) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  };
  const repo = fixtureCheckout(scratch('readyGate-unread-'), { repo: 'acme/app' });
  const home = scratch('readyGate-unread-home-');
  const run = () => spawnSync('node', [script], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'gh pr create -t x -F b.md' }, cwd: repo }),
    env: { ...isolatedEnv(), HOME: home, DEFAULT_BRANCH: 'main' },
    encoding: 'utf8',
  });
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' });
  fs.mkdirSync(path.join(repo, '.woodshed'));
  fs.writeFileSync(path.join(repo, '.woodshed', 'project.yaml'), 'version: 1\nnewerField: true\n');
  git('add', '.woodshed');
  git('commit', '-q', '-m', 'a newer project file');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  fs.writeFileSync(path.join(repo, 'change.txt'), 'x');
  const allowed = run();
  assert.deepEqual([allowed.status, allowed.stderr], [0, '']);

  // The branch changes the file, and it still does not read: refused.
  fs.appendFileSync(path.join(repo, '.woodshed', 'project.yaml'), '# edited here\n');
  const refused = run();
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /^Not opened: \.woodshed\/project\.yaml: has newerField, which is not a field/);
});

test('run from a subfolder, it still sees a new project file the branch has not committed', (t) => {
  const script = fileURLToPath(new URL('./readyGate.mjs', import.meta.url));
  const scratch = (prefix) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  };
  const repo = fixtureCheckout(scratch('readyGate-sub-'), { repo: 'acme/app' });
  const home = scratch('readyGate-sub-home-');
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' });
  fs.mkdirSync(path.join(repo, 'web'));
  fs.writeFileSync(path.join(repo, 'web', 'page.tsx'), 'x');
  git('add', 'web');
  git('commit', '-q', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  // The branch adds a project file that does not read, not even added to the index, and the hook runs from web/.
  fs.mkdirSync(path.join(repo, '.woodshed'));
  fs.writeFileSync(path.join(repo, '.woodshed', 'project.yaml'), 'version: 1\nsurprise: true\n');
  const run = spawnSync('node', [script], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'gh pr create -t x -F b.md' }, cwd: path.join(repo, 'web') }),
    env: { ...isolatedEnv(), HOME: home, DEFAULT_BRANCH: 'main' },
    encoding: 'utf8',
  });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /^Not opened: \.woodshed\/project\.yaml: has surprise, which is not a field/);
});
