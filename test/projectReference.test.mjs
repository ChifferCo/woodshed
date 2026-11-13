import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { PROJECT_FIELDS, parseProject } from '../shared/project.mjs';
import { parseYaml } from '../shared/yamlLite.mjs';

// project.reference.yaml is the documentation of every field a repo may write: it must parse, and name each field the
// parser knows, in every section, so a field added to the parser cannot go undocumented.
const REFERENCE = path.resolve(import.meta.dirname, '../project.reference.yaml');

// `apps` is written commented out, since a file may not have it beside `app`: the block uncommented, as a file of its own.
function appsBlock(text) {
  const block = /^# apps:\n(?:# .*\n|#\n)+/m.exec(text)?.[0];
  assert.ok(block, 'the reference writes an apps block');
  return parseYaml(block.replace(/^# ?/gm, '')).apps;
}

test('the reference project file parses, and writes every field of every section', () => {
  const text = fs.readFileSync(REFERENCE, 'utf8');
  const raw = parseYaml(text);
  parseProject(raw);
  const apps = appsBlock(text);
  const { app, ...rest } = raw;
  assert.deepEqual(parseProject({ ...rest, apps }).apps.map((a) => a.name), ['web', 'admin'], 'the apps block parses too');
  const sections = {
    '': { ...raw, apps }, dependencies: raw.dependencies, 'dependencies.installs': raw.dependencies.installs[0], envFiles: raw.envFiles[0], databases: raw.databases[0], 'databases.migrationsTable': raw.databases[0].migrationsTable, 'databases.dump': raw.databases[0].dump, app: raw.app, apps: apps[0], pullRequests: raw.pullRequests,
    'pullRequests.review': raw.pullRequests.review, 'pullRequests.suites': raw.pullRequests.suites[0],
    'pullRequests.qa': raw.pullRequests.qa, 'pullRequests.mergeRisk': raw.pullRequests.mergeRisk,
    'pullRequests.autoMerge': raw.pullRequests.autoMerge,
  };
  assert.deepEqual(Object.keys(sections).sort(), Object.keys(PROJECT_FIELDS).sort(), 'every section the parser has');
  for (const [section, fields] of Object.entries(PROJECT_FIELDS)) {
    assert.deepEqual(Object.keys(sections[section]).sort(), [...fields].sort(), section || 'the file');
  }
});
