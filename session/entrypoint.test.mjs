import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fixtureApp, fixtureProject } from '../shared/projectFixture.mjs';

const SESSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = fs.readFileSync(path.join(SESSION_DIR, 'entrypoint.sh'), 'utf8');

// One function of the entrypoint, as it is written there, so the test runs the real thing under its own options.
function fn(name) {
  const at = ENTRYPOINT.indexOf(`\n${name}() {`);
  assert.ok(at >= 0, `${name} is in entrypoint.sh`);
  const end = ENTRYPOINT.indexOf('\n}\n', at);
  return ENTRYPOINT.slice(at + 1, end + 2);
}

// woodshed/shared/, where the project file's reader lives: the image's SHARED_DIR.
const SHARED_DIR = path.resolve(SESSION_DIR, '../shared');

// A repo whose project file names the rules and notes its sessions add to Woodshed's own.
const PROJECT_RULE = 'Run `make check` before every push.';
const PROJECT_NOTE = 'Before anything that needs `vendor/`, wait for the install.';
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-project-'));
after(() => fs.rmSync(REPO, { recursive: true, force: true }));
fs.mkdirSync(path.join(REPO, '.woodshed'));
fs.writeFileSync(path.join(REPO, '.woodshed/project.yaml'), fixtureProject({ rules: '.woodshed/rules.md', setup: '.woodshed/setup.md' }));
fs.writeFileSync(path.join(REPO, '.woodshed/rules.md'), `- ${PROJECT_RULE}\n`);
// The notes' title and the blank line after it, which a shared session's inline copy drops.
fs.writeFileSync(path.join(REPO, '.woodshed/setup.md'), `Environment notes:\n\n- ${PROJECT_NOTE}\n`);

