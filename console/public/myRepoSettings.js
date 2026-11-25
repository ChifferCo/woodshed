// My settings' repo rows: a row for each repo the person can write to, which opens on their own values for each of its
// env files, their own instructions and their own whole files (an app/.env.production), which only their private
// sessions on that repo get, drawn as the layers a session writes them from (designSystem/components/LayeredFile). They
// may read the installation's values too, since their sessions hold them anyway; each read is logged.
// ?repo=<project> opens one repo's row, and ?file=<key> one of its env files.
(function () {
  'use strict';
  const W = window.Woodshed;
  const { h } = W;
  const L = window.WoodshedRepoLayers;
  const { INSTRUCTIONS_MAX_BYTES, NO_CREDENTIALS, bytesOf, plural, savedLine, layer } = L;
  const INSTRUCTIONS = '#instructions';

  /**
   * @param {object} page
   * @param {() => void} page.render  redraws the whole page, which calls rows() again
   * @param {(row: object, ...body: *[]) => object} page.row  My settings' row (mySettings.js): `opens` with no body drawn
   * @param {(id: string) => boolean} page.isOpen  whether the row with that id is open
   * @param {(id: string) => void} page.setOpen  opens one, before the next draw
   * @returns {{rows: () => object[], afterRender: () => void, reload: () => void}}
   */
  function createMyRepoSettings({ render, row, isOpen, setOpen }) {
    const asked = new URLSearchParams(location.search);
    let repos = null;
    let reposError = null;
    // Scrolled to once, when a link named a repo.
    let scrollPending = asked.get('repo');
    const rowId = (project) => `repo-${project}`;
    // By project: the env file and the part (instructions, env files, your files) each open repo shows. Several repos
    // may be open at once, so nothing here is "the" repo: every function is told which.
    const fileKeys = new Map();
    const parts = new Map();
    const views = new Map();
    const viewErrors = new Map();
    const viewLoads = new Set();
    // By `${project}\n${key}`: each editor, made once so what is typed survives a redraw, and what was read for it.
    const editors = new Map();
    const shownText = new Map();
    const installationText = new Map();
    const notes = new Map();
    const busy = new Set();
    const saveButtons = new Map();
    const sizeLines = new Map();
    // Your own whole files, by project: their texts, read the first time the repo's files are drawn (a read that failed
    // is not tried again until Try again, or render() would ask at once for as long as the store is down), the one
    // open, '' a new one, and the path and text boxes that hold it.
    const ownFiles = new Map();
    const ownFilesFailed = new Map();
    const ownLoads = new Set();
    const ownOpen = new Map();
    const boxes = new Map();
    const FILES = '#files';

    const id = (project, key) => `${project}\n${key}`;
    const projectOf = (k) => k.slice(0, k.indexOf('\n'));
    const base = (name) => `/api/my/repos/${encodeURIComponent(name)}`;
    const textPath = (project, key) => (key === INSTRUCTIONS ? `${base(project)}/instructions` : `${base(project)}/env/${encodeURIComponent(key)}`);
    const { labelOf, pathsOf, andList } = L;

    function refusal(err) {
      if (err.status === 403) return 'You can no longer start sessions on this repo, so you keep nothing for it.';
      return err.message;
    }

    function editorFor(project, key) {
      const k = id(project, key);
      if (!editors.has(k)) {
        const instructions = key === INSTRUCTIONS;
        const el = h('textarea', {
          id: instructions ? `my-instructions-${project}` : `my-env-${project}-${key}`, class: 'field mono file-text', rows: instructions ? '6' : '8', spellcheck: 'false', autocomplete: 'off',
          placeholder: instructions ? 'Explain each change in a short comment on the pull request.' : 'LOG_LEVEL=debug',
          oninput: () => updateCounts(k),
        });
        el.value = '';
        editors.set(k, el);
      }
      return editors.get(k);
    }

    function sizeLineOf(project) {
      if (!sizeLines.has(project)) sizeLines.set(project, h('p', { class: 'layer-count', role: 'status' }));
      return sizeLines.get(project);
    }

    function boxesOf(project) {
      if (!boxes.has(project)) {
        boxes.set(project, {
          path: h('input', { id: `own-file-path-${project}`, class: 'field mono', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'app/.env.production' }),
          text: h('textarea', { id: `own-file-text-${project}`, class: 'field mono file-text', rows: '10', spellcheck: 'false', autocomplete: 'off', placeholder: 'NOTION_TOKEN=…' }),
          filled: false,
        });
      }
      return boxes.get(project);
    }

    const changed = (k) => editors.has(k) && editors.get(k).value !== (shownText.get(k) ?? '');

    function canSave(k) {
      const v = views.get(projectOf(k));
      if (!v?.available || busy.has(k) || !shownText.has(k) || !changed(k)) return false;
      return !k.endsWith(`\n${INSTRUCTIONS}`) || bytesOf(editors.get(k).value) <= INSTRUCTIONS_MAX_BYTES;
    }

    function updateCounts(k) {
      if (k.endsWith(`\n${INSTRUCTIONS}`)) {
        const bytes = bytesOf(editors.get(k).value);
        const sizeLine = sizeLineOf(projectOf(k));
        sizeLine.textContent = `${bytes.toLocaleString()} of ${INSTRUCTIONS_MAX_BYTES.toLocaleString()} bytes`;
        sizeLine.className = `layer-count${bytes > INSTRUCTIONS_MAX_BYTES ? ' is-over' : ''}`;
      }
      const save = saveButtons.get(k);
      if (save) save.disabled = !canSave(k);
    }

    function note(k) {
      const n = notes.get(k);
      if (!n) return null;
      return h('p', { class: n.bad ? 'form-error' : 'sub', role: n.bad ? 'alert' : 'status' }, n.text);
    }

    async function act(k, run) {
      if (busy.has(k)) return;
      busy.add(k);
      notes.delete(k);
      render();
      try {
        const said = await run();
        if (said) notes.set(k, { text: said });
      } catch (err) {
        notes.set(k, { text: refusal(err), bad: true });
      }
      busy.delete(k);
      render();
    }

    // Yours and the installation's come in one answer; reading the installation's is logged.
    async function show(project, key) {
      const k = id(project, key);
      await act(k, async () => {
        const answer = await W.getJson(textPath(project, key));
        shownText.set(k, answer.text);
        installationText.set(k, answer.installation);
        editorFor(project, key).value = answer.text;
        return null;
      });
    }

    function hide(project, key) {
      const k = id(project, key);
      shownText.delete(k);
      installationText.delete(k);
      editorFor(project, key).value = '';
      notes.delete(k);
      render();
    }

    function save(project, key, { clear = false } = {}) {
      const k = id(project, key);
      const editor = editorFor(project, key);
      const text = clear ? '' : editor.value;
      return act(k, async () => {
        const answer = await W.postJson(textPath(project, key), { text });
        views.set(project, answer);
        editor.value = text;
        shownText.set(k, text);
        summaryOf(project, answer);
        if (key === INSTRUCTIONS) return text.trim() ? 'Saved. Your next private session on this repo has them in its prompt; running ones keep theirs.' : 'Cleared. Your sessions get this installation\'s instructions and the repo\'s rules alone.';
        const f = answer.envFiles.find((x) => x.key === key);
        if (text.trim()) return `Saved. Your next private session on ${answer.repo} writes them into ${f ? andList(pathsOf(f)) : key}; running ones keep theirs.`;
        return 'Cleared. Your sessions get the repo\'s defaults and this installation\'s values alone.';
      });
    }

    function clear(project, key) {
      const f = key === INSTRUCTIONS ? null : views.get(project).envFiles.find((x) => x.key === key);
      const what = key === INSTRUCTIONS ? 'your own instructions for this repo' : `your own values for ${labelOf(f)}`;
      if (!window.confirm(`Clear ${what}? Your sessions then get this installation's alone.`)) return;
      save(project, key, { clear: true });
    }

    // The row's words follow what the person keeps, without asking the console again.
    function summaryOf(name, v) {
      const entry = repos?.repos.find((r) => r.project === name);
      if (!entry) return;
      entry.envFiles = v.envFiles.filter((f) => f.personal).map((f) => f.key);
      entry.instructions = Boolean(v.instructions.personal);
      entry.files = v.files?.length ?? 0;
    }

    async function loadView(name) {
      if (viewLoads.has(name)) return;
      viewLoads.add(name);
      viewErrors.delete(name);
      try {
        const v = await W.getJson(base(name));
        views.set(name, v);
        summaryOf(name, v);
      } catch (err) {
        viewErrors.set(name, refusal(err));
      }
      viewLoads.delete(name);
      render();
      const v = views.get(name);
      if (v && (v.instructions.installation || v.instructions.personal) && isOpen(rowId(name))) await show(name, INSTRUCTIONS);
    }

    function setQuery(params) {
      const url = new URL(location.href);
      for (const [k, value] of Object.entries(params)) {
        if (value === null) url.searchParams.delete(k);
        else url.searchParams.set(k, value);
      }
      history.replaceState(null, '', url);
    }

    function openFile(project, key) {
      fileKeys.set(project, key);
      setQuery({ repo: project, file: key });
      render();
    }

    async function load() {
      try {
        repos = await W.getJson('/api/my/repos');
      } catch (err) {
        reposError = err.message;
        render();
        return;
      }
      // A link's repo opens its row, on its env file when the link names one. Any other repo stays shut, and is read
      // only once it is opened.
      const wanted = asked.get('repo');
      if (repos.repos.some((r) => r.project === wanted)) {
        setOpen(rowId(wanted));
        if (asked.get('file')) {
          fileKeys.set(wanted, asked.get('file'));
          parts.set(wanted, 'env');
        }
      } else {
        scrollPending = null;
      }
      render();
    }

    // The person's own editable layer: behind Show and edit once saved, since the answer carries the installation's too.
    function ownEditor(project, key, record, label) {
      const k = id(project, key);
      const editor = editorFor(project, key);
      const v = views.get(project);
      if (!record && !shownText.has(k)) shownText.set(k, '');
      editor.readOnly = busy.has(k);
      editor.disabled = !v.available;
      if (record && !shownText.has(k)) {
        return h('div', { class: 'value-row' },
          h('code', { class: 'value-box is-masked' }, key === INSTRUCTIONS ? '•••••••••••• hidden' : `•••••••••••• ${plural(record.keys?.length ?? 0, 'key', 'keys')}, hidden`),
          h('button', { type: 'button', class: 'btn btn-plain', disabled: busy.has(k), onclick: () => show(project, key) }, busy.has(k) ? 'Reading…' : 'Show and edit'));
      }
      const saveButton = h('button', { type: 'button', class: 'btn btn-open', disabled: true, onclick: () => save(project, key) }, busy.has(k) ? 'Saving…' : 'Save');
      saveButtons.set(k, saveButton);
      return [
        h('label', { class: 'sr-only', for: editor.id }, label),
        editor,
        h('div', { class: 'card-foot' },
          saveButton,
          record && h('button', { type: 'button', class: 'btn btn-quiet', disabled: busy.has(k) || !v.available, onclick: () => clear(project, key) }, 'Clear mine'),
          record && key !== INSTRUCTIONS && h('button', { type: 'button', class: 'btn btn-quiet', disabled: busy.has(k) || changed(k), title: changed(k) ? 'Save or undo the change first' : null, onclick: () => hide(project, key) }, 'Hide')),
      ];
    }

    // The installation's layer, read only: its text once read, here or with Show and edit below.
    function installationBlock(project, key, record) {
      const k = id(project, key);
      if (!record) return null;
      if (installationText.has(k)) {
        const text = installationText.get(k);
        return text ? h('pre', { class: 'layer-pre' }, text) : h('p', { class: 'layer-text is-none' }, 'None.');
      }
      return h('div', { class: 'value-row' },
        h('code', { class: 'value-box is-masked' }, key === INSTRUCTIONS ? '•••••••••••• hidden' : `•••••••••••• ${plural(record.keys?.length ?? 0, 'key', 'keys')}, hidden`),
        h('button', { type: 'button', class: 'btn btn-plain', disabled: busy.has(k), onclick: () => show(project, key) }, busy.has(k) ? 'Reading…' : 'Show'));
    }

    function byAdmins(project) {
      return W.isAdmin?.() ? ['Set by admins, for every session on this repo: ', h('a', { href: `/console-settings/repos/${encodeURIComponent(project)}` }, 'change it in Settings'), '.']
        : 'Set by your admins, for every session on this repo.';
    }

    function envPanel(project, f) {
      const v = views.get(project);
      const read = v.projectFile.read;
      const headId = `my-file-${project}-${f.key}`;
      return h('div', { class: 'layered', 'aria-labelledby': headId },
        h('div', { class: 'layered-head' },
          h('h3', { id: headId, class: 'mono' }, labelOf(f)),
          h('span', { class: 'data-meta' }, h('span', null, `key ${f.key}`))),
        pathsOf(f).length > 1 && L.sharedNote(f),
        read && L.defaultsLayer(f, v.repo),
        layer('installation', 'This installation\'s values',
          h('p', { class: 'layer-meta' }, savedLine(f.installation)),
          installationBlock(project, f.key, f.installation),
          h('p', { class: 'sub' }, byAdmins(project))),
        layer('personal', 'Your values',
          h('p', { class: 'layer-meta' }, savedLine(f.personal)),
          ownEditor(project, f.key, f.personal, `Your values for ${labelOf(f)}`),
          note(id(project, f.key)),
          h('p', { class: 'sub' }, `In your private sessions, these keys replace the repo's and this installation's. ${NO_CREDENTIALS}`)),
        read && L.sessionLayer(f),
        read && h('div', { class: 'layer-gets' },
          h('h3', null, 'What your sessions get'),
          L.keyTable(f, { yours: true }),
          h('p', { class: 'sub' }, 'Keys only. Shared sessions get the same, without yours.')));
    }

    function instructionsPanel(project) {
      const v = views.get(project);
      const k = id(project, INSTRUCTIONS);
      const { installation, personal } = v.instructions;
      const headId = `my-instructions-head-${project}`;
      return h('div', { class: 'layered', 'aria-labelledby': headId },
        h('div', { class: 'layered-head' }, h('h3', { id: headId }, 'Instructions')),
        layer('repo', 'From the repo', L.repoRules(v)),
        layer('installation', 'This installation\'s instructions',
          h('p', { class: 'layer-meta' }, savedLine(installation)),
          installationBlock(project, INSTRUCTIONS, installation)),
        layer('personal', 'Your instructions',
          h('p', { class: 'layer-meta' }, savedLine(personal)),
          ownEditor(project, INSTRUCTIONS, personal, 'Your instructions'),
          shownText.has(k) && sizeLineOf(project),
          note(k),
          h('p', { class: 'sub' }, 'At most 16 KB, in your private sessions only, after this installation\'s. No secrets: put those in an env file.')));
    }

    async function loadOwnFiles(name) {
      if (ownLoads.has(name)) return;
      ownLoads.add(name);
      ownFilesFailed.delete(name);
      try {
        const answer = await W.getJson(`${base(name)}/files`);
        ownFiles.set(name, answer.files ?? {});
        ownOpen.set(name, Object.keys(answer.files ?? {}).sort()[0] ?? '');
        boxesOf(name).filled = false;
      } catch (err) {
        ownFilesFailed.set(name, refusal(err));
      }
      ownLoads.delete(name);
      render();
    }

    // Each repo's path and text boxes are one pair, filled from its open file.
    function openOwnFile(project, file, { redraw = true } = {}) {
      const box = boxesOf(project);
      ownOpen.set(project, file);
      box.path.value = file;
      box.text.value = file ? ownFiles.get(project)?.[file] ?? '' : '';
      notes.delete(id(project, FILES));
      if (redraw) render();
    }

    function saveOwnFile(project, file, text, done) {
      return act(id(project, FILES), async () => {
        const answer = await W.postJson(`${base(project)}/files`, { path: file, text });
        ownFiles.set(project, answer.files);
        views.set(project, answer.view);
        summaryOf(project, answer.view);
        openOwnFile(project, answer.files[file.trim()] !== undefined ? file.trim() : Object.keys(answer.files).sort()[0] ?? '', { redraw: false });
        return done;
      });
    }

    function filesPanel(project) {
      const v = views.get(project);
      const k = id(project, FILES);
      const box = boxesOf(project);
      let files = ownFiles.get(project) ?? null;
      // The view lists their paths: with none, there is nothing to read.
      if (v.available && !files && !ownFilesFailed.has(project)) {
        if (v.files?.length) loadOwnFiles(project);
        else ownFiles.set(project, files = {});
      }
      // Read since the boxes were last filled: fill them from the open file.
      if (files && !box.filled) {
        box.filled = true;
        openOwnFile(project, ownOpen.get(project) ?? Object.keys(files).sort()[0] ?? '', { redraw: false });
      }
      const open = ownOpen.get(project) ?? '';
      const records = v.files ?? [];
      const savedAt = (file) => records.find((f) => f.path === file)?.savedAt;
      const working = busy.has(k);
      box.path.readOnly = working || Boolean(open);
      box.text.readOnly = working;
      box.path.disabled = box.text.disabled = !v.available || !files;
      const failed = ownFilesFailed.get(project);
      const headId = `my-files-head-${project}`;
      return h('div', { class: 'layered', 'aria-labelledby': headId },
        h('div', { class: 'layered-head' }, h('h3', { id: headId }, 'Your files'),
          h('span', { class: 'data-meta' }, h('span', null, records.length ? plural(records.length, 'file', 'files') : 'None'))),
        // Only the person's layer: nothing of the repo's or the installation's is under these paths.
        layer('personal', 'Your whole files',
          h('div', { class: 'file-tabs', role: 'group', 'aria-label': 'Your file' },
            records.map((f) => h('button', { type: 'button', 'aria-pressed': String(f.path === open), disabled: working || !files, onclick: () => openOwnFile(project, f.path) }, f.path)),
            h('button', { type: 'button', 'aria-pressed': String(open === ''), disabled: working || !files, onclick: () => openOwnFile(project, '') }, '+ Add a file')),
          h('label', { class: 'field-label', for: `own-file-path-${project}` }, h('span', null, 'Path in the repo')),
          box.path,
          h('label', { class: 'field-label', for: `own-file-text-${project}` }, h('span', null, open ? `${open}${savedAt(open) ? `, saved ${W.when(savedAt(open))}` : ''}` : 'Its text')),
          box.text,
          h('div', { class: 'card-foot' },
            failed && h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => loadOwnFiles(project) }, 'Try again'),
            h('button', {
              type: 'button', class: 'btn btn-open', disabled: !v.available || !files || working,
              onclick: () => {
                const file = box.path.value.trim();
                if (!box.text.value.trim()) {
                  notes.set(k, { text: 'Write the file\'s text first. To delete a file, use Remove.', bad: true });
                  render();
                  return;
                }
                saveOwnFile(project, file, box.text.value, `Saved ${file}. Your next private session on ${v.repo} writes it; running ones keep theirs.`);
              },
            }, working ? 'Saving…' : 'Save'),
            open && h('button', {
              type: 'button', class: 'btn btn-quiet', disabled: working,
              onclick: () => {
                if (!window.confirm(`Remove ${open}? Your next sessions on ${v.repo} no longer write it.`)) return;
                saveOwnFile(project, open, '', `Removed ${open}.`);
              },
            }, 'Remove')),
          failed ? h('p', { class: 'form-error', role: 'alert' }, `Could not read your files: ${failed}`) : note(k),
          h('p', { class: 'sub' }, `Whole files your private sessions on ${v.repo} write into its checkout. Git must ignore the path, so it never reaches a commit.`,
            v.filesMaxBytes ? ` Up to ${Math.floor(v.filesMaxBytes / 1024)} KB, ${v.filesMax ?? 20} files at most.` : '')));
    }

    // An open repo shows one part at a time, picked on a switch whose dot says where the person keeps something.
    function repoBody(project) {
      const v = views.get(project);
      if (viewErrors.has(project)) return h('p', { class: 'form-error', role: 'alert' }, `Could not load this repo's settings: ${viewErrors.get(project)}`);
      if (!v) return h('p', { class: 'empty' }, 'Loading the repo\'s settings…');
      const files = v.envFiles;
      if (!files.some((f) => f.key === fileKeys.get(project))) fileKeys.set(project, files[0]?.key ?? null);
      const fileKey = fileKeys.get(project);
      const f = fileKey && files.find((x) => x.key === fileKey);
      const part = parts.get(project) ?? 'instructions';
      const tabs = [
        ['instructions', 'Instructions', Boolean(v.instructions.personal)],
        ['env', 'Env files', files.some((x) => x.personal)],
        ['files', 'Your files', (v.files?.length ?? 0) > 0],
      ];
      return [
        !v.available && h('p', { class: 'cap-note', role: 'status' }, 'This console has no secret store, so nothing can be saved here.'),
        !v.projectFile.read && h('p', { class: 'cap-note', role: 'status' }, `The project file could not be read (${v.projectFile.error}), so only your saved values are listed. They cannot be saved again until it can be read.`),
        h('div', { class: 'theme-seg', role: 'group', 'aria-label': `What to set for ${v.repo}` }, tabs.map(([key, label, yours]) => h('button', {
          type: 'button', class: 'theme-opt', 'aria-pressed': String(key === part), title: yours ? 'You keep something here' : null,
          onclick: () => { parts.set(project, key); render(); },
        }, label, yours ? ' •' : ''))),
        part === 'files' ? filesPanel(project)
          : part === 'instructions' ? instructionsPanel(project)
            : [
              files.length > 1 && h('div', { class: 'file-tabs', role: 'group', 'aria-label': 'Env file' }, files.map((x) => h('button', {
                type: 'button', 'aria-pressed': String(x.key === fileKey), onclick: () => openFile(project, x.key),
              }, labelOf(x), x.personal ? ' •' : ''))),
              f ? envPanel(project, f) : h('p', { class: 'sub' }, 'The project file has no env files.'),
            ],
      ];
    }

    /** One row per repo the person can write to; a repo is read when its row is first opened. */
    function rows() {
      saveButtons.clear();
      if (reposError) return [h('p', { class: 'form-error set-rows-note', role: 'alert' }, `Could not load your repos: ${reposError}`)];
      if (!repos) return [h('p', { class: 'empty set-rows-note' }, 'Loading your repos…')];
      if (!repos.repos.length) return [h('p', { class: 'sub set-rows-note' }, 'You cannot write to any of this console\'s repos yet, so there is nothing to set.')];
      const drawn = repos.repos.map((r) => {
        const openNow = isOpen(rowId(r.project));
        if (openNow && !views.has(r.project) && !viewErrors.has(r.project)) loadView(r.project);
        const keeps = [
          r.envFiles.length && `your values for ${plural(r.envFiles.length, 'env file', 'env files')}`,
          r.instructions && 'your instructions',
          r.files && `your ${plural(r.files, 'file', 'files')}`,
        ].filter(Boolean).join(' · ');
        return row({
          id: rowId(r.project), title: r.repo, opens: true,
          pill: h('span', { class: keeps ? 'pill is-ok' : 'pill' }, keeps ? 'Yours' : 'None of yours'),
          value: keeps ? `${keeps[0].toUpperCase()}${keeps.slice(1)}` : 'Env values, instructions and files of your own, for your private sessions on it',
          // Opening it again after a read that failed reads it again.
          onOpen: () => { viewErrors.delete(r.project); setQuery({ repo: r.project, file: null }); },
        }, openNow && repoBody(r.project));
      });
      for (const k of editors.keys()) updateCounts(k);
      return drawn;
    }

    function afterRender() {
      if (!scrollPending || !views.has(scrollPending)) return;
      const target = document.getElementById(rowId(scrollPending));
      scrollPending = null;
      target?.scrollIntoView?.({ block: 'start' });
    }

    // After Remove My Woodshed: nothing of the person's is left, so everything is read again.
    function reload() {
      for (const map of [views, viewErrors, shownText, installationText, notes, ownFiles, ownFilesFailed, ownOpen]) map.clear();
      for (const editor of editors.values()) editor.value = '';
      for (const box of boxes.values()) {
        box.path.value = '';
        box.text.value = '';
        box.filled = false;
      }
      repos = null;
      load();
    }

    load();
    return { rows, afterRender, reload };
  }

  window.WoodshedMyRepoSettings = { create: createMyRepoSettings };
})();
