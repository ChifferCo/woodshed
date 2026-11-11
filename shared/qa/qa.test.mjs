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

test('every test case passing passes, and an edge case to look at is flagged without changing that', () => {
  const v = verdictOf({ ...none, report: '## TC-1: a ✅\n\n## TC-2: b ✅\n\n## EC-1: c ⚠️\n' });
  assert.equal(v.conclusion, 'success');
  assert.equal(v.title, 'Pass: 2 test cases passed');
  assert.equal(v.status, '✅ **Pass**: all 2 test cases passed · ⚠️ 1 edge case to look at');
});

test('one failed test case fails the run', () => {
  const v = verdictOf({ ...none, report: '## TC-1: a ✅\n## TC-2: b ❌\n' });
  assert.deepEqual([v.conclusion, v.title], ['failure', 'Fail: 1 of 2 test cases failed']);
});

test('a test case that could not be verified is neutral, not a pass', () => {
  const v = verdictOf({ ...none, report: '## TC-1: a ✅\n## TC-2: b ❓\n' });
  assert.deepEqual([v.conclusion, v.title], ['neutral', 'Not covered: 1 of 2 test cases unverified']);
});

test('nothing to test, no plan, no report or an app that did not start are neutral, and say why', () => {
  assert.equal(verdictOf({ ...none, skip: 'Docs only' }).status, '⏭️ **Not covered**: Docs only');
  assert.equal(verdictOf({ ...none, noPlan: 'the planner ran out of turns' }).title, 'Not covered: no test plan');
  assert.equal(verdictOf(none).title, 'Not covered: no QA report');
  const down = verdictOf({ ...none, report: '## TC-1: a ✅\n', notCovered: 'the app did not start' });
  assert.deepEqual([down.conclusion, down.title], ['neutral', 'Not covered: the app did not start']);
  for (const v of [verdictOf({ ...none, skip: 'x' }), verdictOf(none)]) assert.equal(v.conclusion, 'neutral');
});

test('an edge case marked ❌ never fails the run, and a mark mid-title does not count', () => {
  assert.equal(verdictOf({ ...none, report: '## TC-1: a ✅\n## EC-1: b ❌\n' }).conclusion, 'success');
  assert.equal(verdictOf({ ...none, report: '## TC-1: ❌ in the title, then ✅\n' }).conclusion, 'success');
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