function writePrompt({ attachments, kind = 'private', reviewOnly = false, repoDir = REPO, defaultBranch = 'main', sessionUrl = null }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-prompt-'));
  const script = [
    'set -euo pipefail',
    'log() { echo "[woodshed] $*"; }',
    'die() { log "ERROR: $*"; exit 1; }',
    'project() { node "$SHARED_DIR/project.mjs" "$@"; }',
    fn('taskText'),
    // The function writes and reads under /tmp; point both at this test's own folder.
    fn('writePrompt').replaceAll('/tmp/', `${tmp}/`),
    fn('leaveOutConsoleLinks'),
    fn('writeRules').replaceAll('/tmp/', `${tmp}/`),
    'writePrompt',
    'writeRules',
    'echo "after writePrompt"',
  ].join('\n');
  if (attachments) fs.writeFileSync(path.join(tmp, 'woodshed-attachments.md'), '\n[Attached file 1: /tmp/uploads/1-notes.md]\n');
  try {
    const out = execFileSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, PROMPT: reviewOnly ? '' : 'Fix the export button', STARTED_BY: 'octocat', BRANCH: 'woodshed/x', DEFAULT_BRANCH: defaultBranch, SESSION_DIR, SHARED_DIR, REPO_DIR: repoDir, SESSION_KIND: kind, ...(reviewOnly ? { REVIEW_ONLY: '1' } : {}), ...(sessionUrl ? { SESSION_URL: sessionUrl } : {}) },
    });
    return {
      out,
      prompt: fs.existsSync(path.join(tmp, 'woodshed-prompt.md')) ? fs.readFileSync(path.join(tmp, 'woodshed-prompt.md'), 'utf8') : null,
      rules: fs.readFileSync(path.join(tmp, 'woodshed-rules.md'), 'utf8'),
      setup: fs.readFileSync(path.join(tmp, 'woodshed-setup.md'), 'utf8'),
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('a session with no files attached still gets its prompt written, under the entrypoint\'s set -e', () => {
  const { out, prompt } = writePrompt({ attachments: false });
  assert.match(out, /Prompt written/);
  assert.match(out, /after writePrompt/);
  assert.match(prompt, /Fix the export button/);
  assert.doesNotMatch(prompt, /Attached file/);
});

test('a review-only session writes no prompt, and claude starts with none', () => {
  const { out, prompt, rules } = writePrompt({ attachments: false, reviewOnly: true });
  assert.match(out, /Prompt skipped/);
  assert.match(out, /after writePrompt/);
  assert.equal(prompt, null);
  assert.match(rules, /You are running in a Woodshed session/);
  assert.match(fn('startClaude'), /REVIEW_ONLY:-\}" = 1 \]; then\n\s+tmux send-keys -t claude "\$SESSION_DIR\/bin\/claude\$\(claudeFlags\)" Enter/);
});

test('attached files are listed under the prompt', () => {
  const { prompt } = writePrompt({ attachments: true });
  assert.match(prompt, /Fix the export button\n\[Attached file 1: /);
});

test('the first message is the request alone, and the rules are written apart for the system prompt', () => {
  const { prompt, rules } = writePrompt({ attachments: false });
  assert.doesNotMatch(prompt, /You are running in a Woodshed session/);
  assert.match(rules, /You are running in a Woodshed session/);
  assert.match(rules, /branch `woodshed\/x`/);
  assert.match(rules, /Started by @octocat/);
  assert.doesNotMatch(rules, /\{\{/);
});

test('a shared session\'s rules drop the private lines, and a private one\'s drop the shared lines', () => {
  assert.match(writePrompt({ attachments: false, kind: 'shared' }).rules, /Nobody is waiting on this terminal/);
  const { rules } = writePrompt({ attachments: false });
  assert.doesNotMatch(rules, /Nobody is waiting on this terminal/);
  assert.match(rules, /Someone may be watching this terminal/);
});

test('the project\'s rules follow Woodshed\'s, and its notes go inline in a shared session and in a file for a private one', () => {
  const shared = writePrompt({ attachments: false, kind: 'shared' });
  assert.ok(shared.rules.includes(PROJECT_RULE));
  assert.ok(shared.rules.indexOf('You are running in a Woodshed session') < shared.rules.indexOf(PROJECT_RULE));
  assert.ok(shared.rules.includes(`- ${PROJECT_NOTE}`));
  assert.doesNotMatch(shared.rules, /Environment notes:/);
  const own = writePrompt({ attachments: false });
  assert.match(own.rules, /Environment notes .* are in `[^`]*\/woodshed-setup\.md`/);
  assert.ok(!own.rules.includes(PROJECT_NOTE));
  assert.ok(own.setup.includes(PROJECT_NOTE));
});

test('a project of several apps has its rules name each, with how it starts and how to prove a change; one app adds nothing', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-apps-'));
  after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, '.woodshed'));
  const apps = [
    { name: 'web', label: 'Web app', ...fixtureApp({ start: 'make web', frontendPort: 3001, paths: ['web/'], howToProve: 'Open the page in the browser.' }) },
    { name: 'admin', ...fixtureApp({ start: 'make admin', frontendPort: 3000, howToProve: 'Open the admin pages.' }) },
  ];
  fs.writeFileSync(path.join(repo, '.woodshed/project.yaml'), fixtureProject({ apps }));
  const { rules, out } = writePrompt({ attachments: false, repoDir: repo });
  assert.match(rules, /^- This project has several apps, and one runs at a time/m);
  assert.match(rules, /^ {2}- `web` \(Web app\), the default: `make web`, its frontend on port 3001, for changes under `web\/`\. To prove a change in it: Open the page in the browser\.$/m);
  assert.match(rules, /^ {2}- `admin`: `make admin`, its frontend on port 3000\. To prove a change in it: Open the admin pages\.$/m);
  assert.match(out, /Rules written .*apps: 2\)/);
  fs.writeFileSync(path.join(repo, '.woodshed/project.yaml'), fixtureProject({ app: fixtureApp() }));
  assert.doesNotMatch(writePrompt({ attachments: false, repoDir: repo }).rules, /several apps/);
});

test('a project with a review tag tells its sessions to end each push\'s last commit with it; one with none says nothing', () => {
  const none = writePrompt({ attachments: false, kind: 'shared' });
  assert.doesNotMatch(none.rules, /code review runs on a push|\{\{REVIEW_TAG\}\}/);
  assert.match(none.out, /review tag: none/);

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-reviewtag-'));
  try {
    fs.mkdirSync(path.join(repo, '.woodshed'));
    const review = { author: 'ci[bot]', heading: '## Review', workflow: '.github/workflows/review.yml', rerun: '[run-review]', commentAuthor: null };
    fs.writeFileSync(path.join(repo, '.woodshed/project.yaml'), fixtureProject({ pullRequests: { review, suites: [], qa: null, mergeRisk: null } }));
    for (const kind of ['shared', 'private']) {
      const tagged = writePrompt({ attachments: false, kind, repoDir: repo });
      assert.ok(tagged.rules.includes('end the subject of the last commit of each push with ` [run-review]`'), kind);
      assert.match(tagged.rules, /keep the tag out of the PR title/);
      assert.doesNotMatch(tagged.rules, /\{\{/);
      assert.match(tagged.out, /review tag: \[run-review\]/);
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('a project file with consoleLinks: false keeps the session\'s link out of its pull requests, on any repo', () => {
  const url = 'https://console.example/s/0a1b2c3d';
  const linked = writePrompt({ attachments: false, sessionUrl: url });
  assert.ok(linked.rules.includes(`Started by @octocat via [Woodshed](${url}).`), 'left out, the link stays');
  assert.doesNotMatch(linked.out, /Session link left out/);

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-nolinks-'));
  try {
    fs.mkdirSync(path.join(repo, '.woodshed'));
    fs.writeFileSync(path.join(repo, '.woodshed/project.yaml'), fixtureProject({ consoleLinks: false }));
    const unlinked = writePrompt({ attachments: false, sessionUrl: url, repoDir: repo });
    assert.match(unlinked.out, /Session link left out of pull requests \(the project file's consoleLinks\)/);
    assert.ok(unlinked.rules.includes('Started by @octocat via Woodshed.'));
    assert.doesNotMatch(unlinked.rules, /console\.example/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('a consoleLinks read that fails never stops the start: the link stays', () => {
  const script = [
    'set -euo pipefail',
    'log() { echo "[woodshed] $*"; }',
    'die() { log "ERROR: $*"; exit 1; }',
    'project() { return 1; }',
    fn('leaveOutConsoleLinks'),
    'leaveOutConsoleLinks',
    'echo "link: ${SESSION_URL:-unset}"',
  ].join('\n');
  const out = execFileSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH, SESSION_URL: 'https://console.example/s/0a1b2c3d' } });
  assert.match(out, /link: https:\/\/console\.example\/s\/0a1b2c3d/);
  assert.doesNotMatch(out, /ERROR/);
});

test('a repo with no project file gets Woodshed\'s rules alone, and no notes', (t) => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-noproject-'));
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));
  // A repository whose default branch, `trunk`, has no project file, as a session's checkout of another repo would be.
  const git = (...args) => execFileSync('git', ['-C', repoDir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' });
  git('init', '-q', '-b', 'trunk');
  git('commit', '-q', '--allow-empty', '-m', 'empty');
  git('update-ref', 'refs/remotes/origin/trunk', 'HEAD');
  const { rules, setup } = writePrompt({ attachments: false, kind: 'shared', repoDir, defaultBranch: 'trunk' });
  assert.match(rules, /You are running in a Woodshed session/);
  assert.match(rules, /Started by @octocat/);
  assert.ok(!rules.includes(PROJECT_RULE), 'no project rules');
  assert.doesNotMatch(rules, /\{\{/);
  assert.match(rules, /open the PR against trunk/);
  assert.doesNotMatch(rules, /master/);
  assert.equal(setup, '\n');
});

test('claude gets the rules as a system prompt on a fresh start and on a resume, which rewrites them', () => {
  assert.match(fn('claudeFlags'), /--append-system-prompt-file %s' \/tmp\/woodshed-rules\.md/);
  const run = ENTRYPOINT.slice(ENTRYPOINT.indexOf('\n  if [ "${AGENT:-claude}" != codex ] && resumable; then\n    log "Resuming'));
  assert.ok(run.indexOf('  writeRules\n') > run.indexOf('  fi\n'), 'writeRules runs after the resume branch, for both');
  assert.ok(run.indexOf('  writeRules\n') < run.indexOf('  startClaude\n'), 'writeRules runs before claude is started, which reads its file');
});

// installDefaultPlugins with a stand-in claude that records each install, in a home of the test's own.
function installDefaultPlugins({ kind, installed = null, offered = null, failInstall = false, brokenList = false }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-plugins-'));
  const sessionDir = path.join(tmp, 'session');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(sessionDir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
  if (brokenList) fs.writeFileSync(path.join(sessionDir, 'defaultPlugins.mjs'), 'process.exit(3);\n');
  else fs.copyFileSync(path.join(SESSION_DIR, 'defaultPlugins.mjs'), path.join(sessionDir, 'defaultPlugins.mjs'));
  // Beside it, in the image's layout: ../shared/isMain.mjs.
  fs.mkdirSync(path.join(tmp, 'shared'));
  fs.copyFileSync(path.join(SHARED_DIR, 'isMain.mjs'), path.join(tmp, 'shared', 'isMain.mjs'));
  fs.writeFileSync(path.join(sessionDir, 'bin', 'claude'),
    `#!/bin/bash\necho "$*" >> ${tmp}/calls\n${failInstall ? 'echo "no network" >&2; exit 1' : 'exit 0'}\n`, { mode: 0o755 });
  if (installed) fs.writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify(installed));
  if (offered) fs.writeFileSync(path.join(home, '.claude', 'woodshed-default-plugins.json'), JSON.stringify(offered));
  const script = ['set -euo pipefail', 'log() { echo "[woodshed] $*"; }', fn('installDefaultPlugins'), 'installDefaultPlugins', 'echo "start goes on"'].join('\n');
  try {
    let out = execFileSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: home, SESSION_DIR: sessionDir, REPO_DIR: tmp, ...(kind ? { SESSION_KIND: kind } : {}) },
    });
    const calls = fs.existsSync(path.join(tmp, 'calls')) ? fs.readFileSync(path.join(tmp, 'calls'), 'utf8') : '';
    const offeredFile = path.join(home, '.claude', 'woodshed-default-plugins.json');
    assert.match(out, /start goes on\n$/, 'the start goes on under set -e');
    out = out.replace(/start goes on\n$/, '');
    const offeredNow = fs.existsSync(offeredFile) ? JSON.parse(fs.readFileSync(offeredFile, 'utf8')) : null;
    return { out, calls, offered: offeredNow };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('a private session installs the default plugins, Slack among them, into a home without them', () => {
  const { out, calls, offered } = installDefaultPlugins({ kind: 'private' });
  assert.match(calls, /^plugin install --scope user slack@anthropic-plugin-directory$/m);
  assert.deepEqual(offered, ['slack@anthropic-plugin-directory']);
  assert.match(out, /Default plugins installed \(installed: 1, failed: 0\)/);
});

test('a shared session never gets the default plugins', () => {
  assert.deepEqual(installDefaultPlugins({ kind: undefined }), { out: '', calls: '', offered: null });
});

test('a home that has them installs nothing, and a failed install does not stop the start', () => {
  const installed = { version: 2, plugins: { 'slack@anthropic-plugin-directory': [{ scope: 'user' }] } };
  // One installed by hand before the list existed is recorded as offered, so uninstalling it later sticks.
  assert.deepEqual(installDefaultPlugins({ kind: 'private', installed }),
    { out: '[woodshed] Default plugins already there\n', calls: '', offered: ['slack@anthropic-plugin-directory'] });
  const failed = installDefaultPlugins({ kind: 'private', failInstall: true });
  assert.match(failed.out, /WARNING: a default plugin could not be installed \(plugin: slack@anthropic-plugin-directory, error: no network\)/);
  assert.match(failed.out, /installed: 0, failed: 1/);
  assert.equal(failed.offered, null, 'a failed install is tried again next time');
});

test('a private session is told how to post to Slack itself, and a shared one is not', () => {
  assert.match(writePrompt({ attachments: false }).rules, /Slack MCP/);
  assert.doesNotMatch(writePrompt({ attachments: false, kind: 'shared' }).rules, /Slack MCP/);
});

test('a default plugin its owner uninstalled is not installed again', () => {
  assert.deepEqual(installDefaultPlugins({ kind: 'private', offered: ['slack@anthropic-plugin-directory'] }),
    { out: '[woodshed] Default plugins already there\n', calls: '', offered: ['slack@anthropic-plugin-directory'] });
});

test('a default plugin list that cannot be read leaves the start going', () => {
  assert.match(installDefaultPlugins({ kind: 'private', brokenList: true }).out, /WARNING: the default plugins could not be read, none installed/);
});

test('an ask session clears the env files\' secrets and the install secrets, and stops when the project file cannot say which', (t) => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-ask-'));
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));
  // The lines of runAsk that clear the secrets, run as they are written there.
  const body = fn('runAsk');
  const clearing = body.slice(body.indexOf('  local name secretVars'), body.indexOf('  local restoring'));
  const run = () => spawnSync('bash', ['-c', [
    'set -euo pipefail', 'log() { echo "[woodshed] $*"; }', 'die() { log "ERROR: $*"; exit 1; }',
    'project() { node "$SHARED_DIR/project.mjs" "$@"; }', 'f() {', clearing, 'env | grep -E "^(API_ENV|REGISTRY_TOKEN|OTHER_TOKEN|GH_TOKEN)=" || echo cleared', '}', 'f',
  ].join('\n')], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH, SESSION_DIR, SHARED_DIR, REPO_DIR: repoDir, API_ENV: 's', GH_TOKEN: 's',
      WOODSHED_INSTALL_SECRETS: 'OTHER_TOKEN REGISTRY_TOKEN', REGISTRY_TOKEN: 's', OTHER_TOKEN: 's',
    },
  });
  fs.mkdirSync(path.join(repoDir, '.woodshed'));
  fs.writeFileSync(path.join(repoDir, '.woodshed/project.yaml'), fixtureProject({
    envFiles: [{ path: 'api/.env', secret: 'api-env', lines: [] }],
  }));
  assert.equal(run().stdout, 'cleared\n', 'the project\'s secret, each install secret WOODSHED_INSTALL_SECRETS lists, and the fixed ones');
  fs.writeFileSync(path.join(repoDir, '.woodshed/project.yaml'), '{ not json');
  const broken = run();
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /ERROR: the project's secret variables could not be read/);
  assert.doesNotMatch(broken.stdout, /API_ENV=/);
});

