import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  JUNIOR_SYSTEM_PROMPT, juniorArgv, seniorArgv, buildFollowupsPrompt, buildAnswersPrompt,
  topQuestions, followupQuestions, applyAnswers, pathTo, extractStructured,
} from './qa.mjs';

function flag(argv, name) {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

// The newcomer's questions are only a newcomer's while it cannot read the code: with tools it would read the
// checkout first and ask what a model that has read it thinks a newcomer should. And the persona has to be the
// whole system prompt, which is what was asked for, not a line appended to Claude Code's own.
test('the newcomer runs with no tools and the persona as its whole system prompt', () => {
  const argv = juniorArgv({ prompt: 'p', followups: false });
  assert.equal(flag(argv, '--tools'), '');
  assert.equal(flag(argv, '--system-prompt'), JUNIOR_SYSTEM_PROMPT);
  assert.ok(!argv.includes('--append-system-prompt'));
  // The containment every review run has: no MCP, no project settings, no transcript in the session's project.
  for (const f of ['--strict-mcp-config', '--setting-sources', '--no-session-persistence']) assert.ok(argv.includes(f), f);
});

test('the answerer reads the checkout and nothing else', () => {
  const argv = seniorArgv({ prompt: 'p' });
  assert.equal(flag(argv, '--tools'), 'Read,Grep,Glob');
  assert.ok(!argv.includes('--system-prompt'));
  assert.ok(argv.includes('--no-session-persistence'));
});

test('a follow-up hangs only off an answer the newcomer was just given, at most two each', () => {
  const frontier = [
    { id: 'q1', parent: null, depth: 1, question: 'a', answer: 'x' },
    { id: 'q2', parent: null, depth: 1, question: 'b', answer: 'y' },
  ];
  const got = followupQuestions({
    questions: [
      { about: 'q1', question: 'what is a proxy?' },
      { about: 'q9', question: 'made-up parent' },
      { about: 'q1', question: 'second' },
      { about: 'q1', question: 'third, over the cap' },
      { about: 'q2', question: '   ' },
      { about: ' q2 ', question: 'what is egress?' },
    ],
  }, frontier);
  assert.deepEqual(got.map((i) => [i.id, i.parent, i.depth]), [['q1.1', 'q1', 2], ['q1.2', 'q1', 2], ['q2.1', 'q2', 2]]);
});

test('answers land on their own questions only, once', () => {
  const open = topQuestions({ questions: ['What is this?', '', 'Why?'] });
  assert.deepEqual(open.map((i) => i.id), ['q1', 'q2']);
  const landed = applyAnswers(open, {
    answers: [{ id: 'q2', answer: 'Because.' }, { id: 'q7', answer: 'stray' }, { id: 'q2', answer: 'again' }],
  });
  assert.equal(landed, 1);
  assert.equal(open[0].answer, null);
  assert.equal(open[1].answer, 'Because.');
});

test('a follow-up carries the questions and answers above it into both prompts', () => {
  const items = [
    { id: 'q1', parent: null, depth: 1, question: 'What does the relay do?', answer: 'It forwards MCP calls.' },
    { id: 'q1.1', parent: 'q1', depth: 2, question: 'What is MCP?', answer: null },
  ];
  assert.deepEqual(pathTo(items, 'q1.1').map((i) => i.id), ['q1', 'q1.1']);
  const meta = { title: 't', body: 'b' };
  const answers = buildAnswersPrompt({ meta, files: [], overview: '', items, open: [items[1]] });
  assert.match(answers, /earlier question: What does the relay do\?/);
  assert.match(answers, /earlier answer: It forwards MCP calls\./);
  assert.match(answers, /--- id: q1\.1\n\(earlier question: [^\n]*\n\(earlier answer: [^\n]*\nquestion: What is MCP\?/);
  items[1].answer = 'A protocol.';
  const followups = buildFollowupsPrompt({ meta, files: [], overview: '', items, frontier: [items[1]] });
  assert.match(followups, /\(earlier, you asked: What does the relay do\?\)\nyou asked: What is MCP\?\nanswer:\nA protocol\./);
});

test('a run that failed or answered in no structure is a failure with its reason', () => {
  assert.deepEqual(extractStructured({ phase: 'failed', error: 'timed out' }), { ok: false, error: 'timed out' });
  assert.equal(extractStructured({ phase: 'done', stdout: '{"is_error":true,"result":"budget"}' }).error, 'budget');
  assert.equal(extractStructured({ phase: 'done', stdout: '{"result":"prose"}' }).ok, false);
  const ok = extractStructured({ phase: 'done', stdout: '{"structured_output":{"questions":["a"]},"total_cost_usd":0.01}' });
  assert.deepEqual(ok, { ok: true, value: { questions: ['a'] }, costUsd: 0.01 });
});

// A Q&A answers questions about one diff. Left on disk after a re-review or Discard, the page would show answers about
// code that is gone, with nothing to say so.
test('dropping the artifact drops the Q&A with it', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-store-'));
  process.env.WOODSHED_REVIEWS = dir;
  const { writeQa, readQa, writeArtifact, removeArtifact } = await import(`./store.mjs?qa=${Date.now()}`);
  const session = 'claude-0a0a0a0a';
  writeArtifact({ session, artifact: { overview: 'x', groups: [] } });
  writeQa({ session, qa: { status: 'ready', items: [{ id: 'q1', parent: null, depth: 1, question: 'a', answer: 'b' }] } });
  assert.equal(readQa(session).items.length, 1);
  removeArtifact(session);
  assert.equal(readQa(session), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
