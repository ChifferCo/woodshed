// A repo's settings on Console settings (/console-settings/repos/<project>): for each env file of its project file, the
// repo's defaults, this installation's values, what the session sets itself, and which of them a session gets for each
// key; then the installation's instructions, how its sessions start from GitHub (its label and switches), and the Slack
// channel its pull requests are posted to. Admins only: the
// API refuses anyone else, and the page says so. Values stay hidden until Show, as on Secrets & webhooks, and never
// reach the table, which names keys alone. ?file=<key> opens one env file's tab, and #slack the Slack card, so a link
// can point at them.
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
  const SLACK = '#slack';
  // As slack.mjs checks it: a channel's name would be refused by Slack as channel_not_found.
  const CHANNEL_RE = /^[CG][A-Z0-9]{8,}$/;
  // The Slack channel field, made once like the editors, so what is typed and the caret survive a redraw.
  let channelInput = null;
  const GITHUB = '#github';
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
      pathsOf(f).length > 1 && L.sharedNote(f),
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
      h('p', { class: 'sub' }, 'Each env file a session writes is the repo\'s defaults, then this installation\'s values, then a person\'s own (in their private sessions), then the session\'s overrides, what it sets itself. A later line wins.'),
      !view.projectFile.read && h('p', { class: 'cap-note', role: 'status' }, `The project file could not be read (${view.projectFile.error}), so only the saved values are listed. They cannot be saved again until it can be read.`),
      files.length > 1 && h('div', { class: 'file-tabs', role: 'group', 'aria-label': 'Env file' }, files.map((x) => h('button', {
        type: 'button', 'aria-pressed': String(x.key === fileKey), onclick: () => openFile(x.key),
      }, labelOf(x), x.installation ? ' •' : ''))),
      f ? envFilePanel(f) : noEnvFiles(),
      view.unnamed.length > 0 && [
        h('div', { class: 'sub-head' }, 'No longer in the project file', h('span', { class: 'count' }, view.unnamed.length)),
        h('div', { class: 'data-list' }, view.unnamed.map(unnamedRow)),
      ],
      note('unnamed'));
  }

  // How to add an env file, where the project file has none: its key comes from its path, so it needs no secret.
  function noEnvFiles() {
    if (!view.projectFile.read) return h('p', { class: 'sub' }, 'No values are saved.');
    const projectFile = h('a', { href: L.githubFile(view.repo, '.woodshed/project.yaml'), target: '_blank', rel: 'noopener' }, '.woodshed/project.yaml ↗');
    return h('div', { class: 'layered', id: 'no-env-files' },
      h('div', { class: 'layer' },
        h('div', { class: 'layer-head' }, h('h3', null, 'This repo has no env files yet')),
        h('ol', { class: 'cmd-steps' },
          h('li', null, h('p', null, 'In a pull request, add an ', h('code', null, 'envFiles'), ' entry to ', projectFile, ':'),
            h('pre', { class: 'layer-pre' }, 'envFiles:\n  - path: api/.env\n    defaults:        # optional\n      - LOG_LEVEL=info')),
          h('li', null, h('p', null, 'No ', h('code', null, 'secret'), ' is needed: the file\'s key comes from its path (', h('code', null, 'api/.env'), ' is ', h('code', null, 'api-env'), ').')),
          h('li', null, h('p', null, 'Once it is on the default branch, a tab for it appears here, to set this installation\'s values.'))),
        h('p', { class: 'sub' }, 'Every field is in Woodshed\'s ', h('code', null, 'docs/reference.md'), ', "The project file".')));
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

  // The channel's state in words: where the next pull request goes.
  function labelProblem(raw) {
    if (raw.trim() === '') return null;
    if ([...raw.trim()].length > LABEL_MAX) return `GitHub takes labels of at most ${LABEL_MAX} characters.`;
    if (raw.includes(',')) return 'A label cannot have a comma in it.';
    return null;
  }

  // Saved through the Repos card's API, which answers with the repo's label and switches. Each switch applies as it is
  // turned, as the console's other switches do; the label waits for Save.
  function saveTriggers(change, said) {
    return act(GITHUB, async () => {
      const answer = await W.postJson('/api/console-settings/projects/triggers', { name: view.project, ...change });
      view = { ...view, triggers: answer.triggers };
      if (change.label !== undefined) labelInput.value = answer.triggers.label;
      return said(answer.triggers);
    });
  }

  function triggerSwitch({ id, on, label, onText, offText, change }) {
    return h('div', { class: `toggle-row${on ? '' : ' is-off'}` },
      h('button', {
        type: 'button', class: 'switch-ui', role: 'switch', 'aria-checked': String(on), 'aria-labelledby': id, disabled: busy.has(GITHUB),
        onclick: () => saveTriggers(change(!on), () => null),
      }),
      h('span', { class: 'toggle-label', id }, label),
      h('p', { class: 'sub' }, on ? onText : offText));
  }

  function githubCard() {
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
    return h('section', { class: 'settings-card', id: 'github', 'aria-labelledby': 'card-github' },
      h('h2', { id: 'card-github', class: 'label' }, 'Sessions from GitHub'),
      h('p', { class: 'sub' }, `How a shared session on ${view.repo} starts from GitHub. Someone with write access and Sessions from GitHub on People adds the label to an issue, or comments `, code('/woodshed …'), ' on an issue or pull request. A label or comment turned off here is ignored and logged; nothing is posted on the issue.'),
      h('div', { class: 'webhook-switches' },
        triggerSwitch({
          id: 'switch-labels', on: t.labels, label: 'Start sessions from the label', change: (on) => ({ labels: on }),
          onText: ['On: the ', code(t.label), ' label on an issue starts a session, or resumes the one it had.'],
          offText: ['Off: the ', code(t.label), ' label does nothing on this repo.'],
        }),
        triggerSwitch({
          id: 'switch-comments', on: t.comments, label: '/woodshed comments', change: (on) => ({ comments: on }),
          onText: ['On: ', code('/woodshed …'), ' on an issue or pull request starts a session, resumes it, or types the message into a running one.'],
          offText: ['Off: ', code('/woodshed …'), ' comments do nothing on this repo, including on the sessions it already has.'],
        })),
      h('div', { class: 'layered' },
        h('div', { class: 'layer' },
          h('div', { class: 'layer-head' }, h('h3', null, h('label', { for: 'session-label' }, 'The label\'s name'))),
          h('p', { class: 'layer-meta' }, t.labelSet ? `This repo's own. The console's is ${t.consoleLabel}.` : `The console's, ${t.consoleLabel}.`),
          h('div', { class: 'value-row' }, labelInput),
          bad && h('p', { class: 'form-error', role: 'alert' }, bad),
          h('div', { class: 'card-foot' },
            h('button', {
              type: 'button', class: 'btn btn-open', disabled: Boolean(bad) || typed === t.label || busy.has(GITHUB),
              onclick: () => saveTriggers({ label: typed }, (n) => `Saved. The ${n.label} label starts sessions on ${view.repo} from now on; issues with the old one are not picked up again.`),
            }, busy.has(GITHUB) ? 'Saving…' : 'Save'),
            h('button', {
              type: 'button', class: 'btn btn-quiet', disabled: !t.labelSet || busy.has(GITHUB), title: t.labelSet ? `Back to the console's label, ${t.consoleLabel}` : null,
              onclick: () => saveTriggers({ label: null }, (n) => `Back to the console's label, ${n.label}.`),
            }, 'Use the console\'s')),
          note(GITHUB),
          h('p', { class: 'sub' }, 'GitHub matches it whatever its case. It must not be the repo\'s QA label (its project file\'s ', code('pullRequests.qa.label'), '). Make the label on the repo\'s Labels page on GitHub, so people can pick it.'))));
  }

  function slackNow(slack) {
    if (slack.channel) return `Posting to ${slack.channel}.`;
    if (slack.consoleChannel) return `Posting to the console's channel, ${slack.consoleChannel}.`;
    return 'Nothing is posted: neither this repo nor the console has a channel.';
  }

  function channelProblem(raw) {
    return raw && !CHANNEL_RE.test(raw) ? 'Give the channel\'s ID, such as C0123456789, not its name.' : null;
  }

  // Saved through the Repos card's API, which answers with Console settings' view: the repo's channel is in its row.
  function saveChannel(channel) {
    return act(SLACK, async () => {
      const answer = await W.postJson('/api/console-settings/projects/slack-channel', { name: view.project, channel });
      const own = answer.projects?.find((p) => p.name === view.project)?.slackChannel ?? channel;
      view = { ...view, slack: { ...view.slack, channel: own, consoleChannel: answer.slack?.channel ?? view.slack.consoleChannel } };
      channelInput.value = own;
      if (own) return `Saved. ${view.repo}'s next pull request goes to ${own}. Invite the bot to it first.`;
      return view.slack.consoleChannel ? `Cleared. ${view.repo}'s next pull request goes to the console's channel, ${view.slack.consoleChannel}.`
        : 'Cleared. The console has no channel either, so nothing is posted.';
    });
  }

  function slackCard() {
    const slack = view.slack;
    const off = !slack?.canPost;
    const saved = slack?.channel ?? '';
    if (!channelInput) {
      channelInput = h('input', {
        id: 'slack-channel', class: 'field is-text is-channel mono', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'C0123456789',
        oninput: () => render(),
      });
      channelInput.value = saved;
    }
    const field = channelInput;
    const raw = field.value;
    const bad = channelProblem(raw.trim());
    field.disabled = off;
    field.readOnly = busy.has(SLACK);
    field.setAttribute('aria-invalid', bad ? 'true' : 'false');
    const consoleLink = h('a', { href: '/console-settings#card-slack' }, 'Console settings\' Slack card');
    return h('section', { class: 'settings-card', id: 'slack', 'aria-labelledby': 'card-slack' },
      h('h2', { id: 'card-slack', class: 'label' }, 'Slack'),
      h('p', { class: 'sub' }, 'When a shared session on this repo opens a pull request, the console posts it to this channel once its review and checks pass, with its decision brief and a mention of whoever has the session in the post\'s thread. With no channel here, it goes to the channel on ', consoleLink, '.'),
      off && h('p', { class: 'cap-note', role: 'status' }, 'This console has no Slack, so it posts nothing and a channel cannot be set here.'),
      h('div', { class: 'layered' },
        h('div', { class: 'layer' },
          h('div', { class: 'layer-head' }, h('h3', null, h('label', { for: 'slack-channel' }, 'This repo\'s channel ID'))),
          !off && h('p', { class: 'layer-meta' }, slackNow(slack)),
          h('div', { class: 'value-row' }, field),
          bad && h('p', { class: 'form-error', role: 'alert' }, bad),
          h('div', { class: 'card-foot' },
            h('button', { type: 'button', class: 'btn btn-open', disabled: off || Boolean(bad) || raw.trim() === saved || busy.has(SLACK), onclick: () => saveChannel(raw.trim()) }, busy.has(SLACK) ? 'Saving…' : 'Save'),
            h('button', { type: 'button', class: 'btn btn-quiet', disabled: off || !saved || busy.has(SLACK), title: saved ? 'Back to the console\'s channel' : null, onclick: () => saveChannel('') }, 'Clear')),
          note(SLACK),
          h('p', { class: 'sub' }, 'The ID, not the name: in Slack, open the channel\'s name at its top, and the ID (C…) is at the bottom of its About tab. Invite the Woodshed bot to the channel first (', h('code', null, '/invite @'), ' and the bot\'s name), or Slack refuses the post.'))),
      h('p', { class: 'sub' }, 'Nothing else uses it: a question asked in Slack is answered in its own thread, the assignee\'s other messages are direct messages, and a My Woodshed session\'s pull request is never posted.'));
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
      instructionsCard(),
      githubCard(),
      slackCard()));
    for (const key of editors.keys()) updateCounts(key);
    if (focused && ([...editors.values()].includes(focused) || focused === channelInput || focused === labelInput)) {
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
    if (view && location.hash === SLACK) channelInput?.scrollIntoView?.({ block: 'center' });
    if (view && location.hash === GITHUB) document.getElementById('github')?.scrollIntoView?.({ block: 'start' });
    if (view?.instructions.installation) await show(INSTRUCTIONS);
  }

  load();
})();