// A repo with one install, whose command stands in for a package manager and counts its runs, and the image's record
// of the files it was built from.
function depsRepo(t, { command = 'echo run >> ran' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-refresh-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repoDir = path.join(root, 'app');
  fs.mkdirSync(path.join(repoDir, '.woodshed'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'api/pkgs/a'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'api/deps.lock'), 'v1');
  fs.writeFileSync(path.join(repoDir, 'api/pkgs/a/manifest'), 'a');
  const install = { dir: 'api', files: ['deps.lock', 'pkgs/*/manifest'], command, output: ['vendor'] };
  fs.writeFileSync(path.join(repoDir, '.woodshed/project.yaml'), fixtureProject({ dependencies: { installs: [install] } }));
  const records = path.join(root, 'records');
  fs.mkdirSync(path.join(records, 'api'), { recursive: true });
  const recorded = execFileSync('bash', ['-c', `. "${SESSION_DIR}/deps.sh"; depsRecord "$1" "$2" vendor`, 'x', path.join(repoDir, 'api'), install.files.join(' ')], { encoding: 'utf8' });
  fs.writeFileSync(path.join(records, 'api/built-from'), recorded);
  return { root, repoDir, records };
}

// refreshDeps as it is written there, with deps.sh sourced as the entrypoint does, and `env` the session's own.
function refreshDeps({ root, repoDir, records }, env = {}) {
  const script = [
    'set -euo pipefail', 'log() { echo "[woodshed] $*"; }', 'die() { log "ERROR: $*"; exit 1; }',
    'project() { node "$SHARED_DIR/project.mjs" "$@"; }', `. "${SESSION_DIR}/deps.sh"`,
    `DEPS_STATUS=${root}/woodshed-deps`, fn('refreshDeps'), 'refreshDeps',
  ].join('\n');
  const run = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH, SHARED_DIR, REPO_DIR: repoDir, WOODSHED_DEPS_RECORDS: records, ...env } });
  const ran = path.join(repoDir, 'api/ran');
  return { ...run, status: fs.readFileSync(path.join(root, 'woodshed-deps'), 'utf8'), runs: fs.existsSync(ran) ? fs.readFileSync(ran, 'utf8').split('\n').filter(Boolean).length : 0 };
}

