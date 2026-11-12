// The WOODSHED_CLOUD_ to WOODSHED_ rename (shared/envNames.mjs): a console set up under the old names still runs as it
// did, and nothing reads an old name but the shared reader.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../console/config.mjs';
import { providerName } from '../providers/console.mjs';
import { SETTINGS, currentName, oldName } from '../shared/envNames.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
// The deploy workflow's repository variables, an installation's GitHub settings, keep their names for now.
const KEPT = ['WOODSHED_CLOUD_AWS_ROLE_ARN', 'WOODSHED_CLOUD_PLAN_ROLE_ARN', 'WOODSHED_CLOUD_INFRA_ROLE_ARN', 'WOODSHED_CLOUD_BASE_BOX_ID', 'WOODSHED_CLOUD_AWS_REGION'];

// An AWS console's settings, as the base box's compose file gives them, and a few more.
const AWS_CONSOLE = {
  HOST: '127.0.0.1', PUBLIC_URL: 'https://woodshed.example', APP_DOMAIN: 'woodshed.example', HOSTS: '203.0.113.9',
  REQUIRE_SIGN_IN: '1', STATE_DIR: '/var/lib/woodshed-cloud', REPO: 'acme/app',
  PROJECTS: '[{"name":"app","repo":"acme/app","default":true},{"name":"web","repo":"acme/web"}]',
  ENV_FILES: 'app-env=app/.env', DB_ENV_SECRETS: 'app-env', INSTALL_SECRETS: 'registry-token=REGISTRY_TOKEN', MAX_SESSIONS: '7',
  CONSOLE_NAME: 'Acme Woodshed', ACTIONS_WORKFLOWS: 'Deploy=deploy.yml', HOMES_BUCKET: 'homes', GITHUB_APP_ID: '12',
  GITHUB_APP_INSTALLATION_ID: '34', SESSION_API_HOST: '10.0.0.5', LAUNCHER: 'ecs', ECS_CLUSTER: 'c', ECS_TASK_DEFINITION: 't',
  ECS_SUBNETS: 'a,b', ECS_SECURITY_GROUP: 'sg', ECS_LOG_GROUP: 'lg', DATABASES: 'postgres,mongo',
  ECS_DB_ADMIN_TASK_DEFINITION: 'db', TUNNEL_POSTGRES: 'rds:5432', TUNNEL_MONGO: '10.0.0.5:27017', IDLE_HOURS: '2',
  LIFETIME_HOURS: '4', POLL_SECONDS: '60', FALLBACK_POLL_SECONDS: '600', LABEL: 'shed', TLS_ASK_PORT: '7699',
};
const named = (rename) => Object.fromEntries(Object.entries(AWS_CONSOLE).map(([name, value]) => [rename(name), value]));

test('a console set up with the old names only gets the config it gets from the new ones, and says which are old', (t) => {
  const warned = [];
  t.mock.method(console, 'warn', (...args) => warned.push(args));
  const current = loadConfig(named(currentName), { readGhToken: false });
  assert.deepEqual(warned, [], 'the new names say nothing');

  const old = loadConfig(named(oldName), { readGhToken: false });
  assert.deepEqual(old, current);
  assert.equal(providerName(named(oldName)), 'aws');
  const said = warned.map(([message, meta]) => [message, meta?.name]);
  assert.deepEqual(said.filter(([m]) => !m.startsWith('config: deprecated variable, use ')), [], 'nothing else is said');
  assert.deepEqual(said.map(([, name]) => name).sort(), Object.keys(AWS_CONSOLE).map(oldName).sort(), 'each old name once');
  for (const [message, name] of said) assert.equal(message, `config: deprecated variable, use ${currentName(name.slice('WOODSHED_CLOUD_'.length))}`);
  assert.doesNotMatch(JSON.stringify(warned), /acme|registry-token|10\.0\.0\.5/, 'names only, never a value');
});

test('with both names set, the new one is the one read', () => {
  const config = loadConfig({ ...named(oldName), ...named(currentName), WOODSHED_CLOUD_MAX_SESSIONS: '99' }, { readGhToken: false });
  assert.equal(config.maxRunning, 7);
});

test('nothing names an old setting but the shared reader, install.sh\'s, the base box\'s compose file and the rename\'s note', () => {
  const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const allowed = new Set(['shared/envNames.mjs', 'install.sh', 'providers/aws/terraform/baseBoxStack.sh.tftpl']);
  const found = [];
  for (const file of files) {
    if (file.endsWith('.test.mjs') || allowed.has(file) || !fs.existsSync(path.join(ROOT, file))) continue;
    let text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    // The reference's note on the rename names the old ones, and is the one place that does.
    if (file === 'docs/reference.md') text = text.replace(/\n## Renamed variables\n[^]*?\n## /, '\n## ');
    const names = [...text.matchAll(/WOODSHED_CLOUD_[A-Z0-9_]*[A-Z0-9]/g)].map((m) => m[0]).filter((name) => !KEPT.includes(name));
    if (names.length) found.push(`${file}: ${[...new Set(names)].join(', ')}`);
  }
  assert.deepEqual(found, []);
});

test('every setting the console reads is in the list, by its name without the prefix', () => {
  const sources = execFileSync('git', ['ls-files', '*.mjs'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const read = new Set();
  for (const file of sources) {
    for (const m of fs.readFileSync(path.join(ROOT, file), 'utf8').matchAll(/envValue\([\w.]+, '([A-Z0-9_]+)'\)/g)) read.add(m[1]);
  }
  assert.deepEqual([...read].filter((name) => !SETTINGS.includes(name)), []);
  assert.ok(read.size > 40);
});

// Terraform writes the base box's compose file before the deploy's console job brings the image that reads the new
// names, so each setting goes in under both until a later release.
test('the base box gives the console each setting under both names, and the new name is a setting', () => {
  const stack = fs.readFileSync(path.join(ROOT, 'providers/aws/terraform/baseBoxStack.sh.tftpl'), 'utf8');
  const loop = /\n%\{ for prefix in \["WOODSHED_", "WOODSHED_CLOUD_"\] ~\}\n([^]*?)\n%\{ endfor ~\}\n {4}volumes:/.exec(stack);
  assert.ok(loop, 'the console\'s settings are written once for each prefix');
  const items = loop[1].split('\n').filter((line) => /^ {6}- /.test(line));
  const names = items.map((line) => {
    const plain = /^ {6}- (?:\$\{jsonencode\("\$\{prefix\}|\$\{prefix\})([A-Z0-9_]+)=/.exec(line);
    if (plain) return plain[1];
    const ternary = /^ {6}- \$\{prefix == "WOODSHED_" \? "([A-Z0-9_]+)" : "([A-Z0-9_]+)"\}=/.exec(line);
    assert.ok(ternary, `every line in the loop names its setting through the prefix: ${line}`);
    const name = SETTINGS.find((n) => currentName(n) === ternary[1]);
    assert.ok(name && oldName(name) === ternary[2], line);
    return name;
  });
  assert.ok(names.length > 25);
  assert.deepEqual(names.filter((name) => !SETTINGS.includes(name)), []);
  assert.ok(names.includes('INSTALL_SECRETS') && names.includes('REPO'));
});
