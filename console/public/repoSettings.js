// A repo's settings on Console settings (/console-settings/repos/<project>): for each env file of its project file, the
// repo's defaults, this installation's values, what the session sets itself, and which of them a session gets for each
// key; then the installation's instructions. Admins only: the API refuses anyone else, and the page says so. Values
// stay hidden until Show, as on Secrets & webhooks, and never reach the table, which names keys alone.
// ?file=<key> opens one env file's tab, so a link can point at it.
(function () {
  'use strict';
  const W = window.Woodshed;
  const { h } = W;
  const L = window.WoodshedRepoLayers;
  const { INSTRUCTIONS_MAX_BYTES, NO_CREDENTIALS, bytesOf, plural, savedLine, layer } = L;

  const project = decodeURIComponent(location.pathname.split('/').pop() || '');
  const base = `/api/console-settings/repos/${encodeURIComponent(project)}`;
  let view = null;
  let loadError = null;
  let fileKey = new URLSearchParams(location.search).get('file');
  // Each env file's editor, and the instructions', made once so what is typed and the caret survive a redraw.
  const editors = new Map();
  // The saved text each editor was filled from, by editor key; absent while the values are hidden.
  const shownText = new Map();
  // What the last action on each part said: {text, bad}.
  const notes = new Map();
  const busy = new Set();
  const INSTRUCTIONS = '#instructions';

  const fileOf = (key) => view.envFiles.find((f) => f.key === key) ?? null;
  const labelOf = (f) => f.path ?? f.key;

  function editorFor(key) {
    if (!editors.has(key)) {
      const instructions = key === INSTRUCTIONS;
      const el = h('textarea', {
        id: instructions ? 'instructions-text' : `env-${key}`, class: 'field mono file-text', rows: instructions ? '8' : '10', spellcheck: 'false', autocomplete: 'off',
        placeholder: instructions ? 'Run the api tests with npm test -w api before pushing.' : 'API_URL=http://localhost:4000',
        oninput: () => updateCounts(key),
      });
      el.value = '';
      editors.set(key, el);
    }
    return editors.get(key);
  }

  // Whether what is in the editor differs from what was saved.
  function changed(key) {
    return editors.has(key) && editors.get(key).value !== (shownText.get(key) ?? '');
  }

  // The parts that follow the typing, without a redraw: the instructions' size and each Save.
  const sizeLine = h('p', { class: 'layer-count', role: 'status' });
  const saveButtons = new Map();
  function updateCounts(key) {
    if (key === INSTRUCTIONS) {
      const bytes = bytesOf(editorFor(INSTRUCTIONS).value);
      sizeLine.textContent = `${bytes.toLocaleString()} of ${INSTRUCTIONS_MAX_BYTES.toLocaleString()} bytes`;
      sizeLine.className = `layer-count${bytes > INSTRUCTIONS_MAX_BYTES ? ' is-over' : ''}`;
    }
    const save = saveButtons.get(key);
    if (save) save.disabled = !canSave(key);
  }

  function canSave(key) {
    if (!view.available || busy.has(key) || !shownText.has(key) || !changed(key)) return false;
    return key !== INSTRUCTIONS || bytesOf(editorFor(key).value) <= INSTRUCTIONS_MAX_BYTES;
  }

  function note(key) {
    const n = notes.get(key);
    if (!n) return null;
    return h('p', { class: n.bad ? 'form-error' : 'sub', role: n.bad ? 'alert' : 'status' }, n.text);
  }

  // A refusal in the page's words: the console's own sentence, or what a status means when it sent none.
  function refusal(err) {
    if (err.status === 403) return 'Only an admin can change a repo\'s settings.';
    return err.message;
  }

  async function act(key, run) {
    if (busy.has(key)) return;
    busy.add(key);
    notes.delete(key);
    render();
    try {
      const said = await run();
      if (said) notes.set(key, { text: said });
    } catch (err) {
      notes.set(key, { text: refusal(err), bad: true });
    }
    busy.delete(key);
    render();
  }

  function textPath(key) {
    return key === INSTRUCTIONS ? `${base}/instructions` : `${base}/env/${encodeURIComponent(key)}`;
  }

  async function show(key) {
    await act(key, async () => {
      const { text } = await W.getJson(textPath(key));
      shownText.set(key, text);
      editorFor(key).value = text;
      return null;
    });
    if (shownText.has(key)) editorFor(key).focus?.();
  }

  function hide(key) {
    shownText.delete(key);
    editorFor(key).value = '';
    notes.delete(key);
    render();
  }

  // An empty save clears the value: the next session then gets what is under it.
  function save(key, { clear = false } = {}) {
    const editor = editorFor(key);
    const text = clear ? '' : editor.value;
    return act(key, async () => {
      view = await W.postJson(textPath(key), { text });
      editor.value = text;
      shownText.set(key, text);
      if (key === INSTRUCTIONS) return text.trim() ? 'Saved. The next session on this repo has them in its prompt; running ones keep theirs.' : 'Cleared. Sessions on this repo get the repo\'s own rules alone.';
      const f = fileOf(key);
      if (text.trim()) return `Saved. The next session on ${view.repo} writes them into ${labelOf(f ?? { key })}; running ones keep theirs.`;
      return 'Cleared. Sessions get the repo\'s defaults alone.';
    });
  }

  function clear(key) {
    const f = key === INSTRUCTIONS ? null : fileOf(key);
    const what = key === INSTRUCTIONS ? 'this installation\'s instructions' : `this installation's values for ${labelOf(f)}`;
    if (!window.confirm(`Clear ${what}?`)) return;
    save(key, { clear: true });
  }

  // The layer's editor, behind Show when a value is saved: reading it is logged, as on Secrets & webhooks.
  function editorBlock(key, record, label) {
    const editor = editorFor(key);
    const hidden = record && !shownText.has(key);
    if (!record && !shownText.has(key)) shownText.set(key, '');
    editor.readOnly = busy.has(key);
    editor.disabled = !view.available;
    const saveButton = h('button', { type: 'button', class: 'btn btn-open', disabled: true, onclick: () => save(key) }, busy.has(key) ? 'Saving…' : 'Save');
    saveButtons.set(key, saveButton);
    const block = hidden
      ? [
        h('div', { class: 'value-row' },
          h('code', { class: 'value-box is-masked' }, `•••••••••••• ${plural(record.keys?.length ?? 0, 'key', 'keys')}, hidden`),
          h('button', { type: 'button', class: 'btn btn-plain', disabled: busy.has(key), onclick: () => show(key) }, busy.has(key) ? 'Reading…' : 'Show and edit')),
      ]
      : [
        h('label', { class: 'sr-only', for: editor.id }, label),
        editor,
        h('div', { class: 'card-foot' },
          saveButton,
          record && h('button', { type: 'button', class: 'btn btn-quiet', disabled: busy.has(key) || !view.available, onclick: () => clear(key) }, 'Clear'),
          record && h('button', { type: 'button', class: 'btn btn-quiet', disabled: busy.has(key) || changed(key), title: changed(key) ? 'Save or undo the change first' : null, onclick: () => hide(key) }, 'Hide')),
      ];
    return block;
  }

  function envFilePanel(f) {
    const read = view.projectFile.read;
    return h('div', { class: 'layered', 'aria-labelledby': `file-${f.key}` },
      h('div', { class: 'layered-head' },
        h('h3', { id: `file-${f.key}`, class: 'mono' }, labelOf(f)),
        h('span', { class: 'data-meta' }, h('span', null, `key ${f.key}`))),
      read && L.defaultsLayer(f, view.repo),
      layer('installation', 'This installation\'s values',
        h('p', { class: 'layer-meta' }, savedLine(f.installation)),
        editorBlock(f.key, f.installation, `This installation's values for ${labelOf(f)}`),
        note(f.key),
        h('p', { class: 'sub' }, `They replace the repo's defaults for the keys they set. ${NO_CREDENTIALS}`)),
      read && L.sessionLayer(f),
      read && h('div', { class: 'layer-gets' },
        h('h3', null, 'What a session gets'),
        L.keyTable(f),
        h('p', { class: 'sub' }, 'Keys only: each value stays in its own layer. In a person\'s private sessions, their own values from My settings come after this installation\'s.')));
  }

  function openFile(key) {
    fileKey = key;
    const url = new URL(location.href);
    url.searchParams.set('file', key);
    history.replaceState(null, '', url);
    render();
  }

  function unnamedRow(u) {
    return h('div', { class: 'data-row' },
      h('div', { style: 'min-width: 0' },
        h('div', { class: 'data-title' }, h('code', null, u.key), ' is saved but the project file no longer has it'),
        h('div', { class: 'data-meta' }, h('span', null, savedLine(u.installation)))),
      h('div', { class: 'data-actions' }, h('button', {
        type: 'button', class: 'btn btn-delete btn-sm', disabled: !view.available,
        onclick: () => W.confirmChange({
          title: `Delete ${u.key}?`,
          before: 'saved, used by no session',
          after: 'deleted',
          effect: `This installation's values for ${u.key}, and every person's own values for it, are deleted. This cannot be undone.`,
          word: 'delete',
          goLabel: 'Delete',
          run: async () => {
            view = await W.postJson(`${base}/env/${encodeURIComponent(u.key)}/remove`, {});
            notes.set('unnamed', { text: `${u.key} deleted.` });
            render();
          },
        }),
      }, 'Delete')));
  }

  function envCard() {
    const files = view.envFiles;
    if (!files.some((f) => f.key === fileKey)) fileKey = files[0]?.key ?? null;
    const f = fileKey && fileOf(fileKey);
    return h('section', { class: 'settings-card', 'aria-labelledby': 'card-env' },
      h('h2', { id: 'card-env', class: 'label' }, 'Env files'),
      h('p', { class: 'sub' }, 'Each env file a session writes is the repo\'s defaults, then this installation\'s values, then a person\'s own (in their private sessions), then what the session sets itself. A later line wins.'),
      !view.projectFile.read && h('p', { class: 'cap-note', role: 'status' }, `The project file could not be read (${view.projectFile.error}), so only the saved values are listed. They cannot be saved again until it can be read.`),
      files.length > 1 && h('div', { class: 'file-tabs', role: 'group', 'aria-label': 'Env file' }, files.map((x) => h('button', {
        type: 'button', 'aria-pressed': String(x.key === fileKey), onclick: () => openFile(x.key),
      }, labelOf(x), x.installation ? ' •' : ''))),
      f ? envFilePanel(f) : h('p', { class: 'sub' }, 'The project file has no env files.'),
      view.unnamed.length > 0 && [
        h('div', { class: 'sub-head' }, 'No longer in the project file', h('span', { class: 'count' }, view.unnamed.length)),
        h('div', { class: 'data-list' }, view.unnamed.map(unnamedRow)),
      ],
      note('unnamed'));
  }

  function instructionsCard() {
    const record = view.instructions.installation;
    return h('section', { class: 'settings-card', id: 'instructions', 'aria-labelledby': 'card-instructions' },
      h('h2', { id: 'card-instructions', class: 'label' }, 'Instructions'),
      h('p', { class: 'sub' }, 'Added to every session\'s prompt on this repo, after the repo\'s own rules. Woodshed\'s rules come first; below them, this installation\'s beat the repo\'s, and a person\'s own beat this installation\'s.'),
      h('div', { class: 'layered' },
        layer('repo', 'From the repo', L.repoRules(view)),
        layer('installation', 'This installation\'s instructions',
          h('p', { class: 'layer-meta' }, savedLine(record)),
          editorBlock(INSTRUCTIONS, record, 'This installation\'s instructions'),
          shownText.has(INSTRUCTIONS) && sizeLine,
          note(INSTRUCTIONS),
          h('p', { class: 'sub' }, 'At most 16 KB. It goes into the prompt of every session on this repo, so no secrets: put them in an env file\'s values.'))));
  }

  function page(...body) {
    return h('div', { class: 'page' }, W.nav('/console-settings'),
      h('header', { class: 'page-head' },
        h('div', null,
          h('p', { class: 'crumb' }, h('a', { href: '/console-settings#card-projects' }, '‹ Console settings · Repos')),
          h('h1', { class: 'title' }, view?.repo ?? project),
          h('p', { class: 'sub' }, view
            ? [h('span', { class: 'rref' }, view.project), view.default ? ' · the default project. ' : '. ', 'What sessions on this repo get in their env files and prompt. Only admins can change these, and each change is logged with who made it.']
            : 'Repo settings'))),
      body);
  }

  function loadFailed() {
    const words = loadError.status === 403 ? 'Only an admin can open a repo\'s settings. Ask one to change them for you.'
      : loadError.status === 404 ? `${loadError.message} Repos on Console settings lists the ones there are.`
        : `Could not load the repo's settings: ${loadError.message}`;
    return h('p', { class: loadError.status === 403 ? 'cap-note' : 'form-error', role: 'alert' }, words);
  }

  // A redraw replaces the page; the editors are the same nodes, so the one being typed in keeps its caret.
  function render() {
    const app = document.getElementById('app');
    const focused = document.activeElement;
    let caret = null;
    try { caret = [focused.selectionStart, focused.selectionEnd]; } catch { /* nothing focused */ }
    saveButtons.clear();
    if (!view) {
      app.replaceChildren(page(loadError ? loadFailed() : h('p', { class: 'empty' }, 'Loading the repo\'s settings…')));
      return;
    }
    app.replaceChildren(page(
      !view.available && h('p', { class: 'cap-note', role: 'status' }, 'This console has no secret store, so nothing can be saved here. Choose one on Secrets & webhooks.'),
      envCard(),
      instructionsCard()));
    for (const key of editors.keys()) updateCounts(key);
    if (focused && [...editors.values()].includes(focused)) {
      focused.focus?.();
      try { if (caret?.[0] !== undefined && caret?.[0] !== null) focused.setSelectionRange(...caret); } catch { /* not a text field */ }
    }
  }

  async function load() {
    try {
      view = await W.getJson(base);
      loadError = null;
    } catch (err) {
      loadError = err;
    }
    render();
    if (view?.instructions.installation) await show(INSTRUCTIONS);
  }

  load();
})();
