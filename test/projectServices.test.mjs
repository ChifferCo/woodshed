import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseProject, RESERVED_SERVICE_NAMES, RESERVED_SERVICE_PORTS } from '../shared/project.mjs';
import { checkSummary, repoProblems } from '../shared/projectCheck.mjs';
import { fixtureCheckout } from '../shared/projectFixture.mjs';
import { serviceEnv, servicesCompose, servicesTfvars } from '../shared/projectServices.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'install.sh');
const INIT = '/etc/localstack/init/ready.d/create-bucket.sh';
const LOCALSTACK = {
  name: 'localstack', image: 'localstack/localstack:4.14.0', port: 4566, variable: 'S3_ENDPOINT',
  environment: { SERVICES: 's3' }, files: { [INIT]: '.woodshed/services/create-bucket.sh' },
};
const PDF = { name: 'pdf', image: 'example/pdf-renderer:1.0', port: 3000, variable: 'PDF_URL' };

const parse = (services, rest = {}) => parseProject({ version: 1, services, ...rest });

// A checkout with the init script committed on its default branch, as the deploy workflow and install.sh read it.
function checkout() {
  const dir = fixtureCheckout(fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-services-')));
  fs.mkdirSync(path.join(dir, '.woodshed/services'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.woodshed/services/create-bucket.sh'), '#!/bin/sh\nawslocal s3 mb s3://test\n');
  return dir;
}

test('services: each its name, image, port and variable, with an environment, files and memory left out as none', () => {
  const { services } = parse([LOCALSTACK, PDF]);
  assert.deepEqual(services[0], { ...LOCALSTACK, memory: '768m' });
  assert.deepEqual(services[1], { ...PDF, environment: {}, files: {}, memory: '768m' });
  assert.deepEqual(parseProject({ version: 1 }).services, [], 'none when left out');
  assert.equal(parse([{ ...PDF, memory: '2g' }]).services[0].memory, '2g');
  assert.equal(parse([{ ...PDF, image: `registry.example.com:5000/pdf/pdf@sha256:${'a'.repeat(64)}` }]).services.length, 1, 'a digest is a version');
});

test('services refuse what would collide with Woodshed, or change unseen', () => {
  const refused = [
    [{ name: 'mongo' }, /services\[0\]\.name is mongo/],
    [{ name: 'Local_Stack' }, /services\[0\]\.name must be lowercase/],
    [{ image: 'localstack/localstack' }, /must name its version/],
    [{ image: 'localstack/localstack:latest' }, /not latest/],
    [{ image: 'a b:1' }, /must be an image/],
    [{ port: 7691 }, /services\[0\]\.port is 7691/],
    [{ port: 70000 }, /must be a port number/],
    [{ variable: 'S3' }, /ending in _URL or _ENDPOINT/],
    [{ variable: 'PG_URL' }, /PG_URL, one of Woodshed's own session variables/],
    [{ variable: 'WOODSHED_CONSOLE_URL' }, /one of Woodshed's own session variables/],
    [{ environment: { PORT: 1 } }, /environment\.PORT must be a string/],
    [{ environment: { 'A-B': 'x' } }, /environment\.A-B is not a variable name/],
    [{ files: { 'etc/x': 'x.sh' } }, /must be an absolute path in the container/],
    [{ files: { '/a:b': 'x.sh' } }, /must be an absolute path in the container/],
    [{ files: { '/x': '../x.sh' } }, /must be a path inside the repo/],
    [{ memory: '1.5g' }, /megabytes or gigabytes/],
    [{ volumes: [] }, /has volumes, which is not a field/],
  ];
  for (const [change, error] of refused) assert.throws(() => parse([{ ...PDF, ...change }]), error, JSON.stringify(change));
  assert.throws(() => parse([PDF, { ...LOCALSTACK, port: 3000 }]), /the port 3000 more than once/);
  assert.throws(() => parse([PDF, { ...LOCALSTACK, variable: 'PDF_URL' }]), /the variable PDF_URL more than once/);
  assert.throws(() => parse([PDF, { ...LOCALSTACK, name: 'pdf' }]), /the name pdf more than once/);
  assert.throws(() => parse({ s3: PDF }), /services must be a list/);
});

// Terraform still takes shared_services from an installation's tfvars too, so its validations refuse what the project
// file does: the same reserved names, ports and variable rule.
test('Terraform\'s shared_services validations keep the names, ports and variables the project file keeps', () => {
  const tf = fs.readFileSync(path.join(ROOT, 'providers/aws/terraform/variables.tf'), 'utf8');
  const block = /variable "shared_services" \{([^]*?)\n\}/.exec(tf)[1];
  const names = JSON.parse(/!contains\((\[[^\]]*\]), name\)/.exec(block)[1]);
  const ports = JSON.parse(/!contains\((\[[^\]]*\]), s\.port\)/.exec(block)[1]);
  assert.deepEqual(names, [...RESERVED_SERVICE_NAMES]);
  assert.deepEqual(ports, [...RESERVED_SERVICE_PORTS]);
  assert.match(block, /regex\("\^\[A-Z\]\[A-Z0-9_\]\*_\(URL\|ENDPOINT\)\$", s\.variable\)/);
});

test('services-tfvars gives Terraform shared_services, each file\'s text read from the repo in place of its path', () => {
  const dir = checkout();
  fs.writeFileSync(path.join(dir, '.woodshed/project.yaml'), JSON.stringify({ version: 1, services: [LOCALSTACK, { ...PDF, memory: '1g' }] }));
  const expected = {
    shared_services: {
      localstack: { image: LOCALSTACK.image, port: 4566, variable: 'S3_ENDPOINT', environment: { SERVICES: 's3' }, files: { [INIT]: '#!/bin/sh\nawslocal s3 mb s3://test\n' }, mem_limit: '768m' },
      pdf: { image: PDF.image, port: 3000, variable: 'PDF_URL', environment: {}, files: {}, mem_limit: '1g' },
    },
  };
  const out = execFileSync('node', [path.join(ROOT, 'shared/project.mjs'), 'services-tfvars'], { env: { ...process.env, REPO_DIR: dir }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), expected);
  fs.writeFileSync(path.join(dir, '.woodshed/project.yaml'), JSON.stringify({ version: 1 }));
  const none = execFileSync('node', [path.join(ROOT, 'shared/project.mjs'), 'services-tfvars'], { env: { ...process.env, REPO_DIR: dir }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(none), { shared_services: {} }, 'none replaces any the tfvars had: the project file decides');
  fs.rmSync(path.join(dir, '.woodshed/services'), { recursive: true });
  assert.throws(() => servicesTfvars(parse([LOCALSTACK]), dir), /services localstack's file \.woodshed\/services\/create-bucket\.sh is not in the checkout/);
});

test('a service\'s session env is its URL by its name on the network, and the list of their variables', () => {
  assert.deepEqual(serviceEnv(parse([LOCALSTACK, PDF])), {
    S3_ENDPOINT: 'http://localstack:4566', PDF_URL: 'http://pdf:3000', WOODSHED_SERVICES: 'PDF_URL S3_ENDPOINT',
  });
  assert.deepEqual(serviceEnv(parse([])), {});
});

test('the local compose file runs each service on the woodshed network, with its files mounted read-only', () => {
  const repoDir = checkout();
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-services-home-')), 'services');
  fs.mkdirSync(path.join(dir, 'gone'), { recursive: true });
  const compose = servicesCompose(parse([LOCALSTACK, PDF]), { repoDir, dir });
  assert.deepEqual(compose, {
    services: {
      localstack: { image: LOCALSTACK.image, restart: 'unless-stopped', environment: { SERVICES: 's3' }, mem_limit: '768m', networks: ['woodshed'], volumes: [`${dir}/localstack/0:${INIT}:ro`] },
      pdf: { image: PDF.image, restart: 'unless-stopped', environment: {}, mem_limit: '768m', networks: ['woodshed'] },
    },
  });
  assert.equal(fs.readFileSync(path.join(dir, 'localstack/0'), 'utf8'), '#!/bin/sh\nawslocal s3 mb s3://test\n');
  assert.equal(fs.statSync(path.join(dir, 'localstack/0')).mode & 0o111, 0o111, 'executable, for an init script');
  assert.ok(!fs.existsSync(path.join(dir, 'gone')), 'a file from before is gone');
  const onOther = servicesCompose(parse([PDF]), { repoDir, dir, network: 'app_default' });
  assert.deepEqual(onOther.services.pdf.networks, ['woodshed', 'sessions']);
  assert.deepEqual(onOther.networks, { sessions: { name: 'app_default', external: true } }, 'sessions on the repo\'s own network reach it there');
  assert.equal(servicesCompose(parse([]), { repoDir, dir }), null);
  assert.ok(!fs.existsSync(dir));
});

test('check names each service, a file of one that is missing, and an env that would hide its URL', () => {
  const dir = checkout();
  const project = { ...parse([LOCALSTACK, PDF], { env: { PDF_URL: 'http://x:1' } }), from: 'checkout' };
  assert.deepEqual(repoProblems(project, dir), ["env.PDF_URL is services[1]'s variable, which its URL arrives in: leave it to the service"]);
  const fine = { ...parse([LOCALSTACK, PDF], { envFiles: [{ path: '.env', overrides: ['S3={{S3_ENDPOINT}}'] }] }), from: 'checkout' };
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n');
  const summary = checkSummary(fine, dir);
  assert.ok(summary.includes('services: 2 (localstack in S3_ENDPOINT, pdf in PDF_URL)'), summary.join('\n'));
  assert.ok(summary.includes('from the session: none'), 'a service\'s variable is the project\'s own now');
  fs.rmSync(path.join(dir, '.woodshed/services'), { recursive: true });
  assert.deepEqual(repoProblems({ ...parse([LOCALSTACK]), from: 'checkout' }, dir),
    [`services[0].files.${INIT} is .woodshed/services/create-bucket.sh, which is not in the checkout or on the default branch`]);
});

function runInstall(body) {
  return execFileSync('bash', ['-c', `set -euo pipefail; . "${SCRIPT}"; ${body}`], {
    env: { PATH: process.env.PATH, HOME: os.tmpdir(), WOODSHED_INSTALL_LIB: '1' }, encoding: 'utf8',
  });
}

test('install.sh writes the project file\'s services as a compose file, and removes it when they are gone', () => {
  const repoDir = checkout();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-install-services-'));
  fs.writeFileSync(path.join(repoDir, '.woodshed/project.yaml'), JSON.stringify({ version: 1, services: [LOCALSTACK] }));
  assert.equal(runInstall(`writeServices "${ROOT}" "${repoDir}" '' "${home}" woodshed`).trim(), '{}', 'nothing set before');
  const compose = JSON.parse(fs.readFileSync(path.join(home, 'services.yml'), 'utf8').replace(/^#.*\n/, ''));
  assert.deepEqual(Object.keys(compose.services), ['localstack']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'services-env.json'), 'utf8')), { S3_ENDPOINT: 'http://localstack:4566', WOODSHED_SERVICES: 'S3_ENDPOINT' });

  fs.writeFileSync(path.join(repoDir, '.woodshed/project.yaml'), JSON.stringify({ version: 1 }));
  assert.deepEqual(JSON.parse(runInstall(`writeServices "${ROOT}" "${repoDir}" '' "${home}" woodshed`)), { S3_ENDPOINT: 'http://localstack:4566', WOODSHED_SERVICES: 'S3_ENDPOINT' },
    'what the last run set, for writeSessionEnv to take out');
  for (const gone of ['services.yml', 'services-env.json', 'services']) assert.ok(!fs.existsSync(path.join(home, gone)), gone);
});

test('session-env.json gets the project file\'s services at each run, and keeps one added by hand', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-install-senv-')), 'session-env.json');
  const write = (services, before) => runInstall(`writeSessionEnv "${file}" 172.18.0.1 postgres '${JSON.stringify(services)}' '${JSON.stringify(before)}'`);
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const both = serviceEnv(parse([LOCALSTACK, PDF]));
  write(both, {});
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(read(), {
    PGHOST: 'postgres', PGPORT: '5432', PGSSLMODE: 'disable', WOODSHED_CONSOLE_URL: 'http://172.18.0.1:7691',
    S3_ENDPOINT: 'http://localstack:4566', PDF_URL: 'http://pdf:3000', WOODSHED_SERVICES: 'PDF_URL S3_ENDPOINT',
  });
  fs.writeFileSync(file, JSON.stringify({ ...read(), MAIL_URL: 'http://mail:1', WOODSHED_SERVICES: `${read().WOODSHED_SERVICES} MAIL_URL` }));
  const one = serviceEnv(parse([PDF]));
  write(one, both);
  assert.deepEqual(read(), {
    PGHOST: 'postgres', PGPORT: '5432', PGSSLMODE: 'disable', WOODSHED_CONSOLE_URL: 'http://172.18.0.1:7691',
    PDF_URL: 'http://pdf:3000', MAIL_URL: 'http://mail:1', WOODSHED_SERVICES: 'MAIL_URL PDF_URL',
  }, 'the one the file dropped is gone, the one added by hand stays');
  write({}, one);
  assert.deepEqual(read().WOODSHED_SERVICES, 'MAIL_URL');
  assert.equal(read().PDF_URL, undefined);
});
