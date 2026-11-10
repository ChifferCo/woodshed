import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const DOCKERFILE = fs.readFileSync(path.join(import.meta.dirname, 'Dockerfile'), 'utf8');

// The user each RUN runs as, from the USER lines before it in its stage. A stage built on another of this file's stages
// starts as the user that one ended as, and `${RUNTIME}` is the runtime stage, published or built here.
function runsWithUser(text) {
  const runs = [];
  const endedAs = {};
  let user = 'root';
  let stage = null;
  for (const line of text.replace(/\\\n/g, ' ').split('\n')) {
    const from = line.match(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i);
    if (from) {
      if (stage) endedAs[stage] = user;
      const parent = from[1] === '${RUNTIME}' ? 'runtime' : from[1];
      user = endedAs[parent] ?? 'root';
      stage = from[2] ?? null;
    } else if (/^USER\s/.test(line)) user = line.split(/\s+/)[1];
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

// The published runtime (.github/workflows/sessionRuntime.yml builds `--target runtime`) must hold nothing of one
// repository's: every stage that does is built on `${RUNTIME}`, so a build can swap the runtime for the published one.
test('the repository\'s stages are built on the runtime the RUNTIME build arg names', () => {
  assert.match(DOCKERFILE, /^ARG RUNTIME=runtime$/m);
  assert.match(DOCKERFILE, /^FROM base AS runtime$/m);
  const stages = [...DOCKERFILE.matchAll(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/gm)].map((m) => ({ from: m[1], name: m[2] ?? '(final)' }));
  assert.deepEqual(stages.filter((s) => !['base', 'runtime'].includes(s.name)).map((s) => s.from), ['${RUNTIME}', '${RUNTIME}']);
  const runtime = DOCKERFILE.slice(DOCKERFILE.indexOf('FROM base AS runtime'), DOCKERFILE.indexOf('FROM ${RUNTIME}'));
  assert.doesNotMatch(runtime, /^(COPY(?! --link --from=)|ARG REPO)/m);
});

// The installs (the `deps` stage) are built on the runtime, so whatever the runtime changes on runs them again: a
// daily Claude there reran every repository's installs every day.
test('nothing in the runtime changes daily', () => {
  const runtime = DOCKERFILE.slice(DOCKERFILE.indexOf('FROM base AS runtime'), DOCKERFILE.indexOf('FROM ${RUNTIME}'));
  assert.doesNotMatch(runtime, /CLAUDE_DAY|BUILD_SHA|claude\.ai\/install/);
  assert.match(DOCKERFILE.slice(DOCKERFILE.lastIndexOf('FROM ${RUNTIME}')), /^ARG CLAUDE_DAY=$/m);
});
