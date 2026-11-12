import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { instructionsText } from '../shared/repoSettings.mjs';
import { parseYaml } from '../shared/yamlLite.mjs';

// Golden files: the env files a session wrote, byte for byte, before env files had defaults or repo settings, for a
// project file of several apps (__fixtures__/repoSettings/multiApp.project.yaml) and project.reference.yaml. Their values
// come from the console's repo settings now, where a console of the release before copied them: written from those,
// the files must stay exactly these. UPDATE_GOLDEN=1 writes them again from the code as it is: do that only for a
// change that means to change what every session writes, and say so in its pull request.
const WOODSHED = path.resolve(import.meta.dirname, '..');
const FIXTURES = path.join(import.meta.dirname, '__fixtures__/repoSettings');
const PROJECT_MJS = path.join(WOODSHED, 'shared/project.mjs');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

const REFERENCE = fs.readFileSync(path.join(WOODSHED, 'project.reference.yaml'), 'utf8');

// The reference as a file from before `defaults` was a field: the same, with its env file's defaults taken out.
function withoutDefaults(text) {
  const raw = parseYaml(text);
  for (const file of raw.envFiles) delete file.defaults;
  return JSON.stringify(raw);
}

const PROJECTS = {
  multiApp: fs.readFileSync(path.join(FIXTURES, 'multiApp.project.yaml'), 'utf8'),
  reference: withoutDefaults(REFERENCE),
};

// What the entrypoint has exported by the time it writes the env files: the databases', a shared service's and the app's.
const SESSION_ENV = {
  PGHOST: '10.0.1.5', PGPASSWORD: 'session-password', PGDATABASE: 'woodshed__0a1b2c3d',
  PG_URL: 'postgres://woodshed__0a1b2c3d:session-password@10.0.1.5:5432/woodshed__0a1b2c3d',
  MONGODB_URI: 'mongodb://10.0.1.6:27017/woodshed__0a1b2c3d', SESSION_APP_URL: 'https://0a1b2c3d.app.example',
};
// The installation's text for each env file, as its secret's variable carried it before repo settings: comments, a
// blank line, a quoted value over several lines, and no newline at the end.
const LEGACY = {
  API_ENV: '# The api\'s shared values\nAUTH_DOMAIN=example.test\nAUTH_CLIENT_ID=abc123\n\nPRIVATE_KEY="-----BEGIN TEST KEY-----\nnot-a-real-key\n-----END TEST KEY-----"\nPORT=8000',
  WEB_ENV: 'NEXT_PUBLIC_AUTH_DOMAIN=example.test\nNEXT_PUBLIC_SKIP_LOGIN=false\n',
};
const OWN = { 'api-env': 'AUTH_CLIENT_ID=mine\nLOG_LEVEL=debug', 'web-env': 'NEXT_PUBLIC_SKIP_LOGIN=false' };

// No installation values at all; the installation's (a shared session); and a private session's, with its owner's
// lines. Each is the session's environment and the console's answer, the values in its repo settings.
const SCENARIOS = {
  bare: { env: SESSION_ENV, settings: answer({}, {}, null) },
  shared: { env: { ...SESSION_ENV, S3_ENDPOINT: 'http://10.0.1.7:4566' }, settings: answer(LEGACY, {}, null) },
  private: { env: SESSION_ENV, settings: answer(LEGACY, OWN, 'octocat') },
};

// The console's answer holding the legacy values under their keys (an env file's secret is its key).
function answer(installation, own, personalFor) {
  const byKey = Object.fromEntries(Object.entries(installation).map(([variable, text]) => [variable.toLowerCase().replace(/_/g, '-'), text]));
  const keys = [...new Set([...Object.keys(byKey), ...Object.keys(own)])];
  return {
    project: 'app', instructions: { installation: null, personal: null }, personalFor,
    envFiles: Object.fromEntries(keys.map((key) => [key, { installation: byKey[key] ?? null, personal: own[key] ?? null }])),
  };
}

