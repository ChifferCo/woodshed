import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { hostedEngines } from '../../shared/databases/index.mjs';

const HERE = import.meta.dirname;
const read = (file) => fs.readFileSync(path.join(HERE, file), 'utf8');
// The databases' compose files, each given after compose.yml when the installation runs that database.
const DATABASE_FILES = { postgres: 'postgres.yml', mongo: 'mongo.yml' };
const exampleKeys = () => read('stack.env.example').split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => l.split('=')[0]);

test('every variable the compose files read is in stack.env.example', () => {
  const used = Object.values(DATABASE_FILES).flatMap((file) => [...read(file).matchAll(/\$\{([A-Z0-9_]+)/g)].map((m) => m[1]));
  assert.ok(used.length > 0);
  assert.deepEqual(used.filter((v) => !exampleKeys().includes(v)), []);
});

test('every console setting in stack.env.example is one the console reads', () => {
  const read = [path.join(HERE, '../../console/config.mjs'), path.join(HERE, '../console.mjs')].map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const forCompose = new Set(['WOODSHED_LOCAL_DATA_DIR', 'WOODSHED_LOCAL_PG_ROOT_PASSWORD', 'WOODSHED_LOCAL_MONGO_ROOT_PASSWORD',
    'WOODSHED_LOCAL_PG_PORT', 'WOODSHED_LOCAL_MONGO_PORT']);
  assert.deepEqual(exampleKeys().filter((k) => !forCompose.has(k) && !read.includes(k)), []);
});

test('compose.yml is the sessions\' network alone, and each database\'s file runs that one, pinned, on it', () => {
  assert.doesNotMatch(read('compose.yml'), /^services:/m, 'the databases and the shared services each come from a file of their own');
  for (const [name, file] of Object.entries(DATABASE_FILES)) {
    const text = read(file);
    assert.deepEqual([...text.matchAll(/^ {2}([a-z]+):$/gm)].map((m) => m[1]), [name], file);
    const images = [...text.matchAll(/image: (\S+)/g)].map((m) => m[1]);
    assert.equal(images.length, 1, file);
    assert.match(images[0], /:[0-9]/, images[0]);
    assert.match(text, /networks: \[woodshed\]/, file);
    assert.match(text, /ports: \["127\.0\.0\.1:/, `${file} publishes on the loopback only`);
  }
  assert.match(read('compose.yml'), /networks:\n {2}woodshed:\n {4}name: woodshed/);
  assert.ok(read('stack.env.example').includes('WOODSHED_LOCAL_DOCKER_NETWORK=woodshed'));
});

test('the session env example is a JSON object of strings, which the console takes, and sets each service it lists', () => {
  const env = JSON.parse(read('session-env.example.json'));
  assert.ok(Object.values(env).every((v) => typeof v === 'string'));
  // Each engine's server, in the names its engine reads (shared/databases/).
  assert.deepEqual(hostedEngines(env), ['postgres', 'mongo']);
  assert.equal(env.WOODSHED_MONGO_HOST, 'mongo:27017');
  for (const name of env.WOODSHED_SERVICES.split(' ')) assert.match(env[name] ?? '', /^http:\/\//, name);
});

test('the services example joins the sessions\' network, publishes no port, and is the service the session env names', () => {
  const services = read('services.example.yml');
  assert.doesNotMatch(services, /ports:/, 'no published port: Docker skips the firewall');
  assert.match(services, /networks: \[woodshed\]/);
  const [, name] = /^ {2}([a-z0-9-]+):$/m.exec(services);
  assert.equal(JSON.parse(read('session-env.example.json')).S3_ENDPOINT, `http://${name}:4566`);
});
