import test from 'node:test';
import assert from 'node:assert/strict';
import keys from './public/keys.cjs';

const { SHORTCUTS, byId, isMac, caps, label, takesTyping, match, tabOf } = keys;

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

test('⌘J or Ctrl+J is the notifications, and Ctrl+J in a terminal is the terminal\'s', () => {
  assert.equal(match({ key: 'j', code: 'KeyJ', metaKey: true }), 'notifications');
  assert.equal(match({ key: 'j', code: 'KeyJ', ctrlKey: true }), 'notifications');
  assert.equal(match({ key: 'j', code: 'KeyJ', metaKey: true }, { inFrame: true }), 'notifications');
  assert.equal(match({ key: 'j', code: 'KeyJ', ctrlKey: true }, { inFrame: true }), null);
  assert.equal(match({ key: 'J', code: 'KeyJ', metaKey: true, shiftKey: true }), null);
  assert.equal(match({ key: 'j', code: 'KeyJ' }), null, 'J alone is nothing: only ⌘B\'s mode reads it');
  assert.equal(byId.notifications.bell, true, 'left off the sheet where there is no list');
  assert.deepEqual(caps(byId.notifications.mod, false), ['Ctrl', 'J']);
});

test('G, then a letter, goes to a page; anything else after G is nothing', () => {
  assert.equal(match({ key: 'g', code: 'KeyG' }), 'g');
  assert.equal(match({ key: 'm', code: 'KeyM' }, { afterG: true }), 'mine');
  assert.equal(match({ key: 'e', code: 'KeyE' }, { afterG: true }), 'everyone');
  assert.equal(match({ key: 's', code: 'KeyS' }, { afterG: true }), 'mySettings');
  assert.equal(match({ key: 'x', code: 'KeyX' }, { afterG: true }), null);
  assert.equal(match({ key: 'n', code: 'KeyN' }, { afterG: true }), null, 'G N is not a shortcut: ⌘B, then N is');
  for (const id of ['mine', 'everyone', 'mySettings']) assert.ok(byId[id].href.startsWith('/'));
});

