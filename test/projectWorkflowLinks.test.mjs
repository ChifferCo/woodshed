import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createProjectReader } from '../console/projectFile.mjs';
import { createHandler } from '../console/server.mjs';
import { EMPTY_PROJECT, parseProject } from '../shared/project.mjs';
import { checkSummary, repoProblems } from '../shared/projectCheck.mjs';
import { fixtureCheckout, fixtureProject } from '../shared/projectFixture.mjs';

const DEPLOY = { label: 'Deploy', workflow: '.github/workflows/deploy.yml' };
const IMAGES = { label: 'Build images', workflow: '.github/workflows/images.yaml' };

const parse = (workflowLinks) => parseProject({ version: 1, workflowLinks });

test('workflowLinks: each a label and a workflow file, and left out it is null, the installation\'s to say', () => {
  assert.deepEqual(parse([DEPLOY, IMAGES]).workflowLinks, [DEPLOY, IMAGES]);
  assert.deepEqual(parse([]).workflowLinks, [], '[] is none, which is not the same as left out');
  assert.equal(parseProject({ version: 1 }).workflowLinks, null);
  assert.equal(EMPTY_PROJECT.workflowLinks, null, 'a repo with no project file');
});

test('workflowLinks refuses what GitHub has no page for, and a label the menu cannot show', () => {
  const refused = [
    [{ workflow: 'deploy.yml' }, /workflowLinks\[0\]\.workflow must be a workflow file, as \.github\/workflows\/deploy\.yml/],
    [{ workflow: '.github/workflows/ci/deploy.yml' }, /must be a workflow file/],
    [{ workflow: '.github/workflows/../deploy.yml' }, /must be a workflow file/],
    [{ workflow: '.github/workflows/deploy.json' }, /must be a workflow file/],
    [{ label: '' }, /workflowLinks\[0\]\.label must be 1 to 40 printable characters/],
    [{ label: ' Deploy' }, /without spaces around it/],
    [{ label: 'Deploy\nnow' }, /printable characters/],
    [{ label: 'x'.repeat(41) }, /1 to 40/],
    [{ label: 7 }, /printable characters/],
    [{ file: 'deploy.yml' }, /has file, which is not a field/],
  ];
  for (const [change, error] of refused) assert.throws(() => parse([{ ...DEPLOY, ...change }]), error, JSON.stringify(change));
  assert.throws(() => parse([{ label: 'Deploy' }]), /workflowLinks\[0\] is missing workflow/);
  assert.throws(() => parse([DEPLOY, { ...IMAGES, label: 'Deploy' }]), /the label Deploy more than once/);
  assert.throws(() => parse({ Deploy: 'deploy.yml' }), /workflowLinks must be a list/);
});

test('check names a link\'s workflow that is not in the checkout, and the summary lists the links', () => {
  const dir = fixtureCheckout(fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-workflow-links-')));
  fs.mkdirSync(path.join(dir, '.github/workflows'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.github/workflows/deploy.yml'), 'on: workflow_dispatch\njobs: {}\n');
  const project = { ...parse([DEPLOY, IMAGES]), from: 'checkout' };
  assert.deepEqual(repoProblems(project, dir),
    ['workflowLinks[1].workflow is .github/workflows/images.yaml, which is not in the checkout or on the default branch']);
  const summary = checkSummary({ ...parse([DEPLOY]), from: 'checkout' }, dir);
  assert.ok(summary.includes('workflow links: 1 (Deploy to .github/workflows/deploy.yml)'), summary.join('\n'));
  const left = checkSummary({ ...parseProject({ version: 1 }), from: 'checkout' }, dir);
  assert.ok(left.includes("workflow links: the installation's (WOODSHED_ACTIONS_WORKFLOWS)"), left.join('\n'));
});

test('the console reads the links by file name from the default branch, and null where the file names none or is unread', async () => {
  const reader = (text) => createProjectReader({ github: { repo: 'acme/app', projectFile: async () => text } });
  assert.deepEqual(await reader(fixtureProject({ workflowLinks: [DEPLOY, IMAGES] })).workflowLinks(),
    [{ label: 'Deploy', file: 'deploy.yml' }, { label: 'Build images', file: 'images.yaml' }]);
  assert.deepEqual(await reader(fixtureProject({ workflowLinks: [] })).workflowLinks(), []);
  assert.equal(await reader(fixtureProject()).workflowLinks(), null);
  assert.equal(await reader(null).workflowLinks(), null, 'no project file');
  assert.equal(await reader('version: 1\nworkflowLinks: nope\n').workflowLinks(), null, 'a file that does not parse');
});

test('/api/me prefers the project file\'s links, and keeps WOODSHED_ACTIONS_WORKFLOWS\'s where it has none', async (t) => {
  const installation = [{ label: 'Run infrastructure', file: 'infra.yml' }];
  async function me(workflowLinks) {
    const config = {
      host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'acme/app', label: 'woodshed',
      maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 }, actionsWorkflows: installation,
    };
    const handle = createHandler({ config, fleet: { sessions: () => [] }, workflowLinks });
    const server = http.createServer((req, res) => { handle(req, res); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/me`, { headers: { host: '127.0.0.1' } });
    return (await res.json()).workflows;
  }
  assert.deepEqual(await me(async () => [{ label: 'Deploy', file: 'deploy.yml' }]), [{ label: 'Deploy', file: 'deploy.yml' }]);
  assert.deepEqual(await me(async () => []), [], 'the file\'s none wins too');
  assert.deepEqual(await me(async () => null), installation);
  assert.deepEqual(await me(null), installation, 'a console made without a reader');
});
