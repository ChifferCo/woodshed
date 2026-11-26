import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewSummaryProblem } from './reviewSummary.mjs';

const PULL = { number: 7, base: 'main' };
const GOOD = `Review of pull request #7 against main, session 0a1b2c3d

## steps
[review 10:02:11] Review of pull request #7 against main
[review 10:02:13] Reviewing the diff with Claude Code, Codex and Grok Build
[review 10:03:40] Codex reviews on a key the console adds to its calls (the author's or the team's)
[review 10:07:02] Codex ended (exit=0)
[review 10:07:03] Grok Build took longer than 20 minutes and was stopped
[review 10:07:03] Waiting for Codex and Grok Build to finish
[review 10:07:04] Codex wrote no verdict: it ran past its time limit and was stopped

## review
Ended: ran out of turns before it finished (error_max_turns)
Ran: 60 turns, 91 tool calls, 612 s, $2.40
Tool errors: 2 (1 timeout, 1 not found)
Said: 12 messages

## verdict
Verdict: none
`;

test('a review summary made of the lines the script writes is fine, at each point of the run', () => {
  assert.equal(reviewSummaryProblem(GOOD, PULL), null);
  assert.equal(reviewSummaryProblem(GOOD.replace('Verdict: none', 'Verdict: not yet').replace(/## review[\s\S]*## verdict/, '## review\nStarted; its outcome is not known yet.\n\n## verdict'), PULL), null);
});

test('a review summary with any other text is refused, wherever it is', () => {
  const secret = 'zzOpaque7788';
  for (const bad of [
    `${GOOD}${secret}\n`,
    GOOD.replace('Verdict: none', `Verdict: ${secret}`),
    GOOD.replace('Codex ended (exit=0)', `Codex ended (exit=${secret})`),
    GOOD.replace('Reviewing the diff with Claude Code, Codex and Grok Build', `Reviewing the diff of ${secret}`),
    GOOD.replace('Reviewing the diff with Claude Code, Codex and Grok Build', `Reviewing the diff with ${secret}`),
    GOOD.replace('(error_max_turns)', '(opaque_registry_credential)'),
    GOOD.replace('Tool errors: 2 (1 timeout, 1 not found)', `Tool errors: 2 (1 timeout, 1 ${secret})`),
    GOOD.replace('## verdict', `## ${secret}`),
    GOOD.replace('[review 10:07:02]', '[qa 10:07:02]'),
    '',
  ]) {
    assert.match(String(reviewSummaryProblem(bad, PULL)), /not/, bad.slice(0, 60));
  }
});

test('what names the pull request must be this session\'s', () => {
  assert.match(reviewSummaryProblem(GOOD, { number: 8, base: 'main' }), /heading/);
  assert.match(reviewSummaryProblem(GOOD, { number: 7, base: 'release' }), /heading/);
});
