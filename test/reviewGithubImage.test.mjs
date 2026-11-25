import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { isolatedEnv } from './isolatedEnv.mjs';

const execFileAsync = promisify(execFile);

test('review images require a commit-pinned raster URL on the pull request repository', async (t) => {
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'review-image-gh-'));
  t.after(() => fs.rm(bin, { recursive: true, force: true }));
  await fs.writeFile(path.join(bin, 'gh'), `#!/bin/sh
case "$1/$2" in
  auth/token) printf '%s\\n' "$TEST_GITHUB_CREDENTIAL"; exit ;;
  api/user) [ "$GH_TOKEN" = fixture-person ] || exit 1; printf 'octocat\\n'; exit ;;
esac
[ "$GH_TOKEN" = fixture-person ] || exit 1
printf '%s\\n' "$@"
`, { mode: 0o755 });
  const env = isolatedEnv();
  env.PATH = [bin, env.PATH].join(path.delimiter);
  const slug = 'acme/web';
  const sha = 'a'.repeat(40);
  const rejectedUrls = [
    `https://github.com/acme/other/blob/${sha}/proof.png?raw=true`,
    'https://github.com/acme/web/blob/main/proof.png?raw=true',
    `https://github.com/acme/web/blob/${sha}/proof.svg?raw=true`,
    `https://github.com/acme/web/blob/${sha}/%2e%2e/proof.png?raw=true`,
    `https://github.com/acme/web/blob/${sha}/nested%2fproof.png?raw=true`,
    `https://github.com/acme/web/blob/${sha}/proof.png?raw=true&ref=main`,
  ];
  const acceptedUrl = `https://github.com/acme/web/blob/${sha}/nested/proof%20shot.png?raw=true`;
  const script = `
    import assert from 'node:assert/strict';
    import { personalPrImageReader } from '../shared/review/github.mjs';
    const [slug, ...urls] = process.argv.slice(1);
    process.env.TEST_GITHUB_CREDENTIAL = 'fixture-person';
    const read = await personalPrImageReader();
    assert.equal(typeof read, 'function');
    process.env.TEST_GITHUB_CREDENTIAL = 'fixture-app';
    assert.equal(await personalPrImageReader(), null);
    for (const src of urls) {
      const image = await read({ slug, src });
      console.log(JSON.stringify(image && { type: image.type, args: image.bytes.toString().trim().split('\\n') }));
    }
  `;
  const { stdout } = await execFileAsync(process.execPath, [
    '--input-type=module', '-e', script, slug, ...rejectedUrls, acceptedUrl,
  ], { cwd: import.meta.dirname, env });
  const results = stdout.trim().split('\n').map((line) => JSON.parse(line));
  const image = results.pop();
  assert.deepEqual(results, rejectedUrls.map(() => null));
  assert.equal(image.type, 'image/png');
  assert.deepEqual(image.args, [
    'api', `repos/acme/web/contents/nested/proof%20shot.png?ref=${sha}`, '-H', 'Accept: application/vnd.github.raw',
  ]);
});
