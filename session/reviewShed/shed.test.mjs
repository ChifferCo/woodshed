import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// The host over the shed's real review code and a real git checkout. No claude and no gh on the path: nothing here
// may need either to open the page, which is the property this pins. The Codex case stubs its CLI on PATH.
process.env.WOODSHED_REVIEWS = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-state-'));
process.env.PATH = '/usr/bin:/bin';
// A Woodshed session exports these; the fixtures' repos are on master.
delete process.env.DEFAULT_BRANCH;
delete process.env.REVIEW_ONLY;
const { createReviewHost } = await import('./host.mjs');

function checkout(t, { dirty }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-checkout-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-C', cwd, ...a], { stdio: 'pipe' });
  const remote = path.join(dir, 'remote.git');
  const repo = path.join(dir, 'repo');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', remote]);
  execFileSync('git', ['init', '-q', '-b', 'master', repo]);
  fs.writeFileSync(path.join(repo, 'a.mjs'), 'export const a = 1;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'start');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', 'origin', 'master');
  git(repo, 'remote', 'set-head', 'origin', 'master');
  git(repo, 'checkout', '-q', '-b', 'work');
  if (dirty) fs.writeFileSync(path.join(repo, 'a.mjs'), 'export const a = 2;\nexport const b = 3;\n');
  return repo;
}

async function serve(t, repoDir, sessionId, options = {}) {
  const host = createReviewHost({ repoDir, sessionId, sessionKind: 'shared', ...options });
  const server = http.createServer((req, res) => host.handle(req, res).then((done) => { if (!done) { res.writeHead(404); res.end(); } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/shed-review`;
  // The JSON of a call, or the response itself for the page.
  return (p, options) => fetch(base + p, options).then((r) => (r.headers.get('content-type')?.startsWith('application/json') ? r.json() : r));
}

test('opening the review of a checkout with changes makes the review, with its diff, and starts the analysis', async (t) => {
  const get = await serve(t, checkout(t, { dirty: true }), 'aaaaaaa1');
  const status = await get('/reviews/claude-aaaaaaa1');
  assert.equal(status.ok, true);
  assert.equal(status.kind, 'worktree');
  assert.notEqual(status.status, 'unknown', 'the analysis was started on opening');
  assert.equal(status.livePr, null);
  const diff = await get('/reviews/claude-aaaaaaa1/diff');
  assert.deepEqual(diff.files.map((f) => f.path), ['a.mjs']);
  assert.equal(diff.files[0].language, 'c');
});

test('a checkout with nothing to review says so instead of opening an empty page', async (t) => {
  const get = await serve(t, checkout(t, { dirty: false }), 'bbbbbbb2');
  const status = await get('/reviews/claude-bbbbbbb2');
  assert.equal(status.ok, false);
  assert.match(status.error, /nothing to review/);
});

test('the page served is the shed\'s own, byte for byte', async (t) => {
  const { REVIEW_HTML } = await import('../../shared/review/page.mjs');
  const get = await serve(t, checkout(t, { dirty: true }), 'ccccccc3');
  const res = await get('/review?session=claude-ccccccc3');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), REVIEW_HTML);
});

test('Codex analysis passes a schema to the CLI and persists the streamed artifact', { timeout: 10_000 }, async (t) => {
  const repo = checkout(t, { dirty: true });
  const bin = path.join(repo, '..', 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex'), `#!${process.execPath}
const assert = require('node:assert/strict');
const fs = require('node:fs');
const schemaIndex = process.argv.indexOf('--output-schema');
assert.ok(schemaIndex > 0, 'Codex analysis requires --output-schema');
const schema = JSON.parse(fs.readFileSync(process.argv[schemaIndex + 1], 'utf8'));
assert.deepEqual(schema.required.sort(), ['architecture', 'decisions', 'diagram', 'groups', 'overview']);
assert.equal(schema.properties.groups.items.properties.files.items.properties.path.type, 'string');
assert.ok(schema.properties.diagram.anyOf.some((option) => option.type === 'null'));
assert.match(fs.readFileSync(0, 'utf8'), /a[.]mjs/);

const artifact = {
  overview: 'Codex explained the export changes.',
  architecture: 'A single module declares the exports.',
  decisions: [],
  diagram: null,
  groups: [{
    title: 'Exports', why: 'The module declares its public constants.',
    files: [{ path: 'a.mjs', preamble: 'Adds a new constant.', role: 'core' }],
  }],
};
for (const event of [
  { type: 'turn.started' },
  { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(artifact) } },
  { type: 'turn.completed' },
]) console.log(JSON.stringify(event));
`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });

  const session = 'claude-ddddddd4';
  const get = await serve(t, repo, 'ddddddd4', { agent: 'codex' });
  let status = await get(`/reviews/${session}`);
  assert.equal(status.ok, true);
  for (let attempt = 0; attempt < 100 && status.status === 'running'; attempt += 1) {
    await delay(50);
    status = await get(`/reviews/${session}`);
  }

  assert.equal(status.status, 'ready', status.error);
  const { readArtifact } = await import('../../shared/review/store.mjs');
  const saved = readArtifact(session);
  assert.deepEqual(saved, status.review);
  assert.equal(saved.overview, 'Codex explained the export changes.');
  assert.equal(saved.groups[0].files[0].path, 'a.mjs');
});

test('Codex chat gets the named file before the excerpt cutoff and is told to identify missing context', { timeout: 10_000 }, async (t) => {
  const repo = checkout(t, { dirty: true });
  fs.writeFileSync(path.join(repo, 'a-large.txt'), ('x'.repeat(2_000) + '\n').repeat(80));
  fs.writeFileSync(path.join(repo, 'z-feature.mjs'), 'export const contextCanary = true;\n');
  execFileSync('git', ['-C', repo, 'add', 'a-large.txt', 'z-feature.mjs']);
  const bin = path.join(repo, '..', 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex'), `#!${process.execPath}
const fs = require('node:fs');
const prompt = fs.readFileSync(0, 'utf8');
if (process.argv.includes('--output-schema')) process.exit(1);
const problems = [];
if (/current working directory/.test(prompt)) problems.push('prompt promises checkout access');
if (!prompt.includes('explain what context is missing')) problems.push('missing context guidance absent');
if (!prompt.includes('export const contextCanary = true')) problems.push('named hunk was omitted');
if (!prompt.includes('Remaining diff omitted')) problems.push('expected a truncated excerpt');
if (problems.length) {
  console.error(problems.join(', '));
  process.exit(1);
}
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'The named change was included.' } }));
console.log(JSON.stringify({ type: 'turn.completed' }));
`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });

  const base = '/reviews/claude-eeeeeee5';
  const get = await serve(t, repo, 'eeeeeee5', { agent: 'codex' });
  await get(base);
  const chat = await get(`${base}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'What changed in z-feature.mjs?' }),
  });
  assert.equal(chat.ok, true, chat.error);
  let status = await get(`${base}/explain/${chat.askId}`);
  for (let attempt = 0; attempt < 100 && status.status === 'running'; attempt += 1) {
    await delay(50);
    status = await get(`${base}/explain/${chat.askId}`);
  }
  assert.equal(status.status, 'ready', status.error);
  assert.equal(status.answer.text, 'The named change was included.');
});