test('refreshDeps runs nothing while each install\'s files are the ones the image was built from', (t) => {
  const result = refreshDeps(depsRepo(t));
  assert.equal(result.status, 'ready\n');
  assert.equal(result.runs, 0);
  assert.match(result.stdout, /Dependencies ready/);
  assert.doesNotMatch(result.stdout, /reinstalling/);
});

test('refreshDeps runs an install again where a file changed or a glob matches a new one, and records it', (t) => {
  const repo = depsRepo(t);
  fs.writeFileSync(path.join(repo.repoDir, 'api/deps.lock'), 'v2');
  const changed = refreshDeps(repo);
  assert.equal(changed.status, 'ready\n');
  assert.equal(changed.runs, 1);
  assert.match(changed.stdout, /Dependency files changed since the image was built, reinstalling \(dir: api\)/);
  assert.equal(refreshDeps(repo).runs, 1, 'the new record is what the next start compares with');
  fs.mkdirSync(path.join(repo.repoDir, 'api/pkgs/b'));
  fs.writeFileSync(path.join(repo.repoDir, 'api/pkgs/b/manifest'), 'b');
  assert.equal(refreshDeps(repo).runs, 2);
  fs.rmSync(path.join(repo.records, 'api'), { recursive: true });
  assert.equal(refreshDeps(repo).runs, 3, 'an install the image has no record of, as one a branch added, runs');
});

test('a reinstall reads the install secrets already in the session\'s environment, and not the manifest on its stdin', (t) => {
  const repo = depsRepo(t, { command: 'cat > /dev/null; printf %s "$REGISTRY_TOKEN" > token; echo run >> ran' });
  fs.writeFileSync(path.join(repo.repoDir, 'api/deps.lock'), 'v2');
  const result = refreshDeps(repo, { WOODSHED_INSTALL_SECRETS: 'REGISTRY_TOKEN', REGISTRY_TOKEN: 'the-token' });
  assert.equal(result.status, 'ready\n');
  assert.equal(fs.readFileSync(path.join(repo.repoDir, 'api/token'), 'utf8'), 'the-token');
  assert.doesNotMatch(result.stdout + result.stderr, /the-token/, 'a value is never logged');
});

