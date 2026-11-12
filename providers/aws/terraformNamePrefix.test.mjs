import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../../console/config.mjs';
import { awsProvider } from './index.mjs';

// No test here runs terraform, so these read the Terraform as text, as terraformProjects.test.mjs does, and render the
// prefix into it the way Terraform would. __fixtures__/terraformNames.json is every line that named woodshed-cloud
// before name_prefix existed, comments in .tf files left out: an installation that sets name_prefix = "woodshed-cloud"
// must get each of them back, byte for byte, or its plan would rename what it has.
const DIR = path.join(import.meta.dirname, 'terraform');
const read = (file) => fs.readFileSync(path.join(DIR, file), 'utf8');
const BEFORE = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '__fixtures__', 'terraformNames.json'), 'utf8'));
const OLD = 'woodshed-cloud';

// The console's state folder inside its container is the image's own (console/Dockerfile), not the box's.
const CONTAINER_PATH = /(?<=STATE_DIR=\/var\/lib\/|:\/var\/lib\/)woodshed-cloud$/;

// The locals the names are made of, with tfstate_bucket and tfstate_key left unset, as an installation leaves them.
function locals(prefix) {
  return {
    p: prefix,
    tfstate_bucket: `${prefix}-tfstate-\${local.account_id}`,
    tfstate_key: `${prefix}/terraform.tfstate`,
  };
}

function render(file, prefix) {
  const text = read(file);
  if (file.endsWith('.tftpl')) return text.replaceAll('${name_prefix}', prefix);
  let out = text;
  for (const [name, value] of Object.entries(locals(prefix))) {
    out = out.replaceAll(`\${local.${name}}`, value).replace(new RegExp(`(?<![\\w.{])local\\.${name}\\b`, 'g'), JSON.stringify(value));
  }
  return out;
}

const renderedLines = (file, prefix) => new Set(render(file, prefix).split('\n'));
// A .tf comment or a variable's description names nothing.
const isProse = (file, line) => !file.endsWith('.tftpl') && /^\s*(#|description\s*=)/.test(line);

test('the locals the names are rendered from are the Terraform\'s own', () => {
  const vars = read('variables.tf');
  assert.match(vars, /\nlocals \{\n {2}p = var\.name_prefix\n\}\n/);
  assert.match(vars, /variable "tfstate_bucket" \{[^}]*default {5}= ""\n\}/);
  assert.match(vars, /variable "tfstate_key" \{[^}]*default {5}= ""\n\}/);
  const infra = read('githubInfra.tf');
  assert.match(infra, / {2}tfstate_bucket = coalesce\(var\.tfstate_bucket, "\$\{local\.p\}-tfstate-\$\{local\.account_id\}"\)\n/);
  assert.match(infra, / {2}tfstate_key {4}= coalesce\(var\.tfstate_key, "\$\{local\.p\}\/terraform\.tfstate"\)\n/);
  // Every template that names something is given the prefix.
  assert.match(read('baseBox.tf'), /templatefile\("\$\{path\.module\}\/baseBox\.sh\.tftpl", \{ [^}]*name_prefix = local\.p \}\)/);
  assert.match(read('baseBox.tf'), /templatefile\("\$\{path\.module\}\/baseBoxStack\.sh\.tftpl", \{\n {4}name_prefix {8}= local\.p\n/);
});

test('with name_prefix = "woodshed-cloud" every name, tag, path and value is the one it was', () => {
  let checked = 0;
  for (const [file, lines] of Object.entries(BEFORE)) {
    const now = renderedLines(file, OLD);
    for (const line of lines) {
      assert.ok(now.has(line), `${file} no longer renders: ${line.trim()}`);
      checked += 1;
    }
  }
  assert.equal(checked, 106);
});

test('with name_prefix = "woodshed" each of those names follows it, and only the container\'s own path keeps woodshed-cloud', () => {
  for (const [file, lines] of Object.entries(BEFORE)) {
    const now = renderedLines(file, 'woodshed');
    for (const line of lines) {
      const expected = line.replace(CONTAINER_PATH, '\0').replaceAll(OLD, 'woodshed').replace('\0', OLD);
      assert.ok(now.has(expected), `${file} should render: ${expected.trim()}`);
    }
  }
  const files = fs.readdirSync(DIR).filter((f) => /\.(tf|tftpl)$/.test(f));
  const left = files.flatMap((file) => render(file, 'woodshed').split('\n')
    .filter((line) => line.includes(OLD) && !isProse(file, line) && !CONTAINER_PATH.test(line))
    .map((line) => `${file}: ${line.trim()}`));
  assert.deepEqual(left, []);
});

