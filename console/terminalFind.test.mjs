import { test } from 'node:test';
import assert from 'node:assert/strict';

import find from './public/terminalFind.cjs';

// A stand-in for xterm's buffer: rows of `cols` cells, a wide glyph (from WIDE) taking two, the second of width 0.
const WIDE = new Set(['界', '🙂']);
function buffer(rows, cols, wrapped = new Set()) {
  const lines = rows.map((text, i) => {
    const cells = [];
    for (const ch of text) {
      if (WIDE.has(ch)) cells.push({ chars: ch, width: 2 }, { chars: '', width: 0 });
      else cells.push({ chars: ch, width: 1 });
    }
    while (cells.length < cols) cells.push({ chars: '', width: 1 });
    return {
      isWrapped: wrapped.has(i),
      length: cols,
      getCell: (c, into) => Object.assign(into, { c: cells[c] }),
      translateToString: (trim) => {
        const s = cells.filter((x) => x.width > 0).map((x) => x.chars || ' ').join('');
        return trim ? s.replace(/ +$/, '') : s;
      },
    };
  });
  return {
    length: lines.length,
    getLine: (i) => lines[i],
    getNullCell: () => ({ getChars() { return this.c.chars; }, getWidth() { return this.c.width; } }),
  };
}

test('every match is found, oldest first, whatever its case', () => {
  const buf = buffer(['Retry the call', 'no match here', 'then retry, RETRY again'], 30);
  assert.deepEqual(find.findAll(buf, 'retry', 30), [
    { row: 0, col: 0, cells: 5 },
    { row: 2, col: 5, cells: 5 },
    { row: 2, col: 12, cells: 5 },
  ]);
  assert.deepEqual(find.findAll(buf, '', 30), [], 'an empty query finds nothing');
  assert.deepEqual(find.findAll(buf, 'missing', 30), []);
});

test('a match across a line xterm wrapped is one match, its cells running on to the next row', () => {
  const buf = buffer(['abcdefghwe', 'bhook done'], 10, new Set([1]));
  assert.deepEqual(find.findAll(buf, 'webhook', 10), [{ row: 0, col: 8, cells: 7 }]);
  const notWrapped = buffer(['abcdefghwe', 'bhook done'], 10);
  assert.deepEqual(find.findAll(notWrapped, 'webhook', 10), [], 'two lines are not one');
});

test('a wide glyph is one character and two cells', () => {
  const buf = buffer(['界界 hello 🙂ok'], 20);
  assert.deepEqual(find.findAll(buf, 'hello', 20), [{ row: 0, col: 5, cells: 5 }]);
  assert.deepEqual(find.findAll(buf, '界 h', 20), [{ row: 0, col: 2, cells: 4 }]);
  assert.deepEqual(find.findAll(buf, '🙂ok', 20), [{ row: 0, col: 11, cells: 4 }]);
});

test('the first match shown is the newest; Enter goes older and Shift+Enter newer, round the ends', () => {
  const m = [{ row: 1, col: 0 }, { row: 5, col: 3 }, { row: 5, col: 9 }, { row: 40, col: 2 }];
  assert.equal(find.step(m, null, 0), 3);
  assert.equal(find.step(m, null, -1), 3);
  assert.equal(find.step(m, m[3], -1), 2);
  assert.equal(find.step(m, m[2], -1), 1);
  assert.equal(find.step(m, m[0], -1), 3, 'past the oldest, back to the newest');
  assert.equal(find.step(m, m[1], 1), 2);
  assert.equal(find.step(m, m[3], 1), 0, 'past the newest, round to the oldest');
  assert.equal(find.step([], null, 0), -1);
});

test('typing more keeps the match shown while it still matches, else the nearest older one', () => {
  const m = [{ row: 1, col: 0 }, { row: 5, col: 3 }, { row: 40, col: 2 }];
  assert.equal(find.step(m, { row: 5, col: 3 }, 0), 1);
  assert.equal(find.step(m, { row: 20, col: 0 }, 0), 1);
  assert.equal(find.step(m, { row: 0, col: 0 }, 0), 2, 'none older: the newest');
});

test('⌘F opens find on a Mac, Ctrl+Shift+F elsewhere; Ctrl+F stays the pane\'s', () => {
  assert.equal(find.isFindKey({ key: 'f', code: 'KeyF', metaKey: true }, true), true);
  assert.equal(find.isFindKey({ key: 'f', code: 'KeyF', ctrlKey: true }, true), false);
  assert.equal(find.isFindKey({ key: 'f', code: 'KeyF', metaKey: true, shiftKey: true }, true), false);
  assert.equal(find.isFindKey({ key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true }, false), true);
  assert.equal(find.isFindKey({ key: 'f', code: 'KeyF', ctrlKey: true }, false), false, 'forward a character in the prompt');
  assert.equal(find.isFindKey({ key: 'f', code: 'KeyF', ctrlKey: true, shiftKey: true, altKey: true }, false), false);
  assert.equal(find.isFindKey({ key: 'g', code: 'KeyG', metaKey: true }, true), false);
});
