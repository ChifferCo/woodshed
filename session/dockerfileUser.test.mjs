import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const DOCKERFILE = fs.readFileSync(path.join(import.meta.dirname, 'Dockerfile'), 'utf8');

// The user each RUN runs as, from the USER lines before it in its stage.
function runsWithUser(text) {
  const runs = [];
  let user = 'root';
  for (const line of text.replace(/\\\n/g, ' ').split('\n')) {
    if (/^FROM\s/.test(line)) user = 'root';
    else if (/^USER\s/.test(line)) user = line.split(/\s+/)[1];
    else if (/^RUN\s/.test(line)) runs.push({ line, user });
  }
  return runs;
}

// /opt belongs to root, and a RUN under `USER node` cannot write there: the symlink step of #26836 failed the image
// build with "Permission denied" in exactly this way, which no test that only reads the file layout could see.
test('every RUN that writes under /opt runs as root', () => {
  const writes = runsWithUser(DOCKERFILE).filter(({ line }) => /\b(mkdir|ln|cp|mv|install|touch|chown|chmod)\b[^&|;]*\/opt\//.test(line));
  assert.deepEqual(writes.filter(({ user }) => user !== 'root').map(({ line }) => line.slice(0, 120)), []);
});

test('the image ends as the node user, so a session never runs as root', () => {
  const users = [...DOCKERFILE.matchAll(/^USER\s+(\S+)/gm)].map((m) => m[1]);
  assert.equal(users.at(-1), 'node');
});

// Root owns `/`, so a RUN under `USER node` cannot make a folder there: /deps-browsers, made after USER node, failed
// the image build with "Permission denied", which no test of the session's own files could see.
test('no RUN as node makes a folder directly under /', () => {
  const makes = runsWithUser(DOCKERFILE).filter(({ line, user }) => user !== 'root' && /\bmkdir\b[^&|;]*\s\/[\w.-]+(\s|$|\/?[;&|])/.test(line));
  assert.deepEqual(makes.map(({ line }) => line.slice(0, 120)), []);
});
