// The phone's message box under claude's terminal: a message written with the phone's own keyboard (autocorrect,
// dictation, paste, the cursor), files from its picker, and the browser's speech recognition for the mic. Send types
// it all into claude as one message, through the session's statusd (POST /api/sessions/<id>/send), then Enter.
// Return makes a new line; only Send sends. session.js shows it on a phone, for a running session's Agent tab.
(function () {
  'use strict';
  const W = window.Woodshed;
  const { h } = W;
  const MAX_FILES = 8;
  const MAX_FILE_MB = 25;
  // Five lines of the 16px type, after which the box scrolls. 16px, since iOS zooms in on a smaller field it focuses.
  const MAX_FIELD_PX = 5 * 22 + 16;
  const DRAFT_KEY = (id) => `woodshed-draft:${id}`;
  const ICONS = {
    attach: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"/></svg>',
    mic: W.dictation.MIC_ICON,
  };

  function iconButton(icon, opts) {
    const button = h('button', { type: 'button', class: 'mb-icon', ...opts });
    button.innerHTML = ICONS[icon];
    return button;
  }

  function readDraft(id) {
    try {
      return window.sessionStorage.getItem(DRAFT_KEY(id)) || '';
    } catch {
      return '';
    }
  }

  function keepDraft(id, text) {
    try {
      if (text) window.sessionStorage.setItem(DRAFT_KEY(id), text);
      else window.sessionStorage.removeItem(DRAFT_KEY(id));
    } catch {
      // A private window keeps the draft for this page only.
    }
  }

  function createMessageBox() {
    // Each session's files, while you write: { name, path, busy }. Its text is in sessionStorage.
    const files = new Map();
    let sessionId = null;
    let sending = false;
    // The dictation listening (dictation.js), for the session it started on.
    let recognition = null;

    const field = h('textarea', {
      class: 'mb-field', rows: '1', placeholder: 'Message claude', 'aria-label': 'Message claude', enterkeyhint: 'enter',
      oninput: () => { keepDraft(sessionId, field.value); fit(); draw(); },
    });
    const picker = h('input', { type: 'file', multiple: true, hidden: true, onchange: () => { attach([...picker.files]); picker.value = ''; } });
    const attachButton = iconButton('attach', { title: 'Add a photo or a file', 'aria-label': 'Add a photo or a file', onclick: () => picker.click() });
    const micButton = iconButton('mic', { title: 'Dictate', 'aria-label': 'Dictate', onclick: () => (recognition ? recognition.stop() : listen()) });
    const sendButton = h('button', { type: 'button', class: 'mb-send', onclick: send }, 'Send');
    const chips = h('div', { class: 'mb-chips' });
    const heard = h('span', { class: 'mb-heard' });
    const listening = h('div', { class: 'mb-listening', hidden: true },
      h('span', { class: 'mb-wave', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i')), 'Listening · tap the mic to stop ', heard);
    const el = h('div', { class: 'msgbox', hidden: true }, chips, listening,
      h('div', { class: 'mb-line' }, attachButton, field, micButton, sendButton), picker);

    const mine = () => files.get(sessionId) ?? [];

    function fit() {
      field.style.height = 'auto';
      field.style.height = `${Math.min(field.scrollHeight, MAX_FIELD_PX)}px`;
    }

    function draw() {
      chips.replaceChildren(...mine().map((f) => h('span', { class: `mb-chip${f.busy ? ' is-busy' : ''}` },
        h('span', { class: 'mb-chip-name' }, f.busy ? `${f.name}…` : f.name),
        h('button', { type: 'button', 'aria-label': `Take off ${f.name}`, onclick: () => drop(f) }, '×'))));
      chips.hidden = !mine().length;
      const something = Boolean(field.value.trim()) || mine().some((f) => f.path);
      // The mic while there is nothing to send, or while it listens; Send once there is.
      const mic = W.dictation.available && (Boolean(recognition) || !something);
      micButton.hidden = !mic;
      micButton.classList.toggle('is-live', Boolean(recognition));
      sendButton.hidden = mic;
      sendButton.disabled = sending || !something || mine().some((f) => f.busy);
      listening.hidden = !recognition;
    }

    function drop(file) {
      files.set(sessionId, mine().filter((f) => f !== file));
      draw();
    }

    async function attach(list) {
      const id = sessionId;
      if (mine().length + list.length > MAX_FILES) return W.shell.toast(`At most ${MAX_FILES} files in one message`);
      const big = list.find((f) => f.size > MAX_FILE_MB * 1024 * 1024);
      if (big) return W.shell.toast(`${big.name || 'That file'} is over ${MAX_FILE_MB} MB`);
      await Promise.all(list.map(async (file) => {
        // A photo from the camera can come without a name; its type gives it one.
        const entry = { name: file.name || `photo.${(file.type.split('/')[1] || 'jpg').replace(/[^a-z0-9]/g, '')}`, path: null, busy: true };
        files.set(id, [...(files.get(id) ?? []), entry]);
        draw();
        const res = await fetch(`/api/sessions/${id}/upload?${new URLSearchParams({ name: entry.name, pane: 'none' })}`, {
          method: 'POST', headers: { 'x-woodshed': '1', 'content-type': 'application/octet-stream' }, body: file,
        }).catch(() => null);
        const body = await res?.json().catch(() => ({}));
        if (!res?.ok || !body?.path) {
          W.shell.toast(`${entry.name} not added: ${body?.error || 'the upload failed'}`);
          files.set(id, (files.get(id) ?? []).filter((f) => f !== entry));
        } else {
          Object.assign(entry, { path: body.path, busy: false });
        }
        if (id === sessionId) draw();
      }));
    }

    // Cut off at once, for a move to another session or a Send: stop() would still deliver its last words, into
    // whichever box shows by then. Returns the words still settling.
    function abortListening() {
      const was = recognition;
      recognition = null;
      const words = was?.abort() ?? '';
      draw();
      return words;
    }

    function listen() {
      const id = sessionId;
      const mine = W.dictation.dictate(field, {
        heard: (pending) => { heard.textContent = pending; },
        changed: () => { keepDraft(id, field.value); fit(); },
        ended: () => {
          if (recognition === mine) recognition = null;
          draw();
        },
      });
      recognition = mine;
      draw();
    }

    async function send() {
      const id = sessionId;
      if (sending) return;
      // The words on screen are the words sent, the ones still settling too.
      if (recognition) {
        const words = abortListening();
        if (words) field.value = `${field.value.replace(/\s*$/, '')} ${words}`.trimStart();
      }
      const paths = mine().filter((f) => f.path).map((f) => f.path);
      const text = [field.value.trim(), ...paths].filter(Boolean).join('\n');
      if (!text) return draw();
      sending = true;
      draw();
      try {
        await W.postJson(`/api/sessions/${id}/send`, { text });
        files.delete(id);
        keepDraft(id, '');
        if (id === sessionId) {
          field.value = '';
          fit();
          // The keyboard goes down, so claude's answer has the screen.
          field.blur();
        }
        W.shell.toast('Sent');
      } catch (err) {
        W.shell.toast(`Not sent: ${err.message}`);
      } finally {
        sending = false;
        draw();
      }
    }

    /** @param {object|null} s  the running session whose Agent tab shows, or null to hide the box */
    function show(s) {
      el.hidden = !s;
      if (!s) {
        abortListening();
        return;
      }
      if (s.id === sessionId) return;
      abortListening();
      sessionId = s.id;
      field.value = readDraft(s.id);
      fit();
      draw();
    }

    return { el, show };
  }

  W.createMessageBox = createMessageBox;
})();
