// The shed's shell around every page: the command palette (⌘K or /), the shortcuts sheet (⌘? or ?), ⇧⌘, to My
// settings' Display card (the theme, review files and a session's default view), the keys that open them, and the
// hover hint that names a control's key. Which key does
// what is keys.cjs's. The session page registers its sessions and their actions (W.shell.register); every other page
// gets the commands alone. Keys pressed in a terminal frame reach here too (W.shell.bindFrame), with ⌘ only: Ctrl and
// a key alone there are the terminal's.
(function () {
  'use strict';
  const W = window.Woodshed;
  const { h } = W;
  const K = window.WoodshedKeys;
  const MAC = K.isMac(window.navigator);
  // A shortcut's key as text, for this computer: ⇧⌘O on a Mac, Ctrl+Shift+O elsewhere.
  const keyText = (id) => K.label(K.byId[id].mod, MAC);
  // Where ⇧⌘, goes: the theme and the rest of what was the settings sheet are a card on My settings (mySettings.js).
  const DISPLAY_HREF = '/settings#my-display';

  // moveSession(step), nextNeedsYou() and showTab(n, onlyAsk) are the session page's (keys.cjs, `page`): a page without
  // them leaves the double tap and its mode's keys alone.
  let page = { sessions: () => [], actions: () => [], toggleRail: null, railShown: () => true, moveSession: null, nextNeedsYou: null, showTab: null, endMoving: null };

  function register(next) {
    page = { ...page, ...next };
  }

  // ---- focus: a sheet takes it, and gives it back to where it was ----
  let returnFocus = null;
  function takeFocus(el) {
    returnFocus = document.activeElement;
    el.focus();
  }
  function giveFocusBack() {
    const el = returnFocus;
    returnFocus = null;
    if (el && el.isConnected) el.focus();
  }

  function overlay(child, onClose) {
    const el = h('div', { class: 'overlay', hidden: true }, child);
    el.addEventListener('click', (e) => { if (e.target === el) onClose(); });
    document.body.append(el);
    return el;
  }

  function closeAll() {
    closePalette();
    closeSheet(keys);
  }
  // The notifications, on ⌘J (notificationBell.js, loaded before this): the desktop app's, or the browser's own
  // (browserNotifications.js); none on a page with no one signed in.
  const notifications = () => W.notifications ?? { available: false, isOpen: () => false, close() {} };

  // ---- toast ----
  let toastEl = null;
  let toastTimer = null;
  // `ms` keeps it up longer: an error needs time to be read on a phone.
  function toast(text, { ms = 2000 } = {}) {
    // A toast in the mode's place (an upload's error, a tab's reason) ends the mode too: the next key is the page's.
    stopMoving();
    toastEl ??= document.body.appendChild(h('div', { class: 'toast', role: 'status', hidden: true }));
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms);
  }

  // ---- the palette ----
  const input = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'Search or start a session', 'aria-label': 'Search' });
  const list = h('div', { class: 'plist', role: 'listbox' });
  const foot = h('div', { class: 'pfoot' });
  const palette = overlay(h('div', { class: 'palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command palette' }, input, list, foot), closePalette);
  let results = [];
  let cursor = 0;
  // A session whose actions the palette shows, after Tab on it.
  let actionsFor = null;

  // A page with the rail moves to its own pages in place (session.js); every other page loads the next.
  function go(href) {
    return () => { (W.navigate ?? ((to) => { window.location.href = to; }))(href); };
  }

  function commands() {
    return [
      { group: 'Go to', label: 'Shared sessions', run: go('/all') },
      { group: 'Go to', label: 'My Woodshed', run: go('/') },
      { group: 'Go to', label: 'My settings', run: go('/settings') },
      ...(W.isAdmin?.() ? W.consoleLinks().map((link) => ({ group: 'Go to', label: link.label, run: go(link.href) })) : []),
      // A log, not a menu entry (common.js, CONSOLE_LINKS), so named here to stay a place to go.
      W.isAdmin?.() && { group: 'Go to', label: 'Webhook events', run: go('/events') },
      notifications().available && { group: 'Commands', label: 'Notifications', meta: keyText('notifications'), run: () => notifications().open() },
      { group: 'Commands', label: 'Keyboard shortcuts', meta: '?', run: () => openSheet(keys) },
      { group: 'Go to', label: 'Display: theme, review files, Chat or TUI', meta: keyText('settings'), run: go(DISPLAY_HREF) },
      page.toggleRail && { group: 'Commands', label: page.railShown() ? 'Hide the rail' : 'Show the rail', meta: keyText('rail'), run: page.toggleRail },
    ].filter(Boolean);
  }

  // A plain substring match, as the shed's: a name is typed, not guessed at.
  function find(query) {
    const q = query.trim().toLowerCase();
    const hit = (text) => !q || String(text || '').toLowerCase().includes(q);
    if (actionsFor) return page.actions(actionsFor).filter((a) => hit(a.label));
    const out = [];
    if (hit('new session')) out.push({ group: 'Quick actions', label: 'New session', meta: keyText('new'), run: go('/?new=1') });
    for (const s of page.sessions()) {
      // Stopped ones only once something is typed: the list is for jumping, and most of them are history.
      if (!s.live && !q) continue;
      if (!hit(`${s.title} ${s.id} ${s.branch || ''}`)) continue;
      out.push({ group: s.live ? 'Active' : 'Stopped', label: s.title, meta: s.meta, live: s.live, session: s, run: go(s.href) });
    }
    for (const c of commands()) if (hit(`${c.group} ${c.label}`)) out.push(c);
    return out;
  }

  function renderPalette() {
    results = find(input.value);
    cursor = Math.min(cursor, Math.max(0, results.length - 1));
    let group = null;
    const rows = [];
    results.forEach((item, i) => {
      if (item.group !== group) {
        group = item.group;
        rows.push(h('div', { class: 'pgroup' }, group));
      }
      const row = h('button', {
        type: 'button', class: `pitem${item.danger ? ' is-danger' : ''}`, role: 'option', 'data-cursor': String(i === cursor),
        onmousemove: () => { if (cursor !== i) { cursor = i; renderPalette(); } },
        onclick: (e) => { e.stopPropagation(); run(item); },
      },
        h('span', { class: `pdot${item.live ? ' on' : ''}`, 'aria-hidden': 'true' }),
        h('span', { class: 'plabel' }, item.label),
        item.meta && h('span', { class: 'pmeta' }, item.meta));
      rows.push(row);
    });
    list.replaceChildren(...(rows.length ? rows : [h('p', { class: 'pempty' }, 'Nothing matches that.')]));
    list.querySelector('[data-cursor="true"]')?.scrollIntoView({ block: 'nearest' });
    const hint = (label, key) => h('span', null, h('kbd', null, key), label);
    const onSession = Boolean(results[cursor]?.session);
    foot.replaceChildren(...(actionsFor
      ? [hint('Select', '↑↓'), hint('Run', '⏎'), hint('Back', '⇥'), hint('Close', 'esc')]
      : [hint('Select', '↑↓'), hint('Open', '⏎'), onSession && hint('Actions', '⇥'), hint('Close', 'esc')].filter(Boolean)));
  }

  function setLevel(session) {
    actionsFor = session;
    input.value = '';
    cursor = 0;
    input.placeholder = session ? `What to do with ${session.title}` : 'Search or start a session';
    renderPalette();
  }

  function run(item) {
    closePalette();
    item.run();
  }

  function openPalette() {
    closeSheet(keys);
    notifications().close();
    setLevel(null);
    palette.hidden = false;
    takeFocus(input);
  }

  function closePalette() {
    if (palette.hidden) return;
    palette.hidden = true;
    actionsFor = null;
    giveFocusBack();
  }

  input.addEventListener('input', () => { cursor = 0; renderPalette(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (results.length) cursor = (cursor + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      renderPalette();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results[cursor]) run(results[cursor]);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (actionsFor) setLevel(null);
      else if (results[cursor]?.session) setLevel(results[cursor].session);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (actionsFor) setLevel(null);
      else closePalette();
    }
  });

  // ---- the shortcuts sheet ----
  function sheet(title, body) {
    const dialog = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabindex: '-1' },
      h('div', { class: 'sheet-head' }, h('h3', null, title), h('span', { class: 'esc' }, 'esc to close')),
      h('div', { class: 'sheet-body', tabindex: '-1' }, body));
    const el = overlay(dialog, () => closeSheet(record));
    const record = { el, dialog, onOpen: null };
    return record;
  }

  function openSheet(s) {
    closePalette();
    notifications().close();
    s.onOpen?.();
    s.el.hidden = false;
    // The body takes the focus, so Page Down and the arrows scroll a list taller than the window.
    takeFocus(s.dialog.querySelector('.sheet-body') ?? s.dialog);
  }

  function closeSheet(s) {
    if (s.el.hidden) return;
    s.el.hidden = true;
    giveFocusBack();
  }

  function toggleSheet(s) {
    if (s.el.hidden) openSheet(s);
    else closeSheet(s);
  }

  // A shortcut's keys as key caps: its combo, then its key alone. A sequence (G M) is its keys one after the other.
  // The double tap's key, twice, as caps: ⌘ ⌘ on a Mac, Ctrl Ctrl elsewhere.
  const tapCaps = () => [0, 1].map(() => h('kbd', null, K.caps(K.byId.prefix.tap, MAC)[0]));
  function keyCaps(shortcut) {
    if (shortcut.tap) return tapCaps();
    const mod = MAC ? shortcut.mod : shortcut.modOther || shortcut.mod;
    const combo = mod && K.caps(mod, MAC).map((k) => h('kbd', null, k));
    const bare = shortcut.bare && shortcut.bare.split(' ').map((k) => h('kbd', null, k));
    // A key of the mode: the double tap, then the key, or the other key it names (J or ↓).
    if (shortcut.then) {
      const then = shortcut.then.split(' ').flatMap((k, i) => [i > 0 && h('span', { class: 'kor' }, 'or'), h('kbd', null, k)]).filter(Boolean);
      return [...tapCaps(), h('span', { class: 'kor' }, 'then'), ...then];
    }
    return [combo, combo && bare && h('span', { class: 'kor' }, 'or'), bare].filter(Boolean);
  }
  // Drawn as it opens, from what the page registered: a page with no rail (My settings) lists no session keys, and
  // says nothing of them in its note.
  function keyRows() {
    const moves = Boolean(page.moveSession);
    const shown = K.SHORTCUTS.filter((s) => (!s.bell || notifications().available) && (!s.page || page[s.page]));
    return [
      shown.map((s) => h('div', { class: 'krow' }, h('div', { class: 'kkeys' }, keyCaps(s)), h('div', null, s.id === 'keys' ? 'This list' : s.what, s.where && h('span', { class: 'kwhere' }, ` on ${s.where}`)))),
      h('p', { class: 'sheet-note' }, MAC
        ? `Ctrl works for ⌘ too, except inside a terminal, where Ctrl is the terminal's. A key alone works while you are not typing. ${moves ? 'Tap ⌘ twice, even while typing or in a terminal, and the keys after it move through the sessions until Esc, a click or another key. ' : ''}⌘K, then a name, jumps to any session.`
        : `A key alone works while you are not typing. Inside a terminal, Ctrl is the terminal's: click outside it first. ${moves ? 'Tap Ctrl twice, even while typing or in a terminal, and the keys after it move through the sessions until Esc, a click or another key. ' : ''}Ctrl+K, then a name, jumps to any session.`),
    ];
  }
  const keys = sheet('Keyboard shortcuts', []);
  keys.onOpen = () => keys.dialog.querySelector('.sheet-body').replaceChildren(...keyRows().flat());


  // ---- the double tap's mode, as Herdr's navigate mode: on until Esc, a click, a toast or a key that is not one of its own ----
  // The toast's place says it is on, and which keys it takes, for as long as it is.
  let moving = false;
  let movingEl = null;
  function startMoving() {
    moving = true;
    // One toast at a time: the mode takes the place of one still up (a tab's reason).
    if (toastEl) {
      clearTimeout(toastTimer);
      toastEl.hidden = true;
    }
    movingEl ??= document.body.appendChild(h('div', { class: 'toast', role: 'status', hidden: true }));
    movingEl.replaceChildren(...tapCaps(), ' ', h('kbd', null, 'J'), ' ', h('kbd', null, 'K'), ' ', h('kbd', null, '1–4'), ' ', h('kbd', null, 'N'), ' · ', h('kbd', null, 'esc'), ' to stop');
    movingEl.hidden = false;
  }
  function stopMoving() {
    moving = false;
    if (movingEl) movingEl.hidden = true;
    // The session page's side of it (session.js, movingByKey): the session shown may take focus again.
    page.endMoving?.();
  }
  // A click is the pointer's move, not the keyboard's: it ends the mode, in the page or in a frame (bindFrame).
  function stopMovingOnClick() {
    if (moving) stopMoving();
  }
  document.addEventListener('pointerdown', stopMovingOnClick, true);

  // ---- the keys ----
  // G waits this long for the second key of a sequence.
  const SEQUENCE_MS = 1500;
  let gAt = 0;
  const ACTS = {
    keys: () => toggleSheet(keys),
    palette: () => (palette.hidden ? openPalette() : closePalette()),
    notifications: () => notifications().toggle(),
    settings: go(DISPLAY_HREF),
    rail: () => page.toggleRail?.(),
    new: go('/?new=1'),
    nextSession: () => page.moveSession(1),
    prevSession: () => page.moveSession(-1),
    needsYou: () => page.nextNeedsYou(),
  };
  // The keys of the mode (keys.cjs, AFTER_PREFIX and the tab keys), and its Esc.
  // The tab key that ended the mode, while it is still held down (onTapKeyUp lets it go).
  let heldCode = null;
  const MOVING_IDS = new Set(['nextSession', 'prevSession', 'needsYou', 'tab', 'cancel']);
  const MODIFIERS = new Set(['Shift', 'Meta', 'Control', 'Alt', 'AltGraph', 'CapsLock']);
  // ---- the double tap: ⌘ (Ctrl off a Mac) pressed and let go twice, alone (keys.cjs, doubleTap) ----
  // Read in the page and in every frame (bindFrame), with one count for all.
  const taps = K.doubleTap({ mac: MAC });
  const notATap = () => taps.reset();
  // A key let go in another window is never seen let go here: leaving the window forgets the one held.
  window.addEventListener('blur', () => { heldCode = null; });
  function onTapKeyDown(e) {
    taps.down(e, Date.now());
  }
  function onTapKeyUp(e) {
    if (heldCode && e.code === heldCode) heldCode = null;
    if (!taps.up(e, Date.now())) return;
    // Only where the page moves through sessions (session.js): elsewhere a double tap is nothing.
    if (!page.moveSession) return;
    if (moving) stopMoving();
    else {
      closeAll();
      startMoving();
    }
  }
  window.addEventListener('blur', notATap);
  // ⌘ or Ctrl with a click or the wheel (a new tab, a zoom) is that, not a tap.
  for (const type of ['pointerdown', 'wheel']) document.addEventListener(type, notATap, { capture: true, passive: true });

  function onKey(e, inFrame, modOnly = false) {
    onTapKeyDown(e);
    hideHint();
    // Shift pressed on its way to a digit (AZERTY) is not a key of the mode, nor the one after G.
    if (MODIFIERS.has(e.key)) return;
    // Esc ends the mode and goes no further: not to a terminal, whose agent would take it as its own Esc. With the
    // palette or the sheet open, it also closes that, below.
    if (e.key === 'Escape' && moving) {
      stopMoving();
      // Open notifications take the same Esc and close (notificationBell.js), so it is not stopped here for them.
      if (palette.hidden && keys.el.hidden && !notifications().isOpen()) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }
    if (e.key === 'Escape' && (!palette.hidden || !keys.el.hidden)) {
      if (!palette.hidden && actionsFor) return;
      e.preventDefault();
      closeAll();
      return;
    }
    // A key held down in the mode moves once, and its repeats go nowhere: not into a field that has the focus still,
    // nor into the one a tab key just focused (the mode has ended by then: heldCode keeps them out until it is let go).
    if (e.repeat && (moving || (heldCode && e.code === heldCode))) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.repeat || e.isComposing) return;
    // A page framed in the pane (the Review) keeps its keys alone for itself: only ⌘ or Ctrl ones are the shell's, and
    // the mode's own while it is on.
    if (modOnly && !e.metaKey && !e.ctrlKey && !moving) return;
    const afterG = Date.now() - gAt < SEQUENCE_MS;
    gAt = 0;
    // A key alone is for the page, never for an open palette or sheet, whose own keys come first.
    const overlayOpen = !palette.hidden || !keys.el.hidden || notifications().isOpen();
    const id = K.match(e, { inFrame, afterG, moving, typing: overlayOpen || K.takesTyping(e.composedPath?.()[0] ?? e.target) });
    // Any other key ends the mode and is what it would have been: / opens the palette, a letter types.
    const movingKey = moving && MOVING_IDS.has(id);
    if (moving && !movingKey) stopMoving();
    if (modOnly && !e.metaKey && !e.ctrlKey && !movingKey) return;
    // A form's own key (⌘↵ on New session) is left to the form, which reads it from its fields.
    // A key the page does (K.byId[id].page) is nothing on a page that registered no such thing: no rail, no tabs.
    const pageHook = K.byId[id]?.page;
    const nothing = !id || K.byId[id]?.where || (pageHook && !page[pageHook]) || (id === 'rail' && !page.toggleRail) || (id === 'notifications' && !notifications().available)
      // 3 on a session with no third tab is no key of the mode's either.
      || (id === 'tab' && !page.showTab(K.tabOf(e), true));
    if (nothing) {
      if (movingKey) {
        stopMoving();
        // A key of the mode's that has nothing to do here (4 on a bar of three tabs) is still the mode's: it ends it,
        // and types nothing into a field that has the focus still.
        if (id !== 'cancel') {
          // Its repeats too, while it is held: none types into the field.
          heldCode = e.code || null;
          e.preventDefault();
          e.stopPropagation();
        }
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (id === 'g') {
      gAt = Date.now();
      return;
    }
    // A move or a tab picked with the palette or the sheet open closes it first, so the new session gets the keys.
    // Notifications too: a move takes the focus from their list, whose own Esc would then never close it.
    if (movingKey) {
      closeAll();
      notifications().close();
    }
    // A tab ends the mode: the tab takes the keys from there, to be typed in.
    if (id === 'tab') {
      heldCode = e.code || null;
      stopMoving();
      page.showTab(K.tabOf(e));
    } else (ACTS[id] ?? go(K.byId[id].href))();
  }
  document.addEventListener('keydown', (e) => onKey(e, false), true);
  document.addEventListener('keyup', onTapKeyUp, true);

  // A terminal frame is same-origin, so its document's keys can be read before xterm takes them. Another framed page
  // (the Review, { terminal: false }) gets the shell's ⌘ and Ctrl keys, as the page around it does, and keeps the rest.
  function bindFrame(frame, { terminal = true } = {}) {
    try {
      const doc = frame.contentDocument;
      if (!doc || doc.__woodshedShell) return;
      doc.__woodshedShell = true;
      doc.addEventListener('keydown', (e) => onKey(e, terminal, !terminal), true);
      doc.addEventListener('keyup', onTapKeyUp, true);
      for (const type of ['pointerdown', 'wheel']) doc.addEventListener(type, notATap, { capture: true, passive: true });
      doc.addEventListener('pointerdown', stopMovingOnClick, true);
    } catch {
      // Not same-origin after all: the page's own keys still work.
    }
  }

  // ---- the hover hint ----
  // A control that has a key says so when the pointer rests on it, or when the keyboard brings focus to it:
  // data-keys names its shortcut (keys.cjs), data-hint, when set, what it does in place of the shortcut's words.
  // A phone has no hover and no keys, so it gets none.
  const HINT_DELAY_MS = 400;
  const hint = h('div', { class: 'keyhint', role: 'tooltip', hidden: true });
  document.body.append(hint);
  let hintTimer = null;
  let hintFor = null;
  function showHint(el) {
    const shortcut = K.byId[el.dataset.keys];
    if (!shortcut) return;
    hint.replaceChildren(...[
      h('div', { class: 'keyhint-row' }, h('span', null, el.dataset.hint || shortcut.what), h('span', { class: 'keyhint-keys' }, keyCaps(shortcut))),
      shortcut.id !== 'keys' && h('div', { class: 'keyhint-more' }, 'Press ', h('kbd', null, '?'), ' for every shortcut'),
    ].filter(Boolean));
    hint.hidden = false;
    const box = el.getBoundingClientRect();
    const w = hint.offsetWidth;
    const ht = hint.offsetHeight;
    const left = Math.min(Math.max(8, box.left + box.width / 2 - w / 2), window.innerWidth - w - 8);
    const below = box.bottom + 6 + ht <= window.innerHeight - 8;
    hint.style.left = `${left}px`;
    hint.style.top = `${below ? box.bottom + 6 : box.top - 6 - ht}px`;
  }
  function hideHint() {
    clearTimeout(hintTimer);
    hintFor = null;
    hint.hidden = true;
  }
  function soon(el) {
    if (el === hintFor) return;
    hideHint();
    hintFor = el;
    hintTimer = setTimeout(() => { if (hintFor === el && el.isConnected) showHint(el); }, HINT_DELAY_MS);
  }
  if (window.matchMedia?.('(hover: hover)').matches) {
    document.addEventListener('mouseover', (e) => {
      const el = e.target.closest?.('[data-keys]');
      if (el) soon(el);
      else if (hintFor) hideHint();
    });
    document.addEventListener('focusin', (e) => {
      const el = e.target.closest?.('[data-keys]');
      if (el && el.matches(':focus-visible')) soon(el);
    });
    document.addEventListener('focusout', hideHint);
    document.documentElement.addEventListener('mouseleave', hideHint);
    document.addEventListener('mousedown', hideHint, true);
    document.addEventListener('scroll', hideHint, true);
    window.addEventListener('blur', hideHint);
  }

  W.shell = {
    register, toast, bindFrame, openPalette, openKeys: () => openSheet(keys), closeAll,
    keyText,
  };
})();
