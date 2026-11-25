import test from 'node:test';
import assert from 'node:assert/strict';
import keys from './public/keys.cjs';

const { SHORTCUTS, byId, isMac, isTap, doubleTap, caps, label, takesTyping, match, tabOf } = keys;

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
  assert.equal(match({ key: 'j', code: 'KeyJ' }), null, 'J alone is nothing: only the mode reads it');
  assert.equal(byId.notifications.bell, true, 'left off the sheet where there is no list');
  assert.deepEqual(caps(byId.notifications.mod, false), ['Ctrl', 'J']);
});

test('G, then a letter, goes to a page; anything else after G is nothing', () => {
  assert.equal(match({ key: 'g', code: 'KeyG' }), 'g');
  assert.equal(match({ key: 'm', code: 'KeyM' }, { afterG: true }), 'mine');
  assert.equal(match({ key: 'e', code: 'KeyE' }, { afterG: true }), 'everyone');
  assert.equal(match({ key: 's', code: 'KeyS' }, { afterG: true }), 'mySettings');
  assert.equal(match({ key: 'x', code: 'KeyX' }, { afterG: true }), null);
  assert.equal(match({ key: 'n', code: 'KeyN' }, { afterG: true }), null, 'G N is not a shortcut: the mode\'s N is');
  for (const id of ['mine', 'everyone', 'mySettings']) assert.ok(byId[id].href.startsWith('/'));
});

