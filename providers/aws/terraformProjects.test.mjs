import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { loadProjects } from '../../console/projects.mjs';

// No test here runs terraform, so these read the Terraform as text: the projects variable reaches the console as
// WOODSHED_PROJECTS only when it is set, in a form the console's own parser takes.
const DIR = path.join(import.meta.dirname, 'terraform');
const read = (file) => fs.readFileSync(path.join(DIR, file), 'utf8');

test('the console gets WOODSHED_PROJECTS only when projects is set, quoted for YAML', () => {
  const stack = read('baseBoxStack.sh.tftpl');
  assert.match(stack, / {6}- \$\{prefix\}REPO=\$\{repo\}\n%\{ endif ~\}\n%\{ if projects != "" ~\}\n {6}#[^\n]*\n {6}- \$\{jsonencode\("\$\{prefix\}PROJECTS=\$\{replace\(projects, "\$", "\$\$"\)\}"\)\}\n%\{ endif ~\}\n/);
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
  const item = JSON.stringify(`WOODSHED_PROJECTS=${json.replaceAll('$', '$$')}`);
  const [key, value] = JSON.parse(item).split(/=(.*)/s);
  assert.equal(key, 'WOODSHED_PROJECTS');
  assert.deepEqual(loadProjects({ WOODSHED_PROJECTS: value, WOODSHED_REPO: 'acme/app' }), [
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

test('without sessions_on_github_repo the console gets no WOODSHED_REPO, and may default to any project', () => {
  const vars = read('variables.tf');
  assert.match(vars, /variable "sessions_on_github_repo" \{[^}]*type {8}= bool\n {2}default {5}= true\n\}/, 'on by default: an installation that sets nothing keeps its repo');
  assert.match(vars, /condition {5}= length\(var\.projects\) == 0 \|\| !var\.sessions_on_github_repo \|\| anytrue/);
  assert.match(read('baseBox.tf'), / {4}repo {15}= var\.sessions_on_github_repo \? var\.github_repo : ""\n/);
  assert.match(read('baseBoxStack.sh.tftpl'), /%\{ if repo != "" ~\}\n {6}- \$\{prefix\}REPO=\$\{repo\}\n%\{ endif ~\}\n/);
  // The deploy workflow's roles and the image still come from github_repo.
  assert.match(read('github.tf'), /repo:\$\{var\.github_repo\}:environment:\$\{local\.p\}-images/);
});

test('the console\'s role makes, reads and deletes every repo\'s settings, beside people\'s and sessions\' own secrets', () => {
  const box = read('baseBox.tf');
  const statement = /sid = "PeoplesAndSessionsOwnSecrets"[\s\S]*?resources = \[([\s\S]*?)\]/.exec(box);
  assert.ok(statement, 'the statement is there');
  const resources = statement[1].match(/secret:\$\{local\.p\}\/[^"]+/g);
  assert.deepEqual(resources, ['secret:${local.p}/users/*', 'secret:${local.p}/sessions/*', 'secret:${local.p}/repos/*']);
  assert.match(box, /sid = "PeoplesAndSessionsOwnSecrets"\n {4}actions = \[\n {6}"secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:GetSecretValue",\n {6}"secretsmanager:DescribeSecret", "secretsmanager:DeleteSecret", "secretsmanager:TagResource",/);
});