test('a failed install says which command in which dir, and names the install secrets only when there are some', (t) => {
  const repo = depsRepo(t, { command: 'exit 3' });
  fs.writeFileSync(path.join(repo.repoDir, 'api/deps.lock'), 'v2');
  const failed = refreshDeps(repo, { WOODSHED_INSTALL_SECRETS: 'REGISTRY_TOKEN' });
  assert.equal(failed.status, 'failed: `exit 3` in api. Are the install secrets (REGISTRY_TOKEN) right? Run it again there.\n');
  assert.match(failed.stdout, /ERROR: the install failed \(dir: api\)/);
  assert.equal(refreshDeps(repo).status, 'failed: `exit 3` in api. Run it again there.\n');
});

test('refreshDeps reports a project file it cannot read as failed, not ready', (t) => {
  const repo = depsRepo(t);
  fs.writeFileSync(path.join(repo.repoDir, '.woodshed/project.yaml'), fixtureProject({ dependencies: ['api'] }));
  const broken = refreshDeps(repo);
  assert.equal(broken.status, 'failed: the project file (.woodshed/project.yaml) could not be read\n');
});

test('the default branch is what the remote says, not a name the entrypoint assumes', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-default-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' });
  const remote = path.join(base, 'remote.git');
  const clone = path.join(base, 'clone');
  sh(base, 'init', '-q', '--bare', '-b', 'trunk', remote);
  sh(base, 'clone', '-q', remote, clone);
  sh(clone, 'checkout', '-q', '-b', 'trunk');
  sh(clone, 'commit', '-q', '--allow-empty', '-m', 'first');
  sh(clone, 'push', '-q', 'origin', 'trunk');
  const run = (extra = '') => spawnSync('bash', ['-c', [
    'set -euo pipefail', 'log() { echo "[woodshed] $*"; }', 'die() { log "ERROR: $*"; exit 1; }', fn('findDefaultBranch'), extra, 'findDefaultBranch', 'echo "$DEFAULT_BRANCH"',
  ].join('\n')], { encoding: 'utf8', env: { PATH: process.env.PATH, REPO_DIR: clone } });
  assert.equal(run().stdout.trim().split('\n').at(-1), 'trunk');
  // The remote cannot be asked: the clone's own origin/HEAD answers.
  sh(clone, 'remote', 'set-url', 'origin', path.join(base, 'gone.git'));
  sh(clone, 'remote', 'set-head', 'origin', 'trunk');
  assert.equal(run().stdout.trim().split('\n').at(-1), 'trunk');
});

test('a session starts only the services its project\'s env uses, and warns of a line whose variable is unset', (t) => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-services-'));
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repoDir, '.woodshed'));
  const run = (envFiles, env = {}) => {
    fs.writeFileSync(path.join(repoDir, '.woodshed/project.yaml'), fixtureProject({ env: { NODE_ENV: 'test' }, envFiles }));
    return spawnSync('bash', ['-c', [
      'set -euo pipefail', 'log() { echo "[woodshed] $*"; }', 'die() { log "ERROR: $*"; exit 1; }',
      'project() { node "$SHARED_DIR/project.mjs" "$@"; }', 'databases() { node "$SHARED_DIR/databases/index.mjs" "$@"; }',
      fn('usesVariable'), fn('writeEnvFiles'), 'writeEnvFiles', 'usesVariable REDIS_URL && echo redis || echo no-redis',
    ].join('\n')], { encoding: 'utf8', env: { PATH: process.env.PATH, SHARED_DIR, REPO_DIR: repoDir, ...env } });
  };
  const none = run([]);
  assert.equal(none.status, 0, 'a repo that uses none of them is given none');
  assert.match(none.stdout, /no-redis/);
  assert.doesNotMatch(none.stdout, /WARNING/);
  const uses = [{ path: 'a/.env', secret: null, lines: ['STORE_URL={{STORE_URL}}', 'REDIS_URL=redis://127.0.0.1:6379'] }];
  const missing = run(uses);
  assert.equal(missing.status, 0, 'a service is the installation\'s, so one missing is a warning, not a stop');
  assert.match(missing.stdout, /a\/\.env \(base: 0 bytes, unset: STORE_URL\)/);
  assert.match(missing.stdout, /WARNING: an env file line needs a variable that is not set/);
  const given = run(uses, { STORE_URL: 'http://store:4566', WOODSHED_SERVICES: 'STORE_URL' });
  assert.equal(given.status, 0);
  assert.match(given.stdout, /redis/);
  assert.doesNotMatch(given.stdout, /no-redis|WARNING/);
});

test('a session starts Redis and its viewer only when its project uses REDIS_URL, and says which', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-redis-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'repo/.woodshed'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'bin'));
  const calls = path.join(dir, 'calls');
  for (const program of ['redis-server', 'redis-commander']) {
    fs.writeFileSync(path.join(dir, 'bin', program), `#!/bin/bash\necho ${program} >> '${calls}'\n`, { mode: 0o755 });
  }
  const run = (project, args = '') => {
    fs.rmSync(calls, { force: true });
    fs.writeFileSync(path.join(dir, 'repo/.woodshed/project.yaml'), fixtureProject(project));
    const result = spawnSync('bash', ['-c', [
      'set -euo pipefail', 'log() { echo "[woodshed] $*"; }', 'project() { node "$SHARED_DIR/project.mjs" "$@"; }',
      fn('usesVariable'), fn('startRedis'), fn('startRedisViewer'), fn('startRedisIfUsed'), `startRedisIfUsed ${args}`, 'wait',
    ].join('\n')], { encoding: 'utf8', env: { PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, SHARED_DIR, REPO_DIR: path.join(dir, 'repo'), SESSION_ID: '0a1b2c3d' } });
    assert.equal(result.status, 0, result.stderr);
    return { stdout: result.stdout, started: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').sort() : [] };
  };
  const none = run({ env: { NODE_ENV: 'test' } }, 'viewer');
  assert.deepEqual(none.started, [], 'a repo whose app uses no Redis is given none');
  assert.match(none.stdout, /Redis not started \(the project uses none/);
  const inEnv = run({ env: { REDIS_URL: 'redis://127.0.0.1:6379' } }, 'viewer');
  assert.deepEqual(inEnv.started, ['redis-commander', 'redis-server']);
  assert.match(inEnv.stdout, /Redis started \(viewer: yes\)/);
  const inFile = run({ envFiles: [{ path: 'a/.env', secret: null, lines: ['REDIS_URL={{REDIS_URL}}'] }] });
  assert.deepEqual(inFile.started, ['redis-server'], 'the template commands need Redis, not its viewer');
  assert.match(inFile.stdout, /Redis started \(viewer: no\)/);
});

