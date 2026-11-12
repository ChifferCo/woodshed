import { test } from 'node:test';
import assert from 'node:assert/strict';

// No claude and no gh on the path, as in session/reviewShed/shed.test.mjs: opening the review must need neither.
process.env.PATH = '/usr/bin:/bin';
delete process.env.DEFAULT_BRANCH;
const { startDevReview } = await import('./devReviewSession.mjs');

test('the dev console\'s review session opens with its analysis, every file of its change, and nothing else', async (t) => {
  const review = await startDevReview({ id: 'beadfeed', branch: 'woodshed/beadfeed' });
  t.after(() => review.close());
  const get = (p) => fetch(`http://127.0.0.1:${review.port}/shed-review${p}`).then((r) => r.json().then((body) => ({ code: r.status, body })));

  const { body: status } = await get('/reviews/claude-beadfeed');
  assert.equal(status.ok, true);
  assert.equal(status.status, 'ready', 'the analysis written beforehand is read as finished');
  assert.ok(status.review.decisions.length > 0);
  assert.ok(status.review.diagram.nodes.length > 0);

  const { body: diff } = await get('/reviews/claude-beadfeed/diff');
  const changed = diff.files.map((f) => f.path).sort();
  const placed = status.review.groups.flatMap((g) => g.files.map((f) => f.path)).sort();
  assert.deepEqual(placed, changed, 'the analysis places exactly the files the change has');
  for (const d of status.review.decisions) for (const f of d.files) assert.ok(changed.includes(f), f);

  const other = await fetch(`http://127.0.0.1:${review.port}/status`);
  assert.equal(other.status, 404);
});
