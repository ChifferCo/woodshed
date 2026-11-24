// The terminal page behind the TUI and Terminal tabs, served by the console as /static/term.html (server.mjs,
// terminalPageHtml) and kept by the browser by its hash, so opening a session's terminal loads nothing but its
// websocket. The address's fragment says which: #term/<id> for the agent's tmux, #shell/<id> for the plain shell, and
// #term/<id>?arg=agent-<n> for an agent beside the session's own, whose `arg` goes on the websocket's query for ttyd to
// hand to woodshed-attach.
//
// It does what ttyd 1.7.7's own page does, so the session's ttyd is only the connection: xterm.js (vendor/xterm/, the
// versions ttyd bundles), and ttyd's protocol on the websocket at /<kind>/<id>/ws, subprotocol `tty`. The first
// message is the terminal's size as JSON; the console adds ttyd's credential to it (terminalProxy.mjs), so the page
// never holds one. Then each message is one byte saying what it is and the rest: to ttyd '0' input, '1' a new size,
// '2' and '3' to pause and resume its output; from ttyd '0' output, '1' its window title, '2' its preferences (the
// session's `-t` flags: theme, scrollback).
//
// The session page (terminal.js) reaches into this frame as it does into ttyd's: `window.term` is the xterm, and the
// document's title is the pane's own then ttyd's (`claude (main screen) | …`, terminalScroll.cjs). A closed socket is
// opened again by itself while the page is in front, a few times a minute; past that, Enter opens it.
(function () {
  'use strict';
  const ROUTE_RE = /^#(term|shell)\/([0-9a-f]{8})(?:\?arg=(agent-[2-9]))?$/;
  // ttyd's own defaults, with the session's theme over them so nothing flashes grey before its preferences arrive
  // (session/entrypoint.sh's `theme`, which still comes after, as ttyd's '2' message).
  const OPTIONS = {
    fontSize: 13,
    fontFamily: 'Consolas,Liberation Mono,Menlo,Courier,monospace',
    theme: {
      foreground: '#d6d3cd', background: '#14171d', cursor: '#E87D09', cursorAccent: '#14171d', selectionBackground: '#2c2013',
      black: '#000000', red: '#d81e00', green: '#5ea702', yellow: '#cfae00', blue: '#427ab3', magenta: '#89658e', cyan: '#00a7aa',
      white: '#dbded8', brightBlack: '#686a66', brightRed: '#f54235', brightGreen: '#99e343', brightYellow: '#fdeb61',
      brightBlue: '#84b0d8', brightMagenta: '#bc94b7', brightCyan: '#37e6e8', brightWhite: '#f1f1f0',
    },
    // registerDecoration and registerMarker, which find (terminal.js) paints with, are proposed API in xterm 5.
    allowProposedApi: true,
  };
  // ttyd's flow control: past LIMIT bytes, each write is counted until xterm has drawn it, and ttyd is asked to pause
  // its output while more than HIGH are waiting, and to go on below LOW.
  const FLOW = { limit: 100_000, high: 10, low: 4 };
  const RETRIES_PER_MINUTE = 3;
  const RETRY_MS = [500, 2000, 5000];
  const CLAIM_MS = 2000;

  const route = ROUTE_RE.exec(window.location.hash);
  const container = document.getElementById('terminal-container');
  const overlay = document.getElementById('overlay');
  let overlayTimer = null;
  if (!route) {
    showOverlay('No terminal named in this address');
    return;
  }
  const [, kind, id, arg] = route;
  const query = arg ? `?${new URLSearchParams({ arg })}` : '';
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let socket = null;
  let opened = false;
  let ttydTitle = '';
  let written = 0;
  let pending = 0;
  let retryTimer = null;
  let waitingForEnter = null;
  let unicode11 = false;
  let webgl = null;
  let canvas = null;
  const tries = [];
  let claimedAt = 0;

  const term = new window.Terminal(OPTIONS);
  window.term = term;
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new window.WebLinksAddon.WebLinksAddon());
  term.open(container);
  fit.fit();
  // ttyd's defaults, before its preferences say otherwise: WebGL, falling back to canvas, and Unicode 11's widths.
  useWebgl();
  useUnicode11();

  term.onTitleChange((title) => {
    if (title) document.title = `${title} | ${ttydTitle}`;
  });
  term.onData((data) => send('0', data));
  term.onBinary((data) => send('0', Uint8Array.from(data, (c) => c.charCodeAt(0))));
  term.onResize(({ cols, rows }) => send('1', JSON.stringify({ columns: cols, rows })));
  // As ttyd's page does: a selection is copied as it is made.
  term.onSelectionChange(() => {
    if (term.getSelection() === '') return;
    try {
      document.execCommand('copy');
    } catch {
      // The browser would not: the selection stays for the copy key.
    }
  });
  window.addEventListener('resize', () => fit.fit());
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !isOpen() && !retryTimer) retry();
    if (!document.hidden) claim();
  });
  // tmux sizes the window by the client used last (window-size latest), and only input counts: after a phone opened the
  // session, a desktop that scrolls (the browser's own history, or tmux's copy mode through statusd) or comes back to
  // the front sends tmux nothing, and stays at the phone's width until a click or a key. Any of those here says so with a
  // focus-in, which tmux takes as use, only while tmux asked for focus events (DECSET 1004, tmux.conf's focus-events):
  // otherwise those bytes would be typing.
  for (const type of ['wheel', 'pointerdown', 'touchstart']) window.addEventListener(type, claim, { capture: true, passive: true });
  window.addEventListener('focus', claim);

  connect();

  function isOpen() {
    return socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING;
  }

  function connect() {
    retryTimer = null;
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${scheme}//${window.location.host}/${kind}/${id}/ws${query}`, ['tty']);
    ws.binaryType = 'arraybuffer';
    socket = ws;
    ws.addEventListener('open', () => {
      // The size only: the console puts ttyd's credential in this message on its way.
      ws.send(encoder.encode(JSON.stringify({ columns: term.cols, rows: term.rows })));
      written = 0;
      pending = 0;
      if (opened) {
        // tmux draws the whole screen again for a new client, so what was on it goes first.
        term.reset();
        term.options.disableStdin = false;
        showOverlay('Reconnected', 300);
      } else {
        opened = true;
        hideOverlay();
      }
      term.focus();
    });
    ws.addEventListener('message', (e) => received(e.data));
    ws.addEventListener('close', (e) => {
      if (socket !== ws) return;
      console.log('[terminal] websocket closed', { code: e.code });
      term.options.disableStdin = true;
      retry();
    });
  }

  function received(data) {
    const bytes = new Uint8Array(data);
    const body = bytes.subarray(1);
    switch (String.fromCharCode(bytes[0])) {
      case '0':
        write(body);
        break;
      case '1':
        ttydTitle = decoder.decode(body);
        document.title = ttydTitle;
        break;
      case '2':
        preferences(JSON.parse(decoder.decode(body) || '{}'));
        break;
      default:
        console.warn('[terminal] unknown message from ttyd', bytes[0]);
    }
  }

  function write(bytes) {
    written += bytes.length;
    if (written <= FLOW.limit) {
      term.write(bytes);
      return;
    }
    written = 0;
    pending += 1;
    term.write(bytes, () => {
      pending = Math.max(pending - 1, 0);
      if (pending < FLOW.low) send('3');
    });
    if (pending > FLOW.high) send('2');
  }

  // At most every CLAIM_MS: one says it, and a scroll is many events.
  function claim() {
    if (!term.modes.sendFocusMode || socket?.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (now - claimedAt < CLAIM_MS) return;
    claimedAt = now;
    send('0', '\x1b[I');
  }

  function send(type, data = '') {
    if (socket?.readyState !== WebSocket.OPEN) return;
    const body = typeof data === 'string' ? encoder.encode(data) : data;
    const message = new Uint8Array(body.length + 1);
    message[0] = type.charCodeAt(0);
    message.set(body, 1);
    socket.send(message);
  }

  // The session's `-t` flags, as ttyd applies them: its own switches, and anything else straight onto xterm.
  function preferences(prefs) {
    for (const [key, value] of Object.entries(prefs)) {
      switch (key) {
        case 'rendererType':
          if (value === 'webgl') useWebgl();
          else if (value === 'canvas') useCanvas();
          break;
        case 'unicodeVersion':
          if (String(value) === '11') useUnicode11();
          break;
        // ttyd's page switches, which this page has no use for: no leave alert, no size overlay, no file transfer.
        case 'disableLeaveAlert': case 'disableResizeOverlay': case 'disableReconnect': case 'enableZmodem': case 'enableTrzsz':
        case 'enableSixel': case 'isWindows': case 'titleFixed': case 'closeOnDisconnect': case 'trzszDragInitTimeout':
          break;
        default: {
          const current = term.options[key];
          term.options[key] = current && typeof current === 'object' && value && typeof value === 'object' ? { ...current, ...value } : value;
          if (key.startsWith('font')) fit.fit();
        }
      }
    }
  }

  function useUnicode11() {
    if (unicode11) return;
    unicode11 = true;
    term.loadAddon(new window.Unicode11Addon.Unicode11Addon());
    term.unicode.activeVersion = '11';
  }

  function useWebgl() {
    if (webgl) return;
    dropCanvas();
    try {
      webgl = new window.WebglAddon.WebglAddon();
      webgl.onContextLoss(() => {
        dropWebgl();
        useCanvas();
      });
      term.loadAddon(webgl);
    } catch (err) {
      console.log('[terminal] WebGL renderer not loaded, using canvas', err?.message);
      dropWebgl();
      useCanvas();
    }
  }
  function useCanvas() {
    if (canvas) return;
    dropWebgl();
    try {
      canvas = new window.CanvasAddon.CanvasAddon();
      term.loadAddon(canvas);
    } catch (err) {
      console.log('[terminal] canvas renderer not loaded, using the DOM', err?.message);
      dropCanvas();
    }
  }
  function dropWebgl() {
    try { webgl?.dispose(); } catch { /* already gone */ }
    webgl = null;
  }
  function dropCanvas() {
    try { canvas?.dispose(); } catch { /* already gone */ }
    canvas = null;
  }

  // Opened again by itself while the page is in front, at most RETRIES_PER_MINUTE times a minute, so a session that
  // is gone for good is not asked for again and again: past that, Enter opens it. A page in the background waits to be
  // shown, as a phone closes its sockets there.
  function retry() {
    if (document.hidden) {
      showOverlay('Connection closed');
      return;
    }
    const now = Date.now();
    while (tries.length && now - tries[0] > 60_000) tries.shift();
    if (tries.length >= RETRIES_PER_MINUTE) {
      waitForEnter();
      return;
    }
    tries.push(now);
    showOverlay('Reconnecting…');
    retryTimer = setTimeout(connect, RETRY_MS[tries.length - 1] ?? RETRY_MS.at(-1));
  }

  function waitForEnter() {
    showOverlay('Connection closed. Press ⏎ to reconnect');
    if (waitingForEnter) return;
    waitingForEnter = term.onKey((e) => {
      if (e.domEvent.key !== 'Enter') return;
      waitingForEnter.dispose();
      waitingForEnter = null;
      tries.length = 0;
      showOverlay('Reconnecting…');
      connect();
    });
    // The keyboard reaches xterm only while stdin is on; nothing is sent while the socket is closed anyway.
    term.options.disableStdin = false;
  }

  function showOverlay(text, ms = 0) {
    clearTimeout(overlayTimer);
    overlay.textContent = text;
    overlay.hidden = false;
    if (ms) overlayTimer = setTimeout(hideOverlay, ms);
  }
  function hideOverlay() {
    clearTimeout(overlayTimer);
    overlay.hidden = true;
  }
})();
