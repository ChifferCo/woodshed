import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fixtureProject, fixtureProjectFiles } from '../../shared/projectFixture.mjs';
import { dockerLauncher, parseDockerPort } from './dockerLauncher.mjs';
import { PROJECT_FILES_MOUNT, projectFileMounts } from './projectFileMounts.mjs';

test('parseDockerPort reads the host port docker published', () => {
  assert.equal(parseDockerPort('127.0.0.1:49153'), 49153);
  assert.equal(parseDockerPort('0.0.0.0:49153\n[::]:49153'), 49153);
  assert.equal(parseDockerPort(''), null);
});

function launch({ projectFilesDir, repo = 'acme/app', env = {} }) {
  const runs = [];
  const launcher = dockerLauncher({
    image: 'woodshed-session', memory: '6g', cpus: '2', projectFilesDir, repo,
    run: async (args, given) => {
      if (args[0] === 'run') runs.push({ args, env: given });
      return args[0] === 'port' ? '127.0.0.1:49153' : '';
    },
  });
  return launcher.start('a1b2c3d4', { SESSION_ID: 'a1b2c3d4', ...env }).then(() => runs[0]);
}

function mountsOf(args) {
  return args.flatMap((a, i) => (args[i - 1] === '--mount' ? [a] : []));
}

test('a session gets its repo\'s and the image\'s repo\'s installation project files, each mounted read-only, and no other', async (t) => {
  t.mock.method(console, 'log', () => {});
  const dir = fixtureProjectFiles(fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-files-')), {
    'acme/app': fixtureProject(), 'Other/Web': fixtureProject(), 'acme/secret-plans': fixtureProject(),
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const own = await launch({ projectFilesDir: dir });
  assert.deepEqual(mountsOf(own.args), [`type=bind,source=${path.join(dir, 'acme/app.yaml')},target=${PROJECT_FILES_MOUNT}/acme/app.yaml,readonly`]);
  assert.equal(own.env.WOODSHED_CLOUD_PROJECT_FILES_DIR, PROJECT_FILES_MOUNT);
  assert.ok(own.args.includes('WOODSHED_CLOUD_PROJECT_FILES_DIR'), 'passed by name, as every variable is');

  const other = await launch({ projectFilesDir: dir, env: { PROJECT_REPO: 'other/web' } });
  assert.deepEqual(mountsOf(other.args), [
    `type=bind,source=${path.join(dir, 'acme/app.yaml')},target=${PROJECT_FILES_MOUNT}/acme/app.yaml,readonly`,
    `type=bind,source=${path.join(dir, 'Other/Web.yaml')},target=${PROJECT_FILES_MOUNT}/other/web.yaml,readonly`,
  ]);

  const none = await launch({ projectFilesDir: dir, repo: 'acme/nothing' });
  assert.deepEqual(mountsOf(none.args), []);
  assert.equal(none.env.WOODSHED_CLOUD_PROJECT_FILES_DIR, undefined, 'a repo with no file there reads none, as one with no folder');
  assert.deepEqual(mountsOf((await launch({ projectFilesDir: null })).args), []);
  assert.deepEqual(mountsOf((await launch({ projectFilesDir: path.join(dir, 'missing') })).args), []);
});

test('a mount\'s path with a comma or a quote is one CSV field, as docker reads --mount', (t) => {
  const dir = fixtureProjectFiles(fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-files,"odd"-')), { 'acme/app': fixtureProject() });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const [, value] = projectFileMounts({ dir, repos: ['acme/app'] }).args;
  assert.equal(value, `type=bind,"source=${path.join(dir, 'acme/app.yaml').replaceAll('"', '""')}",target=${PROJECT_FILES_MOUNT}/acme/app.yaml,readonly`);
});
