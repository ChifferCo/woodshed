// 2D top-down spatial layout engine for the whole-codebase review map.
//
// Places every repository module as a geographic "district" block containing
// its file "parcels" (changed files prominently with room for their full
// descriptions and hunks at street-level zoom, unchanged files as compact
// architectural tiles), and routes inter-module interaction highways cleanly
// around the blocks.
//
// Layers flow west-to-east (callers / entrypoints on the left, core modules in
// the center, foundations / stores / config on the right) so dependency chains
// fill a widescreen map viewport naturally instead of stacking into a narrow
// vertical strip.
//
// Shipped to the browser the way `layoutDiagram` is — `${layoutCodebaseMap.toString()}`
// interpolated into page.mjs's inline script — so it must be SELF-CONTAINED:
// no module-scope bindings, no template literals, no backticks, and nothing
// the browser lacks. codebaseMapLayout.test.mjs rebuilds it with `new Function`
// to prove that.
export function layoutCodebaseMap(map, detailsByPath) {
  var MARGIN = 64;
  var GAP_X = 96;
  var GAP_Y = 56;
  var PAD_X = 14;
  var PAD_TOP = 50;
  var PAD_BOTTOM = 14;
  var CHANGED_W = 286;
  var CHANGED_GAP = 14;
  var TILE_W = 138;
  var TILE_H = 32;
  var TILE_GAP = 7;
  var MAX_UNCHANGED_TILES = 12;
  var BEND_STEP = 38;

  var details = detailsByPath || {};
  var rawModules = (map && map.modules) || [];
  var rawModEdges = (map && map.moduleEdges) || [];
  var rawFileEdges = (map && map.fileEdges) || [];
  // Scale column capacity with module count so both small repos and 30-module
  // codebases keep a comfortable landscape Google Maps aspect ratio.
  var PER_COL = Math.max(3, Math.min(5, Math.ceil(Math.sqrt(rawModules.length * 0.7))));

  if (!rawModules.length) {
    return {
      width: 400,
      height: 240,
      modules: [],
      moduleEdges: [],
      fileEdges: [],
      bounds: { minX: 0, minY: 0, maxX: 400, maxY: 240 },
      changedBounds: null,
    };
  }

  var modules = [];
  var byId = {};
  for (var i = 0; i < rawModules.length; i++) {
    var rm = rawModules[i];
    if (!rm || typeof rm.id !== 'string' || byId[rm.id]) continue;
    var mod = buildModuleBox(rm);
    mod.index = modules.length;
    modules.push(mod);
    byId[mod.id] = mod;
  }

  var modEdges = [];
  for (var e = 0; e < rawModEdges.length; e++) {
    var re = rawModEdges[e];
    if (!re || !byId[re.from] || !byId[re.to] || re.from === re.to) continue;
    modEdges.push({
      from: re.from,
      to: re.to,
      count: re.count || 1,
      touchesChange: !!re.touchesChange,
      samples: re.samples || [],
      back: false,
    });
  }

  // Partition connected vs isolated modules so standalone folders (docs, root)
  // sit in a quiet trailing column instead of stretching the dependency layers.
  var degree = {};
  for (var d = 0; d < modEdges.length; d++) {
    degree[modEdges[d].from] = (degree[modEdges[d].from] || 0) + 1;
    degree[modEdges[d].to] = (degree[modEdges[d].to] || 0) + 1;
  }

  var connected = [];
  var isolated = [];
  for (var m = 0; m < modules.length; m++) {
    if (degree[modules[m].id]) connected.push(modules[m]);
    else isolated.push(modules[m]);
  }
  if (!connected.length) {
    connected = modules.slice();
    isolated = [];
  }

  // DFS back-edge detection on connected modules to break cycles cleanly.
  var out = {};
  for (var k = 0; k < modEdges.length; k++) {
    (out[modEdges[k].from] = out[modEdges[k].from] || []).push(modEdges[k]);
  }
  var mark = {};
  function visit(id) {
    mark[id] = 1;
    var list = out[id] || [];
    for (var j = 0; j < list.length; j++) {
      var to = list[j].to;
      if (mark[to] === 1) list[j].back = true;
      else if (!mark[to]) visit(to);
    }
    mark[id] = 2;
  }
  for (var v = 0; v < connected.length; v++) {
    if (!mark[connected[v].id]) visit(connected[v].id);
  }

  // Longest-path layering over forward edges: callers west, foundations east.
  for (var round = 0; round < connected.length; round++) {
    var moved = false;
    for (var f = 0; f < modEdges.length; f++) {
      if (modEdges[f].back) continue;
      var a = byId[modEdges[f].from];
      var b = byId[modEdges[f].to];
      if (b.layer < a.layer + 1) {
        b.layer = a.layer + 1;
        moved = true;
      }
    }
    if (!moved) break;
  }

  var layers = [];
  for (var p = 0; p < connected.length; p++) {
    var ly = connected[p].layer;
    (layers[ly] = layers[ly] || []).push(connected[p]);
  }

  // Order each vertical column by barycenter of upstream (west) neighbors and
  // group affinity to minimize highway crossings, then wrap tall layers into
  // adjacent columns.
  var order = {};
  var cols = [];
  for (var l = 0; l < layers.length; l++) {
    var layer = layers[l] || [];
    if (!layer.length) continue;
    for (var q = 0; q < layer.length; q++) {
      var sum = 0;
      var cnt = 0;
      for (var g = 0; g < modEdges.length; g++) {
        if (modEdges[g].back || modEdges[g].to !== layer[q].id) continue;
        if (order[modEdges[g].from] === undefined) continue;
        sum += order[modEdges[g].from];
        cnt += 1;
      }
      layer[q].weight = cnt ? sum / cnt : layer[q].index;
    }
    layer.sort(function byWeight(x, y) {
      if (Math.abs(x.weight - y.weight) > 0.01) return x.weight - y.weight;
      if (x.group !== y.group) return x.group < y.group ? -1 : 1;
      return x.index - y.index;
    });
    for (var r = 0; r < layer.length; r += PER_COL) cols.push(layer.slice(r, r + PER_COL));
    for (var s = 0; s < layer.length; s++) order[layer[s].id] = s;
  }

  if (isolated.length) {
    isolated.sort(function byChangeThenName(x, y) {
      if ((y.changedCount > 0) !== (x.changedCount > 0)) return y.changedCount > 0 ? 1 : -1;
      if (x.group !== y.group) return x.group < y.group ? -1 : 1;
      return x.id < y.id ? -1 : 1;
    });
    for (var ir = 0; ir < isolated.length; ir += PER_COL) {
      cols.push(isolated.slice(ir, ir + PER_COL));
    }
  }

  // Compute column heights and center each column vertically in the landscape map.
  var maxColH = 0;
  var colHeights = [];
  for (var ch = 0; ch < cols.length; ch++) {
    var totalH = 0;
    for (var cr = 0; cr < cols[ch].length; cr++) {
      totalH += cols[ch][cr].h + (cr > 0 ? GAP_Y : 0);
    }
    colHeights.push(totalH);
    if (totalH > maxColH) maxColH = totalH;
  }

  var hasBack = modEdges.some(function isBack(x) { return x.back; });
  var bottomGutter = hasBack ? 72 : 0;
  var cursorX = MARGIN;
  for (var cc = 0; cc < cols.length; cc++) {
    var col = cols[cc];
    var startY = MARGIN + (maxColH - colHeights[cc]) / 2;
    var widest = 0;
    for (var t = 0; t < col.length; t++) {
      var box = col[t];
      box.col = cc;
      box.x = Math.round(cursorX);
      box.y = Math.round(startY);
      startY += box.h + GAP_Y;
      if (box.w > widest) widest = box.w;
    }
    // Center narrower boxes horizontally within their column for crisp alignment.
    for (var t2 = 0; t2 < col.length; t2++) {
      col[t2].x = Math.round(cursorX + (widest - col[t2].w) / 2);
    }
    cursorX += widest + GAP_X;
  }

  var width = Math.ceil(cols.length ? cursorX - GAP_X + MARGIN : 400);
  var height = Math.ceil(MARGIN * 2 + maxColH + bottomGutter);

  // Convert each file parcel's local offset into absolute map coordinates.
  var fileBoxByPath = {};
  for (var mi = 0; mi < modules.length; mi++) {
    var md = modules[mi];
    for (var fi = 0; fi < md.parcels.length; fi++) {
      var pc = md.parcels[fi];
      pc.x = md.x + pc.rx;
      pc.y = md.y + pc.ry;
      if (pc.path) fileBoxByPath[pc.path] = pc;
    }
    delete md.weight;
    delete md.index;
  }

  // Spread edge anchors evenly along each district's side so highways do not overlap.
  var portCounts = {};
  var portSeen = {};
  for (var ec = 0; ec < modEdges.length; ec++) {
    var edc = modEdges[ec];
    var sides = pickSides(byId[edc.from], byId[edc.to], edc.back);
    edc.fromSide = sides.from;
    edc.toSide = sides.to;
    var fk = edc.from + ':' + sides.from;
    var tk = edc.to + ':' + sides.to;
    portCounts[fk] = (portCounts[fk] || 0) + 1;
    portCounts[tk] = (portCounts[tk] || 0) + 1;
  }

  var backIndex = 0;
  for (var er = 0; er < modEdges.length; er++) {
    var ed = modEdges[er];
    var src = byId[ed.from];
    var dst = byId[ed.to];
    var fk2 = ed.from + ':' + ed.fromSide;
    var tk2 = ed.to + ':' + ed.toSide;
    var fi2 = portSeen[fk2] || 0;
    portSeen[fk2] = fi2 + 1;
    var ti2 = portSeen[tk2] || 0;
    portSeen[tk2] = ti2 + 1;

    var p0 = anchorOn(src, ed.fromSide, fi2, portCounts[fk2]);
    var p3 = anchorOn(dst, ed.toSide, ti2, portCounts[tk2]);
    var p1;
    var p2;

    if (ed.back || dst.col < src.col) {
      var laneY = MARGIN + maxColH + 24 + (backIndex % 3) * BEND_STEP;
      backIndex += 1;
      p0 = anchorOn(src, 'bottom', fi2, portCounts[fk2]);
      p3 = anchorOn(dst, 'bottom', ti2, portCounts[tk2]);
      p1 = [p0[0], laneY];
      p2 = [p3[0], laneY];
    } else if (ed.fromSide === 'right' && ed.toSide === 'left') {
      var dx = Math.max(32, (p3[0] - p0[0]) * 0.46);
      p1 = [p0[0] + dx, p0[1]];
      p2 = [p3[0] - dx, p3[1]];
    } else if (ed.fromSide === 'bottom' && ed.toSide === 'top') {
      var dyD = Math.max(24, (p3[1] - p0[1]) * 0.5);
      p1 = [p0[0], p0[1] + dyD];
      p2 = [p3[0], p3[1] - dyD];
    } else {
      var dyU = Math.max(24, (p0[1] - p3[1]) * 0.5);
      p1 = [p0[0], p0[1] - dyU];
      p2 = [p3[0], p3[1] + dyU];
    }

    ed.d = 'M' + num(p0) + ' C' + num(p1) + ' ' + num(p2) + ' ' + num(p3);
    ed.labelX = round1(bezier(p0[0], p1[0], p2[0], p3[0], 0.5));
    ed.labelY = round1(bezier(p0[1], p1[1], p2[1], p3[1], 0.5));
  }

  // Geometry for file-to-file edges where both files have visible parcels.
  var fileEdges = [];
  for (var fe = 0; fe < rawFileEdges.length; fe++) {
    var rfe = rawFileEdges[fe];
    var aBox = fileBoxByPath[rfe.from];
    var bBox = fileBoxByPath[rfe.to];
    if (!aBox || !bBox || aBox === bBox) continue;
    var aCx = aBox.x + aBox.w / 2;
    var aCy = aBox.y + aBox.h / 2;
    var bCx = bBox.x + bBox.w / 2;
    var bCy = bBox.y + bBox.h / 2;
    var s0;
    var s3;
    var c1;
    var c2;
    if (Math.abs(bCx - aCx) >= Math.abs(bCy - aCy) * 0.65) {
      if (bCx >= aCx) {
        s0 = [aBox.x + aBox.w, aCy];
        s3 = [bBox.x, bCy];
      } else {
        s0 = [aBox.x, aCy];
        s3 = [bBox.x + bBox.w, bCy];
      }
      var hMid = (s3[0] - s0[0]) * 0.5;
      c1 = [s0[0] + hMid, s0[1]];
      c2 = [s3[0] - hMid, s3[1]];
    } else {
      if (bCy >= aCy) {
        s0 = [aCx, aBox.y + aBox.h];
        s3 = [bCx, bBox.y];
      } else {
        s0 = [aCx, aBox.y];
        s3 = [bCx, bBox.y + bBox.h];
      }
      var vMid = (s3[1] - s0[1]) * 0.5;
      c1 = [s0[0], s0[1] + vMid];
      c2 = [s3[0], s3[1] - vMid];
    }
    fileEdges.push({
      from: rfe.from,
      to: rfe.to,
      touchesChange: aBox.status !== 'unchanged' || bBox.status !== 'unchanged',
      d: 'M' + num(s0) + ' C' + num(c1) + ' ' + num(c2) + ' ' + num(s3),
    });
  }

  // Bounding boxes for one-click focus: significant changes first, then all changes.
  var changedBounds = null;
  var majorBounds = null;
  for (var cb = 0; cb < modules.length; cb++) {
    var cm = modules[cb];
    if (!cm.changedCount) continue;
    if (!changedBounds) {
      changedBounds = { minX: cm.x, minY: cm.y, maxX: cm.x + cm.w, maxY: cm.y + cm.h };
    } else {
      if (cm.x < changedBounds.minX) changedBounds.minX = cm.x;
      if (cm.y < changedBounds.minY) changedBounds.minY = cm.y;
      if (cm.x + cm.w > changedBounds.maxX) changedBounds.maxX = cm.x + cm.w;
      if (cm.y + cm.h > changedBounds.maxY) changedBounds.maxY = cm.y + cm.h;
    }
    if (cm.majorCount > 0) {
      if (!majorBounds) {
        majorBounds = { minX: cm.x, minY: cm.y, maxX: cm.x + cm.w, maxY: cm.y + cm.h };
      } else {
        if (cm.x < majorBounds.minX) majorBounds.minX = cm.x;
        if (cm.y < majorBounds.minY) majorBounds.minY = cm.y;
        if (cm.x + cm.w > majorBounds.maxX) majorBounds.maxX = cm.x + cm.w;
        if (cm.y + cm.h > majorBounds.maxY) majorBounds.maxY = cm.y + cm.h;
      }
    }
  }

  return {
    width: width,
    height: height,
    modules: modules,
    moduleEdges: modEdges,
    fileEdges: fileEdges,
    bounds: { minX: 0, minY: 0, maxX: width, maxY: height },
    changedBounds: changedBounds,
    majorBounds: majorBounds,
  };

  function classifyImpact(cf, det) {
    if (det && (det.impact === 'major' || det.impact === 'minor')) return det.impact;
    var role = det && det.role ? det.role : '';
    var churn = (cf.additions || 0) + (cf.deletions || 0);
    var inDecision = !!(det && det.decisionCount > 0);
    if (role === 'docs' || role === 'test' || role === 'generated' || role === 'config') {
      return (inDecision && role === 'config' && churn >= 12) ? 'major' : 'minor';
    }
    if (role === 'core') {
      return (churn >= 8 || cf.status === 'added' || cf.status === 'deleted' || inDecision) ? 'major' : 'minor';
    }
    if (role === 'support') {
      return (inDecision && churn >= 12) ? 'major' : 'minor';
    }
    if (inDecision) return 'major';
    // Heuristic fallback before analysis finishes: tests/docs are minor,
    // substantial source edits or added/deleted source files are major.
    var p = String(cf.path || '').toLowerCase();
    if (/(^|\/)(docs|doc|skills)\/|\.md$|\.test\.|\.spec\.|_test\./.test(p)) return 'minor';
    if (cf.status === 'added' || cf.status === 'deleted' || churn >= 20) return 'major';
    return 'minor';
  }

  function buildModuleBox(rm) {
    var files = rm.files || [];
    var changed = [];
    var unchanged = [];
    var majorCount = 0;
    var minorCount = 0;
    for (var i = 0; i < files.length; i++) {
      if (files[i].status && files[i].status !== 'unchanged') {
        var det0 = details[files[i].path] || {};
        var imp = classifyImpact(files[i], det0);
        if (imp === 'major') majorCount += 1;
        else minorCount += 1;
        changed.push({ file: files[i], impact: imp, det: det0 });
      } else {
        unchanged.push(files[i]);
      }
    }
    // Put significant changes first inside each module so your eye lands on them immediately.
    changed.sort(function byImpact(a, b) {
      if (a.impact !== b.impact) return a.impact === 'major' ? -1 : 1;
      var da = (a.file.additions || 0) + (a.file.deletions || 0);
      var db = (b.file.additions || 0) + (b.file.deletions || 0);
      if (db !== da) return db - da;
      return a.file.name < b.file.name ? -1 : 1;
    });

    // Use 2 columns once a module has >= 2 changed files so districts stay
    // balanced and readable instead of turning into tall narrow towers.
    var changedCols = changed.length >= 2 ? 2 : 1;
    var tileCols = changedCols === 2 ? 4 : 2;
    var innerW = changed.length
      ? changedCols * CHANGED_W + (changedCols - 1) * CHANGED_GAP
      : Math.max(TILE_W * 2 + TILE_GAP, 286);
    var actualTileW = Math.floor((innerW - (tileCols - 1) * TILE_GAP) / tileCols);

    var parcels = [];
    var y = PAD_TOP;

    if (changed.length) {
      for (var c = 0; c < changed.length; c += changedCols) {
        var rowH = 0;
        var rowParcels = [];
        for (var col = 0; col < changedCols && c + col < changed.length; col++) {
          var item = changed[c + col];
          var cf = item.file;
          var det = item.det;
          var preambleLen = det.preamble ? String(det.preamble).length : 0;
          var hunksShown = Math.min(det.hunksCount || cf.hunksCount || 0, 3);
          var estLines = preambleLen ? Math.min(6, Math.max(2, Math.ceil(preambleLen / 46))) : 1;
          var ph = 70 + estLines * 14 + (hunksShown > 0 ? 10 + hunksShown * 22 : 0);
          if (ph < 114) ph = 114;
          if (ph > 230) ph = 230;
          var parcel = {
            kind: 'changed',
            impact: item.impact,
            path: cf.path,
            name: cf.name,
            lines: cf.lines || 0,
            status: cf.status,
            additions: cf.additions || 0,
            deletions: cf.deletions || 0,
            hunksCount: cf.hunksCount || 0,
            rx: PAD_X + col * (CHANGED_W + CHANGED_GAP),
            ry: y,
            w: CHANGED_W,
            h: ph,
          };
          rowParcels.push(parcel);
          if (ph > rowH) rowH = ph;
        }
        for (var rp = 0; rp < rowParcels.length; rp++) {
          rowParcels[rp].h = rowH;
          parcels.push(rowParcels[rp]);
        }
        y += rowH + CHANGED_GAP;
      }
    }

    if (unchanged.length) {
      if (changed.length) y += 2;
      var shownCount = unchanged.length > MAX_UNCHANGED_TILES ? MAX_UNCHANGED_TILES - 1 : unchanged.length;
      var overflowCount = unchanged.length - shownCount;
      var totalTiles = shownCount + (overflowCount > 0 ? 1 : 0);
      for (var u = 0; u < shownCount; u++) {
        var uf = unchanged[u];
        var uc = u % tileCols;
        var ur = Math.floor(u / tileCols);
        parcels.push({
          kind: 'unchanged',
          impact: 'none',
          path: uf.path,
          name: uf.name,
          lines: uf.lines || 0,
          status: 'unchanged',
          additions: 0,
          deletions: 0,
          hunksCount: 0,
          rx: PAD_X + uc * (actualTileW + TILE_GAP),
          ry: y + ur * (TILE_H + TILE_GAP),
          w: actualTileW,
          h: TILE_H,
        });
      }
      if (overflowCount > 0) {
        var oc = shownCount % tileCols;
        var or2 = Math.floor(shownCount / tileCols);
        parcels.push({
          kind: 'overflow',
          impact: 'none',
          path: null,
          name: '+' + overflowCount + ' more files',
          overflowCount: overflowCount,
          lines: 0,
          status: 'unchanged',
          rx: PAD_X + oc * (actualTileW + TILE_GAP),
          ry: y + or2 * (TILE_H + TILE_GAP),
          w: actualTileW,
          h: TILE_H,
        });
      }
      var tileRows = Math.ceil(totalTiles / tileCols);
      y += tileRows * TILE_H + Math.max(0, tileRows - 1) * TILE_GAP;
    }

    var totalH = Math.max(92, y + PAD_BOTTOM);
    return {
      id: rm.id,
      label: rm.label || rm.id,
      summary: rm.summary || '',
      group: rm.group || rm.id,
      fileCount: rm.fileCount || files.length,
      totalLines: rm.totalLines || 0,
      changedCount: rm.changedCount || changed.length,
      majorCount: majorCount,
      minorCount: minorCount,
      impact: majorCount > 0 ? 'major' : (changed.length > 0 ? 'minor' : 'none'),
      addedCount: rm.addedCount || 0,
      modifiedCount: rm.modifiedCount || 0,
      deletedCount: rm.deletedCount || 0,
      additions: rm.additions || 0,
      deletions: rm.deletions || 0,
      allFiles: files,
      parcels: parcels,
      w: innerW + PAD_X * 2,
      h: totalH,
      layer: 0,
      col: 0,
      x: 0,
      y: 0,
    };
  }

  function pickSides(src, dst, isBack) {
    if (isBack || dst.col < src.col) return { from: 'bottom', to: 'bottom' };
    if (dst.col > src.col) return { from: 'right', to: 'left' };
    if (dst.y >= src.y) return { from: 'bottom', to: 'top' };
    return { from: 'top', to: 'bottom' };
  }

  function anchorOn(box, side, idx, total) {
    var t = (idx + 1) / (total + 1);
    var span = 0.2 + t * 0.6;
    if (side === 'top') return [box.x + box.w * span, box.y];
    if (side === 'bottom') return [box.x + box.w * span, box.y + box.h];
    if (side === 'left') return [box.x, box.y + box.h * span];
    return [box.x + box.w, box.y + box.h * span];
  }

  function bezier(a, b, c, e, at) {
    var o = 1 - at;
    return o * o * o * a + 3 * o * o * at * b + 3 * o * at * at * c + at * at * at * e;
  }
  function round1(value) { return Math.round(value * 10) / 10; }
  function num(point) { return round1(point[0]) + ',' + round1(point[1]); }
}
