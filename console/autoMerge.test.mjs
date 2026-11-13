import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoMergeDecision } from './autoMerge.mjs';

const ON = { enabled: true, tiers: ['Low'], paths: [] };

test('it merges a Low-risk pull request with QA passed and no path rules', () => {
  const d = autoMergeDecision({ autoMerge: ON, tier: 'Low', qaConfigured: true, qaConclusion: 'success', changedFiles: ['a.js'] });
  assert.deepEqual(d, { merge: true, reason: 'Low merge risk, within the auto-merge rules' });
});

test('off, wrong tier, and failed QA each block it', () => {
  assert.equal(autoMergeDecision({ autoMerge: { ...ON, enabled: false }, tier: 'Low', qaConfigured: false, qaConclusion: null, changedFiles: [] }).reason, 'auto-merge is off');
  assert.equal(autoMergeDecision({ autoMerge: null, tier: 'Low', qaConfigured: false, qaConclusion: null, changedFiles: [] }).merge, false);
  assert.equal(autoMergeDecision({ autoMerge: ON, tier: 'Medium', qaConfigured: false, qaConclusion: null, changedFiles: [] }).reason, 'Medium merge risk is not in the auto-merge tiers');
  assert.equal(autoMergeDecision({ autoMerge: ON, tier: 'Low', qaConfigured: true, qaConclusion: 'failure', changedFiles: [] }).reason, 'QA has not passed');
  assert.equal(autoMergeDecision({ autoMerge: ON, tier: 'Low', qaConfigured: true, qaConclusion: undefined, changedFiles: [] }).reason, 'QA has not passed');
  assert.equal(autoMergeDecision({ autoMerge: ON, tier: null, qaConfigured: false, qaConclusion: null, changedFiles: [] }).reason, 'no trusted merge-risk tier');
});

test('QA not configured does not block (its conclusion is not read)', () => {
  assert.equal(autoMergeDecision({ autoMerge: ON, tier: 'Low', qaConfigured: false, qaConclusion: null, changedFiles: ['x'] }).merge, true);
});

test('paths: every changed file must be within the allowed rules', () => {
  const am = { enabled: true, tiers: ['Low'], paths: ['docs/', 'README.md', 'public/*'] };
  const ok = (files) => autoMergeDecision({ autoMerge: am, tier: 'Low', qaConfigured: false, qaConclusion: null, changedFiles: files });
  assert.equal(ok(['docs/a.md', 'docs/sub/b.md', 'README.md', 'public/x.css']).merge, true, 'dir prefix, exact and star');
  assert.equal(ok(['docs']).merge, true, 'the directory itself');
  assert.equal(ok(['docs/a.md', 'src/x.js']).reason, 'a changed file is outside the allowed paths');
  assert.equal(ok(['READMExmd']).merge, false, 'exact rule is not a prefix');
  assert.equal(ok(null).reason, 'too many files to check against the allowed paths');
});

test('with no path rules, any set of files is fine', () => {
  assert.equal(autoMergeDecision({ autoMerge: ON, tier: 'Low', qaConfigured: false, qaConclusion: null, changedFiles: null }).merge, true);
});
