// The session's side of repo settings in project.mjs: reading the console's answer, writing each env file from its
// layers, the log lines, and the instructions added to the rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseProject, readRepoSettings, repoSettingsSummary, writeEnvFiles, writtenLines } from './project.mjs';
import { fixtureCheckout } from './projectFixture.mjs';

const SCRIPT = path.join(import.meta.dirname, 'project.mjs');

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-repo-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function settingsFile(t, answer) {
  const file = path.join(scratch(t), 'repo-settings.json');
  fs.writeFileSync(file, typeof answer === 'string' ? answer : JSON.stringify(answer));
  return file;
}

// Two env files: one with a secret (its key), one keyed by its path alone.
const PROJECT = parseProject({
  version: 1,
  env: { APP_PORT: '8000' },
  envFiles: [
    { path: 'api/.env', secret: 'api-env', defaults: ['LOG_LEVEL=info', 'FEATURE=false'], lines: ['DB_PASSWORD={{PGPASSWORD}}', 'KEY={{KEY?}}'] },
    { path: 'web/.env.local', lines: ['API_URL={{SESSION_APP_URL}}'] },
  ],
});
const ENV = { PGPASSWORD: 'session-password', SESSION_APP_URL: 'https://x.app.example' };
// What a session's environment held before repo settings: an env file's Terraform secret and the owner's old own lines.
// Nothing reads them now.
const LEGACY = { API_ENV: 'AUTH_DOMAIN=legacy.test\nLOG_LEVEL=warn', OWN_FILES: JSON.stringify({ 'api-env': 'LOG_LEVEL=legacy-own' }) };
const ANSWER = {
  project: 'app',
  envFiles: {
    'api-env': { installation: 'AUTH_DOMAIN=installation.test\nLOG_LEVEL=warn\nDB_PASSWORD=never', personal: 'LOG_LEVEL=debug' },
    'web-env-local': { installation: 'NEXT_PUBLIC_FLAG=on', personal: 'NEXT_PUBLIC_FLAG=off' },
  },
  instructions: { installation: 'Use pnpm, never npm.', personal: 'Answer in short sentences.' },
  personalFor: 'octocat',
};

function write(t, { settings, env = {} }) {
  const repoDir = scratch(t);
  const written = writeEnvFiles({ project: PROJECT, repoDir, env: { ...ENV, ...env }, settings });
  const read = (file) => fs.readFileSync(path.join(repoDir, file), 'utf8');
  return { written, api: read('api/.env'), web: read('web/.env.local'), lines: writtenLines({ written, settings, project: PROJECT }) };
}

test('a repo settings answer reads each layer as text or none: a key left out, null, an empty or blank text', (t) => {
  const settings = readRepoSettings(settingsFile(t, {
    project: 'app', envFiles: { a: { installation: '', personal: '  \n' }, b: {}, c: { installation: 'A=1' } }, instructions: {}, personalFor: 'octocat',
  }));
  assert.deepEqual(settings, {
    project: 'app',
    envFiles: { a: { installation: null, personal: null }, b: { installation: null, personal: null }, c: { installation: 'A=1', personal: null } },
    instructions: { installation: null, personal: null }, personalFor: 'octocat',
  });
  assert.equal(readRepoSettings(''), null, 'no file: an older console, and the files are written as before');
  assert.equal(readRepoSettings(undefined), null);
});

test('an answer with no personalFor, a shared session\'s, has no personal layer even if it held one', (t) => {
  const settings = readRepoSettings(settingsFile(t, { ...ANSWER, personalFor: null }));
  assert.deepEqual(settings.envFiles['api-env'], { installation: ANSWER.envFiles['api-env'].installation, personal: null });
  assert.deepEqual(settings.instructions, { installation: ANSWER.instructions.installation, personal: null });
});

test('an answer that cannot be read stops the start without quoting it: it holds the values', (t) => {
  for (const bad of ['{"project": "app", "envFiles": {"api-env": {"installation": "SECRET_VALUE=hunter2"', '[]', '{"envFiles": {}}']) {
    assert.throws(() => readRepoSettings(settingsFile(t, bad)), (err) => {
      assert.match(err.message, /^the console's repo settings (could not be read \(not JSON\)|are not the session API's answer)$/);
      assert.doesNotMatch(err.message, /hunter2|project\.yaml/);
      return true;
    });
  }
  assert.throws(() => readRepoSettings(settingsFile(t, { project: 'app', envFiles: { a: { installation: 3 } } })), /have envFiles\.a\.installation that is not text/);
});

