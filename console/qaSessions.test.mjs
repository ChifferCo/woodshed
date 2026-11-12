import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_REPORT_CHARS, finishedComment, parseQaReport, runningComment } from './qaSessions.mjs';

const VERDICT = { conclusion: 'neutral', title: 'Not covered: nothing to test', status: '⏭️ **Not covered**: Docs only', total: 0 };
const SHA = 'c'.repeat(40);

test('the QA comment says it is running, then gives the verdict, the report when it has test cases, and the session', () => {
  assert.equal(runningComment({ heading: '## QA', sessionUrl: null }), '## QA\n\n⏳ **Running** in a Woodshed session: planning the tests, then running them in a browser.\n');
  const skipped = finishedComment({ heading: '## QA', verdict: VERDICT, report: '', sessionUrl: 'https://c/s/1' });
  assert.equal(skipped, '## QA\n\n⏭️ **Not covered**: Docs only\n\n---\n\nRun in [a Woodshed session](https://c/s/1), whose terminal shows the run.\n');
  const passed = finishedComment({ heading: '## QA', verdict: { ...VERDICT, total: 1, status: '✅ **Pass**' }, report: '## TC-1: a ✅\n', sessionUrl: null });
  assert.equal(passed, '## QA\n\n✅ **Pass**\n\n## TC-1: a ✅\n\n');
});

test('a QA report must carry a known conclusion and the commit it tested; the report is cut to fit a comment', () => {
  const body = (over) => JSON.stringify({ verdict: VERDICT, report: 'r', sha: SHA, costUsd: 0.4, ...over });
  assert.deepEqual(parseQaReport(body()), { verdict: VERDICT, report: 'r', sha: SHA, costUsd: 0.4 });
  assert.equal(parseQaReport(body({ costUsd: 'free' })).costUsd, null);
  assert.equal(parseQaReport(body({ report: 'x'.repeat(MAX_REPORT_CHARS + 10) })).report.length, MAX_REPORT_CHARS);
  assert.throws(() => parseQaReport('nope'), /body must be JSON/);
  assert.throws(() => parseQaReport(body({ verdict: { ...VERDICT, conclusion: 'cancelled' } })), /conclusion must be/);
  assert.throws(() => parseQaReport(body({ verdict: { conclusion: 'success' } })), /title, a status and a total/);
  assert.throws(() => parseQaReport(body({ sha: 'main' })), /sha must be a commit/);
});
