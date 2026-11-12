// My settings' Repo settings card: for each repo the person can write to, their own values for each of its env files
// and their own instructions, which only their private sessions on that repo get, drawn as the layers a session writes
// them from (designSystem/components/LayeredFile). They may read the installation's values too, since their sessions
// hold them anyway; each read is logged. ?repo=<project> opens one repo, and ?file=<key> one of its env files.
(function () {
  'use strict';
  const W = window.Woodshed;
  const { h } = W;
  const L = window.WoodshedRepoLayers;
  const { INSTRUCTIONS_MAX_BYTES, NO_CREDENTIALS, bytesOf, plural, savedLine, layer } = L;
  const INSTRUCTIONS = '#instructions';

  /**
   * @param {{render: () => void}} page  redraws the whole page, which calls card() again
   * @returns {{card: () => object, afterRender: () => void, reload: () => void}}
   */
  function createMyRepoSettings({ render }) {
    const asked = new URLSearchParams(location.search);
    let repos = null;
    let reposError = null;
    let project = null;
    let fileKey = asked.get('file');
    // Scrolled to once, when a link named a repo.
    let scrollPending = asked.has('repo');
    const views = new Map();
    const viewErrors = new Map();
    // By `${project}\n${key}`: each editor, made once so what is typed survives a redraw, and what was read for it.
    const editors = new Map();
    const shownText = new Map();
    const installationText = new Map();
    const notes = new Map();
    const busy = new Set();
    const saveButtons = new Map();
    const sizeLine = h('p', { class: 'layer-count', role: 'status' });

    const id = (key) => `${project}\n${key}`;
    const base = (name) => `/api/my/repos/${encodeURIComponent(name)}`;
    const textPath = (key) => (key === INSTRUCTIONS ? `${base(project)}/instructions` : `${base(project)}/env/${encodeURIComponent(key)}`);
    const labelOf = (f) => f.path ?? f.key;
    const view = () => views.get(project) ?? null;

    function refusal(err) {
      if (err.status === 403) return 'You can no longer start sessions on this repo, so you keep nothing for it.';
      return err.message;
    }

    function editorFor(key) {
      const k = id(key);
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

    const changed = (k) => editors.has(k) && editors.get(k).value !== (shownText.get(k) ?? '');

    function canSave(k) {
      const v = view();
      if (!v?.available || busy.has(k) || !shownText.has(k) || !changed(k)) return false;
      return !k.endsWith(`\n${INSTRUCTIONS}`) || bytesOf(editors.get(k).value) <= INSTRUCTIONS_MAX_BYTES;
    }

    function updateCounts(k) {
      if (k === id(INSTRUCTIONS)) {
        const bytes = bytesOf(editors.get(k).value);
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
    async function show(key) {
      const k = id(key);
      await act(k, async () => {
        const answer = await W.getJson(textPath(key));
        shownText.set(k, answer.text);
        installationText.set(k, answer.installation);
        editorFor(key).value = answer.text;
        return null;
      });
    }

    function hide(key) {
      const k = id(key);
      shownText.delete(k);
      installationText.delete(k);
      editorFor(key).value = '';
      notes.delete(k);
      render();
    }

    function save(key, { clear = false } = {}) {
      const k = id(key);
      const editor = editorFor(key);
      const text = clear ? '' : editor.value;
      const name = project;
      return act(k, async () => {
        const answer = await W.postJson(textPath(key), { text });
        views.set(name, answer);
        editor.value = text;
        shownText.set(k, text);
        summaryOf(name, answer);
        if (key === INSTRUCTIONS) return text.trim() ? 'Saved. Your next private session on this repo has them in its prompt; running ones keep theirs.' : 'Cleared. Your sessions get this installation\'s instructions and the repo\'s rules alone.';
        const f = answer.envFiles.find((x) => x.key === key);
        if (text.trim()) return `Saved. Your next private session on ${answer.repo} writes them into ${labelOf(f ?? { key })}; running ones keep theirs.`;
        return 'Cleared. Your sessions get the repo\'s defaults and this installation\'s values alone.';
      });
    }

    function clear(key) {
      const f = key === INSTRUCTIONS ? null : view().envFiles.find((x) => x.key === key);
      const what = key === INSTRUCTIONS ? 'your own instructions for this repo' : `your own values for ${labelOf(f)}`;
      if (!window.confirm(`Clear ${what}? Your sessions then get this installation's alone.`)) return;
      save(key, { clear: true });
    }

    // The list's dot follows what the person keeps, without asking the console again.
    function summaryOf(name, v) {
      const row = repos?.repos.find((r) => r.project === name);
      if (!row) return;
      row.envFiles = v.envFiles.filter((f) => f.personal).map((f) => f.key);
      row.instructions = Boolean(v.instructions.personal);
    }

    async function loadView(name) {
      viewErrors.delete(name);
      try {
        const v = await W.getJson(base(name));
        views.set(name, v);
        summaryOf(name, v);
      } catch (err) {
        viewErrors.set(name, refusal(err));
      }
      render();
      const v = views.get(name);
      if (v && (v.instructions.installation || v.instructions.personal) && name === project) await show(INSTRUCTIONS);
    }

    function setQuery(params) {
      const url = new URL(location.href);
      for (const [k, value] of Object.entries(params)) {
        if (value === null) url.searchParams.delete(k);
        else url.searchParams.set(k, value);
      }
      history.replaceState(null, '', url);
    }

    function openRepo(name) {
      project = name;
      fileKey = null;
      setQuery({ repo: name, file: null });
      if (!views.has(name)) loadView(name);
      render();
    }

    function openFile(key) {
      fileKey = key;
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
      const names = repos.repos.map((r) => r.project);
      const wanted = asked.get('repo');
      project = names.includes(wanted) ? wanted : names.includes(repos.defaultProject) ? repos.defaultProject : names[0] ?? null;
      if (project) await loadView(project);
      else render();
    }

    // The person's own editable layer: behind Show and edit once saved, since the answer carries the installation's too.
    function ownEditor(key, record, label) {
      const k = id(key);
      const editor = editorFor(key);
      const v = view();
      if (!record && !shownText.has(k)) shownText.set(k, '');
      editor.readOnly = busy.has(k);
      editor.disabled = !v.available;
      if (record && !shownText.has(k)) {
        return h('div', { class: 'value-row' },
          h('code', { class: 'value-box is-masked' }, key === INSTRUCTIONS ? '•••••••••••• hidden' : `•••••••••••• ${plural(record.keys?.length ?? 0, 'key', 'keys')}, hidden`),
          h('button', { type: 'button', class: 'btn btn-plain', disabled: busy.has(k), onclick: () => show(key) }, busy.has(k) ? 'Reading…' : 'Show and edit'));
      }
      const saveButton = h('button', { type: 'button', class: 'btn btn-open', disabled: true, onclick: () => save(key) }, busy.has(k) ? 'Saving…' : 'Save');
      saveButtons.set(k, saveButton);
      return [
        h('label', { class: 'sr-only', for: editor.id }, label),
        editor,
        h('div', { class: 'card-foot' },
          saveButton,
          record && h('button', { type: 'button', class: 'btn btn-quiet', disabled: busy.has(k) || !v.available, onclick: () => clear(key) }, 'Clear mine'),
          record && key !== INSTRUCTIONS && h('button', { type: 'button', class: 'btn btn-quiet', disabled: busy.has(k) || changed(k), title: changed(k) ? 'Save or undo the change first' : null, onclick: () => hide(key) }, 'Hide')),
      ];
    }

    // The installation's layer, read only: its text once read, here or with Show and edit below.
    function installationBlock(key, record) {
      const k = id(key);
      if (!record) return null;
      if (installationText.has(k)) {
        const text = installationText.get(k);
        return text ? h('pre', { class: 'layer-pre' }, text) : h('p', { class: 'layer-text is-none' }, 'None.');
      }
      return h('div', { class: 'value-row' },
        h('code', { class: 'value-box is-masked' }, key === INSTRUCTIONS ? '•••••••••••• hidden' : `•••••••••••• ${plural(record.keys?.length ?? 0, 'key', 'keys')}, hidden`),
        h('button', { type: 'button', class: 'btn btn-plain', disabled: busy.has(k), onclick: () => show(key) }, busy.has(k) ? 'Reading…' : 'Show'));
    }

    function byAdmins() {
      return W.isAdmin?.() ? ['Set by admins, for every session on this repo: ', h('a', { href: `/console-settings/repos/${encodeURIComponent(project)}` }, 'change it on Console settings'), '.']
        : 'Set by your admins, for every session on this repo.';
    }

    // While a file may still be read from its Terraform secret: no installation value yet.
    function legacyNote(f) {
      if (!f.legacy || f.installation) return null;
      return h('p', { class: 'cap-note' }, 'No values here yet: sessions still read the Terraform secret ', h('code', null, f.legacy.secret), '.');
    }

    function envPanel(f) {
      const v = view();
      const read = v.projectFile.read;
      return h('div', { class: 'layered', 'aria-labelledby': `my-file-${f.key}` },
        h('div', { class: 'layered-head' },
          h('h3', { id: `my-file-${f.key}`, class: 'mono' }, labelOf(f)),
          h('span', { class: 'data-meta' }, h('span', null, `key ${f.key}`))),
        read && L.defaultsLayer(f, v.repo),
        layer('installation', 'This installation\'s values',
          h('p', { class: 'layer-meta' }, savedLine(f.installation)),
          installationBlock(f.key, f.installation),
          legacyNote(f),
          h('p', { class: 'sub' }, byAdmins())),
        layer('personal', 'Your values',
          h('p', { class: 'layer-meta' }, savedLine(f.personal)),
          ownEditor(f.key, f.personal, `Your values for ${labelOf(f)}`),
          note(id(f.key)),
          h('p', { class: 'sub' }, `They replace the repo's defaults and this installation's values for the keys they set, in your private sessions on this repo only. ${NO_CREDENTIALS}`)),
        read && L.sessionLayer(f),
        read && h('div', { class: 'layer-gets' },
          h('h3', null, 'What your sessions get'),
          L.keyTable(f, { yours: true }),
          h('p', { class: 'sub' }, 'Keys only: each value stays in its own layer. Shared sessions get the same, without yours.')));
    }

    function instructionsPanel() {
      const v = view();
      const k = id(INSTRUCTIONS);
      const { installation, personal } = v.instructions;
      return h('div', { class: 'layered', 'aria-labelledby': 'my-instructions-head' },
        h('div', { class: 'layered-head' }, h('h3', { id: 'my-instructions-head' }, 'Instructions')),
        layer('repo', 'From the repo', L.repoRules(v)),
        layer('installation', 'This installation\'s instructions',
          h('p', { class: 'layer-meta' }, savedLine(installation)),
          installationBlock(INSTRUCTIONS, installation)),
        layer('personal', 'Your instructions',
          h('p', { class: 'layer-meta' }, savedLine(personal)),
          ownEditor(INSTRUCTIONS, personal, 'Your instructions'),
          shownText.has(k) && sizeLine,
          note(k),
          h('p', { class: 'sub' }, 'At most 16 KB. They go into the prompt of your private sessions on this repo only, after this installation\'s, and win where the two disagree. No secrets: put them in an env file\'s values.')));
    }

    function repoBody() {
      const v = view();
      if (viewErrors.has(project)) return h('p', { class: 'form-error', role: 'alert' }, `Could not load this repo's settings: ${viewErrors.get(project)}`);
      if (!v) return h('p', { class: 'empty' }, 'Loading the repo\'s settings…');
      const files = v.envFiles;
      if (!files.some((f) => f.key === fileKey)) fileKey = files[0]?.key ?? null;
      const f = fileKey && files.find((x) => x.key === fileKey);
      return [
        !v.available && h('p', { class: 'cap-note', role: 'status' }, 'This console has no secret store, so nothing can be saved here.'),
        !v.projectFile.read && h('p', { class: 'cap-note', role: 'status' }, `The project file could not be read (${v.projectFile.error}), so only your saved values are listed. They cannot be saved again until it can be read.`),
        files.length > 1 && h('div', { class: 'file-tabs', role: 'group', 'aria-label': 'Env file' }, files.map((x) => h('button', {
          type: 'button', 'aria-pressed': String(x.key === fileKey), onclick: () => openFile(x.key),
        }, labelOf(x), x.personal ? ' •' : ''))),
        f ? envPanel(f) : h('p', { class: 'sub' }, 'The project file has no env files.'),
        instructionsPanel(),
      ];
    }

    function card() {
      saveButtons.clear();
      const list = repos?.repos ?? [];
      const keeps = list.filter((r) => r.envFiles.length || r.instructions);
      const pill = keeps.length ? h('span', { class: 'pill is-ok' }, `Yours on ${plural(keeps.length, 'repo', 'repos')}`) : h('span', { class: 'pill' }, 'None of yours');
      const body = reposError ? h('p', { class: 'form-error', role: 'alert' }, `Could not load your repos: ${reposError}`)
        : !repos ? h('p', { class: 'empty' }, 'Loading your repos…')
          : !list.length ? h('p', { class: 'sub' }, 'You cannot write to any of this console\'s repos yet, so there is nothing to set.')
            : [
              list.length > 1 && h('div', { class: 'file-tabs', role: 'group', 'aria-label': 'Repo' }, list.map((r) => h('button', {
                type: 'button', 'aria-pressed': String(r.project === project), onclick: () => openRepo(r.project),
              }, r.repo, r.envFiles.length || r.instructions ? ' •' : ''))),
              repoBody(),
            ];
      const node = h('section', { class: 'set-card is-wide', id: 'repo-settings' },
        h('div', { class: 'set-head' }, h('h2', null, 'Repo settings'), pill),
        h('p', { class: 'sub' }, 'Your own values for each repo\'s env files, and your own instructions, for your private sessions on that repo. Shared sessions never get them. Your next private session picks up what you save; running ones keep theirs. Only repos you can write to are listed.'),
        body);
      for (const k of editors.keys()) updateCounts(k);
      return node;
    }

    function afterRender() {
      if (!scrollPending || !views.has(project)) return;
      scrollPending = false;
      document.getElementById('repo-settings')?.scrollIntoView?.({ block: 'start' });
    }

    // After Remove My Woodshed: nothing of the person's is left, so everything is read again.
    function reload() {
      for (const map of [views, viewErrors, shownText, installationText, notes]) map.clear();
      for (const editor of editors.values()) editor.value = '';
      repos = null;
      load();
    }

    load();
    return { card, afterRender, reload };
  }

  window.WoodshedMyRepoSettings = { create: createMyRepoSettings };
})();
