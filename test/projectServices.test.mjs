import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseProject } from '../shared/project.mjs';
import { checkSummary, repoProblems } from '../shared/projectCheck.mjs';
import { fixtureCheckout } from '../shared/projectFixture.mjs';

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
  assert.deepEqual(services[0], { ...LOCALSTACK, memory: '768m', data: null });
  assert.deepEqual(services[1], { ...PDF, environment: {}, files: {}, memory: '768m', data: null });
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

test('data: what a stateful service keeps, and for whom; none is stateless', () => {
  assert.equal(parse([PDF]).services[0].data, null);
  assert.deepEqual(parse([{ ...LOCALSTACK, data: { dir: '/var/lib/localstack/', keep: 'person' } }]).services[0].data, { dir: '/var/lib/localstack', keep: 'person' });
  assert.equal(parse([{ ...LOCALSTACK, data: { dir: '/data', keep: 'session' } }]).services[0].data.keep, 'session');
  for (const [data, error] of [
    [{ dir: '/data', keep: 'org' }, /data\.keep must be one of person, session/],
    [{ dir: '/data' }, /data is missing keep/],
    [{ dir: 'data', keep: 'person' }, /data\.dir must be an absolute folder/],
    [{ dir: '/', keep: 'person' }, /data\.dir must be an absolute folder/],
    [{ dir: '/a/../b', keep: 'person' }, /data\.dir must be an absolute folder/],
    [{ dir: '/data', keep: 'person', size: '1g' }, /data has size, which is not a field/],
  ]) assert.throws(() => parse([{ ...LOCALSTACK, data }]), error, JSON.stringify(data));
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