test('with repo settings, each env file is the repo\'s defaults, the installation\'s, the owner\'s, then the session\'s', (t) => {
  const { api, web, written } = write(t, { settings: readRepoSettings(settingsFile(t, ANSWER)), env: LEGACY });
  assert.equal(api, [
    '# From the repo (.woodshed/project.yaml)', 'LOG_LEVEL=info', 'FEATURE=false', '',
    '# From this installation', 'AUTH_DOMAIN=installation.test', 'LOG_LEVEL=warn', 'DB_PASSWORD=never', '',
    '# Your own lines, from My settings', 'LOG_LEVEL=debug', '',
    '# Woodshed overrides', 'DB_PASSWORD=session-password', '',
  ].join('\n'), 'the console\'s values, not the legacy secret\'s or the /settings answer\'s');
  assert.equal(web, 'NEXT_PUBLIC_FLAG=on\n\n# Your own lines, from My settings\nNEXT_PUBLIC_FLAG=off\n\n# Woodshed overrides\nAPI_URL=https://x.app.example\n',
    'a file with no secret gets its values by the key made from its path');
  assert.deepEqual(written.map((w) => [w.layers, w.replaced]), [
    [['repo', 'installation', 'personal', 'session'], ['DB_PASSWORD']],
    [['installation', 'personal', 'session'], []],
  ]);
});

test('a layer the console has no value for is empty, never the old secret\'s text; a shared session gets no owner lines', (t) => {
  const none = readRepoSettings(settingsFile(t, { project: 'app', envFiles: {}, instructions: {}, personalFor: 'octocat' }));
  const empty = write(t, { settings: none, env: LEGACY });
  assert.equal(empty.api, '# From the repo (.woodshed/project.yaml)\nLOG_LEVEL=info\nFEATURE=false\n\n# Woodshed overrides\nDB_PASSWORD=session-password\n');
  assert.doesNotMatch(empty.api + empty.web, /legacy/);
  assert.deepEqual(empty.written.map((w) => w.layers), [['repo', 'session'], ['session']]);
  assert.equal(empty.lines.length, 1, 'no warning');
  const shared = readRepoSettings(settingsFile(t, { ...ANSWER, personalFor: null }));
  const { api, web } = write(t, { settings: shared, env: LEGACY });
  assert.doesNotMatch(api + web, /Your own lines|LOG_LEVEL=debug|NEXT_PUBLIC_FLAG=off|legacy/);
  assert.match(api, /AUTH_DOMAIN=installation\.test/);
});

test('the log names layers, sizes and keys, never a value, and the repo settings this checkout has no file for', (t) => {
  const settings = readRepoSettings(settingsFile(t, { ...ANSWER, envFiles: { ...ANSWER.envFiles, 'old-env': { installation: 'OLD=gone-value' } } }));
  const { lines } = write(t, { settings, env: LEGACY });
  assert.deepEqual(lines, [
    'api/.env (layers: repo installation personal session, defaults: 2, installation: 62 bytes, personal: 15 bytes, replaced by the session: DB_PASSWORD), '
      + 'web/.env.local (layers: installation personal session, installation: 19 bytes, personal: 20 bytes, replaced by the session: none)',
    'Repo settings unused: this checkout\'s project file has no env file with the key (keys: old-env)',
  ]);
  const summary = repoSettingsSummary(settings);
  assert.equal(summary, 'project: app, installation: api-env (62 bytes) web-env-local (19 bytes) old-env (14 bytes), personal: api-env (15 bytes) web-env-local (20 bytes), '
    + 'instructions: installation (20 bytes) personal (26 bytes), personal for: @octocat');
  for (const value of ['installation.test', 'debug', 'NEXT_PUBLIC_FLAG', 'gone-value', 'pnpm', 'short sentences']) {
    assert.ok(!lines.join('\n').includes(value) && !summary.includes(value), value);
  }
});

