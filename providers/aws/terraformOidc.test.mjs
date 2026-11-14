import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { oidcSettings } from '../../console/config.mjs';

// No test here runs terraform, so these read the Terraform as text: oidc_connections reaches the console as
// WOODSHED_OIDC_CONNECTIONS only when it lists one, in a form the console's own parser takes, and the console may
// write its signing key, which no session may read.
const DIR = path.join(import.meta.dirname, 'terraform');
const read = (file) => fs.readFileSync(path.join(DIR, file), 'utf8');

test('the console gets WOODSHED_OIDC_CONNECTIONS only when connections are listed, quoted for YAML', () => {
  assert.match(read('baseBoxStack.sh.tftpl'), /%\{ if oidc_connections != "" ~\}\n(?: {6}#[^\n]*\n)+ {6}- \$\{jsonencode\("WOODSHED_OIDC_CONNECTIONS=\$\{replace\(oidc_connections, "\$", "\$\$"\)\}"\)\}\n%\{ endif ~\}\n/);
  assert.match(read('baseBox.tf'), / {4}oidc_connections {3}= length\(var\.oidc_connections\) > 0 \? jsonencode\(var\.oidc_connections\) : ""\n/);
});

test('the line the template writes is one the console reads back as the same connections', () => {
  // What jsonencode makes of a tfvars list(map(string)), keys sorted as Terraform writes a map.
  const json = JSON.stringify([
    { name: 'aws-dev', region: 'us-east-1', roleArn: 'arn:aws:iam::123456789012:role/woodshed-dev', type: 'aws' },
    { audience: 'vault', name: 'vault', type: 'token' },
  ]);
  const [key, value] = JSON.parse(JSON.stringify(`WOODSHED_OIDC_CONNECTIONS=${json.replaceAll('$', '$$')}`)).split(/=(.*)/s);
  assert.equal(key, 'WOODSHED_OIDC_CONNECTIONS');
  const { issuer, connections } = oidcSettings({ [key]: value }, 'https://woodshed.example.com');
  assert.equal(issuer, 'https://woodshed.example.com');
  assert.deepEqual(connections.map((c) => [c.name, c.audience]), [['aws-dev', 'sts.amazonaws.com'], ['vault', 'vault']]);
});

test('the signing key is the console\'s alone: the base box may read and write it, the session roles never', () => {
  assert.match(read('secrets.tf'), /resource "aws_secretsmanager_secret" "oidc_signing_key" \{\n {2}name {20}= "\$\{local\.p\}\/oidc-signing-key"/);
  const consoleSecrets = /sid {5}= "ConsoleSecrets"[\s\S]*?\n {2}\}\n/.exec(read('baseBox.tf'))[0];
  assert.match(consoleSecrets, /aws_secretsmanager_secret\.oidc_signing_key\.arn/);
  assert.doesNotMatch(read('ecs.tf'), /oidc_signing_key|oidc-signing-key/);
});

test('Terraform refuses the connection names the console refuses', () => {
  const tf = /can\(regex\("(\^\[a-z\]\[a-z0-9-\]\{0,39\}\$)", lookup\(c, "name", ""\)\)\)/.exec(read('variables.tf'));
  assert.ok(tf, 'the oidc_connections name validation');
  const shared = /const NAME_RE = \/(.*)\/;/.exec(fs.readFileSync(path.join(import.meta.dirname, '../../shared/oidcConnections.mjs'), 'utf8'));
  assert.equal(tf[1], shared[1]);
});
