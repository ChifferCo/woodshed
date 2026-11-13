import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutDiagram } from './diagram.mjs';

const GRAPH = {
  nodes: [
    { id: 'route', label: 'POST /deliver', change: 'unchanged' },
    { id: 'deliver', label: 'deliver.mjs', change: 'changed' },
    { id: 'retry', label: 'retry.mjs', change: 'added' },
    { id: 'config', label: 'config/webhooks.json', change: 'added' },
    { id: 'fetch', label: 'subscriber', change: 'unchanged' },
    { id: 'cron', label: 'nightly resend', change: 'removed' },
  ],
  edges: [
    { from: 'route', to: 'deliver', label: 'calls', change: 'unchanged' },
    { from: 'deliver', to: 'retry', label: 'asks', change: 'added' },
    { from: 'deliver', to: 'config', label: 'reads', change: 'added' },
    { from: 'deliver', to: 'fetch', label: 'POSTs', change: 'unchanged' },
    { from: 'cron', to: 'deliver', label: 'calls', change: 'removed' },
  ],
};

test('layoutDiagram survives round-tripping through new Function', () => {
  // page.mjs ships it by interpolating its source into the served script, so a
  // reference to anything at module scope would throw in the browser only.
  const rebuilt = new Function(`return (${layoutDiagram.toString()});`)();
  assert.deepEqual(rebuilt(GRAPH), layoutDiagram(GRAPH));
  assert.equal(layoutDiagram.toString().includes('`'), false, 'a backtick would end the page literal');
  assert.equal(layoutDiagram.toString().includes('${'), false);
});

test('pieces are layered from the ones nothing points at, and no two boxes overlap', () => {
  const out = layoutDiagram(GRAPH);
  const at = Object.fromEntries(out.nodes.map((n) => [n.id, n]));
  assert.ok(at.route.y < at.deliver.y, 'the caller is above what it calls');
  assert.equal(at.route.y, at.cron.y, 'both roots are on the top row');
  assert.ok(at.deliver.y < at.retry.y);
  assert.equal(at.retry.y, at.fetch.y);
  for (const a of out.nodes) {
    assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.w <= out.width && a.y + a.h <= out.height, a.id);
    for (const b of out.nodes) {
      if (a === b) continue;
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      assert.ok(apart, `${a.id} overlaps ${b.id}`);
    }
  }
  assert.equal(out.edges.length, 5);
  for (const e of out.edges) assert.match(e.d, /^M[\d.,-]+ C[\d.,-]+ [\d.,-]+ [\d.,-]+$/);
});

test('a cycle is drawn, not looped on, and a wide layer wraps', () => {
  const cycle = layoutDiagram({
    nodes: [{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
  });
  assert.equal(cycle.edges.filter((e) => e.back).length, 1);
  assert.ok(cycle.nodes[0].y < cycle.nodes[1].y);

  const wide = layoutDiagram({ nodes: Array.from({ length: 13 }, (_, i) => ({ id: `n${i}`, label: `n${i}` })), edges: [] });
  assert.equal(new Set(wide.nodes.map((n) => n.y)).size, 3, 'thirteen unconnected pieces, six to a row');

  assert.deepEqual(layoutDiagram({ nodes: [], edges: [] }), { width: 24, height: 0, nodes: [], edges: [] });
});

test('a long label wraps to two lines and is cut after that', () => {
  const out = layoutDiagram({ nodes: [{ id: 'x', label: 'a very long label that keeps going past what two lines of a box hold' }], edges: [] });
  assert.equal(out.nodes[0].lines.length, 2);
  assert.ok(out.nodes[0].lines.every((l) => l.length <= 19));
  assert.ok(out.nodes[0].lines[1].endsWith('…'));
});