const PG = { engine: 'postgres', dir: '.', migrate: null, seed: null, envFiles: [], paths: [], migrations: null, user: 'app_user', name: 'app' };
const MONGO = { ...PG, engine: 'mongo', user: null, name: null };

test('a project with no databases needs no engine to start, and one with databases needs each one\'s', (t) => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-databases-'));
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repoDir, '.woodshed'));
  // runSession's database check, then writeEnvFiles, as they are written there; the console's credentials as
  // useDatabaseFrom leaves them.
  const run = (project, env = {}) => {
    fs.writeFileSync(path.join(repoDir, '.woodshed/project.yaml'), fixtureProject(project));
    return spawnSync('bash', ['-c', [
      'set -euo pipefail', 'log() { echo "[woodshed] $*"; }', 'die() { log "ERROR: $*"; exit 1; }',
      'project() { node "$SHARED_DIR/project.mjs" "$@"; }', 'databases() { node "$SHARED_DIR/databases/index.mjs" "$@"; }',
      fn('usesVariable'), fn('requireDatabases'), fn('writeEnvFiles'),
      'requireDatabases', 'writeEnvFiles', 'echo "mongo=${MONGODB_URI:-none} pg=${PG_URL:-none} app=${APP_DB:-none}"', 'cat a/.env',
    ].join('\n')], { encoding: 'utf8', cwd: repoDir, env: { PATH: process.env.PATH, SHARED_DIR, REPO_DIR: repoDir, ...env } });
  };
  const lines = { envFiles: [{ path: 'a/.env', secret: null, lines: ['DATABASE_HOST={{PGHOST}}', 'DB_PASSWORD="{{PGPASSWORD}}"', 'MONGO_URL={{MONGODB_URI}}'] }] };
  const none = run({ env: { DATABASE_URL: 'postgres://postgres:postgres@db:5432/app' }, envFiles: [{ path: 'a/.env', secret: null, lines: [] }] });
  assert.equal(none.status, 0, none.stdout + none.stderr);
  assert.match(none.stdout, /mongo=none pg=none/);
  const missing = run({ ...lines, databases: [PG, MONGO] });
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /ERROR: the project file's databases need postgres and mongo, which this installation does not host \(it hosts none\)/);
  // An installation with Postgres alone, for a project with a Mongo database too.
  const noMongo = run({ ...lines, databases: [PG, MONGO] }, { PGHOST: 'pg' });
  assert.equal(noMongo.status, 1);
  assert.match(noMongo.stdout, /ERROR: the project file's databases need mongo, which this installation does not host \(it hosts postgres\)/);
  const creds = { WOODSHED_DB_USER: 'woodshed__ab12cd34', WOODSHED_DB_PASSWORD: 'p#ss', WOODSHED_DB_NAME: 'woodshed__ab12cd34' };
  // Mongo alone, with no Postgres anywhere.
  const mongoOnly = run({ ...lines, env: { APP_DB: '{{MONGODB_URI}}' }, databases: [MONGO] }, { WOODSHED_MONGO_HOST: 'mongo:27017', ...creds });
  assert.equal(mongoOnly.status, 0, mongoOnly.stdout + mongoOnly.stderr);
  assert.match(mongoOnly.stdout, /mongo=mongodb:\/\/woodshed__ab12cd34:p%23ss@mongo:27017\/woodshed__ab12cd34\?authSource=woodshed__ab12cd34 pg=none app=mongodb:/);
  const both = run({ ...lines, databases: [PG, MONGO] }, { PGHOST: 'pg', PGSSLMODE: 'require', WOODSHED_MONGO_HOST: 'mongo:27017', ...creds });
  assert.equal(both.status, 0, both.stdout + both.stderr);
  assert.match(both.stdout, /pg=postgres:\/\/woodshed__ab12cd34:p%23ss@pg:5432\/woodshed__ab12cd34\?sslmode=require/);
  assert.match(both.stdout, /DATABASE_HOST=pg\nDB_PASSWORD="p#ss"\nMONGO_URL=mongodb:\/\/woodshed__ab12cd34:/);
  // The docker launcher: a database the environment names whole, and the project file's user and name for the rest.
  const given = run({ ...lines, env: { APP_DB: '{{PGUSER}}/{{PGDATABASE}}' }, databases: [PG] }, { PGHOST: 'pg', PGPASSWORD: 'x' });
  assert.equal(given.status, 0, given.stdout + given.stderr);
  assert.match(given.stdout, /app=app_user\/app/);
});

test('a shared session in an installation that hosts no database engine asks the console for none', (t) => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-nodb-'));
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repoDir, '.woodshed'));
  fs.writeFileSync(path.join(repoDir, '.woodshed/project.yaml'), fixtureProject({}));
  const out = spawnSync('bash', ['-c', [
    'set -euo pipefail', 'log() { echo "[woodshed] $*"; }', 'die() { log "ERROR: $*"; exit 1; }',
    'databases() { node "$SHARED_DIR/databases/index.mjs" "$@"; }',
    'curl() { echo "curl called"; exit 1; }', fn('fetchSessionDatabases'), 'fetchSessionDatabases', 'echo "db=${WOODSHED_DB_NAME:-none}"',
  ].join('\n')], { encoding: 'utf8', env: { PATH: process.env.PATH, SHARED_DIR, REPO_DIR: repoDir, WOODSHED_CONSOLE_URL: 'http://console:7691', SESSION_TOKEN: 't' } });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /No databases to fetch \(the installation hosts no database engine/);
  assert.doesNotMatch(out.stdout, /curl called/);
});