const roots = [];
after(() => roots.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

/**
 * Runs `project.mjs write-env-files` on a checkout holding `text`, and returns what it printed and every file it wrote.
 * With `settings`, the console's repo settings answer, as the session hands it over in REPO_SETTINGS_FILE.
 */
function writeEnvFilesFor(text, env, settings = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-golden-'));
  roots.push(dir);
  fs.mkdirSync(path.join(dir, '.woodshed'));
  fs.writeFileSync(path.join(dir, '.woodshed/project.yaml'), text);
  const file = path.join(dir, 'repo-settings.json');
  if (settings) fs.writeFileSync(file, JSON.stringify(settings));
  const printed = execFileSync('node', [PROJECT_MJS, 'write-env-files'], { encoding: 'utf8', env: { PATH: process.env.PATH, REPO_DIR: dir, ...env, ...(settings && { REPO_SETTINGS_FILE: file }) } });
  const files = printed.split('\n')[0].split(/, (?=[^ ]+ \((?:base|layers))/).map((entry) => entry.split(' (')[0]);
  return [`printed: ${printed}`, ...files.map((file) => `==> ${file} <==\n${fs.readFileSync(path.join(dir, file), 'utf8')}`)].join('');
}

for (const [name, text] of Object.entries(PROJECTS)) {
  for (const [scenario, { env, settings }] of Object.entries(SCENARIOS)) {
    test(`${name}'s env files, ${scenario}, are written from repo settings byte for byte as before them`, () => {
      const golden = path.join(FIXTURES, `${name}.${scenario}.env.txt`);
      const written = writeEnvFilesFor(text, env, settings);
      if (UPDATE) fs.writeFileSync(golden, written);
      assert.equal(written, fs.readFileSync(golden, 'utf8'));
      assert.doesNotMatch(written, /WARNING/);
    });
  }
}

// The variables that carried the values before repo settings are not read any more: a session whose environment still
// held them, with a console that has nothing for the project or no answer at all, writes the bare files.
const filesOf = (written) => written.slice(written.indexOf('==> '));
for (const [name, text] of Object.entries(PROJECTS)) {
  test(`${name}'s env files read nothing from the old Terraform secrets\' variables or the old own lines`, () => {
    const bare = filesOf(fs.readFileSync(path.join(FIXTURES, `${name}.bare.env.txt`), 'utf8'));
    const old = { ...SESSION_ENV, ...LEGACY, OWN_FILES: JSON.stringify(OWN) };
    assert.equal(filesOf(writeEnvFilesFor(text, old, SCENARIOS.bare.settings)), bare, 'nothing in repo settings');
    const none = writeEnvFilesFor(text, old);
    assert.equal(filesOf(none), bare, 'no repo settings at all');
    assert.doesNotMatch(none, /WARNING|legacy/);
  });
}

// With its defaults, the reference's file starts with them, under their own header, and the rest is as before.
for (const [scenario, { env, settings }] of Object.entries(SCENARIOS)) {
  test(`the reference's env file, ${scenario}, starts with its defaults and is otherwise as before`, () => {
    const golden = path.join(FIXTURES, `referenceWithDefaults.${scenario}.env.txt`);
    const written = writeEnvFilesFor(REFERENCE, env, settings);
    if (UPDATE) fs.writeFileSync(golden, written);
    assert.equal(written, fs.readFileSync(golden, 'utf8'));
    const before = fs.readFileSync(path.join(FIXTURES, `reference.${scenario}.env.txt`), 'utf8');
    const defaults = '# From the repo (.woodshed/project.yaml)\nLOG_LEVEL=info\nFEATURE_SEARCH=false';
    const [printed, file] = written.split('==> api/.env <==\n');
    const [printedBefore, fileBefore] = before.split('==> api/.env <==\n');
    assert.equal(printed, printedBefore.replace('(layers: ', '(layers: repo ').replace(', installation: ', ', defaults: 2, installation: '), 'the log line counts them');
    assert.equal(file, fileBefore.startsWith('\n\n') ? `${defaults}${fileBefore}` : `${defaults}\n\n# From this installation\n${fileBefore}`);
  });
}

// The rules: the entrypoint's own writeRules, run on the project of several apps, is what a session gets with no repo
// settings, and instructionsText with none of them gives it back byte for byte.
const ENTRYPOINT = fs.readFileSync(path.join(WOODSHED, 'session/entrypoint.sh'), 'utf8');

function fn(name) {
  const at = ENTRYPOINT.indexOf(`\n${name}() {`);
  assert.ok(at >= 0, `${name} is in entrypoint.sh`);
  return ENTRYPOINT.slice(at + 1, ENTRYPOINT.indexOf('\n}\n', at) + 2);
}

function writeRules(kind) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-golden-rules-'));
  roots.push(repo);
  fs.mkdirSync(path.join(repo, '.woodshed'));
  fs.writeFileSync(path.join(repo, '.woodshed/project.yaml'), PROJECTS.multiApp);
  for (const file of ['rules.md', 'setup.md']) fs.copyFileSync(path.join(FIXTURES, file), path.join(repo, '.woodshed', file));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-golden-tmp-'));
  roots.push(tmp);
  const script = [
    'set -euo pipefail', 'log() { echo "[woodshed] $*"; }', 'die() { log "ERROR: $*"; exit 1; }',
    'project() { node "$SHARED_DIR/project.mjs" "$@"; }', fn('leaveOutConsoleLinks'), fn('writeRules').replaceAll('/tmp/', `${tmp}/`), 'writeRules',
  ].join('\n');
  execFileSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH, SESSION_DIR: path.join(WOODSHED, 'session'), SHARED_DIR: path.join(WOODSHED, 'shared'), REPO_DIR: repo,
      SESSION_KIND: kind, BRANCH: 'woodshed/fix-export', DEFAULT_BRANCH: 'main', STARTED_BY: 'octocat', SESSION_URL: 'https://console.example/s/0a1b2c3d',
    },
  });
  return fs.readFileSync(path.join(tmp, 'woodshed-rules.md'), 'utf8');
}

for (const kind of ['shared', 'private']) {
  test(`a ${kind} session's rules with no repo settings are byte for byte the entrypoint's`, () => {
    const rules = writeRules(kind);
    assert.match(rules, /Run `make check` before every push/, 'the repo\'s rules are in it');
    assert.match(rules, /several apps/, 'and its apps');
    for (const none of [{}, { installation: '', personal: '' }, { installation: '\n', personal: '  \n' }, { personal: 'Mine.', login: null }]) {
      assert.equal(instructionsText({ rules, repoRules: true, repo: 'acme/app', ...none }), rules, JSON.stringify(none));
    }
    const layered = instructionsText({ rules, repoRules: true, repo: 'acme/app', installation: 'Use pnpm.', personal: 'Answer briefly.', login: 'octocat' });
    assert.ok(layered.startsWith(rules), 'the layers come after everything a session gets today, which is unchanged');
  });
}
