import { test } from 'node:test';
import assert from 'node:assert/strict';

import { missingPlugins } from './missingPlugins.mjs';

const CACHE = '/home/node/.claude/plugins/cache';

test('a plugin the home lists but whose files it left behind is installed again', () => {
  const installed = {
    version: 2,
    plugins: {
      'slack@anthropic-plugin-directory': [{ scope: 'user', installPath: `${CACHE}/anthropic-plugin-directory/slack/1.5.0` }],
      'figma@claude-plugins-official': [{ scope: 'user', installPath: `${CACHE}/claude-plugins-official/figma/2.0.0` }],
      'mongodb@claude-plugins-official': [{ scope: 'project', projectPath: '/work/app', installPath: `${CACHE}/claude-plugins-official/mongodb/1.0.0` }],
      'context7@claude-plugins-official': [{ scope: 'project', projectPath: '/home/someone/else', installPath: `${CACHE}/claude-plugins-official/context7/1.0.0` }],
    },
  };
  const present = new Set([`${CACHE}/claude-plugins-official/figma/2.0.0`]);
  assert.deepEqual(missingPlugins(installed, { repoDir: '/work/app', exists: (p) => present.has(p) }),
    [{ id: 'slack@anthropic-plugin-directory', scope: 'user' }, { id: 'mongodb@claude-plugins-official', scope: 'project' }],
    'a user install or this repo\'s, in the scope it was in; not one with its files or one for another project');
});

test('an id that is not plugin@marketplace, or a list that is not one, puts nothing back', () => {
  const installed = { plugins: { '$(rm -rf ~)@x': [{ scope: 'user', installPath: '/gone' }], 'ok@m': 'not a list' } };
  assert.deepEqual(missingPlugins(installed, { repoDir: '/work/app', exists: () => false }), []);
  assert.deepEqual(missingPlugins(null, { repoDir: '/work/app' }), []);
});
