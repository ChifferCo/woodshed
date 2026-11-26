import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_REPORT_CHARS, SPINNER_HTML, finishedComment, isWebm, parseQaReport, runningComment, videoLine } from './qaSessions.mjs';

const VERDICT = { conclusion: 'neutral', title: 'Not covered: nothing to test', status: '⏭️ **Not covered**: Docs only', total: 0 };
const SHA = 'c'.repeat(40);

test('the QA comment says it is running, then gives the verdict, the report when it has test cases, and the session', () => {
  assert.equal(runningComment({ heading: '## QA', sessionUrl: null }), `## QA\n\n**Running** in a Woodshed session: planning the tests, then running them in a browser, which it records. ${SPINNER_HTML}\n`);
  const skipped = finishedComment({ heading: '## QA', verdict: VERDICT, report: '', sessionUrl: 'https://c/s/1' });
  assert.equal(skipped, '## QA\n\n⏭️ **Not covered**: Docs only\n\n---\n\nRun in [a Woodshed session](https://c/s/1), whose terminal shows the run.\n');
  const passed = finishedComment({ heading: '## QA', verdict: { ...VERDICT, total: 1, status: '✅ **Pass**' }, report: '## TC-1: a ✅\n', sessionUrl: null });
  assert.equal(passed, '## QA\n\n✅ **Pass**\n\n## TC-1: a ✅\n\n');
});

test('the finished QA comment shows a still of the recording, linked to it on the console, ahead of the report', () => {
  const one = [{ url: 'https://console.example/qa/ab12cd34/video/1', bytes: 3 * 1024 * 1024 }];
  assert.equal(videoLine(one), '🎥 **Recording** of the browser during the tests, on the console for 14 days (sign in to watch): [watch](https://console.example/qa/ab12cd34/video/1) (3.0 MB)');
  const poster = 'https://console.example/qa-poster/ab12cd34/' + 'f'.repeat(32) + '.png';
  assert.equal(videoLine(one, poster), `[![The QA run's recording](${poster})](https://console.example/qa/ab12cd34/video/1)\n\n${videoLine(one)}`, 'the still opens the first video');
  assert.match(videoLine([...one, { url: 'u2', bytes: 512 * 1024 }]), /a video for each page it opened, .*\[page 1\]\(https:\/\/console.example\/qa\/ab12cd34\/video\/1\) \(3.0 MB\) · \[page 2\]\(u2\) \(0.5 MB\)$/);
  assert.equal(videoLine([]), '');
  assert.equal(videoLine([], poster), '', 'no still without a video to open');
  const open = [{ url: `https://console.example/qa-video/ab12cd34/${'c'.repeat(32)}/1.webm`, bytes: 3 * 1024 * 1024 }];
  assert.equal(videoLine(open, null, true), `🎥 **Recording** of the browser during the tests, on the console for 14 days: [watch](${open[0].url}) (3.0 MB)`, 'a public repo\'s needs no sign-in');
  const passed = finishedComment({ heading: '## QA', verdict: { ...VERDICT, total: 1, status: '✅ **Pass**' }, report: '## TC-1: a ✅\n', sessionUrl: null, videos: one, poster });
  assert.equal(passed, `## QA\n\n✅ **Pass**\n\n${videoLine(one, poster)}\n\n## TC-1: a ✅\n\n`);
});

test('a QA video must be WebM', () => {
  assert.equal(isWebm(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01])), true);
  assert.equal(isWebm(Buffer.from('<html>')), false);
  assert.equal(isWebm(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])), false, 'a header alone is no video');
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
