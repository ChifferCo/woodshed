// node --test review/jobs.test.mjs
//
// The memory budget: two `claude` children at most, one for background work (the analysis, the Q&A) and one for what
// someone is waiting on (an explain, a chat turn). Counted per kind, each new kind was a third process beside them,
// about 400 MB that the box's sessions and apps were counting on.
//
// `claude` here is a stand-in that sleeps, found first on the PATH: this is about how many run at once, not what any
// of them says, so nothing a model returns is faked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('the Q&A waits for the analysis and the chat for an explain, so two claude run at most', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-jobs-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.WOODSHED_REVIEWS = path.join(dir, 'reviews');
  const { startJob, jobCounts, cancelJobsForSession } = await import('./jobs.mjs');
  const session = 'claude-1b1b1b1b';
  const log = () => {};
  try {
    const started = {};
    for (const kind of ['analysis', 'explain', 'qa', 'chat']) {
      started[kind] = startJob({ kind, session, argv: ['-p', 'x'], cwd: dir, log });
      assert.equal(started[kind].ok, true, kind);
    }
    assert.deepEqual(jobCounts(), { running: 2, queued: 2 });
    assert.equal(started.analysis.job.phase, 'running');
    assert.equal(started.explain.job.phase, 'running');
    assert.equal(started.qa.job.phase, 'queued', 'the Q&A waits for the analysis');
    assert.equal(started.chat.job.phase, 'queued', 'a chat turn waits for the explain, not for the Q&A');
  } finally {
    cancelJobsForSession(session);
    process.env.PATH = oldPath;
  }
  // The queued two start as the first two are cancelled; cancel them in turn so no sleeper outlives the test.
  await new Promise((resolve) => setTimeout(resolve, 200));
  cancelJobsForSession(session);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a Codex review uses the selected model and reads the final answer from JSONL', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-codex-test-'));
  const oldPath = process.env.PATH;
  try {
    fs.writeFileSync(path.join(dir, 'codex'), `#!/bin/sh
model=
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--model" ]; then shift; model=$1; fi
  shift
done
grep -q 'Explain the change' || exit 1
printf '{"type":"item.completed","item":{"type":"agent_message","text":"Answer from %s"}}\\n' "$model"
printf '{"type":"turn.completed"}\\n'
`, { mode: 0o755 });
    process.env.PATH = `${dir}:${oldPath}`;
    const { startJob } = await import('./jobs.mjs');
    const { extractAnswer } = await import('./explain.mjs');
    const started = startJob({
      kind: 'chat', session: 'claude-c0de5e55', cwd: dir, argv: ['-p', 'Explain the change'],
      agent: 'codex', model: 'test-codex-model', log: () => {},
    });
    assert.equal(started.ok, true);
    const job = await started.job.done;
    assert.equal(extractAnswer(job).text, 'Answer from test-codex-model');
    assert.equal(fs.existsSync(job.scratch), false);
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
