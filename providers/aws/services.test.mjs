import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadProject } from '../../shared/project.mjs';
import { fixtureCheckout, fixtureProject } from '../../shared/projectFixture.mjs';
import { createDbAdminRunner } from './dbAdminRunner.mjs';
import { sessionOverrides } from './ecsLauncher.mjs';
import { withServices } from './index.mjs';
import { FIRST_HOST_PORT, HOST_PORT_RANGE, MAX_SERVICES, render, serviceUrlReader, servicesSpec, sessionServiceEnv } from './services.mjs';

const INIT = '/etc/pdf/init.d/fonts.sh';
const PDF = { name: 'pdf', image: 'example/pdf-renderer:1.0', port: 3000, variable: 'PDF_URL', environment: { TOKEN: 'a$b' }, files: { [INIT]: '.woodshed/services/fonts.sh' } };
const MAIL = { name: 'mail', image: 'example/mail:2.1', port: 1025, variable: 'MAIL_URL', memory: '256m' };
const BOX = { dir: '/var/lib/woodshed/services', privateIp: '10.0.1.5', prefix: 'woodshed', memoryMib: 2048 };
const STACK = path.join(import.meta.dirname, 'terraform', 'baseBoxStack.sh.tftpl');
const TF = (file) => fs.readFileSync(path.join(import.meta.dirname, 'terraform', file), 'utf8');