// The db-admin task's `seed` and `migrate`: every database's commands, in the list's order, each in its dir, with the
// variables db-admin gave (seedEnv) and no console.
test('the template commands run each database\'s migrate, then its seed for a new template, in the list\'s order', (t) => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-template-'));
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repoDir, '.woodshed'));
  fs.mkdirSync(path.join(repoDir, 'api'));
  const out = path.join(repoDir, 'ran');
  const record = (what) => `echo "${what} in $(basename "$PWD") $PGDATABASE \${MONGODB_URI:-}" >> ${out}`;
  fs.writeFileSync(path.join(repoDir, '.woodshed/project.yaml'), fixtureProject({ databases: [
    { ...PG, dir: 'api', migrate: record('pg migrate'), seed: record('pg seed') },
    { ...MONGO, dir: 'api', seed: record('mongo seed') },
  ] }));
  const run = (mode) => {
    fs.rmSync(out, { force: true });
    const result = spawnSync('bash', ['-c', [
      'set -euo pipefail', 'log() { echo "[woodshed] $*"; }', 'die() { log "ERROR: $*"; exit 1; }',
      'project() { node "$SHARED_DIR/project.mjs" "$@"; }', 'databases() { node "$SHARED_DIR/databases/index.mjs" "$@"; }',
      fn('usesVariable'), fn('startRedisIfUsed'), fn('requireDatabases'), fn('writeEnvFiles'), fn('runTemplateCommands').replaceAll('/tmp/', `${repoDir}/`),
      `runTemplateCommands ${mode}`,
    ].join('\n')], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, SHARED_DIR, REPO_DIR: repoDir, PGHOST: 'pg', PGUSER: 'woodshed__seed', PGPASSWORD: 'x', PGDATABASE: 'next', MONGODB_URI: 'mongodb://m/next' },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return fs.readFileSync(out, 'utf8').trim().split('\n');
  };
  assert.deepEqual(run('seed'), ['pg migrate in api next mongodb://m/next', 'pg seed in api next mongodb://m/next', 'mongo seed in api next mongodb://m/next']);
  assert.deepEqual(run('migrate'), ['pg migrate in api next mongodb://m/next']);
});

test('a Codex session starts codex with the picked flags, and the rules go in codex\'s own AGENTS.md', () => {
  const flags = execFileSync('bash', ['-c', `${fn('codexFlags')}\ncodexFlags`], {
    encoding: 'utf8', env: { PATH: process.env.PATH, PERMISSION_MODE: 'plan', MODEL: 'gpt-5.5', EFFORT: 'high' },
  });
  assert.equal(flags, ' --add-dir /tmp/uploads --sandbox read-only --ask-for-approval on-request --model gpt-5.5 -c model_reasoning_effort=\\"high\\"');
  assert.match(fn('configureCodex'), /cp \/tmp\/woodshed-rules\.md "\$CODEX_HOME_DIR\/AGENTS\.md"/);
  assert.ok(ENTRYPOINT.indexOf('  writeRules\n  if [ "${AGENT:-claude}" = codex ]') > 0, 'the rules are written before codex is configured');
});


