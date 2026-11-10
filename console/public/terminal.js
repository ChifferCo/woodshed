// The shed's terminal, around a session's ttyd frame (same-origin, so its window's `term` is xterm's): copy out by
// OSC 52, tap a link on a phone, a picture's path opens it (a thumbnail on hover, a viewer on click), a file pasted or
// dropped is saved in the session and its path typed at the prompt, and a swipe on a phone scrolls tmux. Copy is a
// chain this page does not own: with tmux's mouse on, claude copies through `tmux load-buffer -w`, tmux writes an OSC 52
// sequence to the client, and the handler on the frame's `term` takes it; a browser that allows the clipboard write
// only inside a key press gets the text held and a toast asking for the copy key. Files go through the console to the
// session's statusd.
(function () {
  'use strict';
  const W = window.Woodshed;
  const { h } = W;
  const TERM_POLL_MS = 250;
  // ttyd sets window.term after its token fetch, which the proxy gives 30 s.
  const TERM_WAIT_MS = 60_000;
  const OSC_DEDUPE_MS = 1000;
  // How long a copy the browser refused waits for the copy key.
  const HELD_MS = 60_000;
  const TAP_PX = 10;
  const TAP_MS = 500;
  const SWIPE_PX = 20;
  const MAX_URL_ROWS = 16;
  const EDGE_COLS = 2;
  const MAX_FILES = 8;
  const MAX_FILE_MB = 25;
  const MAX_TOTAL_MB = 40;
  const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
  const URL_STOP = new Set([' ', '\t', '<', '>', '"', '\'', '`']);
  const URL_TRAIL = new Set(['.', ',', ';', ':', ')', ']', '}', '!', '?']);
  const UTF8 = new TextDecoder();

  function toast(text) {
    W.shell.toast(text);
  }

  async function writeClipboard(win, text) {
    try {
      await win.navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Below: the old way, inside the frame whose gesture this is.
    }
    try {
      const box = win.document.createElement('textarea');
      box.value = text;
      box.setAttribute('readonly', '');
      box.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      win.document.body.append(box);
      box.select();
      const ok = win.document.execCommand('copy');
      box.remove();
      return ok;
    } catch {
      return false;
    }
  }

  function whenTerm(frame, fn) {
    const until = Date.now() + TERM_WAIT_MS;
    const timer = setInterval(() => {
      const win = frame.isConnected ? frame.contentWindow : null;
      const term = win && win.term;
      if (!term) {
        if (!win || Date.now() > until) clearInterval(timer);
        return;
      }
      clearInterval(timer);
      fn(win, term);
    }, TERM_POLL_MS);
  }

  // The key that copies a held selection: ⌘C on a Mac. Elsewhere Ctrl+C is the pane's interrupt, so it is a terminal's
  // Ctrl+Shift+C, or Ctrl+Insert where the browser keeps Ctrl+Shift+C for its developer tools.
  function isCopyKey(e, mac) {
    if (e.altKey) return false;
    if (mac) return e.key.toLowerCase() === 'c' && e.metaKey && !e.ctrlKey;
    if (e.key === 'Insert') return e.ctrlKey && !e.shiftKey && !e.metaKey;
    return e.key.toLowerCase() === 'c' && e.ctrlKey && e.shiftKey && !e.metaKey;
  }

  // With tmux's mouse on, claude copies a drag itself and tmux writes it back as OSC 52. Only the focused frame
  // takes it, once, and a read request ('?') is never answered: the sequence is the pane's output.
  // Safari and Firefox refuse a clipboard write that is not inside a click or a key press, and this one comes from the
  // socket. So a refused copy is held, and the copy key writes it, inside its own key press, which they allow.
  function bindClipboard(frame) {
    whenTerm(frame, (win, term) => {
      let lastB64 = null;
      let lastAt = 0;
      let held = null;
      let heldAt = 0;
      const mac = /Mac|iPhone|iPad/.test(win.navigator.platform || win.navigator.userAgent);
      const keyboard = !win.matchMedia('(pointer: coarse)').matches;
      win.addEventListener('keydown', (e) => {
        if (held === null) return;
        // A minute on, the key is someone copying something else, not the drag the toast asked about.
        if (Date.now() - heldAt > HELD_MS) {
          held = null;
          return;
        }
        if (!isCopyKey(e, mac)) return;
        // A selection made in xterm itself (Shift+drag) is newer than the held one: the browser's own copy takes it.
        if (term.hasSelection()) {
          held = null;
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        const text = held;
        writeClipboard(win, text).then((copied) => {
          if (copied && held === text) held = null;
          toast(copied ? 'Copied' : 'Copy blocked by the browser');
        });
      }, true);
      term.parser.registerOscHandler(52, (data) => {
        if (!win.document.hasFocus()) return true;
        const b64 = data.slice(data.lastIndexOf(';') + 1);
        if (b64 === '' || b64 === '?') return true;
        const now = Date.now();
        if (b64 === lastB64 && now - lastAt < OSC_DEDUPE_MS) return true;
        lastB64 = b64;
        lastAt = now;
        let text;
        try {
          text = UTF8.decode(Uint8Array.from(win.atob(b64), (c) => c.charCodeAt(0)));
        } catch {
          return true;
        }
        writeClipboard(win, text).then((copied) => {
          term.focus();
          held = copied ? null : text;
          if (!copied) heldAt = Date.now();
          if (copied) toast('Copied');
          else toast(keyboard ? `Press ${mac ? '⌘C' : 'Ctrl+Shift+C or Ctrl+Insert'} to copy` : 'Copy blocked by the browser');
        });
        return true;
      });
    });
  }

  // ---- reading the screen at a point: cell by cell, a wide glyph being two cells and one character ----
  function continuesRow(buf, i) {
    const line = buf.getLine(i);
    if (!line) return false;
    if (line.isWrapped) return true;
    // Claude hard-wraps a long URL with its own newline and an indent, which tmux repaints as two rows.
    const above = buf.getLine(i - 1);
    if (!above) return false;
    const cell = buf.getNullCell();
    for (let c = above.length - 1; c >= 0 && c >= above.length - EDGE_COLS; c--) {
      const chars = above.getCell(c, cell).getChars();
      if (chars === '' || chars === ' ') continue;
      return !URL_STOP.has(chars);
    }
    return false;
  }

  function indentOf(line, cell) {
    let c = 0;
    while (c < line.length && line.getCell(c, cell).getChars() === ' ') c++;
    return c;
  }

  // The logical line from row `first`: `at` is the index of (hitRow, hitCol) in its text, -1 when not on it.
  function readLine(buf, first, hitRow, hitCol) {
    const cell = buf.getNullCell();
    let text = '';
    let at = -1;
    let row = first;
    for (let n = 0; n < 2 * MAX_URL_ROWS; n++, row++) {
      const line = buf.getLine(row);
      if (!line) break;
      const start = row > first && !line.isWrapped ? indentOf(line, cell) : 0;
      let rowText = '';
      for (let c = start; c < line.length; c++) {
        const got = line.getCell(c, cell);
        if (got.getWidth() === 0) continue;
        if (row === hitRow && c === hitCol) at = text.length + rowText.length;
        rowText += got.getChars() || ' ';
      }
      const next = continuesRow(buf, row + 1);
      text += next && !buf.getLine(row + 1)?.isWrapped ? rowText.replace(/ +$/, '') : rowText;
      if (!next) break;
    }
    return { text, at, next: row + 1 };
  }

  function textAtPoint(win, x, y) {
    const term = win && win.term;
    if (!term || !term.element) return null;
    const screen = term.element.querySelector('.xterm-screen');
    if (!screen) return null;
    const box = screen.getBoundingClientRect();
    const col = Math.floor((x - box.left) / (box.width / term.cols));
    const row = Math.floor((y - box.top) / (box.height / term.rows));
    if (col < 0 || row < 0 || col >= term.cols || row >= term.rows) return null;
    const buf = term.buffer.active;
    const hit = buf.viewportY + row;
    let first = hit;
    while (first > 0 && hit - first < MAX_URL_ROWS && continuesRow(buf, first)) first--;
    const line = readLine(buf, first, hit, col);
    return line.at < 0 ? null : line;
  }

  function trimTrail(s) {
    let end = s.length;
    while (end > 0 && URL_TRAIL.has(s[end - 1])) {
      if (s[end - 1] === ')' && (s.slice(0, end).split('(').length > s.slice(0, end).split(')').length - 1)) break;
      end--;
    }
    return s.slice(0, end);
  }

  function urlAt(text, at) {
    const from = Math.max(text.lastIndexOf('http://', at), text.lastIndexOf('https://', at));
    if (from < 0) return null;
    let end = from;
    while (end < text.length && !URL_STOP.has(text[end])) end++;
    const url = trimTrail(text.slice(from, end));
    return at < from + url.length ? url : null;
  }

  function linkAtPoint(win, x, y) {
    const line = textAtPoint(win, x, y);
    return line ? urlAt(line.text, line.at) : null;
  }

  // ---- pictures: a path claude printed, often as `[image] <path>` ----
  function imagePathOf(word) {
    let p = String(word || '').replace(/^[([`"']+/, '');
    while (p && (URL_TRAIL.has(p.at(-1)) || '"\'`'.includes(p.at(-1)))) p = p.slice(0, -1);
    if (!p || p.includes('://')) return null;
    const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase();
    return IMAGE_EXTS.has(ext) ? p : null;
  }

  function wordAt(text, at) {
    let from = at;
    let to = at;
    while (from > 0 && text[from - 1] !== ' ') from--;
    while (to < text.length && text[to] !== ' ') to++;
    return { word: text.slice(from, to), to };
  }

  function imageAtPoint(win, x, y) {
    const line = textAtPoint(win, x, y);
    if (!line) return null;
    let { word, to } = wordAt(line.text, line.at);
    if (word === '[image]') ({ word } = wordAt(line.text, to + 1));
    return imagePathOf(word);
  }

  function imagesIn(win) {
    const buf = win.term.buffer.active;
    const found = [];
    for (let row = 0; row < buf.length;) {
      const line = readLine(buf, row, -1, -1);
      for (const word of line.text.split(' ')) {
        const p = imagePathOf(word);
        if (p && !found.includes(p)) found.push(p);
      }
      row = line.next;
    }
    return found;
  }

  function imageSrc(sessionId, p) {
    return `/api/sessions/${sessionId}/image?path=${encodeURIComponent(p)}`;
  }

  const peek = { name: h('span', { class: 'imgpeek-name' }), img: h('img', { alt: '' }), path: null };
  peek.el = h('div', { class: 'imgpeek', hidden: true }, peek.img, peek.name);
  peek.img.addEventListener('load', () => { if (peek.path) peek.el.hidden = false; });
  const viewer = {
    img: h('img', { alt: '' }), name: h('span', { class: 'imgview-name' }), count: h('span', { class: 'imgview-count' }),
    error: h('p', { class: 'imgview-error', hidden: true }, 'This image can\'t be opened. It may have been deleted, or it\'s outside the folders a session serves images from: the repo, uploads, and Claude\'s scratchpad.'),
    open: h('a', { class: 'imgview-btn', target: '_blank', rel: 'noopener' }, 'Open in tab'),
    list: [], index: 0, session: null,
  };
  const step = (n) => () => stepImage(n);
  viewer.prev = h('button', { type: 'button', class: 'imgview-btn', 'aria-label': 'Previous image', onclick: step(-1) }, '‹');
  viewer.next = h('button', { type: 'button', class: 'imgview-btn', 'aria-label': 'Next image', onclick: step(1) }, '›');
  viewer.el = h('div', { class: 'imgview', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Image', tabindex: '-1' },
    h('div', { class: 'imgview-bar' }, viewer.name, viewer.count, viewer.prev, viewer.next, viewer.open,
      h('button', { type: 'button', class: 'imgview-btn', 'aria-label': 'Close', onclick: closeImage }, '✕')),
    h('div', { class: 'imgview-body' }, viewer.img, viewer.error));
  viewer.img.addEventListener('error', () => { viewer.error.hidden = false; viewer.img.hidden = true; });
  viewer.el.addEventListener('click', (e) => { if (e.target === viewer.el || e.target.classList.contains('imgview-body')) closeImage(); });
  document.addEventListener('keydown', (e) => {
    if (viewer.el.hidden || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') closeImage();
    else if (e.key === 'ArrowLeft') stepImage(-1);
    else if (e.key === 'ArrowRight') stepImage(1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  function showPeek(frame, sessionId, p, x, y) {
    const box = frame.getBoundingClientRect();
    const scale = box.width / (frame.offsetWidth || box.width);
    const px = box.left + x * scale;
    const py = box.top + y * scale;
    if (peek.path !== p) {
      peek.el.hidden = true;
      peek.path = p;
      peek.name.textContent = p.split('/').pop();
      peek.img.src = imageSrc(sessionId, p);
    }
    const left = px + 16 + 320 > window.innerWidth ? px - 16 - 320 : px + 16;
    const top = py + 20 + 240 > window.innerHeight ? py - 20 - 240 : py + 20;
    peek.el.style.left = `${Math.max(8, left)}px`;
    peek.el.style.top = `${Math.max(8, top)}px`;
  }

  function hidePeek() {
    peek.path = null;
    peek.el.hidden = true;
  }

  function showImage() {
    const p = viewer.list[viewer.index];
    viewer.error.hidden = true;
    viewer.img.hidden = false;
    viewer.img.src = imageSrc(viewer.session, p);
    viewer.open.href = viewer.img.src;
    viewer.name.textContent = p.split('/').pop();
    viewer.name.title = p;
    viewer.count.textContent = viewer.list.length > 1 ? `${viewer.index + 1} / ${viewer.list.length}` : '';
    viewer.prev.hidden = viewer.next.hidden = viewer.list.length < 2;
  }

  function openImage(frame, sessionId, p) {
    hidePeek();
    const list = imagesIn(frame.contentWindow);
    viewer.list = list.includes(p) ? list : [p];
    viewer.index = viewer.list.indexOf(p);
    viewer.session = sessionId;
    showImage();
    viewer.el.hidden = false;
    viewer.el.focus();
  }

  function stepImage(n) {
    viewer.index = (viewer.index + n + viewer.list.length) % viewer.list.length;
    showImage();
  }

  function closeImage() {
    viewer.el.hidden = true;
    viewer.img.removeAttribute('src');
  }

  function bindImages(frame, doc, sessionId) {
    let down = null;
    let queued = false;
    doc.addEventListener('mousedown', (e) => { down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null; }, true);
    doc.addEventListener('click', (e) => {
      if (!down || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (Math.abs(e.clientX - down.x) > TAP_PX || Math.abs(e.clientY - down.y) > TAP_PX) return;
      const p = imageAtPoint(frame.contentWindow, e.clientX, e.clientY);
      if (!p) return;
      e.preventDefault();
      openImage(frame, sessionId, p);
    }, true);
    doc.addEventListener('mousemove', (e) => {
      if (queued) return;
      queued = true;
      const { clientX, clientY } = e;
      frame.contentWindow.requestAnimationFrame(() => {
        queued = false;
        const win = frame.contentWindow;
        const p = win && imageAtPoint(win, clientX, clientY);
        win?.term?.element?.classList.toggle('xterm-cursor-pointer', Boolean(p));
        if (p) showPeek(frame, sessionId, p, clientX, clientY);
        else hidePeek();
      });
    }, true);
    doc.addEventListener('mouseleave', hidePeek, true);
  }

  // ---- files pasted or dropped: saved in the session, their paths typed with no Enter ----
  async function attachToSession(sessionId, pane, files) {
    if (files.length > MAX_FILES) return toast(`At most ${MAX_FILES} files at a time`);
    const big = files.find((f) => f.size > MAX_FILE_MB * 1024 * 1024);
    if (big) return toast(`${big.name || 'That file'} is over ${MAX_FILE_MB} MB`);
    if (files.reduce((n, f) => n + f.size, 0) > MAX_TOTAL_MB * 1024 * 1024) return toast(`Those add up to more than ${MAX_TOTAL_MB} MB`);
    toast(files.length === 1 ? `Attaching ${files[0].name || 'the file'}…` : `Attaching ${files.length} files…`);
    let typed = 0;
    for (const file of files) {
      // A pasted screenshot has no name; its type gives it one.
      const name = file.name || `pasted.${(file.type.split('/')[1] || 'png').replace(/[^a-z0-9]/g, '')}`;
      const res = await fetch(`/api/sessions/${sessionId}/upload?${new URLSearchParams({ name, pane })}`, {
        method: 'POST', headers: { 'x-woodshed': '1', 'content-type': 'application/octet-stream' }, body: file,
      }).catch(() => null);
      const body = await res?.json().catch(() => ({}));
      if (!res?.ok) return toast(body?.error ? `Not attached: ${body.error}` : 'Attach failed');
      typed++;
    }
    toast(`${typed} path${typed === 1 ? '' : 's'} typed at the prompt: add your question and press enter`);
  }

  function bindFiles(doc, sessionId, pane) {
    const take = (e, list) => {
      const files = [...(list || [])];
      if (!files.length) return;
      e.preventDefault();
      e.stopPropagation();
      attachToSession(sessionId, pane, files);
    };
    doc.addEventListener('paste', (e) => take(e, e.clipboardData?.files), true);
    doc.addEventListener('dragover', (e) => {
      if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }, true);
    doc.addEventListener('drop', (e) => take(e, e.dataTransfer?.files), true);
  }

  // ---- a phone: a swipe scrolls tmux, a tap opens a link or a picture ----
  const scrolls = new Map();
  function queueScroll(sessionId, pane, notches) {
    const key = `${sessionId}|${pane}`;
    const entry = scrolls.get(key) || { pending: 0, busy: false };
    entry.pending += notches;
    scrolls.set(key, entry);
    if (!entry.busy) setTimeout(() => flushScroll(sessionId, pane, key), 60);
  }

  // One request at a time per pane, carrying what built up meanwhile, so a reversal never lands out of order.
  async function flushScroll(sessionId, pane, key) {
    const entry = scrolls.get(key);
    if (!entry || entry.busy || !entry.pending) return;
    const steps = entry.pending;
    entry.pending = 0;
    entry.busy = true;
    await W.postJson(`/api/sessions/${sessionId}/scroll`, { steps, pane }).catch(() => null);
    entry.busy = false;
    if (entry.pending) flushScroll(sessionId, pane, key);
  }

  function bindTouch(frame, doc, sessionId, pane) {
    let lastY = null;
    let carry = 0;
    let tap = null;
    const opts = { capture: true, passive: true };
    // The swipe is tmux's alone: left to the browser, a swipe down at the top of the page is a pull to refresh.
    doc.documentElement.style.overscrollBehavior = 'none';
    doc.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) {
        lastY = null;
        tap = null;
        return;
      }
      lastY = e.touches[0].clientY;
      carry = 0;
      tap = { x: e.touches[0].clientX, y: lastY, at: Date.now() };
    }, opts);
    doc.addEventListener('touchmove', (e) => {
      if (lastY === null || e.touches.length !== 1) return;
      if (e.cancelable) e.preventDefault();
      const y = e.touches[0].clientY;
      if (tap && (Math.abs(e.touches[0].clientX - tap.x) > TAP_PX || Math.abs(y - tap.y) > TAP_PX)) tap = null;
      carry += lastY - y;
      lastY = y;
      const notches = Math.trunc(carry / SWIPE_PX);
      if (!notches) return;
      carry -= notches * SWIPE_PX;
      queueScroll(sessionId, pane, notches);
    }, { capture: true, passive: false });
    doc.addEventListener('touchend', (e) => {
      lastY = null;
      const t = tap;
      tap = null;
      if (!t || Date.now() - t.at > TAP_MS) return;
      const image = imageAtPoint(frame.contentWindow, t.x, t.y);
      if (image) {
        e.preventDefault();
        openImage(frame, sessionId, image);
        return;
      }
      const url = linkAtPoint(frame.contentWindow, t.x, t.y);
      if (!url) return;
      // Stops the click the touch would make: xterm would open it too, and the keyboard would come up.
      e.preventDefault();
      window.open(url, '_blank', 'noopener');
    }, { capture: true, passive: false });
  }

  // ---- a dropped connection: ttyd's "Press ⏎ to Reconnect", pressed for you ----
  // A phone closes the terminal's websocket while the page is in the background, and ttyd then waits for a key. Its
  // overlay is a bare div on the terminal; an Enter on xterm's textarea is the key it waits for, and with the socket
  // closed it reaches no program. Pressed once the page is in front, at most RECONNECTS_PER_MINUTE times, so a session
  // that is gone for good is left on the overlay.
  // A pattern, not the string: the return symbol has more than one spelling, and only ttyd's own one matches exactly.
  const RECONNECT_RE = /^Press\s+\S+\s+to\s+Reconnect$/;
  const RECONNECTS_PER_MINUTE = 3;
  function bindReconnect(frame, sessionId) {
    whenTerm(frame, (win, term) => {
      const tries = [];
      // ttyd adds its overlay once and changes only its text after: "Connection Closed", then the reconnect prompt.
      const overlays = () => [...term.element.children].filter((d) => d.tagName === 'DIV' && !d.className && d.children.length === 0);
      const waiting = () => overlays().some((d) => RECONNECT_RE.test(d.textContent.trim()));
      const watched = new WeakSet();
      function press() {
        if (!frame.isConnected || document.hidden || !waiting()) return;
        const now = Date.now();
        while (tries.length && now - tries[0] > 60_000) tries.shift();
        if (tries.length >= RECONNECTS_PER_MINUTE) return;
        tries.push(now);
        console.log('terminal: reconnecting', { sessionId, tries: tries.length });
        for (const type of ['keydown', 'keypress']) {
          term.textarea.dispatchEvent(new win.KeyboardEvent(type, {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13, charCode: type === 'keypress' ? 13 : 0, bubbles: true, cancelable: true,
          }));
        }
      }
      // The overlay can be there before this runs (ttyd shows the terminal's size in it as it opens), so it is looked
      // for at once as well as when one is added.
      const observer = new win.MutationObserver(scan);
      function scan() {
        for (const d of overlays()) {
          if (watched.has(d)) continue;
          watched.add(d);
          observer.observe(d, { childList: true, characterData: true, subtree: true });
        }
        setTimeout(press, 300);
      }
      observer.observe(term.element, { childList: true });
      scan();
      function onShown() {
        if (!frame.isConnected) return document.removeEventListener('visibilitychange', onShown);
        if (!document.hidden) setTimeout(press, 300);
      }
      document.addEventListener('visibilitychange', onShown);
    });
  }

  /**
   * Everything above, on one terminal frame, once per document it loads.
   * @param {HTMLIFrameElement} frame
   * @param {{session: string, pane: 'agent'|'terminal'}} opts
   */
  function bind(frame, { session, pane }) {
    try {
      const doc = frame.contentDocument;
      if (!doc || doc.__woodshedTerminal) return;
      doc.__woodshedTerminal = true;
      bindFiles(doc, session, pane);
      bindTouch(frame, doc, session, pane);
      bindClipboard(frame);
      bindImages(frame, doc, session);
      bindReconnect(frame, session);
    } catch {
      // Not same-origin after all: the terminal works, without these.
    }
  }

  document.body.append(peek.el, viewer.el);
  W.terminal = { bind };
})();
