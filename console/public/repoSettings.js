// A repo's settings on Console settings (/console-settings/repos/<project>): for each env file of its project file, the
// repo's defaults, this installation's values, what the session sets itself, and which of them a session gets for each
// key; then the installation's instructions. Admins only: the API refuses anyone else, and the page says so. Values
// stay hidden until Show, as on Secrets & webhooks, and never reach the table, which names keys alone.
// ?file=<key> opens one env file's tab, so a link can point at it.
(function () {
  'use strict';
  const W = window.Woodshed;
  const { h } = W;
  const INSTRUCTIONS_MAX_BYTES = 16 * 1024;
  const LAYER_WORDS = { repo: 'Repo', installation: 'Installation', personal: 'Person', session: 'Session' };
  const NO_CREDENTIALS = 'No production credentials or integration tokens: sessions run unattended, and anything here can end up in a log, a commit or a pull request.';

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

  const bytesOf = (text) => new TextEncoder().encode(text).length;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const fileOf = (key) => view.envFiles.find((f) => f.key === key) ?? null;
  const labelOf = (f) => f.path ?? f.key;
  const githubFile = (filePath) => `https://github.com/${view.repo}/blob/HEAD/${filePath}`;

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
      return f?.legacy ? `Cleared. Sessions read the Terraform secret ${f.legacy.secret} again.` : 'Cleared. Sessions get the repo\'s defaults alone.';
    });
  }

  function clear(key) {
    const f = key === INSTRUCTIONS ? null : fileOf(key);
    const what = key === INSTRUCTIONS ? 'this installation\'s instructions' : `this installation's values for ${labelOf(f)}`;
    const after = f?.legacy ? ` Sessions then read the Terraform secret ${f.legacy.secret} again.` : '';
    if (!window.confirm(`Clear ${what}?${after}`)) return;
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

  function savedLine(record) {
    if (!record) return 'None yet.';
    const by = record.by === 'terraform env_files' ? 'copied from Terraform' : record.by ? `by @${record.by}` : '';
    return [`Saved ${W.when(record.savedAt)}`, by, `${record.bytes.toLocaleString()} bytes`, record.keys && plural(record.keys.length, 'key', 'keys')].filter(Boolean).join(' · ');
  }

  // While sessions may still read an env file's old Terraform secret, which one they read.
  function legacyNote(f) {
    if (!f.legacy) return null;
    const secret = h('code', null, f.legacy.secret);
    if (f.legacy.copiedAt) return h('p', { class: 'cap-note' }, 'Copied from the Terraform secret ', secret, ` on ${W.when(f.legacy.copiedAt)}. Sessions read this one now.`);
    if (!f.installation) return h('p', { class: 'cap-note' }, 'No values yet: sessions still read the Terraform secret ', secret, '.');
    return h('p', { class: 'cap-note' }, 'Sessions read these values now, not the Terraform secret ', secret, '.');
  }

  function keyList(keys) {
    return keys.map((k, i) => [i ? ', ' : '', h('code', null, k)]);
  }

  function sessionLayer(f) {
    const optional = new Set(f.wiring.optional);
    const always = f.wiring.lines.filter((k) => !optional.has(k));
    const parts = [
      always.length && h('p', { class: 'layer-text' }, 'Its lines: ', keyList(always), '.'),
      optional.size > 0 && h('p', { class: 'layer-text' }, 'Only when the session has a value for it: ', keyList([...optional]), '.'),
      f.wiring.env.length > 0 && h('p', { class: 'layer-text' }, 'The project file\'s env, set in every process: ', keyList(f.wiring.env), '.'),
    ].filter(Boolean);
    return layer('session', 'Set by the session', parts.length ? parts : h('p', { class: 'layer-text is-none' }, 'Nothing.'),
      h('p', { class: 'sub' }, 'Woodshed writes these last, with the session\'s databases, ports and URLs, so they win whatever the layers above say.'));
  }

  function layer(word, title, ...body) {
    return h('div', { class: `layer is-${word}` },
      h('div', { class: 'layer-head' }, h('span', { class: 'layer-tag' }, LAYER_WORDS[word]), h('h3', null, title)),
      body);
  }

  // What wins a key the session sets itself: its lines, the project file's env, or one of Woodshed's own variables.
  function sessionCell(f, row) {
    if (f.wiring.lines.includes(row.key)) return f.wiring.optional.includes(row.key) ? '✓ if set' : '✓';
    if (f.wiring.env.includes(row.key)) return 'env';
    return row.wins === 'session' ? 'Woodshed' : '';
  }

  function winsWord(f, row) {
    if (row.wins === 'session' && f.wiring.optional.includes(row.key)) return 'Session, if set';
    return LAYER_WORDS[row.wins];
  }

  function keyTable(f) {
    if (!f.table.length) return h('p', { class: 'sub' }, 'No layer sets a key yet.');
    const mark = (row, word) => (row.setBy.includes(word) ? '✓' : '');
    return h('div', { class: 'table-box' },
      h('table', { class: 'layer-table' },
        h('thead', null, h('tr', null, h('th', null, 'Key'), h('th', null, 'Repo'), h('th', null, 'Installation'), h('th', null, 'Session'), h('th', null, 'Wins'))),
        h('tbody', null, f.table.map((row) => h('tr', null,
          h('td', { class: 'mono' }, row.key),
          h('td', { class: 'mark' }, mark(row, 'repo')),
          h('td', { class: 'mark' }, mark(row, 'installation')),
          h('td', { class: 'mark' }, sessionCell(f, row)),
          h('td', null, h('span', { class: `layer-tag is-wins is-${row.wins}` }, winsWord(f, row))))))));
  }

  function envFilePanel(f) {
    const read = view.projectFile.read;
    return h('div', { class: 'layered', 'aria-labelledby': `file-${f.key}` },
      h('div', { class: 'layered-head' },
        h('h3', { id: `file-${f.key}`, class: 'mono' }, labelOf(f)),
        h('span', { class: 'data-meta' }, h('span', null, `key ${f.key}`))),
      read && layer('repo', 'From the repo',
        f.defaults.length ? h('pre', { class: 'layer-pre' }, f.defaults.join('\n')) : h('p', { class: 'layer-text is-none' }, 'No defaults.'),
        h('p', { class: 'sub' }, 'Change it in ', h('a', { href: githubFile('.woodshed/project.yaml'), target: '_blank', rel: 'noopener' }, '.woodshed/project.yaml ↗'), '.')),
      layer('installation', 'This installation\'s values',
        h('p', { class: 'layer-meta' }, savedLine(f.installation)),
        editorBlock(f.key, f.installation, `This installation's values for ${labelOf(f)}`),
        note(f.key),
        legacyNote(f),
        h('p', { class: 'sub' }, `They replace the repo's defaults for the keys they set. ${NO_CREDENTIALS}`)),
      read && sessionLayer(f),
      read && h('div', { class: 'layer-gets' },
        h('h3', null, 'What a session gets'),
        keyTable(f),
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

  function repoRules() {
    const { rules, setup } = view.projectFile;
    const link = (p) => h('a', { href: githubFile(p), target: '_blank', rel: 'noopener' }, `${p} ↗`);
    if (!view.projectFile.read) return h('p', { class: 'layer-text is-none' }, 'Unknown: the project file could not be read.');
    if (!rules && !setup) return h('p', { class: 'layer-text is-none' }, 'None: the project file names no rules or setup notes.');
    return h('p', { class: 'layer-text' }, rules && ['Rules: ', link(rules)], rules && setup && ' · ', setup && ['Setup notes: ', link(setup)]);
  }

  function instructionsCard() {
    const record = view.instructions.installation;
    return h('section', { class: 'settings-card', id: 'instructions', 'aria-labelledby': 'card-instructions' },
      h('h2', { id: 'card-instructions', class: 'label' }, 'Instructions'),
      h('p', { class: 'sub' }, 'Added to every session\'s prompt on this repo, after the repo\'s own rules. Woodshed\'s rules come first; below them, this installation\'s beat the repo\'s, and a person\'s own beat this installation\'s.'),
      h('div', { class: 'layered' },
        layer('repo', 'From the repo', repoRules()),
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
