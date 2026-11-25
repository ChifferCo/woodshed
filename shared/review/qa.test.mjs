import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildAnalysisPrompt } from './analyze.mjs';
import {
  seniorArgv, buildGeneratedQaPrompt, buildAnswersPrompt,
  generatedItems, applyAnswers, pathTo, extractStructured,
} from './qa.mjs';

function flag(argv, name) {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

test('generated questions and answers share the read tools and one output schema', () => {
  for (const followups of [false, true]) {
    const argv = seniorArgv({ prompt: 'p', generated: true, followups });
    assert.equal(flag(argv, '--tools'), 'Read,Grep,Glob');
    const pair = JSON.parse(flag(argv, '--json-schema')).properties.questions.items;
    assert.deepEqual(pair.required, followups ? ['question', 'answer', 'about'] : ['question', 'answer']);
    for (const flag of ['--strict-mcp-config', '--setting-sources', '--no-session-persistence']) assert.ok(argv.includes(flag));
  }
});

test('generated Q&A gets the saved diff and uses the provider\'s code access', () => {
  const files = [{ path: 'images.mjs', hunks: [{ header: '@@ -0,0 +1 @@', lines: [{ type: 'add', text: 'loadPreview();' }] }] }];
  const context = { meta: {}, files, frontier: [] };
  const claude = buildGeneratedQaPrompt(context);
  const codex = buildGeneratedQaPrompt({ ...context, diffOnly: true });
  assert.match(claude, /Read the relevant changed files/);
  assert.match(claude, /"text":"loadPreview\(\);"/);
  assert.match(codex, /Use the supplied diff as your code context/);
  assert.doesNotMatch(codex, /working directory/);
});

test('the answerer reads the checkout and nothing else', () => {
  const argv = seniorArgv({ prompt: 'p' });
  assert.equal(flag(argv, '--tools'), 'Read,Grep,Glob');
  assert.ok(!argv.includes('--system-prompt'));
  assert.ok(argv.includes('--no-session-persistence'));
});

test('a follow-up hangs only off an answer from the previous round, at most two each', () => {
  const frontier = [
    { id: 'q1', parent: null, depth: 1, question: 'a', answer: 'x' },
    { id: 'q2', parent: null, depth: 1, question: 'b', answer: 'y' },
  ];
  const got = generatedItems({
    questions: [
      { about: 'q1', answer: 'Answer.', question: 'what is a proxy?' },
      { about: 'q9', answer: 'Answer.', question: 'made-up parent' },
      { about: 'q1', answer: 'Answer.', question: 'second' },
      { about: 'q1', answer: 'Answer.', question: 'third, over the cap' },
      { about: 'q2', answer: 'Answer.', question: '   ' },
      { about: 'q2', answer: '', question: 'incomplete' },
      { about: ' q2 ', answer: 'Answer.', question: 'what is egress?' },
    ],
  }, frontier);
  assert.deepEqual(got.map((i) => [i.id, i.parent, i.depth]), [['q1.1', 'q1', 2], ['q1.2', 'q1', 2], ['q2.1', 'q2', 2]]);
});

test('answers land on their own questions only, once', () => {
  const open = [
    { id: 'q1', question: 'What is this?', answer: null },
    { id: 'q2', question: 'Why?', answer: null },
  ];
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
  const followups = buildGeneratedQaPrompt({ meta, files: [], overview: '', items, frontier: [items[1]] });
  assert.match(followups, /question: What does the relay do\?\nanswer: It forwards MCP calls\.\nquestion: What is MCP\?\nanswer: A protocol\./);
});

// A worktree review has no pull request: its title ("Work in progress on <branch>") and body (a count of commits)
// are the shed's, made for the page's header. Put to the newcomer as the author's, every Q&A opened by asking what
// the change was for, "since the title just says Work in progress and the description only counts commits".
test('a worktree review\'s made-up title and body are not handed over as the author\'s', () => {
  const meta = {
    state: 'WORKTREE', title: 'Work in progress on feature-x', headRefName: 'feature-x',
    body: 'This worktree is 2 commits and 1 uncommitted file ahead of main.',
  };
  const files = [{ path: 'a.mjs', additions: 1, deletions: 0, status: 'modified' }];
  const top = buildGeneratedQaPrompt({ meta, files, overview: '', frontier: [] });
  const answers = buildAnswersPrompt({ meta, files, overview: '', items: [], open: [] });
  const analysis = buildAnalysisPrompt({ meta, files });
  for (const prompt of [top, answers, analysis]) {
    assert.doesNotMatch(prompt, /Work in progress on/);
    assert.doesNotMatch(prompt, /written by the author\):/);
    assert.match(prompt, /title: \(none: the change is still being made on feature-x/);
    assert.match(prompt, /do\s+not ask about or remark on them/);
  }
  assert.doesNotMatch(top, /Ask about the words in the title/);
  assert.doesNotMatch(analysis, /written by the PR author/);
  assert.match(buildAnalysisPrompt({ meta: { title: 'x', body: 'y' }, files }), /written by the PR author/);

  const pr = { state: 'OPEN', title: 'Add the relay', body: 'It forwards calls.', number: 7 };
  const prTop = buildGeneratedQaPrompt({ meta: pr, files, overview: '', frontier: [] });
  assert.match(prTop, /title: Add the relay\ndescription \(written by the author\):\nIt forwards calls\./);
  assert.match(prTop, /Study the code context before writing both the questions and their answers/);
  assert.match(prTop, /Read the relevant changed files/);
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
