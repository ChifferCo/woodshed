import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { loadProjects } from '../../console/projects.mjs';

// No test here runs terraform, so these read the Terraform as text: the projects variable reaches the console as
// WOODSHED_CLOUD_PROJECTS only when it is set, in a form the console's own parser takes.
const DIR = path.join(import.meta.dirname, 'terraform');
const read = (file) => fs.readFileSync(path.join(DIR, file), 'utf8');

test('the console gets WOODSHED_CLOUD_PROJECTS only when projects is set, quoted for YAML', () => {
  const stack = read('baseBoxStack.sh.tftpl');
  assert.match(stack, / {6}- WOODSHED_CLOUD_REPO=\$\{repo\}\n%\{ if projects != "" ~\}\n {6}#[^\n]*\n {6}- \$\{jsonencode\("WOODSHED_CLOUD_PROJECTS=\$\{replace\(projects, "\$", "\$\$"\)\}"\)\}\n%\{ endif ~\}\n/);
  const box = read('baseBox.tf');
  assert.match(box, /projects_json = length\(var\.projects\) == 0 \? "" :/, 'no projects, no line');
  assert.match(box, / {4}projects {11}= local\.projects_json\n/);
});

test('the line the template writes is a YAML string the console reads back as the same projects', () => {
  // What projects_json and the template make of a two-project tfvars, as Terraform's jsonencode writes them.
  const json = `[${[
    JSON.stringify({ name: 'app', repo: 'acme/app', default: true }),
    JSON.stringify({ name: 'tools', repo: 'acme/tools', default: false, installationId: '42' }),
  ].join(',')}]`;
  const item = JSON.stringify(`WOODSHED_CLOUD_PROJECTS=${json.replaceAll('$', '$$')}`);
  const [key, value] = JSON.parse(item).split(/=(.*)/s);
  assert.equal(key, 'WOODSHED_CLOUD_PROJECTS');
  assert.deepEqual(loadProjects({ WOODSHED_CLOUD_PROJECTS: value, WOODSHED_CLOUD_REPO: 'acme/app' }), [
    { name: 'app', repo: 'acme/app', default: true },
    { name: 'tools', repo: 'acme/tools', default: false, installationId: '42' },
  ]);
});

test('Terraform refuses the names the console refuses', () => {
  const tf = /can\(regex\("(\^\[a-z0-9\][^"]*)", p\.name\)\) && length\(p\.name\) <= (\d+)/.exec(read('variables.tf'));
  assert.ok(tf, 'the projects name validation');
  const console = /const NAME = \/(.*)\/;\nconst NAME_MAX = (\d+);/.exec(fs.readFileSync(path.join(import.meta.dirname, '../../console/projects.mjs'), 'utf8'));
  assert.deepEqual([tf[1], tf[2]], [console[1], console[2]]);
});
