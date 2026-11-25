// node --test review/github.test.mjs
//
// One property, and it is the reason this file exists: no string a caller
// controls may reach `gh` through `-F`.
//
// `gh api graphql -F name=value` does type conversion AND reads a value that
// begins with `@` out of a file on this box. Measured, not assumed:
//
//   printf 'String' > /tmp/probe
//   gh api graphql -f 'query=query($s:String!){ __type(name:$s){ name } }' \
//     -F s=@/tmp/probe      ->  {"data":{"__type":{"name":"String"}}}   read it
//     -f s=@/tmp/probe      ->  {"data":{"__type":null}}                did not
//
// Every string variable on this path — a file path, a node id, an owner —
// arrives in an HTTP body, and the shed has no authentication by design. One
// `-F path=@/etc/passwd` would therefore have it read a file and hand the
// contents to GitHub. The failure is silent: the call still succeeds, and
// nothing on the page looks different.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { fetchPrImage, graphqlArgv } from './github.mjs';

test('review images require a commit-pinned raster URL on the pull request repository', async (t) => {
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'review-image-gh-'));
  const previousPath = process.env.PATH;
  t.after(async () => {
    process.env.PATH = previousPath;
    await fs.rm(bin, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(bin, 'gh'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
  const slug = 'acme/web';
  const sha = 'a'.repeat(40);
  for (const src of [
    `https://github.com/acme/other/blob/${sha}/proof.png?raw=true`,
    'https://github.com/acme/web/blob/main/proof.png?raw=true',
    `https://github.com/acme/web/blob/${sha}/proof.svg?raw=true`,
    `https://github.com/acme/web/blob/${sha}/%2e%2e/proof.png?raw=true`,
    `https://github.com/acme/web/blob/${sha}/nested%2fproof.png?raw=true`,
    `https://github.com/acme/web/blob/${sha}/proof.png?raw=true&ref=main`,
  ]) {
    assert.equal(await fetchPrImage({ slug, src }), null, src);
  }
  const image = await fetchPrImage({ slug, src: `https://github.com/acme/web/blob/${sha}/nested/proof%20shot.png?raw=true` });
  assert.equal(image.type, 'image/png');
  assert.deepEqual(image.bytes.toString().trim().split('\n'), [
    'api', `repos/acme/web/contents/nested/proof%20shot.png?ref=${sha}`, '-H', 'Accept: application/vnd.github.raw',
  ]);
});

/** The values of every -F flag in an argv. */
function typedFields(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-F') out.push(args[i + 1]);
  }
  return out;
}

test('strings go through -f, never -F', () => {
  const args = graphqlArgv({
    query: 'mutation {}',
    strings: { id: 'PR_abc', path: '@/etc/passwd' },
  });
  assert.deepEqual(typedFields(args), []);
  assert.ok(args.includes('path=@/etc/passwd'));
  assert.equal(args[args.indexOf('path=@/etc/passwd') - 1], '-f');
});

test('numbers go through -F, because the type conversion is the point', () => {
  const args = graphqlArgv({ query: 'q', numbers: { pr: 24959 } });
  assert.deepEqual(typedFields(args), ['pr=24959']);
});

test('a number that is not one is refused rather than passed on', () => {
  assert.throws(() => graphqlArgv({ query: 'q', numbers: { pr: '@/etc/passwd' } }), /not an integer/);
  assert.throws(() => graphqlArgv({ query: 'q', numbers: { pr: 1.5 } }), /not an integer/);
});

test('an absent variable is left out rather than sent as the word undefined', () => {
  const args = graphqlArgv({ query: 'q', strings: { after: null, owner: 'acme' } });
  assert.ok(!args.some((a) => String(a).startsWith('after=')));
  assert.ok(args.includes('owner=acme'));
});

test('the query itself is the first field', () => {
  const args = graphqlArgv({ query: 'query{__typename}' });
  assert.deepEqual(args, ['api', 'graphql', '-f', 'query=query{__typename}']);
});
