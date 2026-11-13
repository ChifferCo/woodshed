import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ownFilePathProblem } from './ownFiles.mjs';

test('an own file is a plain path inside the repo, outside .git', () => {
  for (const ok of ['app/.env.production', '.env', 'tools/mcp/config.json', 'a/b-c_d@e+f.txt']) assert.equal(ownFilePathProblem(ok), null, ok);
  for (const bad of ['', '  ', '/etc/passwd', '~/.ssh/config', '../up', 'a/../b', './a', 'a//b', 'a/', '.git/hooks/pre-commit', '.git', 'a b', 'a\nb', 'a;b', 42, null, 'x'.repeat(201)]) {
    assert.ok(ownFilePathProblem(bad), JSON.stringify(bad));
  }
});
