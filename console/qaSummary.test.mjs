import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summaryProblem } from './qaSummary.mjs';

const PULL = { number: 7, base: 'main' };
const GOOD = `QA of pull request #7 against main, session 0a1b2c3d

## steps
[qa 10:02:11] QA of pull request #7 against main
[qa 10:02:12] QA notes: .woodshed/qa.md
[qa 10:02:13] Planning the tests
[qa 10:05:40] Starting the app
[qa 10:06:21] Running the tests at http://localhost:3999, recording the browser

## plan
Ended: finished (success)
Ran: 22 turns, 31 tool calls, 207 s, $0.84
Said: 4 messages

## test
Ended: ran out of turns before it finished (error_max_turns)
Ran: 200 turns, 311 tool calls, 2086 s, $6.12
Permission denied: 2 calls
Tool errors: 3 (2 timeout, 1 connection refused)
Said: 87 messages
Other output: 1 line

No report.md was written.
`;

test('a summary made of the lines the run\'s script writes is fine', () => {
  assert.equal(summaryProblem(GOOD, PULL), null);
  assert.equal(summaryProblem(GOOD.replace('Planning the tests', 'No test plan'), PULL), null);
});

test('a summary with any other text is refused, wherever the text is', () => {
  const secret = 'zzOpaque7788';
  for (const bad of [
    `${GOOD}${secret}\n`,
    GOOD.replace('Said: 4 messages', `Said: ${secret}`),
    GOOD.replace('[qa 10:02:13] Planning the tests', `[qa 10:02:13] ${secret}`),
    GOOD.replace('Ended: finished (success)', `Ended: finished (${secret})`),
    GOOD.replace('(2 timeout, 1 connection refused)', `(2 timeout, 1 ${secret})`),
    GOOD.replace('Ran: 22 turns', `Ran: ${secret} turns`),
    GOOD.replace('Permission denied: 2 calls', `Permission denied: 2 calls (${secret})`),
    `${secret}\n${GOOD}`,
    '',
  ]) {
    assert.match(String(summaryProblem(bad, PULL)), /not/, bad.slice(0, 60));
  }
});

test('what names the pull request must be this session\'s', () => {
  assert.match(summaryProblem(GOOD, { number: 8, base: 'main' }), /heading/);
  assert.match(summaryProblem(GOOD, { number: 7, base: 'release' }), /heading/);
  assert.equal(summaryProblem(GOOD.replace(/against main/g, 'against feature/a.b'), { number: 7, base: 'feature/a.b' }), null, 'a base with regex characters is matched as text');
});
