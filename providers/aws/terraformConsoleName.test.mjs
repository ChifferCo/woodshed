import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { consoleName } from '../../console/config.mjs';

// No test here runs terraform, so these read the Terraform as text, as terraformProjects.test.mjs does.
const DIR = path.join(import.meta.dirname, 'terraform');
const read = (file) => fs.readFileSync(path.join(DIR, file), 'utf8');

test('the console gets console_name as WOODSHED_CLOUD_CONSOLE_NAME, quoted for YAML, defaulting to Woodshed', () => {
  assert.match(read('variables.tf'), /variable "console_name" \{[^}]*default {5}= "Woodshed"/);
  assert.match(read('baseBox.tf'), / {4}console_name {7}= var\.console_name\n/);
  assert.match(read('baseBoxStack.sh.tftpl'), / {6}- \$\{jsonencode\("WOODSHED_CLOUD_CONSOLE_NAME=\$\{replace\(console_name, "\$", "\$\$"\)\}"\)\}\n/);
});

test('the line the template writes is a YAML string the console reads back as the same name', () => {
  const name = 'Acme: the shed #2 $HOME';
  const item = JSON.stringify(`WOODSHED_CLOUD_CONSOLE_NAME=${name.replaceAll('$', '$$')}`);
  // Compose reads the item as YAML, a JSON string being one, and turns $$ back into $.
  const [key, value] = JSON.parse(item).replaceAll('$$', '$').split(/=(.*)/s);
  assert.equal(key, 'WOODSHED_CLOUD_CONSOLE_NAME');
  assert.equal(consoleName({ [key]: value }), name);
});

test('Terraform refuses the names the console refuses', () => {
  const tf = /can\(regex\("(\^[^"]*\\"[^"]*)", var\.console_name\)\)/.exec(read('variables.tf'));
  assert.ok(tf, 'the console_name validation');
  // The Terraform string's escapes, undone: \\ is \ and \" is ".
  const pattern = tf[1].replace(/\\(["\\])/g, '$1');
  const config = /const CONSOLE_NAME_RE = \/(.*)\/u;/.exec(fs.readFileSync(path.join(import.meta.dirname, '../../console/config.mjs'), 'utf8'));
  assert.equal(pattern, config[1]);
});