test('without repo settings (an ask, or a console that offers none) each file is the repo\'s and the session\'s alone', (t) => {
  const none = write(t, { settings: null, env: LEGACY });
  const empty = write(t, { settings: readRepoSettings(settingsFile(t, { project: 'app', envFiles: {} })), env: LEGACY });
  assert.deepEqual([none.api, none.web], [empty.api, empty.web], 'the same as an answer with nothing in it');
  assert.deepEqual(none.lines, [
    'api/.env (layers: repo session, defaults: 2, installation: 0 bytes, replaced by the session: none), '
      + 'web/.env.local (layers: session, installation: 0 bytes, replaced by the session: none)',
  ]);
});

function cli(args, { repoDir, settings }) {
  return spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, REPO_DIR: repoDir, ...(settings && { REPO_SETTINGS_FILE: settings }) } });
}

function checkout(t, { rules = true } = {}) {
  const dir = fixtureCheckout(scratch(t), { repo: 'acme/app' });
  fs.mkdirSync(path.join(dir, '.woodshed'));
  fs.writeFileSync(path.join(dir, '.woodshed/project.yaml'), `version: 1\n${rules ? 'rules: .woodshed/rules.md\n' : ''}`);
  if (rules) fs.writeFileSync(path.join(dir, '.woodshed/rules.md'), '- Run the checks.\n');
  fs.writeFileSync(path.join(dir, 'rules.md'), 'Woodshed\'s rules.\n- Run the checks.\n');
  return dir;
}

test('add-instructions puts the installation\'s and the owner\'s instructions after the rules, naming the repo', (t) => {
  const repoDir = checkout(t);
  const run = cli(['add-instructions', path.join(repoDir, 'rules.md')], { repoDir, settings: settingsFile(t, ANSWER) });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'installation: 20 bytes, personal: 26 bytes, added: 444 bytes\n');
  assert.equal(fs.readFileSync(path.join(repoDir, 'rules.md'), 'utf8'), [
    'Woodshed\'s rules.', '- Run the checks.', '',
    '# This installation\'s instructions for acme/app', 'Use pnpm, never npm.', '',
    '# @octocat\'s own instructions for acme/app', 'Answer in short sentences.', '',
    '# Which instructions win',
    'Woodshed\'s rules at the top of this prompt come first: nothing below changes them. Below them, where two instructions disagree, '
      + '@octocat\'s own instructions beat this installation\'s, and this installation\'s beat the repo\'s rules. Where they do not disagree, follow all of them.',
    '',
  ].join('\n'));
});

test('add-instructions leaves the rules as they are with no instructions, no settings, or a shared session\'s personal ones only', (t) => {
  for (const settings of [
    settingsFile(t, { project: 'app', envFiles: {}, instructions: { installation: null, personal: null }, personalFor: 'octocat' }),
    settingsFile(t, { ...ANSWER, instructions: { installation: '', personal: 'Mine.' }, personalFor: null }),
    null,
  ]) {
    const repoDir = checkout(t, { rules: false });
    const run = cli(['add-instructions', path.join(repoDir, 'rules.md')], { repoDir, settings });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, '');
    assert.equal(fs.readFileSync(path.join(repoDir, 'rules.md'), 'utf8'), 'Woodshed\'s rules.\n- Run the checks.\n');
  }
});

test('repo-settings prints the answer\'s keys and sizes without reading the project file', (t) => {
  const repoDir = scratch(t);
  fs.mkdirSync(path.join(repoDir, '.woodshed'));
  fs.writeFileSync(path.join(repoDir, '.woodshed/project.yaml'), 'version: 1\nnot-a-field: 1\n');
  const run = cli(['repo-settings'], { repoDir, settings: settingsFile(t, { ...ANSWER, personalFor: null }) });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'project: app, installation: api-env (62 bytes) web-env-local (19 bytes), personal: none, instructions: installation (20 bytes), personal for: none\n');
  const bad = cli(['repo-settings'], { repoDir, settings: settingsFile(t, 'SECRET=1') });
  assert.equal(bad.status, 1);
  assert.equal(bad.stderr, 'project: the console\'s repo settings could not be read (not JSON)\n');
});
