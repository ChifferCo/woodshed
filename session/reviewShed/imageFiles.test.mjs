import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The session image is built from an allow-list. A new import in the shed's review code that the list lacks would
// start statusd's first review call with a module-not-found, in every session, with all the shed's own tests green.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WOODSHED = path.resolve(HERE, '../..');
const ALLOW = fs.readFileSync(path.resolve(HERE, '../Dockerfile.dockerignore'), 'utf8').split('\n');
const DOCKERFILE = fs.readFileSync(path.resolve(HERE, '../Dockerfile'), 'utf8');

function importsOf(file) {
  const text = fs.readFileSync(file, 'utf8');
  return [...text.matchAll(/^(?:import .*|\})\s*from '(\.[^']+\.mjs)';$/gm)].map((m) => path.resolve(path.dirname(file), m[1]));
}

function reachable(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...importsOf(file));
  }
  return [...seen];
}

// woodshed/shared/ is copied whole, so a file under it is in the image; anything else needs its own line in both.
function inImage(rel) {
  if (rel.startsWith('woodshed/shared/')) return ALLOW.includes('!woodshed/shared/**') && DOCKERFILE.includes('COPY --chown=node:node woodshed/shared/ /opt/woodshed/shared/');
  return ALLOW.includes(`!${rel}`) && DOCKERFILE.includes(path.basename(rel));
}

test('every file the shed\'s review code imports is in the session image', () => {
  // As the image's build context sees them: Woodshed under woodshed/, whether it is a folder of the repo or a repo of its own.
  const files = reachable(path.join(WOODSHED, 'shared/review/index.mjs')).map((f) => `woodshed/${path.relative(WOODSHED, f)}`);
  assert.ok(files.includes('woodshed/shared/prStatus.mjs'), 'the walk follows review/ into prStatus');
  assert.deepEqual(files.filter((rel) => !inImage(rel)), []);
});

test('the image leaves woodshed/shared/\'s tests and fixtures out', () => {
  for (const line of ['woodshed/shared/**/*.test.mjs', 'woodshed/shared/**/__fixtures__']) assert.ok(ALLOW.includes(line), line);
});
