import { test } from 'node:test';
import assert from 'node:assert/strict';

import { marketplaceArg, pluginsToInstall } from './syncedPlugins.mjs';

test('a session adds a marketplace from GitHub or a plain https URL, never a folder, a pinned ref or a URL with a sign-in', () => {
  assert.equal(marketplaceArg({ source: 'github', repo: 'acme/claude-tools' }), 'acme/claude-tools');
  assert.equal(marketplaceArg({ source: 'git', url: 'https://gitlab.example.com/acme/tools.git' }), 'https://gitlab.example.com/acme/tools.git');
  assert.equal(marketplaceArg({ source: 'url', url: 'https://example.com/marketplace.json' }), 'https://example.com/marketplace.json');
  for (const source of [
    { source: 'directory', path: '/Users/mia/plugins' },
    { source: 'github', repo: 'acme/tools', ref: 'v2' },
    { source: 'github', repo: '--upload-pack=evil/x' },
    { source: 'git', url: 'https://mia:not-a-token@gitlab.example.com/acme/tools.git' },
    { source: 'url', url: 'https://example.com/m.json?token=abc' },
    { source: 'git', url: 'git@github.com:acme/tools.git' },
    { source: 'git', url: 'http://example.com/x.git' },
    null,
  ]) assert.equal(marketplaceArg(source), null, JSON.stringify(source));
});

test('the plugins to install are the synced ones this home lacks, never offered, never turned off', () => {
  const item = (repo) => JSON.stringify({ marketplace: { source: 'github', repo } });
  const synced = {
    '.claude/plugins/installed_plugins.json#plugins/a@acme': item('acme/a'),
    '.claude/plugins/installed_plugins.json#plugins/b@acme': item('acme/a'),
    '.claude/plugins/installed_plugins.json#plugins/c@acme': item('acme/a'),
    '.claude/plugins/installed_plugins.json#plugins/d@acme': item('acme/a'),
    '.claude/plugins/installed_plugins.json#plugins/e@known': JSON.stringify({ marketplace: null }),
    '.claude/plugins/installed_plugins.json#plugins/f@gone': JSON.stringify({ marketplace: null }),
    '.claude/plugins/installed_plugins.json#plugins/g@anthropic-plugin-directory': JSON.stringify({ marketplace: null }),
    '.claude/plugins/installed_plugins.json#plugins/h@claude-plugins-official': JSON.stringify({ marketplace: { source: 'github', repo: 'anthropics/claude-plugins-official' } }),
    '.claude/settings.json': 'e30=',
  };
  assert.deepEqual(pluginsToInstall({
    synced, installed: { plugins: { 'a@acme': [{ scope: 'user' }] } }, settings: { enabledPlugins: { 'b@acme': false } }, offered: ['c@acme'],
    known: { known: { source: { source: 'github', repo: 'k/k' } } },
  }), [
    { id: 'd@acme', add: 'acme/a' }, { id: 'e@known', add: null }, { id: 'f@gone', add: null, skip: true },
    { id: 'g@anthropic-plugin-directory', add: null }, { id: 'h@claude-plugins-official', add: 'anthropics/claude-plugins-official' },
  ], 'a marketplace this home knows is not added again; one claude has built in needs no source');
});

test('a home\'s plugins go with their marketplace\'s carriable shape alone: a folder\'s path or a URL\'s sign-in never leaves it', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { pluginItems } = await import('./settingsSync.mjs');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'woodshed-plugin-items-'));
  try {
    await fs.mkdir(path.join(home, '.claude/plugins'), { recursive: true });
    const user = [{ scope: 'user', installPath: '/x' }];
    await fs.writeFile(path.join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'a@gh': user, 'b@folder': user, 'c@private': user } }));
    await fs.writeFile(path.join(home, '.claude/plugins/known_marketplaces.json'), JSON.stringify({
      gh: { source: { source: 'github', repo: 'acme/tools' }, installLocation: '/x' },
      folder: { source: { source: 'directory', path: '/Users/mia/plugins' } },
      private: { source: { source: 'git', url: 'https://mia:not-a-token@git.example.com/tools.git' } },
    }));
    const items = await pluginItems(home);
    assert.deepEqual(Object.values(items).map((v) => JSON.parse(v).marketplace), [{ source: 'github', repo: 'acme/tools' }, { source: 'directory' }, { source: 'git' }]);
    assert.ok(!JSON.stringify(items).includes('not-a-token') && !JSON.stringify(items).includes('/Users/mia'));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
