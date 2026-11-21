import assert from 'node:assert/strict';
import test from 'node:test';
import { windowsExecutable } from './windowsExecutable.mjs';

test('Windows checkout tools are selected by absolute path outside the checkout', () => {
  const repo = 'C:\\work\\repo';
  const install = 'C:\\Program Files\\Git\\cmd\\git.exe';
  const paths = new Map([
    [repo, repo],
    ['C:\\linked\\git.exe', repo + '\\bin\\git.exe'],
    [install, install],
  ]);
  const opts = { exclude: [repo], real: (file) => paths.get(file), searchPath: '.;bin;C:tools;\\rooted;C:\\work\\repo\\bin;C:\\linked' };
  assert.equal(windowsExecutable('git', opts), null);
  assert.equal(windowsExecutable('git', { ...opts, searchPath: opts.searchPath + ';"C:\\Program Files\\Git\\cmd"' }), install);
  assert.equal(windowsExecutable(install, opts), install);
});
