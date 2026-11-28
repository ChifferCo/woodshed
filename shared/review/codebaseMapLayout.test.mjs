import { test } from 'node:test';
import assert from 'node:assert/strict';

import { layoutCodebaseMap } from './codebaseMapLayout.mjs';

const SAMPLE = {
  modules: [
    {
      id: 'src/api',
      label: 'src/api',
      group: 'src',
      fileCount: 2,
      totalLines: 80,
      changedCount: 0,
      addedCount: 0,
      modifiedCount: 0,
      deletedCount: 0,
      additions: 0,
      deletions: 0,
      files: [
        { path: 'src/api/server.mjs', name: 'server.mjs', lines: 30, status: 'unchanged', additions: 0, deletions: 0, hunksCount: 0 },
        { path: 'src/api/routes.mjs', name: 'routes.mjs', lines: 50, status: 'unchanged', additions: 0, deletions: 0, hunksCount: 0 },
      ],
    },
    {
      id: 'src/webhooks',
      label: 'src/webhooks',
      group: 'src',
      fileCount: 3,
      totalLines: 140,
      changedCount: 2,
      addedCount: 1,
      modifiedCount: 1,
      deletedCount: 0,
      additions: 65,
      deletions: 8,
      files: [
        { path: 'src/webhooks/deliver.mjs', name: 'deliver.mjs', lines: 60, status: 'modified', additions: 25, deletions: 8, hunksCount: 2 },
        { path: 'src/webhooks/retry.mjs', name: 'retry.mjs', lines: 40, status: 'added', additions: 40, deletions: 0, hunksCount: 1 },
        { path: 'src/webhooks/sign.mjs', name: 'sign.mjs', lines: 40, status: 'unchanged', additions: 0, deletions: 0, hunksCount: 0 },
      ],
    },
    {
      id: 'config',
      label: 'config',
      group: 'config',
      fileCount: 1,
      totalLines: 10,
      changedCount: 1,
      addedCount: 0,
      modifiedCount: 1,
      deletedCount: 0,
      additions: 4,
      deletions: 1,
      files: [
        { path: 'config/webhooks.json', name: 'webhooks.json', lines: 10, status: 'modified', additions: 4, deletions: 1, hunksCount: 1 },
      ],
    },
    {
      id: 'docs',
      label: 'docs',
      group: 'docs',
      fileCount: 1,
      totalLines: 20,
      changedCount: 0,
      addedCount: 0,
      modifiedCount: 0,
      deletedCount: 0,
      additions: 0,
      deletions: 0,
      files: [
        { path: 'docs/webhooks.md', name: 'webhooks.md', lines: 20, status: 'unchanged', additions: 0, deletions: 0, hunksCount: 0 },
      ],
    },
  ],
  moduleEdges: [
    { from: 'src/api', to: 'src/webhooks', count: 2, touchesChange: true },
    { from: 'src/webhooks', to: 'config', count: 1, touchesChange: true },
  ],
  fileEdges: [
    { from: 'src/api/routes.mjs', to: 'src/webhooks/deliver.mjs' },
    { from: 'src/webhooks/deliver.mjs', to: 'src/webhooks/retry.mjs' },
    { from: 'src/webhooks/deliver.mjs', to: 'config/webhooks.json' },
  ],
};

test('layoutCodebaseMap survives round-tripping through new Function with no backticks or ${', () => {
  const src = layoutCodebaseMap.toString();
  assert.equal(src.includes('`'), false, 'a backtick would end the REVIEW_HTML template literal');
  assert.equal(src.includes('${'), false, '${ would interpolate inside REVIEW_HTML');
  const rebuilt = new Function(`return (${src});`)();
  assert.deepEqual(rebuilt(SAMPLE, {}), layoutCodebaseMap(SAMPLE, {}));
});

