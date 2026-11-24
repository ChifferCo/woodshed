import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// public/terminalPage.js as a browser runs it, with xterm, the add-ons and the websocket stood in for: what it sends
// ttyd, for the parts a person sees only with a second device on the session (the browser proved them on the dev
// console's live terminal).
const SOURCE = fs.readFileSync(path.join(import.meta.dirname, 'public/terminalPage.js'), 'utf8');
const FOCUS_IN = '0\x1b[I';

function load({ sendFocusMode = true, hash = '#term/0a1b2c3d', box = { width: 900, height: 600 }, proposed = { cols: 120, rows: 40 } } = {}) {
  const fits = [];
  const frame = { proposed };
  const listeners = { window: {}, document: {} };
  const on = (where) => (type, fn) => { (listeners[where][type] ??= []).push(fn); };
  const sockets = [];
  let now = 1_000_000;
  class FakeSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    constructor(url, protocols) {
      Object.assign(this, { url, protocols, readyState: FakeSocket.CONNECTING, sent: [], handlers: {} });
      sockets.push(this);
    }
    addEventListener(type, fn) { this.handlers[type] = fn; }
    send(data) { this.sent.push(Buffer.from(data).toString('latin1')); }
    open() {
      this.readyState = FakeSocket.OPEN;
      this.handlers.open?.();
    }
  }
  const noop = () => ({ dispose() {} });
  class FakeTerminal {
    constructor(options) {
      Object.assign(this, { options, cols: 120, rows: 40, modes: { sendFocusMode }, unicode: {} });
    }
    loadAddon() {}
    open() {}
    focus() {}
    reset() {}
    write() {}
    getSelection() { return ''; }
  }
  for (const event of ['onTitleChange', 'onData', 'onBinary', 'onResize', 'onSelectionChange', 'onKey']) FakeTerminal.prototype[event] = noop;
  const addon = (name) => ({ [name]: class { fit() {} onContextLoss() {} dispose() {} } });
  // xterm's fit: what it would size the terminal to in the frame as it is, and each time it did.
  const fitAddon = { FitAddon: class { proposeDimensions() { return frame.proposed; } fit() { fits.push(frame.proposed); } } };
  const container = { get clientWidth() { return box.width; }, get clientHeight() { return box.height; } };
  const element = (id) => (id === 'terminal-container' ? container : { textContent: '', hidden: true });
  const window = {
    location: { hash, host: 'console.example', protocol: 'https:' },
    addEventListener: on('window'),
    Terminal: FakeTerminal,
    FitAddon: fitAddon,
    WebLinksAddon: addon('WebLinksAddon'),
    Unicode11Addon: addon('Unicode11Addon'),
    WebglAddon: addon('WebglAddon'),
    CanvasAddon: addon('CanvasAddon'),
  };
  const document = { hidden: false, title: '', addEventListener: on('document'), getElementById: element, execCommand() {} };
  const context = vm.createContext({
    window, document, WebSocket: FakeSocket, TextEncoder, TextDecoder, URLSearchParams, Uint8Array, console,
    setTimeout, clearTimeout, Date: { now: () => now },
  });
  vm.runInContext(SOURCE, context);
  const fire = (where, type) => { for (const fn of listeners[where][type] ?? []) fn({ type }); };
  return {
    fits,
    box,
    frame,
    socket: () => sockets.at(-1),
    sockets,
    fire,
    later: (ms) => { now += ms; },
    focusIns: () => sockets.at(-1).sent.filter((m) => m === FOCUS_IN).length,
  };
}

test('a wheel, a click or tap, or the page coming back tells tmux this device is in use, at most every 2 s', () => {
  const page = load();
  assert.equal(page.socket().url, 'wss://console.example/term/0a1b2c3d/ws');
  page.socket().open();
  assert.deepEqual(page.socket().sent, ['{"columns":120,"rows":40}'], 'the size first, as ttyd wants');

  page.fire('window', 'wheel');
  assert.equal(page.focusIns(), 1);
  page.fire('window', 'wheel');
  page.fire('window', 'pointerdown');
  assert.equal(page.focusIns(), 1, 'a scroll is many events, and one says it');

  page.later(2000);
  page.fire('window', 'pointerdown');
  assert.equal(page.focusIns(), 2);
  page.later(2000);
  page.fire('window', 'touchstart');
  page.later(2000);
  page.fire('window', 'focus');
  page.later(2000);
  page.fire('document', 'visibilitychange');
  assert.equal(page.focusIns(), 5, 'a tap, the window to the front, and the tab shown again each count');
});

test('nothing is sent while tmux has not asked for focus events, or before the socket is open', () => {
  const unasked = load({ sendFocusMode: false });
  unasked.socket().open();
  for (const type of ['wheel', 'pointerdown', 'touchstart', 'focus']) unasked.fire('window', type);
  unasked.fire('document', 'visibilitychange');
  assert.deepEqual(unasked.socket().sent, ['{"columns":120,"rows":40}'], 'those bytes would be typing in the pane');

  const opening = load();
  opening.fire('window', 'wheel');
  assert.deepEqual(opening.socket().sent, [], 'not open yet');
  opening.socket().open();
  opening.fire('window', 'wheel');
  assert.equal(opening.focusIns(), 1, 'the wheel before it opened did not use up the 2 s');
});

test('an agent beside the session\'s own goes on the websocket\'s query, and an address naming no terminal opens none', () => {
  const agent = load({ hash: '#term/0a1b2c3d?arg=agent-2' });
  assert.equal(agent.socket().url, 'wss://console.example/term/0a1b2c3d/ws?arg=agent-2');
  assert.equal(load({ hash: '#term/0a1b2c3d?arg=../../x' }).sockets.length, 0);
  assert.equal(load({ hash: '#shell/0a1b2c3d' }).socket().url, 'wss://console.example/shell/0a1b2c3d/ws');
});

test('a frame with no box to measure is never fitted to xterm\'s 2-column minimum: the last size stays', () => {
  const page = load();
  assert.deepEqual(page.fits, [{ cols: 120, rows: 40 }], 'fitted as it opens');
  // Squeezed to nothing for a moment, as a layout change can: xterm would propose its 2x1 minimum.
  page.frame.proposed = { cols: 2, rows: 1 };
  page.fire('window', 'resize');
  page.frame.proposed = { cols: 19, rows: 30 };
  page.fire('window', 'resize');
  page.frame.proposed = undefined;
  page.fire('window', 'resize');
  assert.equal(page.fits.length, 1, 'tmux would have drawn every device\'s screen that narrow');
  page.frame.proposed = { cols: 48, rows: 30 };
  page.fire('window', 'resize');
  assert.deepEqual(page.fits.at(-1), { cols: 48, rows: 30 }, 'a phone\'s narrow pane still fits');
});

test('a terminal not displayed never says its device is in use', () => {
  const page = load();
  page.socket().open();
  page.box.width = 0;
  page.box.height = 0;
  for (const type of ['wheel', 'pointerdown', 'focus']) page.fire('window', type);
  page.fire('document', 'visibilitychange');
  assert.equal(page.focusIns(), 0, 'the phone on its list, or another tab, would take the window');
  page.box.width = 900;
  page.box.height = 600;
  page.fire('window', 'focus');
  assert.equal(page.focusIns(), 1);
});