test('every shortcut has words and at least one key', () => {
  for (const s of SHORTCUTS) {
    assert.ok(s.what, s.id);
    assert.ok(s.mod || s.bare || s.then || s.tap, s.id);
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

test('no key alone moves through the sessions, and no ⌥⌘ or Ctrl+Alt key does: only the mode', () => {
  for (const [key, code] of [['j', 'KeyJ'], ['k', 'KeyK'], ['1', 'Digit1'], ['4', 'Digit4']]) {
    assert.equal(match({ key, code }), null, key);
  }
  assert.equal(match({ key: 'ArrowDown', code: 'ArrowDown', metaKey: true, altKey: true }), null);
  assert.equal(match({ key: '2', code: 'Digit2', ctrlKey: true, altKey: true }), null, 'Ctrl+Alt is AltGr on many keyboards');
  assert.equal(tabOf({ code: 'Digit2' }), 2);
  assert.equal(tabOf({ code: 'Digit5' }), 0);
});

test('⌘ tapped twice (Ctrl off a Mac) turns on the mode, and ⌘B or Ctrl+B is no key of the console\'s', () => {
  for (const where of [{}, { typing: true }, { inFrame: true }]) {
    assert.equal(match({ key: 'b', code: 'KeyB', metaKey: true }, where), null);
    assert.equal(match({ key: 'b', code: 'KeyB', ctrlKey: true }, where), null, 'Ctrl+B is tmux\'s, readline\'s and the browser\'s');
  }
  // The tap's key alone: ⌘ on a Mac, Ctrl elsewhere (the Windows key is the OS's), with nothing else held.
  assert.equal(isTap({ key: 'Meta', metaKey: true }, true), true);
  assert.equal(isTap({ key: 'Control', ctrlKey: true }, false), true);
  assert.equal(isTap({ key: 'Control', ctrlKey: true }, true), false, 'Ctrl on a Mac is not it');
  assert.equal(isTap({ key: 'Meta', metaKey: true }, false), false, 'the Windows key is the OS\'s');
  assert.equal(isTap({ key: 'Meta', metaKey: true, shiftKey: true }, true), false, 'with Shift held it is not alone');
  assert.equal(isTap({ key: 'Control', ctrlKey: true, altKey: true }, false), false, 'Ctrl+Alt is AltGr');
  assert.equal(isTap({ key: 'Control', ctrlKey: true, metaKey: true }, false), false);
  assert.equal(isTap({ key: 'k', code: 'KeyK', metaKey: true }, true), false, '⌘K is not a tap');
  // A modifier alone is no shortcut by itself: the shell counts the taps.
  assert.equal(match({ key: 'Meta', code: 'MetaLeft', metaKey: true }), null);
  assert.equal(match({ key: 'Control', code: 'ControlLeft', ctrlKey: true }), null);
  assert.equal(caps(byId.prefix.tap, true)[0], '⌘', 'written ⌘ ⌘ on a Mac');
  assert.equal(caps(byId.prefix.tap, false)[0], 'Ctrl', 'and Ctrl Ctrl elsewhere');
});

test('in the mode its keys move through the sessions from anywhere, and any other key is itself', () => {
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
  for (const id of ['nextSession', 'prevSession', 'tab', 'needsYou']) {
    assert.ok(byId[id].then && !byId[id].bare && !byId[id].mod, `${id} is the mode's alone`);
    assert.ok(byId[id].page, `${id} is left alone on a page with no rail`);
  }
  assert.equal(byId.prefix.page, 'moveSession');
});

test('a double tap is two quick taps of the key alone, by a clock the test holds', () => {
  const ctrl = (code = 'ControlLeft', extra = {}) => ({ key: 'Control', code, ctrlKey: true, ...extra });
  const tap = (t, at, code) => {
    t.down(ctrl(code), at);
    return t.up(ctrl(code), at + 50);
  };
  let t = doubleTap({ mac: false });
  assert.equal(tap(t, 0), false, 'one tap is not yet');
  assert.equal(tap(t, 200), true, 'a second within 400 ms is');
  assert.equal(tap(t, 400), false, 'and the count starts again after it');

  t = doubleTap({ mac: false });
  tap(t, 0);
  assert.equal(tap(t, 600), false, 'too slow: the second is a first again');
  assert.equal(tap(t, 800), true);

  t = doubleTap({ mac: false });
  t.down(ctrl(), 0);
  t.up(ctrl(), 900);
  assert.equal(tap(t, 1000), false, 'a key held 0.9 s is no tap, and no first one either');

  t = doubleTap({ mac: false });
  t.down(ctrl(), 0);
  t.down({ key: 'c', code: 'KeyC', ctrlKey: true }, 20);
  t.up(ctrl(), 60);
  t.down(ctrl(), 100);
  t.down({ key: 'c', code: 'KeyC', ctrlKey: true }, 120);
  assert.equal(t.up(ctrl(), 160), false, 'Ctrl+C twice is never one');

  t = doubleTap({ mac: false });
  t.down(ctrl(), 0);
  t.down(ctrl(), 30);
  t.down({ ...ctrl(), repeat: true }, 60);
  t.up(ctrl(), 100);
  assert.equal(tap(t, 200), true, 'a held key\'s repeats do not break a tap');

  // The left Ctrl held, the right pressed and let go, then the left: two keys, not a tap.
  t = doubleTap({ mac: false });
  t.down(ctrl('ControlLeft'), 0);
  t.down(ctrl('ControlRight'), 40);
  assert.equal(t.up(ctrl('ControlLeft'), 80), false);
  t.up(ctrl('ControlRight'), 100);
  assert.equal(tap(t, 200), false, 'so the next single tap is a first');
  assert.equal(tap(t, 400), true);

  t = doubleTap({ mac: false });
  tap(t, 0);
  t.reset();
  assert.equal(tap(t, 100), false, 'a click or the wheel between (reset) is no double tap');

  t = doubleTap({ mac: true });
  tap(t, 0);
  assert.equal(tap(t, 100), false, 'Ctrl on a Mac is not the key');
  const cmd = { key: 'Meta', code: 'MetaLeft', metaKey: true };
  t.down(cmd, 200);
  t.up(cmd, 250);
  t.down(cmd, 300);
  assert.equal(t.up(cmd, 350), true, '⌘ twice on a Mac is');
});
