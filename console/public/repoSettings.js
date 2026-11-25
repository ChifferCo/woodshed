// A repo's page under Settings (/console-settings/repos/<project>), as groups of rows that open in place
// (settingsRows.js): a row for each env file of its project file, with the repo's defaults, this installation's values,
// what the session sets itself, and which of them a session gets for each key; then the installation's instructions,
// how its sessions start from GitHub (its switches and its label), and the Slack channel its pull requests are posted
// to. A closed row says what it holds. Admins only: the API refuses anyone else, and the page says so. Values stay
// hidden until Show, as on Secrets & webhooks, and never reach the table, which names keys alone. ?file=<key> opens
// one env file's row, #slack the channel's and #github the label's, so a link can point at them.
// The scripts a program named for its groups (its `repoPage` hook), loaded once for the document: the settings pages are
// one page, and this one starts again on each visit to a repo's settings, which would run them again and stack their
// listeners.
const repoPageScripts = new Set();
window.Woodshed.settingsPage(/^\/console-settings\/repos\/[a-z0-9]+(?:-[a-z0-9]+)*$/, (app, life) => {
  'use strict';
  const W = window.Woodshed;
  const { h } = W;
  const L = window.WoodshedRepoLayers;
  const { INSTRUCTIONS_MAX_BYTES, NO_CREDENTIALS, bytesOf, plural, savedLine, layer } = L;

  const project = decodeURIComponent(location.pathname.split('/').pop() || '');
  const base = `/api/console-settings/repos/${encodeURIComponent(project)}`;
  let view = null;
  let loadError = null;
  // Which rows are open is kept for the page's life, since it is drawn again on each answer.
  const { open, row, line, group, draw, follow } = window.WoodshedSettingsRows.create({ render });
  const fileRow = (key) => `file-${key}`;
  // The env file a link names (?file=<key>): its row starts open.
  const asked = new URLSearchParams(location.search).get('file');
  if (asked) open.add(fileRow(asked));
  // Each env file's editor, and the instructions', made once so what is typed and the caret survive a redraw.
  const editors = new Map();
  // The saved text each editor was filled from, by editor key; absent while the values are hidden.
  const shownText = new Map();
  // What the last action on each part said: {text, bad}.
  const notes = new Map();
  const busy = new Set();
  const INSTRUCTIONS = '#instructions';
  const INSTRUCTIONS_ROW = 'instructions';
  const SLACK = '#slack';
  // The channel's row, which #slack opens.
  const SLACK_ROW = 'slack';
  // The channel picker (slackSetup.js), made once like the editors, so what is typed and the focus survive a redraw.
  let channelPicker = null;
  const GITHUB = '#github';
  // What a switch's refusal is said under, and the label's row, which #github opens: the group has that id.
  const SWITCHES = '#github-switches';
  const LABEL_ROW = 'session-label-row';
  if (location.hash === GITHUB) open.add(LABEL_ROW);
  // The label's name field, made once for the same reason.
  let labelInput = null;
  // As repoTriggers.mjs checks it; the server says the rest (the repo's QA label).
  const LABEL_MAX = 50;

  const fileOf = (key) => view.envFiles.find((f) => f.key === key) ?? null;
  const { pathsOf, labelOf, andList } = L;

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

  // `where` is the note the answer goes under, when it is not the part's own.
  async function act(key, run, where = key) {
    if (busy.has(key)) return;
    busy.add(key);
    notes.delete(where);
    render();
    try {
      const said = await run();
      if (said) notes.set(where, { text: said });
    } catch (err) {
      notes.set(where, { text: refusal(err), bad: true });
    }
    busy.delete(key);
    render();
  }

  function textPath(key) {
    return key === INSTRUCTIONS ? `${base}/instructions` : `${base}/env/${encodeURIComponent(key)}`;
  }

  // `focus` puts the caret in the editor, for someone who pressed Show. The page's own read at load leaves it out:
  // focus brings its field into view, and the page would open scrolled down to Instructions.
  async function show(key, { focus = true } = {}) {
    await act(key, async () => {
      const { text } = await W.getJson(textPath(key));
      shownText.set(key, text);
      editorFor(key).value = text;
      return null;
    });
    if (focus && shownText.has(key)) editorFor(key).focus?.();
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
      if (text.trim()) return `Saved. The next session on ${view.repo} writes them into ${f ? andList(pathsOf(f)) : key}; running ones keep theirs.`;
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
        h('div', { class: 'set-actions' },
          saveButton,
          record && h('button', { type: 'button', class: 'btn btn-quiet', disabled: busy.has(key) || !view.available, onclick: () => clear(key) }, 'Clear'),
          record && h('button', { type: 'button', class: 'btn btn-quiet', disabled: busy.has(key) || changed(key), title: changed(key) ? 'Save or undo the change first' : null, onclick: () => hide(key) }, 'Hide')),
      ];
    return block;
  }

  function envFileBody(f) {
    const read = view.projectFile.read;
    return [
      h('p', { class: 'layer-meta' }, `key ${f.key}`),
      pathsOf(f).length > 1 && L.sharedNote(f),
      h('div', { class: 'layered' },
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
          h('p', { class: 'sub' }, 'Keys only. In a private session, that person\'s own values come after these.'))),
    ];
  }

  // The address names the env file whose row was opened last, so a copied link opens it (?file=<key>).
  function nameFile(key) {
    const url = new URL(location.href);
    url.searchParams.set('file', key);
    history.replaceState(null, '', url);
  }

  // One row an env file: closed, it says whether this installation sets any of its keys, and how many.
  function envFileRow(f) {
    const record = f.installation;
    const count = record?.keys?.length ?? 0;
    return row({
      id: fileRow(f.key), title: h('span', { class: 'mono' }, labelOf(f)),
      value: record ? `This installation sets ${plural(count, 'key', 'keys')} · ${savedLine(record)}`
        : view.projectFile.read ? 'The repo\'s defaults alone' : 'Nothing saved',
      pill: h('span', { class: record ? 'pill is-ok' : 'pill' }, record ? `${plural(count, 'key', 'keys')} set` : 'Defaults only'),
      onOpen: () => nameFile(f.key),
    }, envFileBody(f));
  }

  // A key saved for an env file the project file no longer names: nothing to open, Delete on the row.
  function unnamedRow(u) {
    return row({
      id: fileRow(u.key), title: h('span', { class: 'mono' }, u.key),
      value: [h('code', null, u.key), ` is saved but the project file no longer has it · ${savedLine(u.installation)}`],
      pill: h('span', { class: 'repo-row-ctl' }, h('span', { class: 'pill is-warn' }, 'Unused'), h('button', {
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
      }, 'Delete')),
    });
  }

  function envGroup() {
    const files = view.envFiles;
    const said = note('unnamed');
    return group({
      id: 'env-files', label: 'Env files',
      note: [
        'Layers, later wins: the repo\'s defaults, then this installation, then a person\'s own (private sessions), then what the session sets.',
        !view.projectFile.read && h('p', { class: 'cap-note', role: 'status' }, `The project file could not be read (${view.projectFile.error}), so only the saved values are listed. They cannot be saved again until it can be read.`),
      ],
    },
      files.map(envFileRow),
      !files.length && noEnvFiles(),
      view.unnamed.map(unnamedRow),
      said && h('div', { class: 'set-rows-note' }, said));
  }

  // How to add an env file, where the project file has none: its key comes from its path, so it needs no secret.
  function noEnvFiles() {
    if (!view.projectFile.read) return h('p', { class: 'sub set-rows-note' }, 'No values are saved.');
    const projectFile = h('a', { href: L.githubFile(view.repo, '.woodshed/project.yaml'), target: '_blank', rel: 'noopener' }, '.woodshed/project.yaml ↗');
    return h('div', { class: 'layer', id: 'no-env-files' },
      h('div', { class: 'layer-head' }, h('h3', null, 'This repo has no env files yet')),
      h('ol', { class: 'cmd-steps' },
        h('li', null, h('p', null, 'In a pull request, add an ', h('code', null, 'envFiles'), ' entry to ', projectFile, ':'),
          h('pre', { class: 'layer-pre' }, 'envFiles:\n  - path: api/.env\n    defaults:        # optional\n      - LOG_LEVEL=info')),
        h('li', null, h('p', null, 'No ', h('code', null, 'secret'), ' is needed: the file\'s key comes from its path (', h('code', null, 'api/.env'), ' is ', h('code', null, 'api-env'), ').')),
        h('li', null, h('p', null, 'Once it is on the default branch, a row for it appears here, to set this installation\'s values.'))),
      h('p', { class: 'sub' }, 'Every field is in Woodshed\'s ', h('code', null, 'docs/reference.md'), ', "The project file".'));
  }

  // Saved instructions are read when their row opens: they go into every prompt, so they are not behind Show.
  function readInstructions() {
    if (view?.instructions.installation && !shownText.has(INSTRUCTIONS) && !busy.has(INSTRUCTIONS) && !notes.get(INSTRUCTIONS)?.bad) show(INSTRUCTIONS, { focus: false });
  }

  function promptGroup() {
    const record = view.instructions.installation;
    return group({ id: 'prompt', label: 'Prompt' }, row({
      id: INSTRUCTIONS_ROW, title: 'Instructions',
      value: record ? `Added to every session's prompt on this repo, after the repo's own rules · ${savedLine(record)}`
        : 'None of this installation\'s: sessions on this repo get the repo\'s own rules alone',
      pill: h('span', { class: record ? 'pill is-ok' : 'pill' }, record ? `${record.bytes.toLocaleString()} bytes` : 'None'),
      onOpen: readInstructions,
    },
      h('p', { class: 'sub' }, 'Woodshed\'s rules come first. These beat the repo\'s, and a person\'s own beat these.'),
      h('div', { class: 'layered' },
        layer('repo', 'From the repo', L.repoRules(view)),
        layer('installation', 'This installation\'s instructions',
          h('p', { class: 'layer-meta' }, savedLine(record)),
          editorBlock(INSTRUCTIONS, record, 'This installation\'s instructions'),
          shownText.has(INSTRUCTIONS) && sizeLine,
          note(INSTRUCTIONS),
          h('p', { class: 'sub' }, 'At most 16 KB. No secrets: put those in an env file.')))));
  }

  function labelProblem(raw) {
    if (raw.trim() === '') return null;
    if ([...raw.trim()].length > LABEL_MAX) return `GitHub takes labels of at most ${LABEL_MAX} characters.`;
    if (raw.includes(',')) return 'A label cannot have a comma in it.';
    return null;
  }

  // Saved through the Repos card's API, which answers with the repo's label and switches. Each switch applies as it is
  // turned, as the console's other switches do; the label waits for Save. What it says goes under what was changed:
  // the label's row, or the switches, whose refusal must show while that row is closed.
  function saveTriggers(change, said, where = GITHUB) {
    return act(GITHUB, async () => {
      const answer = await W.postJson('/api/console-settings/projects/triggers', { name: view.project, ...change });
      view = { ...view, triggers: answer.triggers };
      if (change.label !== undefined) labelInput.value = answer.triggers.label;
      return said(answer.triggers);
    }, where);
  }

  // A switch on its own row: its sentence says what it does as it is now.
  function triggerLine({ id, on, label, onText, offText, change }) {
    return line(label, on ? onText : offText, h('button', {
      type: 'button', class: 'switch-ui', role: 'switch', 'aria-checked': String(on), 'aria-label': label, disabled: busy.has(GITHUB),
      onclick: () => saveTriggers(change(!on), () => null, SWITCHES),
    }), { id });
  }

  function githubGroup() {
    const t = view.triggers;
    if (!t) return null;
    if (!labelInput) {
      labelInput = h('input', {
        id: 'session-label', class: 'field is-text mono', type: 'text', autocomplete: 'off', spellcheck: 'false', maxlength: String(LABEL_MAX * 2),
        oninput: () => render(),
      });
      labelInput.value = t.label;
    }
    const raw = labelInput.value;
    const typed = raw.trim() === '' ? t.consoleLabel : raw.trim();
    const bad = labelProblem(raw);
    labelInput.readOnly = busy.has(GITHUB);
    labelInput.setAttribute('aria-invalid', bad ? 'true' : 'false');
    const code = (text) => h('code', null, text);
    const switchesSaid = note(SWITCHES);
    return group({
      id: 'github', label: 'Sessions from GitHub',
      note: `How a shared session on ${view.repo} starts from GitHub, for someone with write access and Sessions from GitHub on People.`,
    },
      triggerLine({
        id: 'switch-labels', on: t.labels, label: 'Start sessions from the label', change: (on) => ({ labels: on }),
        onText: ['On: the ', code(t.label), ' label on an issue starts a session, or resumes the one it had.'],
        offText: ['Off: the ', code(t.label), ' label does nothing on this repo.'],
      }),
      triggerLine({
        id: 'switch-comments', on: t.comments, label: '/woodshed comments', change: (on) => ({ comments: on }),
        onText: ['On: ', code('/woodshed …'), ' on an issue or pull request starts a session, resumes it, or types the message into a running one.'],
        offText: ['Off: ', code('/woodshed …'), ' comments do nothing on this repo, including on the sessions it already has.'],
      }),
      switchesSaid && h('div', { class: 'set-rows-note' }, switchesSaid),
      row({
        id: LABEL_ROW, title: 'The label\'s name',
        value: [code(t.label), t.labelSet ? `, this repo's own. The console's is ${t.consoleLabel}.` : ', the console\'s'],
        pill: h('span', { class: t.labelSet ? 'pill is-ok' : 'pill' }, t.labelSet ? 'Own' : 'Console\'s'),
      },
        h('label', { class: 'field-label', for: 'session-label' }, h('span', null, 'Label')),
        h('div', { class: 'value-row repo-row-field' }, labelInput),
        bad && h('p', { class: 'form-error', role: 'alert' }, bad),
        h('div', { class: 'set-actions' },
          h('button', {
            type: 'button', class: 'btn btn-open', disabled: Boolean(bad) || typed === t.label || busy.has(GITHUB),
            onclick: () => saveTriggers({ label: typed }, (n) => `Saved. The ${n.label} label starts sessions on ${view.repo} from now on; issues with the old one are not picked up again.`),
          }, busy.has(GITHUB) ? 'Saving…' : 'Save'),
          h('button', {
            type: 'button', class: 'btn btn-quiet', disabled: !t.labelSet || busy.has(GITHUB), title: t.labelSet ? `Back to the console's label, ${t.consoleLabel}` : null,
            onclick: () => saveTriggers({ label: null }, (n) => `Back to the console's label, ${n.label}.`),
          }, 'Use the console\'s')),
        note(GITHUB),
        h('p', { class: 'sub' }, 'GitHub matches any case. It must not be this repo\'s QA label. Make it on the repo\'s Labels page so people can pick it.')));
  }

  // The channel's state in words: where the next pull request goes.
  function slackNow(slack) {
    if (slack.channel) return `Posting to ${slack.channel}.`;
    if (slack.consoleChannel) return `Posting to the console's channel, ${slack.consoleChannel}.`;
    return 'Nothing is posted: neither this repo nor the console has a channel.';
  }

  // Saved through the Repos card's API, which answers with Settings' view: the repo's channel is in its row.
  function saveChannel(channel) {
    return act(SLACK, async () => {
      const answer = await W.postJson('/api/console-settings/projects/slack-channel', { name: view.project, channel });
      const own = answer.projects?.find((p) => p.name === view.project)?.slackChannel ?? channel;
      view = { ...view, slack: { ...view.slack, channel: own, consoleChannel: answer.slack?.channel ?? view.slack.consoleChannel } };
      // Drawn again on the saved channel, so Save is off until another is picked.
      channelPicker = null;
      if (own) return `Saved. ${view.repo}'s next pull request goes to ${own}. Invite the bot to it first.`;
      return view.slack.consoleChannel ? `Cleared. ${view.repo}'s next pull request goes to the console's channel, ${view.slack.consoleChannel}.`
        : 'Cleared. The console has no channel either, so nothing is posted.';
    });
  }

  function slackGroup() {
    const slack = view.slack;
    const title = 'Pull request channel';
    // With no Slack there is nothing to open: the row says why.
    if (!slack?.canPost) {
      return group({ id: 'slack-group', label: 'Slack' }, row({
        id: SLACK_ROW, title, value: 'This console has no Slack, so it posts nothing and a channel cannot be set here.', pill: h('span', { class: 'pill' }, 'Off'),
      }));
    }
    const saved = slack.channel ?? '';
    // The picker reads the channels when it is made, so only once its row is open.
    const isOpen = open.has(SLACK_ROW);
    if (isOpen && !channelPicker) channelPicker = W.slackChannelPicker({ value: saved, id: 'slack-channel', onChange: () => render() });
    const picked = channelPicker ? channelPicker.value().trim() : saved;
    const bad = channelPicker?.problem() ?? null;
    const consoleLink = h('a', { href: '/console-settings#card-slack' }, 'Settings\' Slack card');
    const pill = saved ? h('span', { class: 'pill is-ok' }, 'Own channel')
      : slack.consoleChannel ? h('span', { class: 'pill' }, 'Console\'s channel')
        : h('span', { class: 'pill is-warn' }, 'Nothing posted');
    return group({ id: 'slack-group', label: 'Slack' }, row({ id: SLACK_ROW, title, value: slackNow(slack), pill, opens: true },
      isOpen && [
        h('p', { class: 'sub' }, 'A shared session\'s pull request is posted here once review and checks pass. With no channel here, it goes to the channel on ', consoleLink, '.'),
        h('label', { class: 'field-label', for: 'slack-channel' }, h('span', null, 'This repo\'s channel')),
        channelPicker.el,
        bad && h('p', { class: 'form-error', role: 'alert' }, bad),
        h('div', { class: 'set-actions' },
          h('button', { type: 'button', class: 'btn btn-open', disabled: Boolean(bad) || picked === saved || busy.has(SLACK), onclick: () => saveChannel(picked) }, busy.has(SLACK) ? 'Saving…' : 'Save'),
          h('button', { type: 'button', class: 'btn btn-quiet', disabled: !saved || busy.has(SLACK), title: saved ? 'Back to the console\'s channel' : null, onclick: () => saveChannel('') }, 'Clear')),
        note(SLACK),
        h('p', { class: 'sub' }, 'A question asked in Slack is answered in its own thread. A My Woodshed pull request is never posted.'),
      ]));
  }

  function page(...body) {
    return h('div', { class: 'page settings-page' }, life.nav('/console-settings'),
      h('header', { class: 'page-head' },
        h('div', null,
          h('p', { class: 'crumb' }, h('a', { href: '/console-settings#card-projects' }, '‹ Settings · Repos')),
          h('h1', { class: 'title' }, view?.repo ?? project),
          h('p', { class: 'sub' }, view
            ? [h('span', { class: 'rref' }, view.project), view.default ? ' · the default project. ' : '. ', 'Env files and the prompt for every shared session. Only admins can change these. Yours are on ', h('a', { href: '/settings#repo-settings' }, 'My settings'), '.']
            : 'Repo settings'))),
      body);
  }

  function loadFailed() {
    const words = loadError.status === 403 ? 'Only an admin can open a repo\'s settings. Ask one to change them for you.'
      : loadError.status === 404 ? `${loadError.message} Repos in Settings lists the ones there are.`
        : `Could not load the repo's settings: ${loadError.message}`;
    return h('p', { class: loadError.status === 403 ? 'cap-note' : 'form-error', role: 'alert' }, words);
  }

  // A redraw replaces the page; the editors are the same nodes, so the one being typed in keeps its caret.
  function render() {
    const focused = document.activeElement;
    let caret = null;
    try { caret = [focused.selectionStart, focused.selectionEnd]; } catch { /* nothing focused */ }
    saveButtons.clear();
    if (!view) {
      app.replaceChildren(page(loadError ? loadFailed() : h('p', { class: 'empty' }, 'Loading the repo\'s settings…')));
      return;
    }
    draw(app, page(
      !view.available && h('p', { class: 'cap-note', role: 'status' }, 'This console has no secret store, so nothing can be saved here. Choose one on Secrets & webhooks.'),
      envGroup(),
      promptGroup(),
      githubGroup(),
      slackGroup(),
      hostGroups()));
    // A script loaded once listens on the document, or for this: the program's groups were drawn anew, and are in the page.
    if (hostRedrawn) {
      hostRedrawn = false;
      window.dispatchEvent(new CustomEvent('woodshed:host-groups', { detail: { node: hostNode } }));
    }
    for (const key of editors.keys()) updateCounts(key);
    if (focused && focused === document.activeElement) {
      try { if (caret?.[0] !== undefined && caret?.[0] !== null) focused.setSelectionRange(...caret); } catch { /* not a text field */ }
    }
  }

  // A program's own groups for the repo (its `repoPage` hook, settingsMarkup.mjs), after the console's: its markup, put
  // in as a template's so no <script> in it runs, its rows opened by hostRows.js. The same node until the markup changes, so
  // a redraw for the console's groups keeps the program's rows as they were opened, and what is typed in its forms. The
  // scripts it names (paths on the console's address) are loaded once, after its groups are first drawn.
  let hostNode = null;
  let hostText = null;
  let hostRedrawn = false;
  const hostScripts = repoPageScripts;
  function hostGroups() {
    if (!view.host?.html) return null;
    if (view.host.html !== hostText) {
      const template = document.createElement('template');
      template.innerHTML = view.host.html;
      hostNode = h('div', { class: 'host-groups' });
      hostNode.append(template.content);
      hostText = view.host.html;
      // A link that names one of its rows opens it: readOpened, once the page is drawn.
      window.WoodshedHostRows?.wire(hostNode, { hash: false });
      for (const src of view.host.scripts ?? []) {
        if (hostScripts.has(src)) continue;
        hostScripts.add(src);
        hostNode.append(h('script', { src }));
      }
      hostRedrawn = true;
    }
    return hostNode;
  }

  // The search, or a link followed while the page is shown, opens a row without its head being pressed: the
  // instructions are read then too.
  function readOpened() {
    if (hostNode) window.WoodshedHostRows?.reveal(hostNode, location.hash.slice(1));
    if (location.hash === GITHUB && view && !open.has(LABEL_ROW)) {
      open.add(LABEL_ROW);
      render();
    }
    if (open.has(INSTRUCTIONS_ROW)) readInstructions();
  }

  async function load() {
    try {
      view = await W.getJson(base);
      loadError = null;
    } catch (err) {
      loadError = err;
    }
    render();
    if (!view) return;
    // The row or group a link named (?file=, #slack, #github) is brought into view once it is drawn.
    const named = location.hash ? location.hash.slice(1) : asked && fileRow(asked);
    if (named) document.getElementById(named)?.scrollIntoView?.({ block: 'start' });
    readOpened();
  }

  follow(life);
  life.on(window, 'woodshed:settings-reveal', readOpened);
  life.on(window, 'hashchange', readOpened);
  load();
});
