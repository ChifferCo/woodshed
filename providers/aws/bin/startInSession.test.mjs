import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fixtureProject } from '../../../shared/projectFixture.mjs';
import { loadProject } from '../../../shared/project.mjs';
import { IMAGE_ONLY, imageOnlyChanges, limits, liveFilesTouched, refusal, runProcesses } from './startInSession.mjs';

const SESSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../session');

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-in-session-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the limits are always said, and a file the image copies elsewhere that the branch changed comes first, as not covered', () => {
  const plain = limits();
  assert.ok(plain.length >= 5);
  assert.ok(plain.every((line) => !line.startsWith('NOT COVERED')));
  assert.ok(plain.some((line) => /Dockerfile/.test(line)), 'a Dockerfile change is always named as not tried');
  assert.ok(plain.some((line) => /stand-in/.test(line)), 'the console being a stand-in is said');
  const changed = limits({ imageOnlyChanged: ['Dockerfile'] });
  assert.match(changed[0], /^NOT COVERED: this branch changes the image itself \(session\/Dockerfile\)/);
  assert.match(changed[0], /askInImage\.mjs/);
});

test('imageOnlyChanges names each file the image copies outside /opt/woodshed that differs from the image\'s', (t) => {
  const dir = scratch(t);
  for (const side of ['branch', 'image']) {
    fs.mkdirSync(path.join(dir, side));
    for (const { file } of IMAGE_ONLY) fs.writeFileSync(path.join(dir, side, file), `${file} as built\n`);
  }
  assert.deepEqual(imageOnlyChanges(path.join(dir, 'branch'), path.join(dir, 'image')), []);
  fs.appendFileSync(path.join(dir, 'branch', 'gh.sh'), 'changed\n');
  assert.deepEqual(imageOnlyChanges(path.join(dir, 'branch'), path.join(dir, 'image')), ['gh.sh']);
});

test('a project with databases or Redis is refused: they would need ports and data of their own', (t) => {
  const project = (fields) => {
    const repoDir = scratch(t);
    fs.mkdirSync(path.join(repoDir, '.woodshed'));
    fs.writeFileSync(path.join(repoDir, '.woodshed/project.yaml'), fixtureProject(fields));
    return loadProject(repoDir);
  };
  assert.equal(refusal(project({})), null);
  const pg = { engine: 'postgres', dir: '.', migrate: null, seed: null, envFiles: [], paths: [], migrations: null, user: 'app_user', name: 'app' };
  assert.match(refusal(project({ databases: [pg] })), /databases/);
  assert.match(refusal(project({ envFiles: [{ path: '.env', secret: null, lines: ['REDIS_URL=redis://127.0.0.1:6379'] }] })), /Redis/);
});

test('runProcesses finds what the run started by its scratch WOODSHED_TMP, and nothing else', async (t) => {
  const dir = scratch(t);
  const ours = spawn('sleep', ['30'], { env: { PATH: process.env.PATH, WOODSHED_TMP: `${dir}/tmp` } });
  const other = spawn('sleep', ['30'], { env: { PATH: process.env.PATH, WOODSHED_TMP: `${dir}/tmp-other` } });
  t.after(() => { ours.kill(); other.kill(); });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(runProcesses(`${dir}/tmp`), [ours.pid]);
});

test('liveFilesTouched names a live file the run wrote into, not one the live session changed itself', (t) => {
  const dir = scratch(t);
  const since = Date.now() - 1000;
  fs.writeFileSync(path.join(dir, 'woodshed-claude-state.json'), '{"event":"Stop","cwd":"/work/woodshed"}');
  fs.writeFileSync(path.join(dir, 'woodshed-github-token'), '123 ghs_from_the_run_s1d');
  fs.writeFileSync(path.join(dir, 'unrelated.json'), 'ghs_from_the_run_s1d');
  assert.deepEqual(liveFilesTouched(since, ['ghs_from_the_run_s1d', ''], dir), ['woodshed-github-token']);
  assert.deepEqual(liveFilesTouched(Date.now() + 60_000, ['ghs_from_the_run_s1d'], dir), [], 'a file older than the run is not looked at');
});

// A start beside a live session works only while every file and port the start uses can be moved: a path or port
// written in by hand would be the live session's, and the run would write over it.
test('the start names no /tmp path and no fixed port outside the overridable defaults', () => {
  const code = (file) => fs.readFileSync(path.join(SESSION_DIR, file), 'utf8').split('\n')
    .map((line, i) => ({ line, at: `${file}:${i + 1}` }))
    .filter(({ line }) => !/^\s*(#|\/\/|\*)/.test(line));
  const entrypoint = code('entrypoint.sh');
  const tmp = entrypoint.filter(({ line }) => /(^|[^\w$-])\/tmp(\/|\b)/.test(line) && !/WOODSHED_TMP=\$\{WOODSHED_TMP:-\/tmp\}/.test(line));
  assert.deepEqual(tmp.map((l) => l.at), [], 'every path under /tmp goes through $WOODSHED_TMP');
  // Redis and its viewer are left out: a project that uses Redis is refused a start beside a live session (refusal).
  const ports = entrypoint.filter(({ line }) => /\b768[1-8]\b/.test(line) && !/PORT_OFFSET/.test(line) && !/redis-/.test(line));
  assert.deepEqual(ports.map((l) => l.at), [], 'every port the start opens is moved by WOODSHED_PORT_OFFSET');
  for (const file of ['statusd.mjs', 'hookState.mjs', 'settingsSync.mjs', 'codeEditor.mjs', 'terminalFiles.mjs', 'reviewShed/host.mjs']) {
    const fixed = code(file).filter(({ line }) => /['"`]\/tmp\//.test(line));
    assert.deepEqual(fixed.map((l) => l.at), [], `${file} reads its folder from WOODSHED_TMP`);
  }
  for (const file of ['githubToken.sh', 'gh.sh']) {
    const fixed = code(file).filter(({ line }) => /(^|[^-])(\/tmp\/|\/opt\/woodshed\/session\/)/.test(line) && !/:-\/(tmp|opt)/.test(line));
    assert.deepEqual(fixed.map((l) => l.at), [], `${file} has no fixed path the run cannot move`);
  }
});
