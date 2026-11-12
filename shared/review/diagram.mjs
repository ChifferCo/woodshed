// Where the review page draws the architecture's before and after.
//
// The analysis returns ONE graph: each piece marked added, removed, changed
// or unchanged, and each edge added, removed or unchanged. The page draws the
// before (everything not added) and the after (everything not removed) from
// it, and both drawings take their places from this one layout of the whole
// graph, so a piece sits in the same spot on both sides and the eye only has
// to find what appeared and what went.
//
// Shipped to the browser the way `createAskState` is —
// `${layoutDiagram.toString()}` interpolated into page.mjs's inline script — so
// it must be SELF-CONTAINED: no module-scope bindings, no template literals
// (the page is one), and nothing the browser lacks. diagram.test.mjs rebuilds
// it with `new Function` to prove that.
//
// Layers run top to bottom, from the pieces nothing points at. A cycle is
// broken at the edge a depth-first walk finds going back, and that edge is
// drawn round the right-hand side rather than through the boxes.
export function layoutDiagram(graph) {
  var NODE_W = 156;
  var LINE_H = 16;
  var PAD_Y = 9;
  var GAP_X = 28;
  var GAP_Y = 62;
  var MARGIN = 12;
  var BEND = 44;
  var PER_ROW = 6;
  var CHARS = 19;

  var nodes = [];
  var byId = {};
  var inNodes = (graph && graph.nodes) || [];
  for (var i = 0; i < inNodes.length; i++) {
    var n = inNodes[i];
    if (!n || typeof n.id !== 'string' || byId[n.id]) continue;
    var lines = wrap(String(n.label || n.id));
    var node = { id: n.id, label: String(n.label || n.id), change: n.change || 'unchanged', lines: lines,
      w: NODE_W, h: lines.length * LINE_H + PAD_Y * 2, index: nodes.length, layer: 0, x: 0, y: 0 };
    nodes.push(node);
    byId[n.id] = node;
  }

  var edges = [];
  var inEdges = (graph && graph.edges) || [];
  for (var j = 0; j < inEdges.length; j++) {
    var e = inEdges[j];
    if (!e || !byId[e.from] || !byId[e.to] || e.from === e.to) continue;
    edges.push({ from: e.from, to: e.to, label: String(e.label || ''), change: e.change || 'unchanged', back: false });
  }

  // Back edges: the ones a depth-first walk, in the order the pieces were
  // listed, meets pointing at a piece still on its stack.
  var out = {};
  for (var k = 0; k < edges.length; k++) (out[edges[k].from] = out[edges[k].from] || []).push(edges[k]);
  var mark = {};
  function visit(id) {
    mark[id] = 1;
    var list = out[id] || [];
    for (var m = 0; m < list.length; m++) {
      var to = list[m].to;
      if (mark[to] === 1) list[m].back = true;
      else if (!mark[to]) visit(to);
    }
    mark[id] = 2;
  }
  for (var v = 0; v < nodes.length; v++) if (!mark[nodes[v].id]) visit(nodes[v].id);

  // Longest path from a root, over the forward edges alone. At most as many
  // rounds as there are pieces, since the forward edges have no cycle.
  for (var round = 0; round < nodes.length; round++) {
    var moved = false;
    for (var f = 0; f < edges.length; f++) {
      if (edges[f].back) continue;
      var a = byId[edges[f].from];
      var b = byId[edges[f].to];
      if (b.layer < a.layer + 1) { b.layer = a.layer + 1; moved = true; }
    }
    if (!moved) break;
  }

  var layers = [];
  for (var p = 0; p < nodes.length; p++) (layers[nodes[p].layer] = layers[nodes[p].layer] || []).push(nodes[p]);

  // Each layer in the order of the pieces above that point at it, so edges
  // cross less; a piece nothing above points at keeps its listed place.
  var order = {};
  var rows = [];
  for (var l = 0; l < layers.length; l++) {
    var layer = layers[l] || [];
    for (var q = 0; q < layer.length; q++) {
      var sum = 0;
      var count = 0;
      for (var g = 0; g < edges.length; g++) {
        if (edges[g].back || edges[g].to !== layer[q].id) continue;
        if (order[edges[g].from] === undefined) continue;
        sum += order[edges[g].from];
        count += 1;
      }
      layer[q].weight = count ? sum / count : layer[q].index;
    }
    layer.sort(function byWeight(x, y) { return x.weight - y.weight || x.index - y.index; });
    for (var r = 0; r < layer.length; r += PER_ROW) rows.push(layer.slice(r, r + PER_ROW));
    for (var s = 0; s < layer.length; s++) order[layer[s].id] = s;
  }

  var widest = 0;
  for (var c = 0; c < rows.length; c++) widest = Math.max(widest, rows[c].length);
  var hasBack = edges.some(function isBack(x) { return x.back || byId[x.from].layer >= byId[x.to].layer; });
  var inner = widest * NODE_W + Math.max(0, widest - 1) * GAP_X;
  var width = MARGIN * 2 + inner + (hasBack ? BEND : 0);
  var y = MARGIN;
  for (var rr = 0; rr < rows.length; rr++) {
    var row = rows[rr];
    var rowW = row.length * NODE_W + (row.length - 1) * GAP_X;
    var x = MARGIN + (inner - rowW) / 2;
    var tallest = 0;
    for (var t = 0; t < row.length; t++) {
      row[t].row = rr;
      row[t].x = x;
      row[t].y = y;
      x += NODE_W + GAP_X;
      tallest = Math.max(tallest, row[t].h);
    }
    for (var t2 = 0; t2 < row.length; t2++) row[t2].y = y + (tallest - row[t2].h) / 2;
    y += tallest + GAP_Y;
  }
  var height = rows.length ? y - GAP_Y + MARGIN : 0;

  for (var d = 0; d < edges.length; d++) {
    var edge = edges[d];
    var from = byId[edge.from];
    var to = byId[edge.to];
    var p0;
    var p1;
    var p2;
    var p3;
    if (to.row > from.row) {
      p0 = [from.x + from.w / 2, from.y + from.h];
      p3 = [to.x + to.w / 2, to.y];
      var mid = (p3[1] - p0[1]) / 2;
      p1 = [p0[0], p0[1] + mid];
      p2 = [p3[0], p3[1] - mid];
    } else {
      // Up, or along its own row: out of the right side and back in.
      var side = MARGIN + inner + BEND - 8;
      p0 = [from.x + from.w, from.y + from.h / 2];
      p3 = [to.x + to.w, to.y + to.h / 2];
      p1 = [side, p0[1]];
      p2 = [side, p3[1]];
    }
    edge.d = 'M' + num(p0) + ' C' + num(p1) + ' ' + num(p2) + ' ' + num(p3);
    // Nearer the end than the middle: edges fanning out of one piece share
    // their first half, and their labels would sit on each other there.
    edge.labelX = round1(bezier(p0[0], p1[0], p2[0], p3[0], 0.7));
    edge.labelY = round1(bezier(p0[1], p1[1], p2[1], p3[1], 0.7));
  }

  for (var z = 0; z < nodes.length; z++) {
    delete nodes[z].weight;
    delete nodes[z].index;
  }
  return { width: Math.ceil(width), height: Math.ceil(height), nodes: nodes, edges: edges };

  function bezier(a, b, c, e, at) {
    var o = 1 - at;
    return o * o * o * a + 3 * o * o * at * b + 3 * o * at * at * c + at * at * at * e;
  }
  function round1(value) { return Math.round(value * 10) / 10; }
  function num(point) { return round1(point[0]) + ',' + round1(point[1]); }

  // At most two lines, broken between words or after a slash in a path, the
  // second cut with an ellipsis.
  function wrap(text) {
    var words = [];
    var spaced = text.split(/\s+/).filter(Boolean);
    for (var sw = 0; sw < spaced.length; sw++) {
      var parts = spaced[sw].split('/');
      for (var sp = 0; sp < parts.length; sp++) {
        var part = parts[sp] + (sp < parts.length - 1 ? '/' : '');
        if (part) words.push({ text: part, glued: sp > 0 });
      }
    }
    var out2 = [''];
    for (var w = 0; w < words.length; w++) {
      var last = out2.length - 1;
      var next = out2[last] ? out2[last] + (words[w].glued ? '' : ' ') + words[w].text : words[w].text;
      if (next.length <= CHARS || !out2[last]) out2[last] = next;
      else out2.push(words[w].text);
    }
    if (out2.length > 2) out2 = [out2[0], out2.slice(1).join(' ')];
    for (var u = 0; u < out2.length; u++) {
      if (out2[u].length > CHARS) out2[u] = out2[u].slice(0, CHARS - 1) + '…';
    }
    return out2;
  }
}
