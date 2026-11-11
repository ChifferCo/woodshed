import test from 'node:test';
import assert from 'node:assert/strict';
import keys from './public/keys.cjs';

const { SHORTCUTS, byId, isMac, caps, label, takesTyping, match } = keys;

test('a key is written the Mac way on a Mac and with Ctrl elsewhere', () => {
  assert.equal(isMac({ platform: 'MacIntel' }), true);
  assert.equal(isMac({ platform: 'Win32' }), false);
  assert.equal(isMac({ platform: '', userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)' }), true);
  assert.deepEqual(caps('⇧⌘O', true), ['⇧', '⌘', 'O']);
  assert.deepEqual(caps('⇧⌘O', false), ['Ctrl', 'Shift', 'O']);
  assert.equal(label('⇧⌘,', true), '⇧⌘,');
  assert.equal(label('⇧⌘,', false), 'Ctrl+Shift+,');
  assert.equal(label('⌘K', false), 'Ctrl+K');
});

test('the modifier shortcuts work anywhere, Ctrl only outside a terminal', () => {
  assert.equal(match({ key: 'k', code: 'KeyK', metaKey: true }), 'palette');
  assert.equal(match({ key: 'k', code: 'KeyK', ctrlKey: true }), 'palette');
  assert.equal(match({ key: 'k', code: 'KeyK', ctrlKey: true }, { inFrame: true }), null, 'Ctrl+K is the terminal\'s');
  assert.equal(match({ key: 'k', code: 'KeyK', metaKey: true }, { inFrame: true }), 'palette');
  assert.equal(match({ key: 'O', code: 'KeyO', metaKey: true, shiftKey: true }, { typing: true }), 'new', 'a combo works while typing');
  assert.equal(match({ key: 'o', code: 'KeyO', metaKey: true }), null, '⌘O is the browser\'s');
  assert.equal(match({ key: '?', code: 'Slash', metaKey: true, shiftKey: true }), 'keys');
  assert.equal(match({ key: '<', code: 'Comma', metaKey: true, shiftKey: true }), 'settings');
  assert.equal(match({ key: '.', code: 'Period', metaKey: true }), 'rail');
  assert.equal(match({ key: 'k', code: 'KeyK', metaKey: true, altKey: true }), null);
});

test('a key alone works only while nothing takes typing, and never in a terminal', () => {
  assert.equal(match({ key: '?', code: 'Slash', shiftKey: true }), 'keys');
  assert.equal(match({ key: '/', code: 'Slash' }), 'palette');
  assert.equal(match({ key: 'n', code: 'KeyN' }), 'new');
  assert.equal(match({ key: 'N', code: 'KeyN', shiftKey: true }), null, 'Shift+N is not N');
  for (const where of [{ typing: true }, { inFrame: true }]) {
    assert.equal(match({ key: '?', code: 'Slash', shiftKey: true }, where), null);
    assert.equal(match({ key: 'n', code: 'KeyN' }, where), null);
  }
  assert.equal(match({ key: 'n', code: 'KeyN', ctrlKey: true }, { inFrame: true }), null);
  assert.equal(match({ key: 'x', code: 'KeyX' }), null);
});

test('G, then a letter, goes to a page; anything else after G is nothing', () => {
  assert.equal(match({ key: 'g', code: 'KeyG' }), 'g');
  assert.equal(match({ key: 'm', code: 'KeyM' }, { afterG: true }), 'mine');
  assert.equal(match({ key: 'e', code: 'KeyE' }, { afterG: true }), 'everyone');
  assert.equal(match({ key: 's', code: 'KeyS' }, { afterG: true }), 'mySettings');
  assert.equal(match({ key: 'n', code: 'KeyN' }, { afterG: true }), null);
  for (const id of ['mine', 'everyone', 'mySettings']) assert.ok(byId[id].href.startsWith('/'));
});

test('every shortcut has words and at least one key', () => {
  for (const s of SHORTCUTS) {
    assert.ok(s.what, s.id);
    assert.ok(s.mod || s.bare, s.id);
  }
});

test('a key alone is ours only when focus takes no text', () => {
  assert.equal(takesTyping(null), false);
  assert.equal(takesTyping({ tagName: 'BUTTON' }), false);
  assert.equal(takesTyping({ tagName: 'INPUT', type: 'checkbox' }), false);
  assert.equal(takesTyping({ tagName: 'INPUT', type: 'text' }), true);
  assert.equal(takesTyping({ tagName: 'INPUT' }), true);
  assert.equal(takesTyping({ tagName: 'TEXTAREA' }), true);
  assert.equal(takesTyping({ tagName: 'SELECT' }), true);
  assert.equal(takesTyping({ tagName: 'DIV', isContentEditable: true }), true);
});
