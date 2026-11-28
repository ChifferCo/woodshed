// node --test review/page.test.mjs
//
// The whole review document lives inside one template literal, so a backtick
// anywhere in it — including inside a comment, which is where it keeps
// happening — ends the literal and the page stops parsing.
//
// `install.sh --check` already catches this, by booting an instance, fetching
// the page and re-parsing its inline script. That takes seconds and needs a
// free port. This takes milliseconds and needs neither, which is the whole
// point: the mistake is cheap to make and should be cheap to catch.
//
// The same goes for `${`, which would be read as an interpolation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { REVIEW_HTML } from './page.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, 'page.mjs'), 'utf-8');

/** The body of the one template literal this file is. */
function literalBody() {
  const open = 'export const REVIEW_HTML = `';
  const start = source.indexOf(open);
  assert.notEqual(start, -1, 'REVIEW_HTML is not declared the way this test expects');
  const body = source.slice(start + open.length);
  const end = body.lastIndexOf('`;');
  assert.notEqual(end, -1, 'REVIEW_HTML has no closing backtick');
  return body.slice(0, end);
}

test('no bare backtick inside the page literal', () => {
  const body = literalBody();
  const lines = body.split('\n');
  const offenders = [];
  lines.forEach((line, i) => {
    // An escaped one is deliberate and fine; a bare one is the bug.
    if (/(^|[^\\])`/.test(line)) offenders.push(`${i + 1}: ${line.trim().slice(0, 90)}`);
  });
  assert.deepEqual(offenders, [], `backtick inside REVIEW_HTML:\n${offenders.join('\n')}`);
});

// An interpolation added by accident in CSS or JavaScript runs at module load and disappears into the page.
const MEANT = [
  '${DARK_PALETTE}', '${DICTATION_SCRIPT}', '${tokenizeLine.toString()}', '${createAskState.toString()}',
  '${layoutDiagram.toString()}', '${layoutCodebaseMap.toString()}', '${MAX_ASK_DEPTH}', '${MAX_USER_QUESTION}',
];

test('the only interpolations are the ones the file means', () => {
  const body = literalBody();
  const found = body.match(/(?<!\\)\$\{[^}]*\}/g) || [];
  const unexpected = [...new Set(found)].filter((one) => !MEANT.includes(one));
  assert.deepEqual(unexpected, [], `unexpected interpolation in REVIEW_HTML: ${unexpected.join(', ')}`);
});

test('the literal is closed exactly once', () => {
  // Two would mean the parser sees a second literal somewhere, which is how a
  // stray backtick presents when it happens to pair up with another.
  assert.equal(source.split('export const REVIEW_HTML = `').length, 2);
});

// Lightweight DOM harness to run the served inline <script> of REVIEW_HTML and
// verify the Overview codebase map -> Files changed navigation (file click,
// non-first hunk click, deferred pointer capture, and two-finger touch pinch).
function createMiniDom() {
  const byId = new Map();

  function parseClasses(cls) {
    return String(cls || '').trim().split(/\s+/).filter(Boolean);
  }

  function makeClassList(el) {
    return {
      add(...names) {
        const set = new Set(parseClasses(el.className));
        for (const n of names) if (n) set.add(n);
        el.className = [...set].join(' ');
      },
      remove(...names) {
        const set = new Set(parseClasses(el.className));
        for (const n of names) set.delete(n);
        el.className = [...set].join(' ');
      },
      contains(name) {
        return parseClasses(el.className).includes(name);
      },
      toggle(name, force) {
        const has = this.contains(name);
        const next = force === undefined ? !has : Boolean(force);
        if (next) this.add(name);
        else this.remove(name);
        return next;
      },
    };
  }

  function matchesSelector(el, sel) {
    if (!el || el.nodeType !== 1) return false;
    return sel.split(',').some((part) => {
      const s = part.trim();
      if (!s) return false;
      const mTag = /^([a-z0-9_-]+)/i.exec(s);
      if (mTag && el.tagName.toLowerCase() !== mTag[1].toLowerCase()) return false;
      for (const mCls of s.matchAll(/\.([a-z0-9_-]+)/gi)) {
        if (!el.classList.contains(mCls[1])) return false;
      }
      for (const mAttr of s.matchAll(/\[([a-z0-9_-]+)(?:="([^"]*)")?\]/gi)) {
        const val = el.getAttribute(mAttr[1]);
        if (mAttr[2] === undefined) {
          if (val === null) return false;
        } else if (val !== mAttr[2]) {
          return false;
        }
      }
      return true;
    });
  }

  function makeNode(tag, textContent = '') {
    const attrs = new Map();
    const listeners = new Map();
    const style = {};
    const node = {
      nodeType: tag === '#text' ? 3 : 1,
      tagName: String(tag).toUpperCase(),
      className: '',
      children: [],
      get childNodes() { return this.children; },
      parentNode: null,
      dataset: {},
      style,
      hidden: false,
      disabled: false,
      value: '',
      checked: false,
      type: '',
      title: '',
      href: '',
      open: false,
      clientWidth: 1000,
      clientHeight: 620,
      offsetWidth: 1000,
      offsetHeight: 36,
      scrollHeight: 100,
      scrollTop: 0,
      _text: textContent,
      get textContent() {
        if (this.nodeType === 3) return this._text;
        return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text;
      },
      set textContent(v) {
        this._text = String(v ?? '');
        this.children = [];
      },
      get isConnected() {
        let cur = this;
        while (cur) {
          if (cur === doc.body || cur === doc.documentElement) return true;
          cur = cur.parentNode;
        }
        return false;
      },
      get id() { return attrs.get('id') || ''; },
      set id(v) {
        if (attrs.has('id')) byId.delete(attrs.get('id'));
        attrs.set('id', String(v));
        if (v) byId.set(String(v), this);
      },
      setAttribute(k, v) {
        const s = String(v);
        if (k === 'class') this.className = s;
        else if (k === 'id') this.id = s;
        else if (k.startsWith('data-')) {
          const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
          this.dataset[camel] = s;
        }
        attrs.set(k, s);
      },
      getAttribute(k) {
        if (k === 'class') return this.className;
        if (k.startsWith('data-')) {
          const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
          if (camel in this.dataset) return String(this.dataset[camel]);
        }
        return attrs.has(k) ? attrs.get(k) : null;
      },
      removeAttribute(k) { attrs.delete(k); },
      appendChild(child) {
        if (!child) return child;
        if (child.nodeType === 11) {
          for (const c of child.children.slice()) this.appendChild(c);
          return child;
        }
        if (child.parentNode) child.parentNode.removeChild(child);
        child.parentNode = this;
        this.children.push(child);
        return child;
      },
      removeChild(child) {
        const i = this.children.indexOf(child);
        if (i !== -1) this.children.splice(i, 1);
        child.parentNode = null;
        return child;
      },
      replaceChildren(...items) {
        for (const c of this.children) c.parentNode = null;
        this.children = [];
        for (const it of items) {
          if (typeof it === 'string') this.appendChild(makeNode('#text', it));
          else if (it) this.appendChild(it);
        }
      },
      remove() { if (this.parentNode) this.parentNode.removeChild(this); },
      insertBefore(child, ref) {
        if (!ref) return this.appendChild(child);
        const i = this.children.indexOf(ref);
        if (i === -1) return this.appendChild(child);
        if (child.parentNode) child.parentNode.removeChild(child);
        child.parentNode = this;
        this.children.splice(i, 0, child);
        return child;
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      removeEventListener(type, fn) {
        const list = listeners.get(type);
        if (!list) return;
        const i = list.indexOf(fn);
        if (i !== -1) list.splice(i, 1);
      },
      dispatchEvent(ev) {
        const event = {
          type: ev.type,
          target: ev.target || this,
          currentTarget: this,
          button: ev.button ?? 0,
          pointerId: ev.pointerId ?? 1,
          pointerType: ev.pointerType || 'mouse',
          clientX: ev.clientX ?? 0,
          clientY: ev.clientY ?? 0,
          key: ev.key || '',
          bubbles: ev.bubbles !== false,
          _stopped: false,
          preventDefault() {},
          stopPropagation() { this._stopped = true; },
        };
        let cur = this;
        while (cur) {
          event.currentTarget = cur;
          const list = cur._listeners.get(event.type);
          if (list) {
            for (const fn of list.slice()) fn.call(cur, event);
          }
          if (!event.bubbles || event._stopped) break;
          cur = cur.parentNode;
        }
      },
      click() { this.dispatchEvent({ type: 'click', target: this }); },
      focus() { doc.activeElement = this; },
      blur() {},
      close() { this.open = false; },
      showModal() { this.open = true; },
      scrollIntoView() {},
      closest(sel) {
        let cur = this;
        while (cur) {
          if (matchesSelector(cur, sel)) return cur;
          cur = cur.parentNode;
        }
        return null;
      },
      querySelectorAll(sel) {
        const out = [];
        const walk = (n) => {
          for (const c of n.children) {
            if (matchesSelector(c, sel)) out.push(c);
            walk(c);
          }
        };
        walk(this);
        return out;
      },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      getBoundingClientRect() {
        if (typeof this._rect === 'function') return this._rect();
        if (this.classList.contains('dhunk')) {
          const idx = Number(this.dataset.hunkIndex || 0);
          return { top: 200 + idx * 320, left: 0, width: 800, height: 180 };
        }
        if (this.classList.contains('fcard')) {
          return { top: 120, left: 0, width: 800, height: 600 };
        }
        return { top: 0, left: 0, width: this.clientWidth || 1000, height: this.clientHeight || 620 };
      },
      _listeners: listeners,
    };
    node.classList = makeClassList(node);
    return node;
  }

  const doc = {
    documentElement: makeNode('html'),
    body: makeNode('body'),
    title: '',
    hidden: false,
    activeElement: null,
    createElement(tag) { return makeNode(tag); },
    createElementNS(_ns, tag) { return makeNode(tag); },
    createTextNode(t) { return makeNode('#text', String(t ?? '')); },
    createDocumentFragment() {
      const f = makeNode('#frag');
      f.nodeType = 11;
      return f;
    },
    getElementById(id) { return byId.get(id) || null; },
    querySelectorAll(sel) { return doc.body.querySelectorAll(sel); },
    querySelector(sel) { return doc.body.querySelector(sel); },
    addEventListener() {},
    removeEventListener() {},
  };
  doc.documentElement.appendChild(doc.body);

  // Mount the static elements referenced by page.mjs at boot.
  for (const id of [
    'content', 'error', 'flash', 'chat', 'chatLog', 'chatInput', 'chatSend', 'chatClose', 'chatTitle',
    'discardSheet', 'discardGo', 'discardCancel', 'discardX', 'discardMsg',
    'submitSheet', 'sheetDrop', 'sheetGo', 'sheetCancel', 'sheetClose', 'sheetBody', 'sheetNote',
    'sheetPending', 'sheetAction', 'sheetError', 'sheetTitle',
    'mergeSheet', 'mergeConversations', 'mergeGo', 'mergeCancel', 'mergeX', 'mergeTitle', 'mergeBody',
    'mergeCheck', 'mergeMsg', 'mergeError',
    'convSheet', 'convClose', 'convList', 'convResolveAll', 'convStatus', 'convError',
  ]) {
    const el = makeNode(id.endsWith('Sheet') ? 'dialog' : 'div');
    el.id = id;
    doc.body.appendChild(el);
  }
  return doc;
}

test('codebase map opens Files changed at the clicked file and non-first hunk, defers pointer capture, and handles touch pinch', async () => {
  const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(REVIEW_HTML);
  assert.ok(scriptMatch, 'REVIEW_HTML must contain an inline <script>');
  const doc = createMiniDom();
  const scrolls = [];
  const rafQueue = [];

  const mockDiff = {
    createdAt: '2026-11-28T06:00:00Z',
    files: [
      {
        path: 'src/webhooks/deliver.mjs',
        status: 'modified',
        additions: 14,
        deletions: 4,
        hunks: [
          {
            oldStart: 1, oldCount: 5, newStart: 1, newCount: 8,
            header: '@@ -1,5 +1,8 @@',
            context: 'import config',
            lines: [
              { type: 'add', old: null, new: 1, text: "import { retry } from './retry.mjs';" },
            ],
          },
          {
            oldStart: 40, oldCount: 6, newStart: 42, newCount: 11,
            header: '@@ -40,6 +42,11 @@ function retryLoop()',
            context: 'function retryLoop()',
            lines: [
              { type: 'del', old: 41, new: null, text: 'return fetch(url);' },
              { type: 'add', old: null, new: 43, text: 'return retry(() => fetch(url));' },
            ],
          },
        ],
      },
    ],
  };

  const mockReview = {
    session: 'claude-beadfeed',
    kind: 'worktree',
    branch: 'woodshed/beadfeed',
    headSha: 'abc1234',
    createdAt: '2026-11-28T06:00:00Z',
    status: 'done',
    meta: { title: 'Retry webhook deliveries' },
    review: {
      overview: 'Adds retries to webhook delivery.',
      decisions: [],
      architecture: '',
      acts: [{
        title: 'Retry loop',
        summary: 'Retries failed deliveries.',
        files: [{ path: 'src/webhooks/deliver.mjs', role: 'core', preamble: 'Loops on retryable statuses.' }],
      }],
    },
  };

  const mockMap = {
    modules: [
      {
        id: 'src/webhooks',
        label: 'src/webhooks',
        summary: 'Delivers signed webhook events with retries.',
        group: 'src',
        fileCount: 2,
        totalLines: 80,
        changedCount: 1,
        addedCount: 0,
        modifiedCount: 1,
        deletedCount: 0,
        additions: 14,
        deletions: 4,
        files: [
          {
            path: 'src/webhooks/deliver.mjs',
            name: 'deliver.mjs',
            lines: 60,
            status: 'modified',
            additions: 14,
            deletions: 4,
            hunksCount: 2,
          },
          {
            path: 'src/webhooks/sign.mjs',
            name: 'sign.mjs',
            lines: 20,
            status: 'unchanged',
            additions: 0,
            deletions: 0,
            hunksCount: 0,
          },
        ],
      },
    ],
    moduleEdges: [],
    fileEdges: [],
    totalFiles: 2,
    changedFiles: 1,
    truncated: false,
  };

  const pendingTimers = new Set();
  const safeSetTimeout = (fn, ms = 0) => {
    if (ms > 50) return 0; // Ignore background polling timers in the unit harness.
    const t = setTimeout(() => {
      pendingTimers.delete(t);
      fn();
    }, 0);
    t.unref?.();
    pendingTimers.add(t);
    return t;
  };
  const safeClearTimeout = (t) => {
    pendingTimers.delete(t);
    clearTimeout(t);
  };

  const win = {
    location: {
      href: 'http://127.0.0.1/review?session=claude-beadfeed',
      origin: 'http://127.0.0.1',
      pathname: '/review',
      search: '?session=claude-beadfeed',
      replace() {},
    },
    history: { replaceState() {}, pushState() {} },
    localStorage: { getItem: () => null, setItem() {} },
    scrollY: 0,
    scrollTo(opts) {
      scrolls.push(opts);
      if (opts && typeof opts.top === 'number') this.scrollY = opts.top;
    },
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    navigator: { clipboard: { writeText: async () => {} } },
    requestAnimationFrame(fn) { rafQueue.push(fn); return rafQueue.length; },
    cancelAnimationFrame() {},
    setTimeout: safeSetTimeout,
    clearTimeout: safeClearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    URL,
    URLSearchParams,
  };

  async function mockFetch(url) {
    const u = String(url);
    let body = { ok: true };
    if (u.endsWith('/reviews/claude-beadfeed')) body = mockReview;
    else if (u.endsWith('/reviews/claude-beadfeed/diff')) body = mockDiff;
    else if (u.endsWith('/reviews/claude-beadfeed/map')) body = mockMap;
    else if (u.includes('/viewed')) body = { viewed: {} };
    else if (u.includes('/draft')) body = { draft: null };
    else if (u.includes('/chat')) body = { messages: [] };
    else if (u.includes('/qa')) body = { status: 'idle', items: [] };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
      json: async () => body,
    };
  }

  const context = vm.createContext({
    window: win,
    document: doc,
    fetch: mockFetch,
    URL,
    URLSearchParams,
    localStorage: win.localStorage,
    navigator: win.navigator,
    history: win.history,
    location: win.location,
    requestAnimationFrame: win.requestAnimationFrame,
    cancelAnimationFrame: win.cancelAnimationFrame,
    setTimeout: safeSetTimeout,
    clearTimeout: safeClearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    console,
    Math,
    Date,
    RegExp,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Set,
    Map,
    Promise,
    Error,
    parseInt,
    parseFloat,
    isNaN,
    encodeURIComponent,
    decodeURIComponent,
  });

  vm.runInContext(scriptMatch[1], context);
  // Wait for openSession() -> loadReview() -> loadMap() microtasks to settle.
  for (let i = 0; i < 15; i += 1) {
    await new Promise((r) => setImmediate(r));
    while (rafQueue.length) rafQueue.shift()(Date.now());
  }

  // 1. Overview renders the map with src/webhooks/deliver.mjs and its 2 hunk buttons.
  const stage = doc.querySelector('.cmap-stage');
  assert.ok(stage, 'Overview tab should mount .cmap-stage');
  const deliverParcel = doc.querySelectorAll('.cmap-parcel.changed').find((el) => el.title === 'src/webhooks/deliver.mjs');
  assert.ok(deliverParcel, 'Changed file parcel for src/webhooks/deliver.mjs should be rendered');

  // 2. Stationary pointerdown/pointerup on module header does not capture pointer, so click opens inspector.
  const captured = [];
  stage.setPointerCapture = (id) => captured.push(id);
  stage.releasePointerCapture = () => {};
  const mHead = doc.querySelector('.cmap-mhead');
  assert.ok(mHead);
  mHead.dispatchEvent({ type: 'pointerdown', pointerId: 7, clientX: 100, clientY: 100 });
  mHead.dispatchEvent({ type: 'pointerup', pointerId: 7, clientX: 100, clientY: 100 });
  assert.deepEqual(captured, [], 'Stationary press must not call setPointerCapture');
  mHead.click();
  assert.ok(doc.querySelector('.cmap-drawer'), 'Clicking module header should open the inspector drawer');

  // 3. Dragging past threshold captures the pointer; two-pointer pinch changes zoom.
  stage.dispatchEvent({ type: 'pointerdown', pointerId: 8, clientX: 200, clientY: 200 });
  stage.dispatchEvent({ type: 'pointermove', pointerId: 8, clientX: 220, clientY: 210 });
  assert.deepEqual(captured, [8], 'Dragging past 4px threshold should capture pointer');
  stage.dispatchEvent({ type: 'pointerup', pointerId: 8, clientX: 220, clientY: 210 });

  const zoomBeforePinch = doc.querySelector('.cmap-zoom-pct').textContent;
  stage.dispatchEvent({ type: 'pointerdown', pointerId: 11, pointerType: 'touch', clientX: 300, clientY: 300 });
  stage.dispatchEvent({ type: 'pointerdown', pointerId: 12, pointerType: 'touch', clientX: 400, clientY: 300 });
  stage.dispatchEvent({ type: 'pointermove', pointerId: 12, pointerType: 'touch', clientX: 500, clientY: 300 });
  stage.dispatchEvent({ type: 'pointerup', pointerId: 11, pointerType: 'touch', clientX: 300, clientY: 300 });
  stage.dispatchEvent({ type: 'pointerup', pointerId: 12, pointerType: 'touch', clientX: 500, clientY: 300 });
  const zoomAfterPinch = doc.querySelector('.cmap-zoom-pct').textContent;
  assert.notEqual(zoomAfterPinch, zoomBeforePinch, 'Two-pointer touch pinch should adjust zoom level');

  // 4. Clicking the changed file title opens Files changed at src/webhooks/deliver.mjs.
  scrolls.length = 0;
  const titleBtn = deliverParcel.querySelector('.cmap-p-title-link');
  assert.ok(titleBtn, 'Changed file parcel should expose clickable title link');
  titleBtn.click();
  const activeAfterFileClick = doc.querySelector('.tab[aria-selected="true"]');
  assert.equal(activeAfterFileClick?.dataset.tab, 'files', 'File title click must switch to Files changed tab');
  const deliverCard = doc.querySelectorAll('.fcard').find((c) => c.dataset.path === 'src/webhooks/deliver.mjs');
  assert.ok(deliverCard && deliverCard.classList.contains('open'), 'Target file card must be open');
  assert.ok(deliverCard.classList.contains('jump-flash'), 'Target file card must flash on file-level jump');
  assert.equal(scrolls.at(-1)?.top, 116, 'File-level jump should scroll to card top minus 4px offset');

  // 5. Switch back to Overview and click the SECOND (non-first) hunk button inside the map.
  const overviewTab = doc.querySelectorAll('.tab').find((t) => t.dataset.tab === 'analysis');
  assert.ok(overviewTab);
  overviewTab.click();
  const deliverParcel2 = doc.querySelectorAll('.cmap-parcel.changed').find((el) => el.title === 'src/webhooks/deliver.mjs');
  const hunkBtns = deliverParcel2.querySelectorAll('.cmap-hunk-btn');
  assert.equal(hunkBtns.length, 2, 'Changed file parcel should list both diff hunks');
  scrolls.length = 0;
  win.scrollY = 0;
  hunkBtns[1].click();

  const activeAfterHunkClick = doc.querySelector('.tab[aria-selected="true"]');
  assert.equal(activeAfterHunkClick?.dataset.tab, 'files', 'Hunk click must switch to Files changed tab');
  const deliverCard2 = doc.querySelectorAll('.fcard').find((c) => c.dataset.path === 'src/webhooks/deliver.mjs');
  const hunks = deliverCard2.querySelectorAll('.dhunk');
  assert.equal(hunks.length, 2);
  assert.equal(hunks[0].classList.contains('jump-flash'), false, 'First hunk must not flash when second hunk was clicked');
  assert.equal(hunks[1].classList.contains('jump-flash'), true, 'Second (non-first) hunk must flash');
  // Second hunk rect.top is 200 + 1*320 = 520; sticky .fbar offsetHeight is 36 + 8 = 44 -> 476.
  assert.equal(scrolls.at(-1)?.top, 476, 'Non-first hunk click must scroll that exact hunk below the sticky file header');
});