// useProjectRepo as the entrypoint has it, with GitHub swapped for a folder of bare repos and the credential helper
// for a no-op, in a HOME of its own.
function useProjectRepo({ projectRepo, imageOrigin }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-project-repo-'));
  const remotes = path.join(tmp, 'remotes');
  const git = (args, cwd = tmp) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmp, GIT_CONFIG_NOSYSTEM: '1' } });
  for (const name of ['acme/app', 'acme/tools']) {
    const seed = path.join(tmp, 'seed', name);
    fs.mkdirSync(seed, { recursive: true });
    git(['init', '-q', '-b', 'main'], seed);
    fs.writeFileSync(path.join(seed, 'README.md'), `${name}\n`);
    git(['add', '.'], seed);
    git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'first'], seed);
    git(['clone', '-q', '--bare', seed, path.join(remotes, `${name}.git`)]);
  }
  const work = path.join(tmp, 'work');
  fs.mkdirSync(work);
  git(['clone', '-q', path.join(remotes, 'acme/app.git'), path.join(work, 'app')]);
  git(['remote', 'set-url', 'origin', `https://github.com/${imageOrigin}.git`], path.join(work, 'app'));
  const script = [
    'set -euo pipefail',
    'log() { echo "[woodshed] $*"; }',
    'die() { log "ERROR: $*"; exit 1; }',
    'configureGitCredentials() { log "credentials"; }',
    // The default project's env files' secrets, as project.mjs names them from the image's checkout.
    'project() { [ "$1" = secret-vars ] && [ "$REPO_DIR" = "$IMAGE_DIR" ] && echo API_ENV; }',
    fn('useProjectRepo').replace('"https://github.com/$PROJECT_REPO.git"', `"${remotes}/$PROJECT_REPO.git"`),
    fn('withholdInstallationSecrets'),
    'useProjectRepo',
    'echo "secrets: npm=${NPM_TOKEN:-unset} api=${API_ENV:-unset} other=${OTHER_VAR:-unset}"',
    'echo "session link: ${SESSION_URL:-unset}"',
    'echo "REPO_DIR=$REPO_DIR"',
    'git -C "$REPO_DIR" log -1 --format=%s',
    'cat "$REPO_DIR/README.md"',
  ].join('\n');
  try {
    const run = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH, HOME: tmp, GIT_CONFIG_NOSYSTEM: '1', REPO_DIR: path.join(work, 'app'), IMAGE_DIR: path.join(work, 'app'),
        WOODSHED_INSTALL_SECRETS: 'NPM_TOKEN', NPM_TOKEN: 'npm-s3cret', API_ENV: 'api-s3cret', OTHER_VAR: 'kept',
        SESSION_URL: 'https://console.example/s/0a1b2c3d',
        ...(projectRepo ? { PROJECT_REPO: projectRepo } : {}),
      },
    });
    return { ...run, work };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('a session on another project clones its repo next to the image\'s checkout and works there', () => {
  const run = useProjectRepo({ projectRepo: 'acme/tools', imageOrigin: 'acme/app' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Cloning the project's repo \(repo: acme\/tools, image: acme\/app\)/);
  assert.match(run.stdout, new RegExp(`REPO_DIR=${run.work}/tools\\n`));
  assert.match(run.stdout, /acme\/tools\n$/, 'the project\'s own files');
  assert.match(run.stdout, /Installation secrets withheld \(another project\) \(variables: NPM_TOKEN API_ENV\)/);
  assert.match(run.stdout, /secrets: npm=unset api=unset other=kept/, 'the installation\'s install and env file secrets are gone');
  assert.doesNotMatch(run.stdout, /s3cret/, 'no value is ever printed');
  assert.match(run.stdout, /session link: https:\/\/console\.example\/s\/0a1b2c3d/, 'the project file decides the link, in writeRules');
});

test('a session on the image\'s own repo, or with no project named, keeps the image\'s checkout', () => {
  for (const projectRepo of [null, 'ACME/App']) {
    const run = useProjectRepo({ projectRepo, imageOrigin: 'acme/app' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, new RegExp(`REPO_DIR=${run.work}/app\\n`), String(projectRepo));
    assert.doesNotMatch(run.stdout, /Cloning|withheld/);
    assert.match(run.stdout, /secrets: npm=npm-s3cret api=api-s3cret/, 'the default project keeps them, as before');
    assert.match(run.stdout, /session link: https:\/\/console\.example\/s\/0a1b2c3d/, 'and links the session from its pull requests');
  }
});

test('a project whose repo has the image\'s folder name is cloned beside it, not over it', () => {
  const run = useProjectRepo({ projectRepo: 'acme/app', imageOrigin: 'other/app' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, new RegExp(`REPO_DIR=${run.work}/app-project\\n`));
});

// checkoutBranch as the entrypoint has it, on a clone of a repo with or without a submodule, as an image's checkout is:
// cloned with no submodule fetched. Local remotes stand in for GitHub; file:// submodules need git's leave to clone.
function checkoutWithSubmodule({ withSubmodule }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-submodule-'));
  const env = {
    PATH: process.env.PATH, HOME: tmp, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always',
  };
  const git = (args, cwd = tmp) => execFileSync('git', args, { cwd, encoding: 'utf8', env });
  const commit = (cwd, message) => git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', message], cwd);
  const lib = path.join(tmp, 'lib');
  fs.mkdirSync(lib);
  git(['init', '-q', '-b', 'main'], lib);
  fs.writeFileSync(path.join(lib, 'shared.mjs'), 'export const x = 1;\n');
  git(['add', '.'], lib);
  commit(lib, 'lib');
  const app = path.join(tmp, 'app');
  fs.mkdirSync(app);
  git(['init', '-q', '-b', 'main'], app);
  fs.writeFileSync(path.join(app, 'README.md'), 'app\n');
  if (withSubmodule) git(['submodule', 'add', '-q', lib, 'woodshed'], app);
  git(['add', '.'], app);
  commit(app, 'app');
  const remote = path.join(tmp, 'app.git');
  git(['clone', '-q', '--bare', app, remote]);
  const checkout = path.join(tmp, 'work');
  git(['clone', '-q', remote, checkout]);
  const script = [
    'set -euo pipefail',
    'log() { echo "[woodshed] $*"; }',
    fn('updateSubmodules'),
    fn('checkoutBranch'),
    'checkoutBranch',
    'ls woodshed 2>/dev/null || echo "no woodshed"',
  ].join('\n');
  try {
    return spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...env, REPO_DIR: checkout, BRANCH: 'woodshed/task-1', DEFAULT_BRANCH: 'main' } });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('a checkout with a submodule gets it at the commit\'s pin, and one without is left as before', () => {
  const withIt = checkoutWithSubmodule({ withSubmodule: true });
  assert.equal(withIt.status, 0, withIt.stderr);
  assert.match(withIt.stdout, /Submodules checked out/);
  assert.match(withIt.stdout, /shared\.mjs/, 'the submodule\'s files are there');

  const without = checkoutWithSubmodule({ withSubmodule: false });
  assert.equal(without.status, 0, without.stderr);
  assert.doesNotMatch(without.stdout, /Submodules/);
  assert.match(without.stdout, /no woodshed/);
});

test('writeOwnFiles writes the owner\'s files git ignores, logs what it skipped, and deletes the JSON', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-own-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['-C', repo, 'init', '-q']);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.env*\n');
  const json = path.join(dir, 'own-files.json');
  fs.writeFileSync(json, JSON.stringify({ 'app/.env.production': 'NOTION_TOKEN=x\n', 'notes.txt': 'not ignored' }));
  const script = ['set -euo pipefail', 'log() { echo "[woodshed] $*"; }', `SESSION_DIR=${SESSION_DIR}`, `REPO_DIR=${repo}`, `OWN_FILES_JSON=${json}`, fn('writeOwnFiles'), 'writeOwnFiles'].join('\n');
  const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
  assert.equal(out, '[woodshed] WARNING: some of the owner\'s own files were not written (written: app/.env.production, skipped: notes.txt (git does not ignore it))\n');
  assert.equal(fs.readFileSync(path.join(repo, 'app/.env.production'), 'utf8'), 'NOTION_TOKEN=x\n');
  assert.equal(fs.existsSync(path.join(repo, 'notes.txt')), false);
  assert.equal(fs.existsSync(json), false);
  assert.equal(execFileSync('bash', ['-c', script], { encoding: 'utf8' }), '', 'nothing to write without the JSON');
});