test('every shortcut has words and at least one key', () => {
  for (const s of SHORTCUTS) {
    assert.ok(s.what, s.id);
    assert.ok(s.mod || s.bare || s.then, s.id);
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

test('⌘↵ or Ctrl+Enter is Start on New session, written Ctrl+Enter off a Mac, and left to the form', () => {
  assert.equal(match({ key: 'Enter', code: 'Enter', metaKey: true }, { typing: true }), 'start');
  assert.equal(match({ key: 'Enter', code: 'Enter', ctrlKey: true }, { typing: true }), 'start');
  assert.equal(match({ key: 'Enter', code: 'NumpadEnter', metaKey: true }), 'start');
  assert.equal(match({ key: 'Enter', code: 'Enter', metaKey: true, shiftKey: true }), null);
  assert.equal(match({ key: 'Enter', code: 'Enter' }), null, 'Enter alone is a new line in the prompt');
  assert.equal(match({ key: 'Enter', code: 'Enter', ctrlKey: true }, { inFrame: true }), null, 'Ctrl+Enter is the terminal\'s');
  assert.deepEqual(caps(byId.start.mod, true), ['⌘', '↵']);
  assert.deepEqual(caps(byId.start.mod, false), ['Ctrl', 'Enter']);
  assert.equal(byId.start.where, 'New session');
});

test('find is written ⌘F on a Mac and Ctrl+Shift+F elsewhere, and left to the terminal', () => {
  assert.deepEqual(caps(byId.find.mod, true), ['⌘', 'F']);
  assert.deepEqual(caps(byId.find.modOther, false), ['Ctrl', 'Shift', 'F']);
  assert.equal(match({ key: 'f', code: 'KeyF', metaKey: true }, { inFrame: true }), null, 'terminal.js reads it');
  assert.ok(byId.find.where);
});

test('no key alone moves through the sessions, and no ⌥⌘ or Ctrl+Alt key does: only ⌘B\'s mode', () => {
  for (const [key, code] of [['j', 'KeyJ'], ['k', 'KeyK'], ['1', 'Digit1'], ['4', 'Digit4']]) {
    assert.equal(match({ key, code }), null, key);
  }
  assert.equal(match({ key: 'ArrowDown', code: 'ArrowDown', metaKey: true, altKey: true }), null);
  assert.equal(match({ key: '2', code: 'Digit2', ctrlKey: true, altKey: true }), null, 'Ctrl+Alt is AltGr on many keyboards');
  assert.equal(tabOf({ code: 'Digit2' }), 2);
  assert.equal(tabOf({ code: 'Digit5' }), 0);
});

test('⌘B turns on a mode, as Herdr\'s navigate mode, whose keys move through the sessions from anywhere', () => {
  assert.equal(match({ key: 'b', code: 'KeyB', metaKey: true }, { inFrame: true }), 'prefix');
  assert.equal(match({ key: 'b', code: 'KeyB', metaKey: true }, { typing: true }), 'prefix');
  assert.equal(match({ key: 'b', code: 'KeyB', ctrlKey: true }, { typing: true }), 'prefix', 'Ctrl+B off a Mac, while typing');
  assert.equal(match({ key: 'b', code: 'KeyB', ctrlKey: true }, { inFrame: true }), null, 'Ctrl+B in a terminal is tmux\'s prefix');
  assert.equal(match({ key: 'b', code: 'KeyB', ctrlKey: true }, { typing: true, mac: true }), null, 'Ctrl+B in a Mac\'s text field is back one character');
  assert.equal(match({ key: 'b', code: 'KeyB', metaKey: true }, { typing: true, mac: true }), 'prefix');
  assert.equal(match({ key: 'b', code: 'KeyB', ctrlKey: true }, { mac: true }), 'prefix', 'Ctrl+B on a Mac, not typing');
  assert.equal(match({ key: 'B', code: 'KeyB', metaKey: true, shiftKey: true }), null, '⇧⌘B is the browser\'s bookmarks bar');
  for (const where of [{ typing: true }, { inFrame: true }, {}]) {
    const on = { ...where, moving: true };
    assert.equal(match({ key: 'j', code: 'KeyJ' }, on), 'nextSession');
    assert.equal(match({ key: 'k', code: 'KeyK' }, on), 'prevSession');
    assert.equal(match({ key: 'ArrowDown', code: 'ArrowDown' }, on), 'nextSession');
    assert.equal(match({ key: 'ArrowUp', code: 'ArrowUp' }, on), 'prevSession');
    assert.equal(match({ key: 'n', code: 'KeyN' }, on), 'needsYou');
    assert.equal(match({ key: '3', code: 'Digit3' }, on), 'tab');
    assert.equal(match({ key: '3', code: 'Digit3', shiftKey: true }, on), 'tab', 'AZERTY types 3 with Shift');
    assert.equal(match({ key: '"', code: 'Digit3' }, on), null, 'AZERTY\'s " is not 3');
    assert.equal(match({ key: 'J', code: 'KeyJ', shiftKey: true }, on), null);
    assert.equal(match({ key: 'Escape', code: 'Escape' }, on), 'cancel');
    assert.equal(match({ key: 'x', code: 'KeyX' }, on), null, 'any other key ends the mode and goes where it would have');
    assert.equal(match({ key: '/', code: 'Slash' }, on), match({ key: '/', code: 'Slash' }, where), 'and is what it would have been');
  }
  assert.equal(match({ key: 'k', code: 'KeyK', metaKey: true }, { moving: true }), 'palette', 'a ⌘ key in the mode is itself');
  assert.deepEqual(caps(byId.prefix.mod, false), ['Ctrl', 'B']);
  for (const id of ['nextSession', 'prevSession', 'tab', 'needsYou']) {
    assert.ok(byId[id].then && !byId[id].bare && !byId[id].mod, `${id} is ⌘B's alone`);
    assert.ok(byId[id].page, `${id} is left alone on a page with no rail`);
  }
  assert.equal(byId.prefix.page, 'moveSession');
});
