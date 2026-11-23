import test from 'node:test';
import assert from 'node:assert/strict';

import { checkNamesOf, checkRunsOf, prChecksOf } from './prChecks.mjs';

const HEAD = 'a'.repeat(40);
const commit = (...suites) => ({ oid: HEAD, checkSuites: { nodes: suites.map(([app, runs]) => ({ app: { slug: app }, checkRuns: { nodes: runs } })) } });

test('the merge risk check gives its tier and reason, and QA its verdict, both on the head commit', () => {
  const runs = checkRunsOf(commit(
    ['woodshed-reviewer', [{ name: 'Merge risk', status: 'COMPLETED', conclusion: 'NEUTRAL', title: 'High: touches the billing path', summary: 'Why.', permalink: 'https://x/1', completedAt: '2026-11-01T00:00:00Z' }]],
    ['github-actions', [
      { name: 'QA', status: 'COMPLETED', conclusion: 'FAILURE', title: '1 of 3 failed', summary: 'Report', detailsUrl: 'https://x/2', completedAt: '2026-11-01T00:00:00Z' },
      { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', title: '', summary: '' },
    ]],
  ));
  const { mergeRisk, qa } = prChecksOf({ runs, labels: ['merge risk: low'], headSha: HEAD, names: checkNamesOf(null) });
  assert.equal(mergeRisk.tier, 'High');
  assert.equal(mergeRisk.reason, 'touches the billing path');
  assert.equal(mergeRisk.fromLabel, false, 'the check wins over a label from an earlier review');
  assert.equal(mergeRisk.url, 'https://x/1');
  assert.equal(mergeRisk.app, 'woodshed-reviewer');
  assert.equal(qa.conclusion, 'failure');
  assert.equal(qa.title, '1 of 3 failed');
  assert.equal(qa.url, 'https://x/2');
  assert.equal(qa.current, true);
});

test('with no check, the merge risk label is read as an older commit\'s', () => {
  const { mergeRisk, qa } = prChecksOf({ runs: [], labels: ['bug', 'Merge risk: medium'], headSha: HEAD, names: checkNamesOf(null) });
  assert.equal(mergeRisk.tier, 'Medium');
  assert.equal(mergeRisk.fromLabel, true);
  assert.equal(mergeRisk.current, false);
  assert.equal(qa, null, 'no QA check and none asked for: nothing to show');
});

test('the project file names the checks, and one it asks for and GitHub lacks is missing', () => {
  const text = [
    'version: 1',
    'pullRequests:',
    '  review: { workflow: review.yml, author: "acme[bot]", heading: "## Claude review" }',
    '  qa: { check: Browser QA, label: qa, heading: "## QA", author: "acme[bot]" }',
    '  mergeRisk: { check: Risk }',
  ].join('\n');
  const names = checkNamesOf(text);
  assert.deepEqual(names, { mergeRisk: 'Risk', qa: 'Browser QA', asks: { mergeRisk: true, qa: true } });
  const runs = [{ name: 'QA', status: 'COMPLETED', conclusion: 'SUCCESS', title: 'not this one' }, { name: 'Browser QA', status: 'IN_PROGRESS', conclusion: null, title: 'Running' }];
  const { mergeRisk, qa } = prChecksOf({ runs, labels: [], headSha: HEAD, names });
  assert.deepEqual(mergeRisk, { name: 'Risk', missing: true });
  assert.equal(qa.status, 'in_progress');
  assert.equal(qa.title, 'Running');
});

test('a project file that does not read gives the default names, asking for neither', () => {
  assert.deepEqual(checkNamesOf('version: 1\npullRequests: [nope'), { mergeRisk: 'Merge risk', qa: 'QA', asks: { mergeRisk: false, qa: false } });
});

test('the newest run of a name wins', () => {
  const runs = [
    { name: 'QA', status: 'COMPLETED', conclusion: 'FAILURE', title: 'old', completedAt: '2026-11-01T00:00:00Z' },
    { name: 'QA', status: 'COMPLETED', conclusion: 'SUCCESS', title: 'new', completedAt: '2026-11-02T00:00:00Z' },
  ];
  assert.equal(prChecksOf({ runs, headSha: HEAD }).qa.title, 'new');
});