test('modules are layered west-to-east without overlapping, and changed bounds enclose changed modules', () => {
  const details = {
    'src/webhooks/deliver.mjs': { preamble: 'Wraps fetch in a retry loop with backoff.', hunksCount: 2 },
    'src/webhooks/retry.mjs': { preamble: 'Pure functions for backoff and Retry-After.', hunksCount: 1 },
  };
  const out = layoutCodebaseMap(SAMPLE, details);
  const byId = Object.fromEntries(out.modules.map((m) => [m.id, m]));

  assert.ok(byId['src/api'].x < byId['src/webhooks'].x, 'caller sits west of callee');
  assert.ok(byId['src/webhooks'].x < byId.config.x, 'webhooks sits west of config');

  // No two module districts overlap.
  for (const a of out.modules) {
    assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.w <= out.width && a.y + a.h <= out.height, a.id);
    for (const b of out.modules) {
      if (a === b) continue;
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      assert.ok(apart, `${a.id} overlaps ${b.id}`);
    }
    // No two parcels inside a module overlap either.
    for (const p1 of a.parcels) {
      for (const p2 of a.parcels) {
        if (p1 === p2) continue;
        const apart = p1.rx + p1.w <= p2.rx || p2.rx + p2.w <= p1.rx || p1.ry + p1.h <= p2.ry || p2.ry + p2.h <= p1.ry;
        assert.ok(apart, `${p1.name} overlaps ${p2.name} inside ${a.id}`);
      }
    }
  }

  assert.equal(out.moduleEdges.length, 2);
  for (const e of out.moduleEdges) assert.match(e.d, /^M[\d.,-]+ C[\d.,-]+ [\d.,-]+ [\d.,-]+$/);
  assert.equal(out.fileEdges.length, 3);
  for (const e of out.fileEdges) assert.match(e.d, /^M[\d.,-]+ C[\d.,-]+ [\d.,-]+ [\d.,-]+$/);

  assert.ok(out.changedBounds, 'changedBounds computed');
  assert.ok(out.changedBounds.minX <= byId['src/webhooks'].x);
  assert.ok(out.changedBounds.maxY >= byId.config.y + byId.config.h);
});

test('differentiates significant (core/decision) vs minor (docs/test/config) changes and computes majorBounds', () => {
  const details = {
    'src/webhooks/deliver.mjs': { role: 'core', decisionCount: 1, preamble: 'Retry loop.', hunksCount: 2 },
    'src/webhooks/retry.mjs': { role: 'core', decisionCount: 1, preamble: 'Backoff rules.', hunksCount: 1 },
    'config/webhooks.json': { role: 'config', decisionCount: 0, preamble: 'Defaults.', hunksCount: 1 },
  };
  const out = layoutCodebaseMap(SAMPLE, details);
  const byId = Object.fromEntries(out.modules.map((m) => [m.id, m]));
  assert.equal(byId['src/webhooks'].impact, 'major');
  assert.equal(byId['src/webhooks'].majorCount, 2);
  assert.equal(byId.config.impact, 'minor');
  assert.equal(byId.config.minorCount, 1);
  assert.equal(byId['src/api'].impact, 'none');
  assert.ok(out.majorBounds);
  assert.equal(out.majorBounds.minX, byId['src/webhooks'].x);
  assert.equal(out.majorBounds.maxX, byId['src/webhooks'].x + byId['src/webhooks'].w);
});

test('handles cycles, empty maps, and large unchanged modules gracefully', () => {
  const empty = layoutCodebaseMap({ modules: [], moduleEdges: [], fileEdges: [] });
  assert.equal(empty.modules.length, 0);
  assert.equal(empty.changedBounds, null);

  const bigFiles = Array.from({ length: 30 }, (_, i) => ({
    path: `lib/f${i}.mjs`, name: `f${i}.mjs`, lines: 10, status: 'unchanged', additions: 0, deletions: 0, hunksCount: 0,
  }));
  const cyclic = layoutCodebaseMap({
    modules: [
      { id: 'a', label: 'a', group: 'a', fileCount: 30, totalLines: 300, changedCount: 0, files: bigFiles },
      { id: 'b', label: 'b', group: 'b', fileCount: 1, totalLines: 10, changedCount: 0, files: [{ path: 'b/x.mjs', name: 'x.mjs', lines: 10, status: 'unchanged' }] },
    ],
    moduleEdges: [
      { from: 'a', to: 'b', count: 1 },
      { from: 'b', to: 'a', count: 1 },
    ],
    fileEdges: [],
  });
  assert.equal(cyclic.moduleEdges.filter((e) => e.back).length, 1);
  const overflow = cyclic.modules.find((m) => m.id === 'a').parcels.find((p) => p.kind === 'overflow');
  assert.ok(overflow, 'overflow tile caps huge unchanged module');
  assert.equal(overflow.overflowCount, 19);

  // Module names matching Object.prototype properties must not be dropped.
  const protoNames = layoutCodebaseMap({
    modules: [
      { id: 'constructor', label: 'constructor', group: 'constructor', fileCount: 1, totalLines: 10, changedCount: 0, files: [{ path: 'constructor/index.mjs', name: 'index.mjs', lines: 10, status: 'unchanged' }] },
      { id: 'toString', label: 'toString', group: 'toString', fileCount: 1, totalLines: 10, changedCount: 0, files: [{ path: 'toString/index.mjs', name: 'index.mjs', lines: 10, status: 'unchanged' }] },
    ],
    moduleEdges: [{ from: 'constructor', to: 'toString', count: 1 }],
    fileEdges: [{ from: 'constructor/index.mjs', to: 'toString/index.mjs' }],
  });
  assert.deepEqual(protoNames.modules.map((m) => m.id).sort(), ['constructor', 'toString']);
  assert.equal(protoNames.moduleEdges.length, 1);
  assert.equal(protoNames.fileEdges.length, 1);
});
