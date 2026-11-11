import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseYaml } from '../shared/yamlLite.mjs';

// .github/workflows/review.yml: what the reviewer hands the resolve-threads job, and which threads that job resolves.
const WORKFLOW = path.resolve(import.meta.dirname, '../.github/workflows/review.yml');
const { jobs } = parseYaml(fs.readFileSync(WORKFLOW, 'utf8'));
const HAS_JQ = (() => {
  try {
    execFileSync('jq', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function step(job, name) {
  const found = jobs[job].steps.find((s) => s.name === name);
  assert.ok(found, `${job} has a step named ${name}`);
  return found;
}

test('every run block of the review starts with a comment, which Actions shows as the step\'s header', () => {
  for (const [name, job] of Object.entries(jobs)) {
    for (const s of job.steps.filter((x) => x.run)) assert.match(s.run, /^# \S/, `${name}: ${s.name}`);
  }
});

test('the reviewer never gets contents: write; the resolve job has it, after an APPROVE, with the reviewer\'s ids', () => {
  assert.notEqual(jobs.review.permissions.contents, 'write');
  const resolve = jobs['resolve-threads'];
  assert.deepEqual([resolve.needs, resolve.if, resolve.permissions.contents], ['review', "needs.review.outputs.verdict == 'APPROVE'", 'write']);
  assert.ok(!resolve.steps.some((s) => s.uses), 'no checkout and no Claude in the job that can write');
  assert.equal(jobs.review.outputs.resolved, '${{ steps.resolved.outputs.ids }}');
  assert.equal(step('resolve-threads', "Resolve the review's fixed threads").env.FIXED_IDS, '${{ needs.review.outputs.resolved }}');
});

test('the ids handed on are the reviewer\'s digit-only lines, once each', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-review-'));
  try {
    const script = step('review', 'Hand on the threads the reviewer found fixed').run.replaceAll('/tmp/', `${tmp}/`);
    const output = path.join(tmp, 'output');
    const run = () => {
      fs.writeFileSync(output, '');
      execFileSync('bash', ['-e', '-c', script], { env: { PATH: process.env.PATH, GITHUB_OUTPUT: output } });
      return fs.readFileSync(output, 'utf8');
    };
    assert.equal(run(), 'ids=\n', 'no file, no ids');
    fs.writeFileSync(path.join(tmp, 'claude-resolved.txt'), '42\nnot an id\n 7\n42\n12345678901234567890\n9\n');
    assert.equal(run(), 'ids=42 9\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('only the review\'s own open threads are resolved: the outdated ones and those it found fixed', { skip: !HAS_JQ && 'no jq' }, () => {
  const { run } = step('resolve-threads', "Resolve the review's fixed threads");
  const filter = run.match(/^filter='([^']*)'$/m)?.[1];
  assert.ok(filter, 'the step keeps its filter in filter=\'…\'');
  const thread = (id, { by = 'github-actions', comment, outdated = false, resolved = false }) => ({
    id, isResolved: resolved, isOutdated: outdated, comments: { nodes: [{ databaseId: comment, author: { login: by } }] },
  });
  const nodes = [
    thread('fixed', { comment: 1 }),
    thread('fixedBot', { comment: 2, by: 'github-actions[bot]' }),
    thread('outdated', { comment: 3, outdated: true }),
    thread('stillOpen', { comment: 4 }),
    thread('person', { comment: 5, by: 'octocat' }),
    thread('done', { comment: 6, resolved: true }),
  ];
  const pick = (ids) => JSON.parse(execFileSync('jq', ['-c', '--arg', 'ids', ids, filter], { input: JSON.stringify(nodes), encoding: 'utf8' }));
  assert.deepEqual(pick(''), { threads: 6, unresolved: 5, own: 4, outdated: 1, given: 0, matched: 0, ids: ['outdated'] }, 'as before: outdated only');
  assert.deepEqual(pick('1 2 5 6 99 x').ids.sort(), ['fixed', 'fixedBot', 'outdated'], 'a person\'s, a resolved and a made-up id do nothing');
  assert.deepEqual([pick('1 2 5 6 99').given, pick('1 2 5 6 99').matched], [5, 2]);
});
