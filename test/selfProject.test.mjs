import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { parseProject } from '../shared/project.mjs';
import { parseYaml } from '../shared/yamlLite.mjs';

// Woodshed's own .woodshed/: nothing reads it while Woodshed is inside another repo, so this is what keeps it right for when
// woodshed/ is a repo of its own.
const WOODSHED = path.resolve(import.meta.dirname, '..');
const DOT = path.join(WOODSHED, '.woodshed');

test('Woodshed\'s project file parses, with no dependencies, databases or app, and its rules file is there', () => {
  const project = parseProject(parseYaml(fs.readFileSync(path.join(DOT, 'project.yaml'), 'utf8')));
  assert.deepEqual([project.dependencies, project.envFiles, project.databases, project.app, project.pullRequests],
    [{ installs: [] }, [], [], null, null]);
  assert.equal(project.editor, true);
  assert.equal(project.rules, '.woodshed/rules.md');
  assert.ok(fs.existsSync(path.join(WOODSHED, project.rules)), 'rules is a path from what will be the repo root');
});