test('name_prefix has no default, so a plan without it is refused, and takes only names every AWS limit allows', () => {
  const block = /variable "name_prefix" \{\n([\s\S]*?)\n\}\n/.exec(read('variables.tf'))?.[1];
  assert.ok(block, 'the name_prefix variable');
  assert.doesNotMatch(block, /^\s*default\s*=/m);
  assert.match(block, /^ {2}type {8}= string$/m);
  const [, pattern, max] = /condition {5}= can\(regex\("([^"]+)", var\.name_prefix\)\) && !strcontains\(var\.name_prefix, "--"\) && length\(var\.name_prefix\) <= (\d+)/.exec(block) ?? [];
  assert.ok(pattern, 'the name_prefix validation');
  const valid = (value) => new RegExp(pattern).test(value) && !value.includes('--') && value.length <= Number(max);
  for (const good of ['woodshed', OLD, 'acme2', 'a', 'w'.repeat(Number(max))]) assert.ok(valid(good), good);
  for (const bad of ['', 'Woodshed', '1shed', 'wood_shed', 'wood--shed', 'shed-', '-shed', 'wood shed', 'w'.repeat(Number(max) + 1)]) {
    assert.ok(!valid(bad), JSON.stringify(bad));
  }
  // The longest names at the longest prefix: S3 buckets take 63 characters (the account id is 12 digits), IAM role
  // names 64, and RDS's identifier, the prefix alone, refuses a dash last or two in a row.
  const p = 'w'.repeat(Number(max));
  assert.ok(`${p}-tfstate-123456789012`.length <= 63);
  assert.ok(`${p}-homes-123456789012`.length <= 63);
  assert.ok(`${p}-db-admin-execution`.length <= 64);
});

// What the stack hands the console for each AWS name it would otherwise guess, given the template's variable.
function stackEnv(prefix) {
  const box = read('baseBox.tf');
  const webhooks = render('webhooks.tf', prefix);
  const queue = /resource "aws_sqs_queue" "webhooks" \{\n {2}name = "([^"]+)"/.exec(webhooks)?.[1];
  const fn = /function_name {4}= "([^"]+)"/.exec(webhooks)?.[1];
  assert.match(box, / {4}webhook_queue {6}= aws_sqs_queue\.webhooks\.name\n/);
  assert.match(box, / {4}webhook_function {3}= aws_lambda_function\.webhooks\.function_name\n/);
  const stack = render('baseBoxStack.sh.tftpl', prefix).replaceAll('${webhook_queue}', queue).replaceAll('${webhook_function}', fn);
  // Inside the stack's loop over both names of every setting (shared/envNames.mjs), as the console reads them.
  const env = { WOODSHED_LAUNCHER: 'ecs', WOODSHED_DATABASES: '' };
  for (const name of ['SECRET_PREFIX', 'WEBHOOK_QUEUE', 'WEBHOOK_FUNCTION']) {
    const value = new RegExp(`^ {6}- \\$\\{prefix\\}${name}=(.*)$`, 'm').exec(stack)?.[1];
    assert.ok(value, `the stack sets ${name}`);
    env[`WOODSHED_${name}`] = value;
  }
  return env;
}

const awsNames = (config) => ({ secretPrefix: config.secrets.prefix, webhookQueue: config.webhookQueue, webhookFunction: config.webhookFunction });

test('the console gets its secret prefix, webhooks queue and function from the stack, named after the prefix', () => {
  assert.deepEqual(awsNames(loadConfig(stackEnv('woodshed'), { readGhToken: false })), {
    secretPrefix: 'woodshed/', webhookQueue: 'woodshed-webhooks', webhookFunction: 'woodshed-webhooks',
  });
});

test('a console on a box whose stack passes none of them falls back to the woodshed-cloud names', () => {
  const old = loadConfig({ WOODSHED_LAUNCHER: 'ecs' }, { readGhToken: false });
  assert.deepEqual(awsNames(old), { secretPrefix: 'woodshed-cloud/', webhookQueue: 'woodshed-cloud-webhooks', webhookFunction: 'woodshed-cloud-webhooks' });
  // And what an old installation's stack now passes is those same names, so nothing it finds moves.
  assert.deepEqual(awsNames(loadConfig(stackEnv(OLD), { readGhToken: false })), awsNames(old));
});

test('the Webhooks page points at the log of the installation\'s own function', () => {
  const config = loadConfig(stackEnv('woodshed'), { readGhToken: false });
  assert.equal(awsProvider({ ...config, envFiles: [] }).words.webhookLog, 'aws logs tail /aws/lambda/woodshed-webhooks');
});
