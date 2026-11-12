import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SETTINGS, bothNames, currentName, envValue, isSettingName, oldName } from './envNames.mjs';
import { isSessionVariable } from './reservedNames.mjs';

function capturingWarn(t) {
  const lines = [];
  t.mock.method(console, 'warn', (...args) => lines.push(args));
  return lines;
}

test('the new name is read over the old, and the old alone still works, said once a name without its value', (t) => {
  const warned = capturingWarn(t);
  assert.equal(envValue({ WOODSHED_IDLE_HOURS: '2', WOODSHED_CLOUD_IDLE_HOURS: '9' }, 'IDLE_HOURS'), '2');
  assert.deepEqual(warned, [], 'no warning while the new name is set');

  assert.equal(envValue({ WOODSHED_CLOUD_TRUSTED_IDENTITY_SECRET: 'the-secret-value' }, 'TRUSTED_IDENTITY_SECRET'), 'the-secret-value');
  assert.equal(envValue({ WOODSHED_CLOUD_TRUSTED_IDENTITY_SECRET: 'the-secret-value' }, 'TRUSTED_IDENTITY_SECRET'), 'the-secret-value');
  assert.deepEqual(warned, [['config: deprecated variable, use WOODSHED_TRUSTED_IDENTITY_SECRET', { name: 'WOODSHED_CLOUD_TRUSTED_IDENTITY_SECRET' }]]);
  assert.doesNotMatch(JSON.stringify(warned), /the-secret-value/);
});

test('an empty new name is set, and neither name is undefined', (t) => {
  capturingWarn(t);
  assert.equal(envValue({ WOODSHED_HOMES_BUCKET: '', WOODSHED_CLOUD_HOMES_BUCKET: 'old' }, 'HOMES_BUCKET'), '');
  assert.equal(envValue({}, 'HOMES_BUCKET'), undefined);
});

test('two renames keep off the names a session already has with another meaning', () => {
  assert.equal(currentName('INSTALL_SECRETS'), 'WOODSHED_INSTALL_SECRET_PAIRS');
  assert.equal(currentName('CONSOLE_URL'), 'WOODSHED_CONSOLE_WEB_URL');
  assert.equal(currentName('REPO'), 'WOODSHED_REPO');
  assert.equal(oldName('INSTALL_SECRETS'), 'WOODSHED_CLOUD_INSTALL_SECRETS');
  assert.equal(envValue({ WOODSHED_INSTALL_SECRETS: 'REGISTRY_TOKEN' }, 'INSTALL_SECRETS'), undefined, 'a session\'s list is not the console\'s pairs');
});

test('a name that is no setting is a mistake in the code, not an unset setting', () => {
  assert.throws(() => envValue({}, 'CONSOLE_NAMES'), /CONSOLE_NAMES is not one of Woodshed's settings/);
});

test('bothNames is what a console hands a session while older images read the old name', () => {
  assert.deepEqual(bothNames('PROJECT_FILES_DIR', '/x'), { WOODSHED_PROJECT_FILES_DIR: '/x', WOODSHED_CLOUD_PROJECT_FILES_DIR: '/x' });
});

test('isSettingName knows each setting by either name, and nothing else Woodshed sets', () => {
  for (const name of SETTINGS) {
    assert.ok(isSettingName(currentName(name)), name);
    assert.ok(isSettingName(oldName(name)), name);
  }
  for (const other of ['WOODSHED_PROVIDER', 'WOODSHED_LOCAL_SECRETS_DIR', 'WOODSHED_CONSOLE_URL', 'WOODSHED_INSTALL_SECRETS', 'PATH']) {
    assert.ok(!isSettingName(other), other);
  }
});

test('both names of every setting are Woodshed\'s own, so no install secret can arrive in one', () => {
  for (const name of SETTINGS) {
    assert.ok(isSessionVariable(currentName(name)), currentName(name));
    assert.ok(isSessionVariable(oldName(name)), oldName(name));
  }
});