// A checkout of acme/app whose project file has `services`, and the init script one of them names.
function checkout(services) {
  const dir = fixtureCheckout(fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-aws-services-')));
  fs.mkdirSync(path.join(dir, '.woodshed/services'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.woodshed/project.yaml'), fixtureProject({ services }));
  fs.writeFileSync(path.join(dir, '.woodshed/services/fonts.sh'), '#!/bin/sh\necho fonts\n');
  return dir;
}

const specOf = (dir) => servicesSpec(loadProject(dir), { repoDir: dir, repo: 'acme/app' });
const decode = (spec) => JSON.parse(Buffer.from(spec, 'base64').toString('utf8'));
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64');

test('the spec carries each service with its files\' text, and the box makes one container of each on its private address', () => {
  const spec = specOf(checkout([PDF, MAIL]));
  assert.equal(decode(spec).services[0].files[INIT], Buffer.from('#!/bin/sh\necho fonts\n').toString('base64'));
  const out = render(spec, BOX);
  assert.equal(out.count, 2);
  assert.deepEqual(out.compose.services.pdf, {
    image: 'example/pdf-renderer:1.0', restart: 'unless-stopped', mem_limit: '768m',
    ports: [`10.0.1.5:${FIRST_HOST_PORT}:3000`],
    environment: { TOKEN: 'a$$b' },
    volumes: [`/var/lib/woodshed/services/files/pdf/0:${INIT}:ro`],
    security_opt: ['no-new-privileges:true'],
  });
  assert.deepEqual(out.compose.services.mail.ports, [`10.0.1.5:${FIRST_HOST_PORT + 1}:1025`]);
  assert.equal(out.compose.name, 'woodshed-services', 'a project of its own, which the stack\'s --remove-orphans leaves alone');
  assert.deepEqual(out.files, [{ path: 'files/pdf/0', text: Buffer.from('#!/bin/sh\necho fonts\n') }]);
  assert.deepEqual(out.urls, { repo: 'acme/app', sharedVariables: [], services: [
    { name: 'pdf', variable: 'PDF_URL', url: `http://10.0.1.5:${FIRST_HOST_PORT}` },
    { name: 'mail', variable: 'MAIL_URL', url: `http://10.0.1.5:${FIRST_HOST_PORT + 1}` },
  ] });
  assert.deepEqual(out.templateOverrides.containerOverrides[0].environment.at(-1), { name: 'WOODSHED_SERVICES', value: 'MAIL_URL PDF_URL' });
  assert.equal(render(specOf(checkout([])), BOX).count, 0, 'none is a spec too: the box then stops what ran');
});

test('the spec refuses a service that keeps data, and a file check refuses, before the deploy touches AWS', () => {
  const stateful = { ...MAIL, data: { dir: '/data', keep: 'person' } };
  assert.throws(() => specOf(checkout([PDF, stateful])), /mail keeps data \(data\.keep: person\), which the AWS provider does not run yet: leave it in Terraform's shared_services/);
  // One that starts containers keeps data too, so the base box never hands its Docker to a service.
  assert.throws(() => specOf(checkout([PDF, { ...stateful, data: { dir: '/data', keep: 'session' }, docker: true }])), /mail keeps data \(data\.keep: session\)/);
  const dir = checkout([PDF]);
  fs.rmSync(path.join(dir, '.woodshed/services/fonts.sh'));
  fs.symlinkSync('/proc/self/environ', path.join(dir, '.woodshed/services/fonts.sh'));
  assert.throws(() => specOf(dir), /which is a symlink, or under one/);
  assert.throws(() => servicesSpec(loadProject(dir), { repoDir: dir, repo: null }), /the repo could not be told/);
});

test('the box trusts nothing in the spec: the project file\'s rules, and no field the box does not take', () => {
  const good = decode(specOf(checkout([PDF])));
  const refused = [
    ['not base64!', /must be base64/],
    [encode({ ...good, version: 2 }), /must be version 1/],
    [encode({ ...good, extra: 1 }), /has extra, which it does not take/],
    [encode({ ...good, repo: 'acme' }), /names no repo/],
    [encode({ ...good, services: [{ ...good.services[0], privileged: true }] }), /privileged, which is not a field/],
    [encode({ ...good, services: [{ ...good.services[0], name: 'console' }] }), /name is console/],
    [encode({ ...good, services: [{ ...good.services[0], image: 'example/pdf:latest' }] }), /not latest/],
    [encode({ ...good, services: [{ ...good.services[0], data: { dir: '/d', keep: 'person' } }] }), /keeps data/],
    [encode({ ...good, services: [{ ...good.services[0], docker: true }] }), /docker runs containers/],
    [encode({ ...good, services: [{ ...good.services[0], files: { [INIT]: '%%%' } }] }), /is not base64/],
    [encode({ ...good, services: [{ ...good.services[0], files: { '/a:b': '' } }] }), /must be an absolute path in the container/],
    [encode({ ...good, services: [{ ...good.services[0], variable: 'SESSION_URL' }] }), /ending in _URL or _ENDPOINT|Woodshed's own/],
    [encode({ ...good, services: Array.from({ length: MAX_SERVICES + 1 }, (_, i) => ({ ...MAIL, name: `m${i}`, port: 2000 + i, variable: `M${i}_URL`, files: {} })) }), /more than 20/],
  ];
  for (const [spec, error] of refused) assert.throws(() => render(spec, BOX), error, String(error));
  assert.throws(() => render(encode(good), { ...BOX, memoryMib: 500 }), /memory comes to 768 MiB, and the base box has 500 MiB for them: set a larger base_box_instance_type/);
  assert.throws(() => render(encode(good), { ...BOX, privateIp: '10.0.1.5; reboot' }), /is not the box's private address/);
  assert.ok(MAX_SERVICES <= HOST_PORT_RANGE);
});

const LOCALSTACK = { name: 'localstack', variable: 'S3_ENDPOINT', port: 4566, memory: '1g' };

test('Terraform\'s shared_services run beside them: listed in WOODSHED_SERVICES, never clashing, their memory counted', () => {
  const out = render(specOf(checkout([PDF])), { ...BOX, legacy: [LOCALSTACK] });
  assert.deepEqual(out.urls.sharedVariables, ['S3_ENDPOINT']);
  assert.deepEqual(out.templateOverrides.containerOverrides[0].environment, [
    { name: 'PDF_URL', value: `http://10.0.1.5:${FIRST_HOST_PORT}` }, { name: 'WOODSHED_SERVICES', value: 'PDF_URL S3_ENDPOINT' },
  ]);
  assert.throws(() => render(specOf(checkout([{ ...PDF, name: 'localstack' }])), { ...BOX, legacy: [LOCALSTACK] }), /localstack is Terraform's shared_services' localstack too/);
  assert.throws(() => render(specOf(checkout([{ ...PDF, variable: 'S3_ENDPOINT' }])), { ...BOX, legacy: [LOCALSTACK] }), /set shared_services to \{\} for it and apply first/);
  assert.throws(() => render(specOf(checkout([PDF])), { ...BOX, legacy: [{ ...LOCALSTACK, port: 42001 }] }), /listens on 42001, which the project's services take/);
  assert.throws(() => render(specOf(checkout([PDF])), { ...BOX, memoryMib: 1500, legacy: [LOCALSTACK] }), /768 MiB, and the base box has 476 MiB/);
  assert.equal(render(specOf(checkout([PDF])), { ...BOX, memoryMib: 1500, legacy: [{ ...LOCALSTACK, memory: '512MB' }] }).count, 1, 'compose\'s sizes');
  assert.throws(() => render(specOf(checkout([PDF])), { ...BOX, legacy: [{ ...LOCALSTACK, memory: "1g' x" }] }), /is not one of Terraform's shared_services/);
});

test('the console hands the URLs to sessions on the default project, and to db-admin runs', async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-aws-state-'));
  const read = serviceUrlReader(state);
  assert.equal(read(), null, 'no file: the task definition\'s (Terraform\'s shared_services) stand');
  fs.writeFileSync(path.join(state, 'services.json'), JSON.stringify(render(specOf(checkout([PDF])), BOX).urls));
  const env = { PDF_URL: `http://10.0.1.5:${FIRST_HOST_PORT}`, WOODSHED_SERVICES: 'PDF_URL' };
  assert.deepEqual(sessionServiceEnv(read(), {}), env);
  assert.deepEqual(sessionServiceEnv(read(), { PROJECT_REPO: 'ACME/app' }), env, 'GitHub\'s names in any case');
  assert.deepEqual(sessionServiceEnv(read(), { PROJECT_REPO: 'acme/tools' }), {}, 'another project\'s sessions run none of these');

  const started = [];
  const launcher = withServices({ kind: 'ecs', start: async (id, e) => started.push([id, e]), refFor: (id) => id }, read);
  await launcher.start('s1', { SESSION_ID: 's1' });
  assert.deepEqual(started, [['s1', { SESSION_ID: 's1', ...env }]]);
  assert.equal(launcher.kind, 'ecs');

  const calls = [];
  const runner = createDbAdminRunner({ ecs: { cluster: 'c', dbAdminTaskDefinition: 'd', subnets: ['s'], securityGroup: 'g' }, aws: async (args) => { calls.push(args); return { tasks: [{ taskArn: 'arn' }] }; }, services: read });
  await runner.start(['seed', 'alice']);
  const overrides = JSON.parse(calls[0][calls[0].indexOf('--overrides') + 1]);
  assert.deepEqual(overrides.containerOverrides[0].environment, [{ name: 'PDF_URL', value: env.PDF_URL }, { name: 'WOODSHED_SERVICES', value: 'PDF_URL' }]);

  fs.writeFileSync(path.join(state, 'services.json'), JSON.stringify({ repo: 'acme/app', services: [{ name: 'x', variable: 'SESSION_TOKEN', url: 'http://1.2.3.4:1' }] }));
  assert.throws(() => read(), /is not a service's variable and URL/);
});

test('a session\'s run carries the services\' variables, and its prompt gives way to them under ECS\'s cap', () => {
  const env = { SESSION_ID: 's', PROMPT: 'x'.repeat(10_000), WOODSHED_SERVICES: 'PDF_URL', PDF_URL: 'http://10.0.1.5:42000', OTHER: 'no' };
  const out = sessionOverrides(env);
  assert.deepEqual(out.slice(-2), [{ name: 'WOODSHED_SERVICES', value: 'PDF_URL' }, { name: 'PDF_URL', value: 'http://10.0.1.5:42000' }]);
  assert.ok(!out.some((o) => o.name === 'OTHER'));
  const prompt = out.find((o) => o.name === 'PROMPT').value;
  assert.ok(prompt.length < 6000 + 200 - JSON.stringify(out.slice(-2)).length, 'shorter by the services');
  assert.throws(() => sessionOverrides({ WOODSHED_SERVICES: 'SESSION_TOKEN', SESSION_TOKEN: 'x' }), /not a service's variable/);
  assert.deepEqual(sessionOverrides({ WOODSHED_SERVICES: 'PDF_URL S3_ENDPOINT', PDF_URL: 'http://10.0.1.5:42000' }), [
    { name: 'WOODSHED_SERVICES', value: 'PDF_URL S3_ENDPOINT' }, { name: 'PDF_URL', value: 'http://10.0.1.5:42000' },
  ], 'one it lists and does not set is Terraform\'s, whose URL the task definition holds');
  assert.equal(sessionOverrides({ SESSION_ID: 's' }).length, 1, 'none without them');
});

// No test here runs terraform, so these read the Terraform as text.
test('the Terraform: the security group\'s range is the services\' ports, the document takes base64 only, and the deploy role may run it', () => {
  const rule = /resource "aws_vpc_security_group_ingress_rule" "project_services" \{[^}]*from_port\s+= (\d+)\n {2}to_port\s+= (\d+)\n\}/.exec(TF('network.tf'));
  assert.ok(rule, 'the project_services rule');
  assert.deepEqual([Number(rule[1]), Number(rule[2])], [FIRST_HOST_PORT, FIRST_HOST_PORT + HOST_PORT_RANGE - 1]);
  const github = TF('github.tf');
  assert.match(github, /allowedPattern = "\^\[A-Za-z0-9\+\/\]\+=\{0,2\}\$"/);
  assert.match(github, /"printf '%s' '\{\{ spec \}\}' \| \/usr\/local\/bin\/\$\{local\.p\}-services"/);
  assert.match(github, /resources = concat\(\[aws_ssm_document\.redeploy_console\.arn, aws_ssm_document\.refresh_services\.arn\]/);
  assert.match(github, /if \[ -f \/var\/lib\/\$\{local\.p\}\/services\/template-overrides\.json \]; then overrides=file:/);
  const box = TF('baseBox.tf');
  assert.match(box, / {4}reserved_mib {7}= local\.base_box_reserved_mib\n {4}legacy_services {4}= local\.legacy_services_json\n/);
  assert.match(box, /legacy_services_json = jsonencode\(\[for name, s in var\.shared_services : \{ name = name, variable = s\.variable, port = s\.port, memory = s\.mem_limit \}\]\)/);
});

// The stack's <prefix>-services script, as the template writes it for a box with no shared_services, run against a
// folder standing in for /var/lib, with a `docker` that runs the render here and records the rest.
function servicesScript(root, { legacy = [] } = {}) {
  const template = fs.readFileSync(STACK, 'utf8');
  const body = /cat > \/usr\/local\/bin\/\$\{name_prefix\}-services <<'EOF'\n([\s\S]*?)\nEOF\n/.exec(template)[1];
  assert.doesNotMatch(body, /%\{/, 'no template directive this stand-in leaves alone');
  return body
    .replaceAll('${base64encode(legacy_services)}', encode(legacy))
    .replaceAll('${name_prefix}', 'woodshed').replaceAll('${console_image}', 'console:latest').replaceAll('${private_ip}', '10.0.1.5')
    .replaceAll('${reserved_mib}', '0').replaceAll('/var/lib/', `${root}/var/lib/`)
    .replace('install -o 1000 -g 1000 -m 0644', 'install -m 0644');
}

function fakeDocker(bin, log) {
  const services = path.join(import.meta.dirname, 'services.mjs');
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/bash
echo "docker $*" >> ${JSON.stringify(log)}
# A compose file naming FAIL_UP_WITH's service will not start.
if [ "$2" = -f ] && [ "$4" = up ] && [ -n "\${FAIL_UP_WITH:-}" ] && grep -q "\"$FAIL_UP_WITH\"" "$3"; then exit 1; fi
if [ "$1" = run ]; then
  while [ "$1" != -v ]; do shift; done
  out=\${2%%:*}
  while [ "$1" != render ]; do shift; done
  shift
  args=("$@")
  args[1]=$out
  exec node ${JSON.stringify(services)} render "\${args[@]}"
fi
`, { mode: 0o755 });
}

test('the box\'s script renders in a container, pulls before it swaps, and leaves the console the URLs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-aws-box-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-aws-bin-'));
  const log = path.join(root, 'docker.log');
  fakeDocker(bin, log);
  fs.mkdirSync(path.join(root, 'var/lib/woodshed/console'), { recursive: true });
  const run = (spec, opts) => spawnSync('bash', ['-c', servicesScript(root, opts)], { input: spec, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });

  const first = run(specOf(checkout([PDF])));
  assert.equal(first.status, 0, first.stderr);
  const dir = path.join(root, 'var/lib/woodshed/services');
  assert.equal(fs.readFileSync(path.join(dir, 'files/pdf/0'), 'utf8'), '#!/bin/sh\necho fonts\n');
  assert.equal(fs.statSync(path.join(dir, 'files/pdf/0')).mode & 0o777, 0o755);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'var/lib/woodshed/console/services.json'), 'utf8')).services.map((s) => s.url), ['http://10.0.1.5:42000']);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.match(calls[0], /^docker run --rm -i --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 0:0 -v \S+\/services\.new:\/out console:latest node /);
  assert.deepEqual(calls.slice(1).map((c) => c.replace(dir, 'DIR')), [
    `docker compose -f DIR.new/compose.json pull --quiet`,
    'docker compose -f DIR/compose.json up -d --remove-orphans',
    'docker compose -p woodshed-services ps',
  ]);

  // A spec the box refuses leaves what runs as it was.
  fs.writeFileSync(log, '');
  const bad = run(encode({ ...decode(specOf(checkout([PDF]))), version: 9 }));
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /must be version 1/);
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1, 'no pull, no up');
  assert.ok(fs.existsSync(path.join(dir, 'compose.json')));

  // Containers that will not start put back the ones before, with their URLs.
  fs.writeFileSync(log, '');
  const failing = spawnSync('bash', ['-c', servicesScript(root)], { input: specOf(checkout([PDF, MAIL])), encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAIL_UP_WITH: 'mail' } });
  assert.equal(failing.status, 1);
  assert.match(failing.stderr, /the new services did not start; starting the ones before/);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'compose.json'), 'utf8')).services), ['pdf']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'var/lib/woodshed/console/services.json'), 'utf8')).services.map((s) => s.name), ['pdf']);
  assert.equal(fs.readFileSync(log, 'utf8').match(/ up -d /g).length, 2, 'the new, then the ones before');

  // None stops them all.
  fs.writeFileSync(log, '');
  assert.equal(run(specOf(checkout([]))).status, 0);
  assert.match(fs.readFileSync(log, 'utf8'), /docker compose -p woodshed-services down --remove-orphans/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'var/lib/woodshed/console/services.json'), 'utf8')).services, []);

  // Beside Terraform's shared_services, whose variables WOODSHED_SERVICES goes on listing; a clash with one stops it.
  assert.equal(run(specOf(checkout([PDF])), { legacy: [LOCALSTACK] }).status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'var/lib/woodshed/console/services.json'), 'utf8')).sharedVariables, ['S3_ENDPOINT']);
  const clash = run(specOf(checkout([{ ...PDF, variable: 'S3_ENDPOINT' }])), { legacy: [LOCALSTACK] });
  assert.equal(clash.status, 1);
  assert.match(clash.stderr, /Terraform's shared_services' localstack too/);
});

test('the deploy runs `spec` in its checkout, with the repo told from the origin', () => {
  const dir = checkout([PDF]);
  const spec = execFileSync('node', [path.join(import.meta.dirname, 'services.mjs'), 'spec'], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: '', REPO_DIR: '' } }).trim();
  assert.equal(decode(spec).repo, 'acme/app');
  assert.equal(decode(spec).services[0].name, 'pdf');
});
