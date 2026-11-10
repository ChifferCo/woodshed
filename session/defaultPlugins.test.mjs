import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PLUGINS, defaultPluginsToInstall, withOffered } from './defaultPlugins.mjs';

test('a fresh home gets every default plugin', () => {
  assert.deepEqual(defaultPluginsToInstall(null, null, null), DEFAULT_PLUGINS);
  assert.ok(DEFAULT_PLUGINS.includes('slack@anthropic-plugin-directory'));
});

test('a plugin already installed, or one its owner turned off, is left alone', () => {
  const wanted = ['slack@anthropic-plugin-directory', 'figma@claude-plugins-official', 'linear@claude-plugins-official'];
  const installed = { version: 2, plugins: { 'slack@anthropic-plugin-directory': [{ scope: 'user' }] } };
  const settings = { enabledPlugins: { 'figma@claude-plugins-official': false } };
  assert.deepEqual(defaultPluginsToInstall(installed, settings, null, wanted), ['linear@claude-plugins-official']);
});

test('a default offered before is not installed again after its owner uninstalled it', () => {
  assert.deepEqual(defaultPluginsToInstall({ plugins: {} }, {}, ['slack@anthropic-plugin-directory'], ['slack@anthropic-plugin-directory']), []);
  assert.deepEqual(withOffered(null, 'a@m'), ['a@m']);
  assert.deepEqual(withOffered(['a@m', 7], 'a@m'), ['a@m'], 'kept once, and only text');
});
