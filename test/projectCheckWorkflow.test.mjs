import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseYaml } from '../shared/yamlLite.mjs';

// .github/workflows/project-check.yml, the reusable workflow other repos call to check their project file.
const WOODSHED = path.resolve(import.meta.dirname, '..');
const workflow = (name) => parseYaml(fs.readFileSync(path.join(WOODSHED, '.github/workflows', name), 'utf8'));
const CHECK = workflow('project-check.yml');
const { steps } = CHECK.jobs.check;

test('it is called with a Woodshed ref, repository and Node version, each with a default', () => {
  assert.deepEqual(Object.keys(CHECK.on), ['workflow_call']);
  const { inputs } = CHECK.on.workflow_call;
  assert.deepEqual(Object.fromEntries(Object.entries(inputs).map(([name, i]) => [name, [i.type, i.default]])), {
    ref: ['string', 'main'], repository: ['string', 'ChifferCo/woodshed'], 'node-version': ['string', '22.16.0'],
  });
  assert.equal(CHECK.on.workflow_call.secrets, undefined, 'it takes no secrets');
});

test('it reads contents only, pins its actions to commits, and starts each run block with a comment', () => {
  assert.deepEqual([CHECK.permissions, CHECK.jobs.check.permissions], [{ contents: 'read' }, { contents: 'read' }]);
  for (const s of steps.filter((x) => x.uses)) assert.match(s.uses, /^[\w-]+\/[\w-]+@[0-9a-f]{40}$/, s.uses);
  for (const s of steps.filter((x) => x.run)) {
    assert.match(s.run, /^# \S/, s.name);
    assert.doesNotMatch(s.run, /\$\{\{/, `${s.name}: inputs reach the script through env, never pasted into it`);
  }
  assert.equal(steps[0].with['persist-credentials'], false);
});

test('Woodshed is fetched into the runner\'s temp folder, and its check runs in the caller\'s checkout', (t) => {
  const fetch = steps.find((s) => s.name === "Fetch Woodshed's check, outside the workspace");
  assert.deepEqual(fetch.env, { REF: '${{ inputs.ref }}', REPOSITORY: '${{ inputs.repository }}' });
  assert.match(fetch.run, /^dest="\$RUNNER_TEMP\/woodshed"$/m);
  const check = steps.at(-1);
  assert.equal(check.name, 'Check the project file');
  // The step as Actions runs it, with this checkout as Woodshed in the temp folder and as the caller's checkout.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-runner-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  fs.symlinkSync(WOODSHED, path.join(temp, 'woodshed'));
  const out = execFileSync('bash', ['-e', '-c', check.run], { cwd: WOODSHED, encoding: 'utf8', env: { PATH: process.env.PATH, RUNNER_TEMP: temp } });
  assert.match(out, /^\.woodshed\/project\.yaml: read from the checkout$/m);
});

test('Woodshed\'s own Check calls it at the commit under test', () => {
  const job = workflow('check.yml').jobs['project-check'];
  assert.deepEqual(job, {
    uses: './.github/workflows/project-check.yml',
    with: { ref: '${{ github.event.pull_request.head.sha || github.sha }}', repository: '${{ github.repository }}' },
  });
});
