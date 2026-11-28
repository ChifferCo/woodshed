import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { MODES, modeFlags, runSettings } from './antigravitySettings.mjs';
import registry from '../shared/agents.cjs';

const repoDir = '/work/app';

test('every permission mode New session offers for Antigravity CLI has settings and flags', () => {
  assert.deepEqual([...MODES].sort(), [...registry.agent('antigravity').permissionModes].sort());
  for (const mode of MODES) assert.doesNotThrow(() => runSettings({ mode, team: true, repoDir }), mode);
  assert.throws(() => runSettings({ mode: 'bypass', team: true, repoDir }), /no permission mode/);
});

test('plan refuses edits in the checkout and default asks for each, which agy\'s own modes never do', () => {
  assert.deepEqual(runSettings({ mode: 'plan', team: true, repoDir }).permissions.deny, ['write_file(/work/app)']);
  assert.equal(runSettings({ mode: 'plan', team: true, repoDir }).permissions.ask, undefined);
  assert.deepEqual(runSettings({ mode: 'default', team: true, repoDir }).permissions.ask, ['write_file(/work/app)']);
  assert.equal(runSettings({ mode: 'default', team: true, repoDir }).permissions.deny, undefined);
  for (const mode of ['acceptEdits', 'auto']) {
    const { permissions } = runSettings({ mode, team: true, repoDir });
    assert.deepEqual(Object.keys(permissions), ['allow'], mode);
  }
});

test('every mode starts in agy\'s default mode and asks before a command: its own "auto" mode would not', () => {
  for (const mode of MODES) {
    const settings = runSettings({ mode, team: true, repoDir });
    assert.equal(settings.agentMode, '', mode);
    assert.equal(settings.toolPermission, 'request-review', mode);
  }
});

test('the team\'s key is the Gemini API provider, and the owner\'s own login is none', () => {
  assert.equal(runSettings({ mode: 'plan', team: true, repoDir }).modelProvider, 'gemini');
  assert.equal('modelProvider' in runSettings({ mode: 'plan', team: false, repoDir }), false);
});

test('Woodshed\'s own files are read without asking, and nothing else outside the checkout is', () => {
  const rules = runSettings({ mode: 'default', team: true, repoDir }).permissions.allow;
  assert.ok(rules.includes('read_file(/tmp/woodshed-deps)'));
  assert.ok(rules.every((rule) => /^read_file\(\/tmp\/[\w.-]+\)$/.test(rule)), rules.join(' '));
});

test('the flags of each mode are agy\'s own', () => {
  assert.deepEqual(modeFlags('auto'), ['--dangerously-skip-permissions']);
  assert.deepEqual(modeFlags('acceptEdits'), ['--mode', 'accept-edits']);
  assert.deepEqual(modeFlags('plan'), ['--mode', 'plan']);
  assert.deepEqual(modeFlags('default'), []);
});

test('run as a script it prints one run\'s settings, and refuses what it cannot read', () => {
  const script = fileURLToPath(new URL('./antigravitySettings.mjs', import.meta.url));
  const out = execFileSync('node', [script, 'plan', 'own', repoDir], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), runSettings({ mode: 'plan', team: false, repoDir }));
  assert.throws(() => execFileSync('node', [script, 'plan', 'nobody', repoDir], { stdio: 'pipe' }), /usage/);
});
