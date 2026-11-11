import { test } from 'node:test';
import assert from 'node:assert/strict';

import { jobMatches, workflowJobs } from './workflowFile.mjs';

const WORKFLOW = `name: CI
on: [push]
jobs:
  # The gate.
  gate:
    name: Checks the commit message   # a comment
    runs-on: ubuntu-latest
    steps:
      - name: Not the job's name
        run: |
          name: nor this
  "e2e":
    name: \${{ matrix.kind == 'flaky' && 'Flaky check' || format('E2E run ({0}/{1})', matrix.shard, 4) }}
    strategy: { matrix: { shard: [1, 2, 3, 4] } }
  review:
    uses: acme/reviews/.github/workflows/review.yml@main
  test:
    runs-on: ubuntu-latest
concurrency: ci
`;

test('a workflow\'s jobs are read line by line: ids, and the job\'s own name and uses, not a step\'s', () => {
  assert.deepEqual(workflowJobs(WORKFLOW), [
    { id: 'gate', name: 'Checks the commit message', uses: null },
    { id: 'e2e', name: "${{ matrix.kind == 'flaky' && 'Flaky check' || format('E2E run ({0}/{1})', matrix.shard, 4) }}", uses: null },
    { id: 'review', name: null, uses: 'acme/reviews/.github/workflows/review.yml@main' },
    { id: 'test', name: null, uses: null },
  ]);
  assert.deepEqual(workflowJobs('on: push\njobs: {}\n'), []);
  assert.throws(() => workflowJobs('on: push\n'), /no jobs: section/);
});

test('a job matches the prefixes its check runs\' names start with', () => {
  const [gate, e2e, review, plain] = workflowJobs(WORKFLOW);
  const matches = (job, prefixes) => prefixes.map((p) => jobMatches(job, p));
  assert.deepEqual(matches(gate, ['Checks', 'Checks the commit message', 'Checks the commit message (a', 'gate', 'Lint']), [true, true, true, false, false]);
  assert.deepEqual(matches(e2e, ['E2E run', 'E2E run (1', 'Flaky', 'E2E', 'e2e', 'Unit']), [true, true, true, true, false, false]);
  assert.deepEqual(matches(review, ['review', 'review / Claude review', 'Claude review']), [true, true, false]);
  assert.deepEqual(matches(plain, ['test', 'te', 'test (22, ubuntu)', 'tests']), [true, true, true, false]);
});
