import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promptFor, verdictOf, verdictIn, writePrompts } from './qa.mjs';

const QA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'qa.mjs');
const none = { report: null, skip: null, noPlan: null, notCovered: null };

test('the verdict: a failed test case fails, anything short of a verdict is neutral, and edge cases never decide it', () => {
  const cases = [
    [{ report: '## TC-1: a ✅\n\n## TC-2: b ✅\n\n## EC-1: c ⚠️\n' }, 'success', 'Pass: 2 test cases passed'],
    [{ report: '## TC-1: a ✅\n## TC-2: b ❌\n' }, 'failure', 'Fail: 1 of 2 test cases failed'],
    [{ report: '## TC-1: a ✅\n## TC-2: b ❓\n' }, 'neutral', 'Not covered: 1 of 2 test cases unverified'],
    [{ report: '## TC-1: a ✅\n## EC-1: b ❌\n' }, 'success', 'Pass: 1 test cases passed'],
    [{ report: '## TC-1: ❌ in the title, then ✅\n' }, 'success', 'Pass: 1 test cases passed'],
    [{ skip: 'Docs only' }, 'neutral', 'Not covered: nothing to test'],
    [{ noPlan: 'the planner ran out of turns' }, 'neutral', 'Not covered: no test plan'],
    [{}, 'neutral', 'Not covered: no QA report'],
    [{ report: '## TC-1: a ✅\n', notCovered: 'the app did not start' }, 'neutral', 'Not covered: the app did not start'],
  ];
  for (const [given, conclusion, title] of cases) {
    const v = verdictOf({ ...none, ...given });
    assert.deepEqual([v.conclusion, v.title], [conclusion, title], JSON.stringify(given));
  }
  assert.equal(verdictOf({ ...none, report: cases[0][0].report }).status, '✅ **Pass**: all 2 test cases passed · ⚠️ 1 edge case to look at');
  assert.equal(verdictOf({ ...none, skip: 'Docs only' }).status, '⏭️ **Not covered**: Docs only');
});

test('the prompts fill in the app, the base and the rubric, and end with the repo notes or say there are none', () => {
  const plan = promptFor({ kind: 'plan', appUrl: 'http://localhost:3000', base: 'main', rubric: '.qa/rubric.md', notes: 'Sign in as demo.' });
  assert.match(plan, /running at http:\/\/localhost:3000/);
  assert.match(plan, /git diff origin\/main\.\.\.HEAD/);
  assert.match(plan, /`\.qa\/rubric\.md`/);
  assert.doesNotMatch(plan, /\{\{/);
  assert.ok(plan.endsWith("# The repository's QA notes\n\nSign in as demo.\n"));
  const testPrompt = promptFor({ kind: 'test', appUrl: 'http://x', base: 'main', rubric: 'r.md', notes: null });
  assert.ok(testPrompt.endsWith('No QA notes on the base branch\n'));
});

test('the command line writes the prompts and reads a run folder into the same verdict', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-'));
  const notes = path.join(dir, 'notes.md');
  fs.writeFileSync(notes, 'Seeded: one demo account.');
  execFileSync('node', [QA, 'prompts', dir, '--app-url', 'http://localhost:3001', '--base', 'trunk', '--notes', notes]);
  assert.match(fs.readFileSync(path.join(dir, 'test-prompt.md'), 'utf8'), /Seeded: one demo account\./);
  assert.ok(fs.existsSync(path.join(dir, 'rubric.md')));
  writePrompts({ dir, appUrl: 'http://a', base: 'b', notes: null });

  fs.mkdirSync(path.join(dir, 'plan'));
  fs.writeFileSync(path.join(dir, 'plan', 'SKIP.md'), 'Test-only change\nmore');
  const skipped = JSON.parse(execFileSync('node', [QA, 'verdict', dir], { encoding: 'utf8' }));
  assert.deepEqual([skipped.conclusion, skipped.status], ['neutral', '⏭️ **Not covered**: Test-only change']);
  fs.rmSync(path.join(dir, 'plan', 'SKIP.md'));
  fs.writeFileSync(path.join(dir, 'report.md'), '## TC-1: a ✅\n');
  assert.equal(verdictIn({ dir, notCovered: '' }).conclusion, 'success');
  const down = JSON.parse(execFileSync('node', [QA, 'verdict', dir, '--not-covered', 'app down'], { encoding: 'utf8' }));
  assert.equal(down.title, 'Not covered: app down');
});
