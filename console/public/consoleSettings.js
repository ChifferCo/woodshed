// The Settings page, as groups of rows that open in place (settingsRows.js): the Woodshed this console runs and its
// webhook switch, applied as it is turned; the repos; the limits and retention numbers, one Save per row; the sessions
// holding data, and anything stalled, with what fixes it; Slack, with its Set up Slack dialog (slackSetup.js), its
// channel and its questions; and the MCP servers. The data list is read again every minute; a row being typed in is
// left alone, so a half-typed change survives.
window.Woodshed.settingsPage('/console-settings', (app, life) => {
  'use strict';
  const W = window.Woodshed;
  const { h } = W;
  const DATA_REFRESH_MS = 60_000;
  // Which rows are open is kept for the page's life, since it is drawn again on each answer.
  const { open, row, line, group, follow, reveal } = window.WoodshedSettingsRows.create({ render });
  // The numbers, in the blocks they are saved by: a block is one row's fields and its Save. The two limits on how many
  // run at once are a row of their own; whatever else the sessions group holds is its timeouts.
  const RUNNING_KEYS = ['maxRunning', 'maxPrivatePerPerson'];
  const BLOCKS = {
    running: (s) => s.group === 'sessions' && RUNNING_KEYS.includes(s.key),
    timeouts: (s) => s.group === 'sessions' && !RUNNING_KEYS.includes(s.key),
    retention: (s) => s.group === 'retention',
    slack: (s) => s.group === 'slack',
    questions: (s) => s.group === 'questions',
  };
  const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
  const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

  let data = null;
  let loadError = null;
  // What has been typed into each field, by setting key, until it is saved or reloaded.
  const typed = new Map();
  // What the last save of each block of numbers said: {text, bad}.
  const notices = new Map();
  // Each block or row whose save is on its way, so a second click does not send it twice.
  const saving = new Set();
  // What the last Remove on a repo's row said, by project name, until the page is drawn again.
  const rowNotes = new Map();

  // These saves have no typed confirm: each is undone by changing it back, and is logged with who made it. The typed
  // confirm (W.confirmChange) is kept for what cannot be undone: a held session's data, secrets, a restore.

  function problem(s, raw) {
    const value = Number(String(raw).trim());
    if (String(raw).trim() === '' || !Number.isFinite(value)) return 'Give a number.';
    if (value < s.min || value > s.max) return `Must be from ${s.min} to ${s.max} ${s.unit}.`;
    if (Math.abs(Math.round(value / s.step) * s.step - value) > 1e-9) return `Goes in steps of ${s.step} ${s.unit}.`;
    return null;
  }

  const settingsOf = (block) => data.settings.filter(BLOCKS[block]);
  const settingOf = (key) => data.settings.find((s) => s.key === key) ?? null;
  // A saved value with its unit, as a closed row says it: "1 hour", "14 days". Null for a setting the console has not.
  function qty(key, { unit = true } = {}) {
    const s = settingOf(key);
    if (!s) return null;
    return unit ? `${s.value} ${s.value === 1 ? s.unit.replace(/s$/, '') : s.unit}` : String(s.value);
  }

  // The fields of a block that differ from what is saved, and whether any of them is no good.
  function pending(block) {
    const changes = [];
    let bad = false;
    for (const s of settingsOf(block)) {
      if (!typed.has(s.key)) continue;
      const raw = typed.get(s.key);
      if (problem(s, raw)) bad = true;
      else if (Number(raw) !== s.value) changes.push({ key: s.key, label: s.label, from: `${s.value} ${s.unit}`, to: `${Number(raw)} ${s.unit}`, value: Number(raw) });
    }
    return { changes, bad };
  }

  function settingRow(s) {
    const raw = typed.has(s.key) ? typed.get(s.key) : String(s.value);
    const bad = typed.has(s.key) ? problem(s, raw) : null;
    const changed = !bad && Number(raw) !== s.value;
    return h('div', { class: `set-row${changed ? ' is-changed' : ''}${bad ? ' is-bad' : ''}` },
      h('div', null,
        h('label', { class: 'set-name', for: `set-${s.key}` }, s.label),
        h('div', { class: 'set-help' }, s.help),
        h('div', { class: 'set-bounds' }, `${s.min} to ${s.max} ${s.unit} · default ${s.defaultValue}`)),
      h('div', { class: 'set-value' },
        h('input', {
          id: `set-${s.key}`, class: 'field', type: 'text', inputmode: 'decimal', autocomplete: 'off', value: raw,
          'aria-invalid': bad ? 'true' : null,
          oninput: (e) => { typed.set(s.key, e.target.value); render(); },
        }),
        h('span', { class: 'unit' }, s.unit)),
      bad && h('p', { class: 'form-error', role: 'alert' }, bad));
  }

  // Only what changed is sent, so a row's Save never touches another row's numbers.
  async function save(block) {
    const { changes } = pending(block);
    if (saving.has(block) || !changes.length) return;
    saving.add(block);
    render();
    try {
      const values = Object.fromEntries(changes.map((c) => [c.key, c.value]));
      data = { ...data, ...(await W.postJson('/api/console-settings', { values })) };
      for (const c of changes) typed.delete(c.key);
      notices.set(block, { text: `Saved. ${changes.map((c) => `${c.label}: ${c.from} → ${c.to}`).join('; ')}. Applies on the next check, with no restart.` });
    } catch (err) {
      notices.set(block, { text: err.message, bad: true });
    }
    saving.delete(block);
    render();
  }

  // A block's fields and their Save: the body of a row of numbers, or a Slack row's Limits.
  function settingsBlock(block) {
    const { changes, bad } = pending(block);
    return [
      h('div', { class: 'set-rows' }, settingsOf(block).map(settingRow)),
      h('div', { class: 'card-foot' },
        h('button', { type: 'button', class: 'btn btn-open', disabled: bad || !changes.length || saving.has(block), onclick: () => save(block) },
          saving.has(block) ? 'Saving…' : changes.length > 1 ? `Save ${changes.length} changes` : 'Save'),
        notices.get(block)?.bad && !bad
          ? h('span', { class: 'form-error', role: 'alert' }, notices.get(block).text)
          : h('span', { class: 'sub', role: 'status' }, bad ? 'Fix the value in red first.'
            : changes.length ? `${changes.length} changed. Takes effect on the next check, with no restart.`
              : notices.get(block)?.text || 'Saved values. Each change is logged with who made it.')),
    ];
  }

  // What a closed row of numbers says of itself: Not saved while something typed waits for its Save, else whether any
  // of its numbers differs from the default.
  function unsavedPill(block) {
    const { changes, bad } = pending(block);
    return bad || changes.length ? h('span', { class: 'pill is-warn' }, 'Not saved') : null;
  }

  function blockPill(block) {
    if (unsavedPill(block)) return unsavedPill(block);
    return settingsOf(block).every((s) => s.value === s.defaultValue) ? h('span', { class: 'pill' }, 'Defaults') : h('span', { class: 'pill is-ok' }, 'Changed');
  }

  /** A row of numbers with its own Save. None where the console names no setting for it. */
  function numbersRow({ id, title, block, value }, ...intro) {
    if (!settingsOf(block).length) return null;
    return row({ id, title, value: value.filter(Boolean).join(' · '), pill: blockPill(block) }, intro, settingsBlock(block));
  }

  function sessionRows() {
    const n = (key, words) => { const s = settingOf(key); return s && `${s.value} ${words(s.value === 1)}`; };
    return [
      numbersRow({
        id: 'sessions-running', title: 'Running at once', block: 'running',
        value: [n('maxRunning', (one) => (one ? 'shared session' : 'shared sessions')), n('maxPrivatePerPerson', (one) => `My Woodshed ${one ? 'session' : 'sessions'} per person`)],
      }, W.providerWords.capacityNote && h('p', { class: 'cap-note' }, W.providerWords.capacityNote)),
      numbersRow({
        id: 'sessions-timeouts', title: 'Timeouts', block: 'timeouts',
        value: [qty('idleHours') && `Pause after ${qty('idleHours')} waiting for input`, qty('lifetimeHours') && `stop after ${qty('lifetimeHours')} working`],
      }, h('p', { class: 'sub' }, 'When a shared session stops by itself. Its work is pushed first, and Resume picks it up where it was.')),
    ];
  }

  function retentionRow() {
    return numbersRow({
      id: 'card-retention', title: 'Retention', block: 'retention',
      value: [
        qty('keepAfterCloseDays') && `Deleted ${qty('keepAfterCloseDays')} after merge`, qty('keepOpenPrDays') && `${qty('keepOpenPrDays')} with a PR still open`,
        qty('keepWithoutPrDays') && `${qty('keepWithoutPrDays')} with none`, qty('removeDeletedDays') && `off the list after ${qty('removeDeletedDays')}`,
      ],
    }, h('p', { class: 'sub' }, 'How long a stopped shared session keeps its conversation and databases, so it can be resumed. After that the branch alone stays, on GitHub, and the card says Deleted until it is taken off the list.'));
  }

  // The repos sessions can start on: the installation's own (read-only here), and the ones added on this page.
  // `error` is {message, link?}: the server's refusal, shown under the field with the page that fixes it. `typing` is
  // true once Another repo is picked from the list: the field then takes owner/name typed in.
  const repoForm = { repo: '', name: '', error: null, notice: null, busy: false, typing: false };
  // The list's last option, which swaps it for the field: a value no repo can have.
  const TYPE_ONE = ':type';
  // What Add a repo offers (GET /api/console-settings/projects/repos): `repos` the App may reach and that are not
  // projects yet, `grant` each account's installation settings on GitHub, `install` the App's install page. `repos` is
  // null where the console has no App, and the whole of it null until read or when GitHub did not answer: the field
  // then takes owner/name typed in.
  let repoChoices = null;
  let repoChoicesError = null;
  // What the last colour pick said, by project name, until the page is drawn for another reason.
  const colorNotes = new Map();

  // The repo's colour on the rail: a radio per palette colour, saved as soon as one is picked. A colour another repo
  // has is disabled, since two repos never share one.
  function colorPicker(p) {
    const palette = data.palette ?? [];
    const taken = new Map(data.projects.filter((o) => o.name !== p.name && o.color).map((o) => [o.color, o.name]));
    const note = colorNotes.get(p.name);
    return h('div', { class: 'proj-colors' },
      h('fieldset', { class: 'proj-swatches' },
        h('legend', { class: 'sr-only' }, `Colour of ${p.name} on the rail`),
        palette.map((key) => h('label', { class: `proj-pick proj-${key}`, title: taken.has(key) ? `${key}, ${taken.get(key)}'s` : key },
          h('input', {
            type: 'radio', name: `color-${p.name}`, value: key, checked: p.color === key, disabled: taken.has(key),
            'aria-label': taken.has(key) ? `${key}, ${taken.get(key)}'s` : key,
            onchange: () => pickColor(p, key),
          }),
          h('span', { 'aria-hidden': 'true' })))),
      h('span', { class: 'proj-name' }, p.color ? `${p.color} on the rail` : 'no colour left: the palette has six'),
      note && h('span', { class: note.bad ? 'form-error' : 'sub', role: 'status' }, note.text));
  }

  async function pickColor(p, key) {
    try {
      data = { ...data, ...(await W.postJson('/api/console-settings/projects/color', { name: p.name, color: key })) };
      colorNotes.set(p.name, { text: 'Saved.' });
    } catch (err) {
      colorNotes.set(p.name, { text: err.message, bad: true });
    }
    render();
    document.querySelector(`input[name="color-${CSS.escape(p.name)}"]:checked`)?.focus();
  }

  // One repo: the closed row says whether sessions can start on it, how it got here, what it holds and where its pull
  // requests go; opened, it has what is changed here (its colour, Remove) and the way to its own settings page.
  function projectRow(p) {
    const live = p.sessions ? `${p.sessions} ${p.sessions === 1 ? 'session' : 'sessions'} running or kept` : 'no sessions running';
    const how = p.default ? 'Default project' : p.source === 'host' ? 'Added' : p.removable ? `Added by @${p.addedBy || 'unknown'}` : 'Set in the installation\'s configuration';
    const prs = data.slack ? (p.slackChannel ? `PRs to ${p.slackChannel}` : 'PRs to the console\'s channel') : null;
    const href = `/console-settings/repos/${encodeURIComponent(p.name)}`;
    const id = `repo-${p.name}`;
    const note = rowNotes.get(p.name);
    return row({
      id,
      title: [data.palette && p.color && h('span', { class: `proj-dot proj-${p.color}`, 'aria-hidden': 'true' }), p.repo, ' ', h('span', { class: 'rref' }, p.name)],
      value: [how, live, prs].filter(Boolean).join(' · '),
      // Whether sessions can start on it (databaseGate.mjs): a word, never a colour alone.
      pill: p.blocker ? h('span', { class: 'pill is-warn' }, 'Needs setup') : p.blocker === null ? h('span', { class: 'pill is-ok' }, 'Ready') : null,
    },
      p.blocker && W.blockerCard(p.blocker, { head: false, admin: true }),
      h('div', { class: 'set-rows' },
        p.default && h('div', { class: 'set-row' }, h('div', null,
          h('div', { class: 'set-name' }, 'Default project'),
          h('div', { class: 'set-help' }, 'Questions from Slack use it.'))),
        data.palette && h('div', { class: 'set-row' },
          h('div', null,
            h('div', { class: 'set-name' }, 'Colour on the rail'),
            h('div', { class: 'set-help' }, 'Marks its sessions on the rail. Saved as it is picked; a colour another repo has cannot be picked.')),
          h('div', { class: 'set-value' }, colorPicker(p))),
        h('div', { class: 'set-row' },
          h('div', null,
            h('div', { class: 'set-name' }, data.slack ? 'Env files, instructions, sessions from GitHub, Slack channel' : 'Env files, instructions, sessions from GitHub'),
            data.slack && h('div', { class: 'set-help' }, h('a', { href: `${href}#slack`, title: 'Change it on the repo\'s Settings' }, prs))),
          h('div', { class: 'set-value' },
            h('a', { class: 'btn btn-plain', href, 'aria-label': `Settings of ${p.repo}: env files, instructions and Slack channel` }, 'Repo settings ›')))),
      // One the installation's configuration sets, or the program that runs this console keeps, is removed there.
      (p.removable || p.source !== 'host') && h('div', { class: 'card-foot' },
        p.removable && h('button', {
          type: 'button', class: 'btn btn-danger', disabled: p.sessions > 0 || saving.has(`row:${p.name}`), title: p.sessions ? 'Stop or delete its sessions first' : null,
          onclick: () => rowAction(p, async () => {
            data = { ...data, ...(await W.postJson('/api/console-settings/projects/remove', { name: p.name })) };
            loadRepoChoices();
            // Said on Add a repo, which undoes it: the repo's own row is gone.
            open.delete(id);
            open.add('repos-add');
            repoForm.error = null;
            repoForm.notice = `${p.repo} removed: new sessions can no longer start on it. Its pull requests and branches on GitHub are not touched. Add it again to undo.`;
            return null;
          }),
        }, 'Remove'),
        note ? h('span', { class: note.bad ? 'form-error' : 'sub', role: note.bad ? 'alert' : 'status' }, note.text)
          : h('span', { class: 'sub' }, !p.removable ? 'Set in the installation\'s configuration, so it is removed there.'
            : p.sessions ? `Stop or delete its ${p.sessions === 1 ? 'session' : `${p.sessions} sessions`} first.`
              : 'Remove: new sessions can no longer start on it. Its pull requests and branches on GitHub are not touched.')));
  }

  // A save on a repo's row: `run` returns what to say on the row, or throws the console's refusal.
  async function rowAction(p, run) {
    const key = `row:${p.name}`;
    if (saving.has(key)) return;
    saving.add(key);
    rowNotes.delete(p.name);
    try {
      const said = await run();
      if (said) rowNotes.set(p.name, { text: said });
    } catch (err) {
      rowNotes.set(p.name, { text: err.message, bad: true });
    }
    saving.delete(key);
    render();
  }

  // No typed confirm: an added repo is taken off again with Remove, and the console checks it with GitHub first.
  async function addRepo() {
    if (repoForm.busy) return;
    // A pasted link is read the way the server reads it (addedProjects.mjs).
    const repo = repoForm.repo.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '').replace(/\.git$/, '');
    const name = repoForm.name.trim();
    if (!REPO_RE.test(repo)) {
      repoForm.error = { message: listing() ? 'Choose a repo first.' : 'Give the repo as owner/name, such as acme/api.' };
      render();
      return;
    }
    if (name && !NAME_RE.test(name)) { repoForm.error = { message: 'The name is lowercase letters and digits, in words joined by single dashes.' }; render(); return; }
    repoForm.error = null;
    repoForm.notice = null;
    repoForm.busy = true;
    render();
    try {
      data = { ...data, ...(await W.postJson('/api/console-settings/projects', { repo, name })) };
      repoForm.repo = '';
      repoForm.name = '';
      repoForm.typing = false;
      repoForm.notice = `${repo} added: sessions can start on it now. Remove takes it off again.`;
      loadRepoChoices();
    } catch (err) {
      repoForm.error = err;
    }
    repoForm.busy = false;
    render();
  }

  // Whether there is a list to pick from, and whether the list (not the typed field) is showing.
  const picking = () => Array.isArray(repoChoices?.repos);
  const listing = () => picking() && !repoForm.typing;

  // The repos on offer, then Another repo, for one not listed: typed in, the console checks it and says where on
  // GitHub to give the App access when it cannot reach it.
  function repoSelect() {
    const repos = repoChoices.repos;
    return h('select', {
      id: 'repo-new', class: 'field is-repo', 'aria-invalid': repoForm.error ? 'true' : null,
      onchange: (e) => {
        if (e.target.value !== TYPE_ONE) {
          repoForm.repo = e.target.value;
          return;
        }
        repoForm.typing = true;
        repoForm.repo = '';
        render();
        document.getElementById('repo-new')?.focus();
      },
    },
    h('option', { value: '', selected: !repoForm.repo }, repos.length ? 'Choose a repo' : 'No repo left in the list'),
    repos.map((r) => h('option', { value: r.repo, selected: r.repo === repoForm.repo }, r.private ? `${r.repo} (private)` : r.repo)),
    h('option', { value: TYPE_ONE }, 'Another repo: type owner/name'));
  }

  function repoField() {
    return h('input', {
      id: 'repo-new', class: 'field is-text', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'owner/name', value: repoForm.repo,
      'aria-invalid': repoForm.error ? 'true' : null,
      oninput: (e) => { repoForm.repo = e.target.value; },
      onkeydown: (e) => { if (e.key === 'Enter') addRepo(); },
    });
  }

  // Back from the typed field to the list, where there is one.
  function backToList() {
    if (!picking() || !repoForm.typing) return null;
    return h('button', {
      type: 'button', class: 'btn btn-quiet btn-sm',
      onclick: () => {
        repoForm.typing = false;
        repoForm.repo = '';
        render();
        document.getElementById('repo-new')?.focus();
      },
    }, 'Choose from the list');
  }

  // Where the App is given more repos: each account's installation settings, or the App's install page for another
  // account. A repo granted there shows here once the list is read again, on List again or when the tab comes back.
  // Shown with the typed field too: a repo typed in that the App cannot reach is given to it there.
  function repoAccessNote() {
    const ext = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, `${text} ↗`);
    const again = h('button', { type: 'button', class: 'btn btn-quiet btn-sm', onclick: () => loadRepoChoices() }, 'List again');
    if (repoChoicesError) return h('p', { class: 'sub', role: 'status', style: 'grid-column: 1 / -1; margin: 0' }, repoChoicesError, ' ', again);
    if (!picking()) return null;
    const { grant, install } = repoChoices;
    if (!grant.length && !install) return null;
    const parts = [];
    grant.forEach((g, i) => parts.push(i ? ', ' : '', ext(g.href, g.account)));
    return h('p', { class: 'sub', style: 'grid-column: 1 / -1; margin: 0' },
      'Not listed? ',
      grant.length ? ['Give the App access to it on GitHub: ', parts, install ? ['; or ', ext(install, 'install it on another account')] : null]
        : ext(install, 'Install the App on the repo\'s account'),
      '. Then ', again);
  }

  async function loadRepoChoices() {
    try {
      const got = await W.getJson('/api/console-settings/projects/repos');
      repoChoices = got && (Array.isArray(got.repos) || got.repos === null) ? got : null;
      repoChoicesError = null;
      // The pick is kept only while it is still on offer.
      if (listing() && repoForm.repo && !repoChoices.repos.some((r) => r.repo === repoForm.repo)) repoForm.repo = '';
    } catch (err) {
      repoChoices = null;
      repoChoicesError = err.message;
    }
    if (data) render();
  }

  // Add a repo, the group's last row: open by itself while the console has none.
  function addRepoRow() {
    return row({
      id: 'repos-add', title: 'Add a repo',
      value: listing()
        ? `One of the repos ${repoChoices.via === 'gh' ? 'the console\'s gh login can push to' : 'the GitHub App may reach'}, or another typed as owner/name`
        : 'As owner/name',
    },
      h('div', { class: `set-row${repoForm.error ? ' is-bad' : ''}` },
        h('div', null,
          h('label', { class: 'set-name', for: 'repo-new' }, 'Repo'),
          h('div', { class: 'set-help' }, listing()
            ? `One of the repos ${repoChoices.via === 'gh' ? 'the console\'s gh login can push to' : 'the GitHub App may reach'}, or Another repo to type one in.`
            : 'As owner/name.',
          data.repoNames === false ? ' Sessions show it by the repo\'s own name.' : ' The name sessions show for it is the repo\'s own, unless you give one.')),
        h('div', { class: 'set-value' },
          listing() ? repoSelect() : repoField(),
          backToList(),
          data.repoNames !== false && h('input', {
            id: 'repo-name', class: 'field is-text', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'name (optional)', 'aria-label': 'Name (optional)', value: repoForm.name,
            oninput: (e) => { repoForm.name = e.target.value; },
            onkeydown: (e) => { if (e.key === 'Enter') addRepo(); },
          })),
        repoAccessNote(),
        repoForm.error && h('p', { class: 'form-error', role: 'alert' }, W.errorParts(repoForm.error))),
      h('div', { class: 'card-foot' },
        h('button', { type: 'button', class: 'btn btn-open', disabled: repoForm.busy, onclick: addRepo }, repoForm.busy ? 'Checking with GitHub…' : 'Add repo'),
        h('span', { class: 'sub', role: 'status' }, repoForm.notice || 'It applies at once; Remove takes it off again. Each change is logged with who made it.')));
  }

  function projectsGroup() {
    if (!data.projects) return null;
    return group({
      id: 'card-projects', label: 'Repos',
      note: ['The repos sessions can start on. The default one is what questions from Slack use. Each repo\'s own project file says which databases its sessions need, so each is checked on its own: one that cannot start sessions says Needs setup, with why and how to fix it. ', repoChoices?.via === 'gh' ? 'Sessions push with the console\'s gh login, so it must be able to push to a repo added here.' : 'The GitHub App must be given access to a repo before it is added here.', ' An added repo applies at once, with no restart. With more than one, each repo\'s colour marks its sessions on the rail. A repo\'s own settings page has its env file values, instructions and the Slack channel its pull requests go to.'],
    },
      data.projects.length ? data.projects.map(projectRow)
        : row({ id: 'repos-none', title: 'No repo yet', value: 'So no session can start. The first one added becomes the default.' }),
      addRepoRow());
  }

  // The MCP servers (mcpServers.mjs): what sessions' claude gets through the console's relay, each added, changed and
  // removed at once. A server's row opens on its form, with Test and Remove beside its Save; Add a server is the last
  // row. A server's header value is sent once and never shown again. Read on its own: a console that hands out none
  // answers 404, and the group is left out. Add server and Save test the form with the console first
  // (POST …/mcp-servers/test) and save only once it answered, or on Add anyway.
  let mcp = null;
  // `repos` is '*' or a list of owner/name; `reposOpen` whether its list is unfolded; `busy` 'testing' or 'saving';
  // `failedTest` what the last test of the form said, with Add anyway beside it; `savedProduction` a saved server's
  // kind, which stays on offer on a console that can no longer lock a session down.
  const EMPTY_MCP_FORM = { editing: null, name: '', url: '', production: false, shared: false, people: '*', repos: '*', reposOpen: false, auth: 'none', audience: '', header: 'Authorization', value: '', busy: null, error: null, failedTest: null, notice: null, savedProduction: false };
  // Each open row's form, by the server's name, and Add a server's under ''. A server's form starts again from what is
  // saved each time its row is opened, so closing the row is its Cancel.
  const mcpForms = new Map();
  const AUTH_WORDS = { none: 'Nothing', oidc: 'Signed token', header: 'Header' };
  // What the last Test on a saved server's row said, by name: {text, bad}. Each one testing is in `saving` as test:<name>.
  const mcpRowNotes = new Map();
  const MCP_TEST = '/api/console-settings/mcp-servers/test';

  async function loadMcp() {
    try {
      const answer = await W.getJson('/api/console-settings/mcp-servers');
      mcp = Array.isArray(answer?.servers) && answer.production ? answer : null;
    } catch {
      mcp = null;
    }
  }

  const listText = (list, every) => (list === '*' ? every : list.join(', ') || 'nobody');
  // A header's name as it is usually written: case does not matter in HTTP, and the console keeps it lowercased.
  const headerName = (name) => String(name ?? '').split('-').map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w)).join('-');

  function whoText(s) {
    if (s.production) return `My Woodshed sessions of ${listText(s.people, 'everyone')}`;
    const mine = `My Woodshed sessions of ${listText(s.people, 'everyone')}`;
    return s.shared ? `${mine}, and shared sessions` : mine;
  }

  // What a test that reached the server found, as a sentence's middle: "Reached docs-server 1.2, 12 tools".
  function reachedText(t) {
    const who = t.serverInfo?.name ? `Reached ${t.serverInfo.name}${t.serverInfo.version ? ` ${t.serverInfo.version}` : ''}` : 'Reached the server';
    const tools = typeof t.tools === 'number' ? `, ${t.tools} ${t.tools === 1 ? 'tool' : 'tools'}` : '';
    const ms = typeof t.ms === 'number' ? ` in ${Math.round(t.ms)} ms` : '';
    return `${who}${tools}${ms}`;
  }

  async function testRow(s) {
    const key = `test:${s.name}`;
    if (saving.has(key)) return;
    saving.add(key);
    mcpRowNotes.delete(s.name);
    render();
    try {
      const t = await W.postJson(MCP_TEST, { name: s.name });
      mcpRowNotes.set(s.name, t?.ok ? { text: `${reachedText(t)}.` } : { text: t?.error || 'The server did not answer as an MCP server.', bad: true });
    } catch (err) {
      mcpRowNotes.set(s.name, { text: err.message, bad: true });
    }
    saving.delete(key);
    render();
  }

  function testButton(s) {
    const testing = saving.has(`test:${s.name}`);
    return h('button', { type: 'button', class: 'btn btn-plain', disabled: testing, 'aria-label': `Test ${s.name}`, onclick: () => testRow(s) }, testing ? 'Testing…' : 'Test');
  }

  function testNote(s) {
    const note = mcpRowNotes.get(s.name);
    return note && h('p', { class: note.bad ? 'form-error' : 'sub', role: note.bad ? 'alert' : 'status', style: 'margin: 0' }, note.text);
  }

  const mcpRowId = (name) => `mcp-server-${name}`;

  function formOf(s) {
    return {
      ...EMPTY_MCP_FORM, editing: s.name, name: s.name, url: s.url, production: s.production, shared: s.shared, savedProduction: s.production,
      people: listText(s.people, '*'), repos: s.repos === '*' ? '*' : data.projects ? [...s.repos] : s.repos.join(', '), auth: s.auth, audience: s.audience ?? '', header: headerName(s.header ?? 'authorization'),
    };
  }

  // The form of a saved server's row, or of Add a server with none.
  function mcpFormFor(s) {
    const key = s?.name ?? '';
    if (!mcpForms.has(key)) mcpForms.set(key, s ? formOf(s) : { ...EMPTY_MCP_FORM });
    return mcpForms.get(key);
  }

  // The ids of a form's fields: Add a server's are mcp-<field>, a saved server's carry its name, since both may be open.
  // The two underscores are in no server's name, so one server's field never has another's row or field id.
  const fid = (f, part) => (f.editing ? `${mcpRowId(f.editing)}__${part}` : `mcp-${part}`);

  // One server: the closed row says where it is, who gets it and what the console adds; opened, it is its form. One
  // the installation's configuration sets cannot be changed here, so its row has Test alone.
  function mcpRow(s) {
    const fixed = s.source === 'environment';
    const id = mcpRowId(s.name);
    const meta = [
      (() => { try { return new URL(s.url).host; } catch { return s.url; } })(),
      whoText(s),
      `repos: ${listText(s.repos, 'all')}`,
      s.auth === 'header' ? `${headerName(s.header)} header${s.headerSet ? '' : ', no value yet'}` : s.auth === 'oidc' ? `signed token for ${s.audience}` : 'nothing added',
      fixed ? 'set in the installation\'s configuration' : s.source === 'host' ? 'kept by the program that runs this console' : `by @${s.updatedBy || 'unknown'}`,
    ].join(' · ');
    const pill = s.production ? h('span', { class: 'otag is-production', title: 'Its first call locks the session down for good' }, 'Production')
      : s.auth === 'header' && !s.headerSet ? h('span', { class: 'pill is-warn' }, 'No value yet')
        : h('span', { class: 'pill' }, 'Ordinary');
    if (fixed) return line([s.name, ' ', pill], [meta, testNote(s)], testButton(s), { id });
    return row({ id, title: s.name, value: meta, pill, opens: true, onOpen: () => { mcpForms.set(s.name, formOf(s)); } },
      open.has(id) && mcpFormBody(mcpFormFor(s), s));
  }

  // `run` returns {form, text}: what to say, on the form there is once it is done (a save starts the form again).
  async function mcpSave(f, run) {
    if (f.busy) return;
    f.busy = 'saving';
    f.error = null;
    f.failedTest = null;
    f.notice = null;
    render();
    try {
      const done = await run();
      if (done) done.form.notice = done.text;
    } catch (err) {
      f.error = err;
    }
    f.busy = null;
    render();
  }

  function mcpServerOf(f) {
    return {
      name: f.name.trim(), url: f.url.trim(), production: f.production, shared: !f.production && f.shared,
      people: f.people.trim() === '*' ? '*' : f.people.split(',').map((x) => x.trim().replace(/^@/, '')).filter(Boolean),
      // A list from the checkboxes, or owner/name typed in where the console named no repos.
      repos: Array.isArray(f.repos) ? [...f.repos] : f.repos.trim() === '*' ? '*' : f.repos.split(',').map((x) => x.trim()).filter(Boolean),
      auth: f.auth, ...(f.auth === 'oidc' && f.audience.trim() && { audience: f.audience.trim() }), ...(f.auth === 'header' && { header: f.header.trim() || 'Authorization' }),
    };
  }

  // Tests the form first unless `untested` (Add anyway): a server that does not answer is not saved, and the form stays
  // as typed. A console from before the test (404) saves as it did.
  function saveMcp(f, { untested = false } = {}) {
    const server = mcpServerOf(f);
    return mcpSave(f, async () => {
      let tried = null;
      if (!untested) {
        f.busy = 'testing';
        render();
        try {
          // An edit whose Value is left empty sends none: the console tests with the saved one.
          tried = await W.postJson(MCP_TEST, { server, ...(f.auth === 'header' && f.value && { value: f.value }) });
        } catch (err) {
          if (err.status !== 404) throw err;
        }
        if (tried && !tried.ok) {
          f.failedTest = tried.error || 'The server did not answer as an MCP server.';
          return null;
        }
        f.busy = 'saving';
        render();
      }
      mcp = await W.postJson('/api/console-settings/mcp-servers', { server });
      const name = server.name.toLowerCase();
      if (f.auth === 'header' && f.value) mcp = await W.postJson('/api/console-settings/mcp-servers/header', { name, value: f.value });
      const how = tried ? ` ${reachedText(tried)}.` : untested ? ' Not tested.' : '';
      const text = `${name} ${f.editing ? 'saved' : 'added'}.${how} Sessions started from now on get it.${server.production ? ' Its first call locks a session down for good.' : ''}`;
      // The form starts again: a saved server's from what is saved now, Add a server's empty.
      mcpForms.delete(f.editing ?? '');
      // Said on the saved server's own row, under the name it has now, which is opened if the save renamed it. Only
      // an added server's is said on Add a server.
      const saved = f.editing ? mcp.servers.find((s) => s.name === name) : null;
      if (saved) {
        mcpForms.delete(name);
        open.add(mcpRowId(name));
      }
      return { form: mcpFormFor(saved ?? null), text };
    });
  }

  function removeMcp(f, s) {
    return mcpSave(f, async () => {
      mcp = await W.postJson('/api/console-settings/mcp-servers/remove', { name: s.name });
      mcpRowNotes.delete(s.name);
      mcpForms.delete(s.name);
      // Said on Add a server: the server's own row is gone.
      open.delete(mcpRowId(s.name));
      open.add('mcp-add');
      return { form: mcpFormFor(null), text: `${s.name} removed: sessions started from now on do not get it, and running ones' calls to it are refused.` };
    });
  }

  function mcpField(f, part, label, help, key, attrs = {}) {
    const id = fid(f, part);
    return h('div', { class: 'set-row' },
      h('div', null, h('label', { class: 'set-name', for: id }, label), help && h('div', { class: 'set-help' }, help)),
      h('div', { class: 'set-value' }, h('input', {
        id, class: 'field is-text', type: 'text', autocomplete: 'off', spellcheck: 'false', value: f[key], ...attrs,
        oninput: (e) => { f[key] = e.target.value; },
      })));
  }

  function mcpSelect(f, part, label, help, key, options, onchange) {
    const id = fid(f, part);
    return h('div', { class: 'set-row' },
      h('div', null, h('label', { class: 'set-name', for: id }, label), help && h('div', { class: 'set-help' }, help)),
      h('div', { class: 'set-value' }, h('select', { id, class: 'field is-text', onchange: (e) => { onchange(e.target.value); render(); } },
        options.map(([value, text]) => h('option', { value, selected: value === String(f[key]) ? true : null }, text)))));
  }

  // Ordinary or Production, as two cards side by side (designSystem/components/ChoiceCards): native radios, so the
  // arrow keys move between them. Production is drawn in the Production tag's colours when picked, with what it does to
  // a session under it, and is off with the reason where this console cannot lock a session down.
  function mcpKind(f) {
    const prodOff = !mcp.production.available && !f.savedProduction;
    const pick = (production) => {
      f.production = production;
      if (production && f.auth === 'none') f.auth = 'oidc';
      render();
    };
    const option = (production, title, text) => {
      const id = fid(f, production ? 'kind-production' : 'kind-ordinary');
      const off = production && prodOff;
      const on = f.production === production;
      return h('label', { class: `choice-card${production ? ' is-production' : ''}${on ? ' is-on' : ''}${off ? ' is-off' : ''}`, for: id },
        h('input', { id, type: 'radio', name: fid(f, 'kind'), value: production ? 'production' : 'ordinary', checked: on, disabled: off, 'aria-describedby': `${id}-line`, onchange: () => pick(production) }),
        h('span', { class: 'radio', 'aria-hidden': 'true' }),
        h('span', { class: 'choice-title' }, title),
        h('span', { class: 'choice-line', id: `${id}-line` }, text));
    };
    return h('div', { class: 'set-row is-block' },
      h('fieldset', { class: 'choice-set' },
        h('legend', { class: 'set-name' }, 'Kind'),
        h('div', { class: 'choice-cards' },
          option(false, 'Ordinary', 'Reads no production data. Sessions that use it keep their internet.'),
          option(true, 'Production', prodOff
            ? `Not on this console: it cannot lock a session down, since ${mcp.production.why}.`
            : 'Reads production data. Its first call locks the session down for good.'))),
      f.production && h('div', { class: 'prod-callout', role: 'note' },
        h('p', { class: 'prod-callout-head' }, h('span', { class: 'otag is-production' }, 'Production'), 'What happens to a session that uses it'),
        h('ul', null,
          h('li', null, 'Only My Woodshed sessions of the people and repos below get it, and it is off until its person turns it on in /mcp.'),
          h('li', null, 'Its first call locks that session down for good: no internet but its org\'s private repos on GitHub, and no package installs. Nothing undoes it.'),
          h('li', null, 'The session is removed some time after it stops (Retention, under Kept sessions).'))));
  }

  // The repos whose sessions get it: All repos, or some of the console's, as checkboxes under a fold. A saved repo the
  // console no longer has stays listed, ticked, so a save never drops it unseen.
  function mcpRepos(f) {
    const all = f.repos === '*';
    const picked = all ? [] : f.repos;
    const known = (data.projects ?? []).map((p) => p.repo);
    const lower = (r) => r.toLowerCase();
    const extra = picked.filter((r) => !known.some((k) => lower(k) === lower(r)));
    const has = (r) => picked.some((x) => lower(x) === lower(r));
    const set = (repos) => { f.repos = repos; render(); };
    const box = (id, text, checked, onchange, { disabled = false, note = null } = {}) => h('label', { class: 'repo-check', for: id },
      h('input', { id, type: 'checkbox', checked, disabled, onchange: (e) => onchange(e.target.checked) }),
      h('span', { class: 'repo-check-name' }, text), note && h('span', { class: 'repo-check-note' }, note));
    const summary = all ? 'All repos' : picked.length ? picked.join(', ') : 'No repo';
    const label = fid(f, 'repos-label');
    return h('div', { class: 'set-row is-top' },
      h('div', null, h('span', { class: 'set-name', id: label }, 'Repos'),
        h('div', { class: 'set-help' }, 'Whose sessions get it. All repos takes in any added later.')),
      h('div', { class: 'set-value' },
        h('details', { class: 'repo-pick', open: f.reposOpen, ontoggle: (e) => { f.reposOpen = e.target.open; } },
          h('summary', { id: fid(f, 'repos'), class: 'field', 'aria-labelledby': `${label} ${fid(f, 'repos')}` }, h('span', { class: 'repo-pick-text' }, summary)),
          h('div', { class: 'repo-pick-list', role: 'group', 'aria-labelledby': label },
            box(fid(f, 'repo-all'), 'All repos', all, (on) => set(on ? '*' : [...known])),
            known.map((r, i) => box(fid(f, `repo-${i}`), r, all || has(r), (on) => set(on ? [...picked, r] : picked.filter((x) => lower(x) !== lower(r))), { disabled: all })),
            extra.map((r, i) => box(fid(f, `repo-x${i}`), r, true, (on) => set(on ? [...picked, r] : picked.filter((x) => x !== r)), { note: 'not a repo of this console' }))))),
      !all && !picked.length && h('p', { class: 'form-error', role: 'status' }, 'No repo picked: no session gets it.'));
  }

  // A row's body: the form of the saved server `s`, with Test and Remove beside its Save, or of Add a server.
  function mcpFormBody(f, s = null) {
    const verb = f.editing ? 'Save' : 'Add server';
    return [
      h('div', { class: 'set-rows' },
        mcpField(f, 'name', 'Name', 'What claude calls it, such as sentry: lowercase letters, digits and dashes.', 'name', { disabled: f.editing ? true : null }),
        mcpField(f, 'url', 'URL', 'Its Streamable HTTP endpoint, such as https://mcp.example.com/mcp. The console calls it, so it must answer from the console.', 'url', { placeholder: 'https://' }),
        mcpKind(f),
        !f.production && mcpSelect(f, 'shared', 'Shared sessions', 'Whether sessions everyone can type into get it too: issues, pull requests and questions from Slack. Never a QA run or a review.', 'shared',
          [['false', 'No'], ['true', 'Yes']], (v) => { f.shared = v === 'true'; }),
        mcpField(f, 'people', 'People', 'GitHub logins whose My Woodshed sessions get it, comma-separated, or * for everyone.', 'people'),
        data.projects ? mcpRepos(f) : mcpField(f, 'repos', 'Repos', 'owner/name, comma-separated, or * for every repo.', 'repos'),
        mcpSelect(f, 'auth', 'What the console adds', 'Signed token: one the console signs as its OpenID Connect issuer, for the server to check. Header: a value the console keeps, such as an API key.', 'auth', Object.entries(AUTH_WORDS), (v) => { f.auth = v; }),
        f.auth === 'oidc' && mcpField(f, 'audience', 'Audience', `The token's aud. The server trusts issuer ${mcp.issuer}, keys at ${mcp.jwks}. Empty: ${f.production ? 'woodshed-prod-mcp' : 'the server\'s name'}.`, 'audience'),
        f.auth === 'header' && mcp.headers && mcpField(f, 'header', 'Header', 'Its name, such as Authorization or X-Api-Key.', 'header'),
        f.auth === 'header' && mcp.headers && mcpField(f, 'value', 'Value', f.editing ? 'Leave empty to keep the saved one. Never shown again.' : 'Such as Bearer <key>. Kept in the console\'s secret store and never shown again.', 'value', { type: 'password', autocomplete: 'new-password' })),
      f.auth === 'header' && !mcp.headers && h('p', { class: 'cap-note' }, 'This console has no secret store, so it cannot keep a header.'),
      f.error && h('p', { class: 'form-error', role: 'alert', style: 'margin: 0' }, W.errorParts(f.error)),
      f.failedTest && h('p', { class: 'form-error', role: 'alert', style: 'margin: 0' }, `Not ${f.editing ? 'saved' : 'added'}. ${f.failedTest} Fix it and try again, or ${f.editing ? 'save' : 'add'} it anyway if the server is not up yet.`),
      h('div', { class: 'card-foot' },
        h('button', { type: 'button', class: 'btn btn-open', disabled: !!f.busy, onclick: () => saveMcp(f) }, f.busy === 'testing' ? 'Testing…' : f.busy ? 'Saving…' : verb),
        f.failedTest && h('button', { type: 'button', class: 'btn btn-quiet', disabled: !!f.busy, onclick: () => saveMcp(f, { untested: true }) }, `${f.editing ? 'Save' : 'Add'} anyway`),
        s && testButton(s),
        s && h('button', { type: 'button', class: 'btn btn-danger', disabled: !!f.busy, onclick: () => removeMcp(f, s) }, 'Remove'),
        h('span', { class: 'sub', role: 'status' }, f.notice || `${verb} tests the server first. Each change is logged with who made it.${s ? ' Closing the row drops what was typed.' : ''}`)),
      s && testNote(s),
    ];
  }

  function mcpGroup() {
    if (!mcp) return null;
    return group({
      id: 'mcp-servers', label: 'MCP servers',
      note: 'Tools claude gets in sessions, each reached through the console, so no session ever holds what a server takes to let it in: the console adds a token it signs, or a header it keeps, to each call. A change reaches sessions started after it. Test asks a server what it offers, the way the console calls it.',
    },
      mcp.servers.length ? mcp.servers.map(mcpRow) : row({ id: 'mcp-none', title: 'None yet' }),
      row({ id: 'mcp-add', title: 'Add a server', value: 'It is tested first, then reaches sessions started after it', opens: true },
        open.has('mcp-add') && mcpFormBody(mcpFormFor(null))));
  }

  // The Woodshed card: the commit this console runs from its git clone, the newer ones on the branch the clone follows,
  // and Update, which pulls them, builds the session image if it changed and restarts the console (woodshedUpdate.mjs).
  // Read on its own, since it asks git.
  let updates = null;
  let updatesError = null;
  const updateForm = { busy: null, error: null };
  // Set once an update is restarting the console: the page reloads when the new one answers. `restartSince` is when
  // the page first saw it restarting, so one that never comes back is said, with the way back, after RESTART_GIVE_UP_MS.
  let awaitingRestart = false;
  let restartSince = null;
  const RESTART_GIVE_UP_MS = 2 * 60_000;
  const STEP_WORDS = {
    pull: 'Pull the new commits', starts: 'Check the new code starts', image: 'Build the session image', restart: 'Restart the console',
  };

  // How long ago, with "just now" for the first minute, which W.ago rounds up to one.
  function since(iso) {
    return Date.now() - Date.parse(iso) < 60_000 ? 'just now' : W.ago(iso);
  }

  function plural(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
  }

  function took(seconds) {
    if (seconds === null || seconds === undefined) return '';
    return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  }

  function stepNote(step) {
    // What stopped it is said in full under the list, where it has room.
    if (step.state === 'failed') return 'stopped';
    if (step.state === 'now') return step.key === 'image' ? 'takes a few minutes' : '';
    if (step.state === 'done') return [step.detail, took(step.seconds)].filter(Boolean).join(' · ');
    return '';
  }

  // The job's steps as the design system's checklist (`.start-steps`).
  function updateSteps(job) {
    const mark = { done: '✓', now: '', next: '', failed: '✗' };
    return h('ol', { class: 'start-steps' }, job.steps.map((step) => h('li', { class: `is-${step.state}`, 'aria-current': step.state === 'now' ? 'step' : null },
      h('span', { class: 'start-mark', 'aria-hidden': 'true' }, mark[step.state]),
      h('span', { class: 'start-label' }, STEP_WORDS[step.key]),
      h('span', { class: 'start-secs' }, stepNote(step)))));
  }

  function versionLine(u) {
    if (!u.upstream) return h('p', { class: 'cap-note' }, `The clone at ${u.clone} follows no branch, so there is nothing to compare it with. Check out a branch that tracks the remote, such as main.`);
    if (u.error) return h('p', { class: 'form-error', role: 'alert' }, u.error);
    if (!u.checkedAt) return h('p', { class: 'sub' }, `Not compared with ${u.upstream} yet.`);
    const running = h('span', { class: 'rref' }, u.head);
    if (!u.behindBy) return h('p', { class: 'empty-ok' }, `Up to date with ${u.upstream}. Running `, running, '.');
    return h('p', { class: 'set-name', style: 'margin: 0' }, `${plural(u.behindBy, 'commit', 'commits')} behind ${u.upstream}. Running `, running, '.');
  }

  function commitList(u) {
    if (!u.behindBy || !u.commits?.length) return null;
    return [
      h('ul', { class: 'update-commits', 'aria-label': 'Newer commits, newest first' }, u.commits.map((c) => h('li', null,
        h('span', { class: 'sha' }, c.sha), h('span', { class: 'what' }, c.title),
        h('span', { class: 'when' }, [c.author, c.date && W.ago(c.date)].filter(Boolean).join(' · '))))),
      u.more > 0 && h('p', { class: 'sub', style: 'margin: 0' }, `and ${u.more} more.`),
    ];
  }

  // What keeps Update off, in the card's words; null when it can run.
  function blocked(u) {
    if (!u.upstream || u.error || !u.checkedAt) return 'Nothing to update to yet.';
    if (!u.behindBy) return 'Already up to date.';
    if (u.aheadBy) return `The clone has ${plural(u.aheadBy, 'commit', 'commits')} of its own that ${u.upstream} does not, so it cannot simply move forward: merge it by hand.`;
    if (u.job && ['running', 'restarting'].includes(u.job.state)) return 'An update is running.';
    return null;
  }

  function byHand(u) {
    return h('div', { class: 'cap-note' },
      h('p', { style: 'margin: 0 0 6px' }, 'Nothing would start this console again after an update (it is not run by install.sh\'s bin/woodshed or a systemd unit), so there is no Update button. By hand:'),
      h('pre', { class: 'update-cmd' }, `git -C ${u.clone} pull --ff-only\n# then start the console again; if session/ or shared/ changed, build the session image too:\nWOODSHED_REBUILD=1 WOODSHED_NO_START=1 bash ${u.clone}/install.sh`));
  }

  function lastLine(u) {
    if (!u.last || u.job) return null;
    return h('p', { class: 'sub', style: 'margin: 0' },
      `Last updated ${since(u.last.at)}, from ${u.last.from} to ${u.last.to}, by @${u.last.by}${u.last.imageBuilt ? ', with a new session image' : ''}.`);
  }

  function jobBlock(job) {
    if (!job) return null;
    return [
      h('div', { class: 'sub-head' }, 'Update', h('span', { class: `pill ${job.state === 'failed' ? 'is-bad' : 'is-work'}` },
        job.state === 'failed' ? 'Failed' : job.state === 'restarting' || awaitingRestart ? 'Restarting' : 'Updating')),
      updateSteps(job),
      job.state === 'failed' && h('p', { class: 'form-error', role: 'alert' }, `${job.error}. ${job.to ? `The clone was put back on ${job.from}, so ` : ''}the console runs as it did.`),
      job.logTail?.length > 0 && job.state !== 'restarting' && h('pre', { class: 'update-cmd' }, job.logTail.join('\n')),
      (job.state === 'restarting' || awaitingRestart) && restartNote(job),
    ];
  }

  // The new code passed its start check, so it loads; one that fails after that (a port, a database, its state) leaves
  // nothing answering, and whatever started it (bin/woodshed, a systemd unit) has stopped. Its log says why.
  function restartNote(job) {
    if (!restartSince || Date.now() - restartSince < RESTART_GIVE_UP_MS) {
      return h('p', { class: 'sub', role: 'status' }, 'The console is restarting on the new code. Running sessions carry on; this page reloads once it answers.');
    }
    return h('div', { class: 'cap-note', role: 'alert' },
      h('p', { class: 'form-error', style: 'margin: 0 0 6px' }, `The console has not answered for ${Math.floor((Date.now() - restartSince) / 60_000)} minutes since the update restarted it${job.to ? ` on ${job.to}` : ''}. Its log says why: bin/woodshed's output, or journalctl for its systemd unit. To go back to the code that ran, on its machine:`),
      h('pre', { class: 'update-cmd' }, `git -C ${updates?.clone ?? '<clone>'} reset --keep ${job.from}\n# then start the console again: ~/.woodshed/bin/woodshed, or systemctl restart <its unit>`),
      h('p', { class: 'sub', style: 'margin: 6px 0 0' }, 'This page still reloads if it comes back.'));
  }

  async function updateAction(kind) {
    if (updateForm.busy) return;
    updateForm.busy = kind;
    updateForm.error = null;
    render();
    try {
      updates = await W.postJson(`/api/console-settings/updates/${kind}`, {});
    } catch (err) {
      updateForm.error = err.message;
    }
    updateForm.busy = null;
    render();
    scheduleUpdates();
  }

  // The row's status word: the update's own while one runs or failed, else how the clone stands against its branch.
  function updatesPill(u) {
    if (u.job?.state === 'failed') return h('span', { class: 'pill is-bad' }, 'Failed');
    if (u.job || awaitingRestart) return h('span', { class: 'pill is-work' }, u.job?.state === 'restarting' || awaitingRestart ? 'Restarting' : 'Updating');
    if (!u.upstream) return h('span', { class: 'pill' }, 'Follows no branch');
    if (u.error) return h('span', { class: 'pill is-bad' }, 'Check failed');
    if (!u.checkedAt) return h('span', { class: 'pill' }, 'Not checked');
    return u.behindBy ? h('span', { class: 'pill is-warn' }, `${plural(u.behindBy, 'commit', 'commits')} behind`) : h('span', { class: 'pill is-ok' }, 'Up to date');
  }

  function updatesRow() {
    if (!updates && !updatesError) return null;
    const u = updates;
    if (!u) return row({ id: 'card-updates', title: 'Woodshed', value: h('span', { class: 'form-error', role: 'alert' }, `Could not load it: ${updatesError}`), pill: h('span', { class: 'pill is-bad' }, 'Not loaded') });
    const why = blocked(u);
    const running = u.job && ['running', 'restarting'].includes(u.job.state);
    // An update is a job the person waits on: its row stays open while it runs.
    if (running || awaitingRestart) open.add('card-updates');
    return row({
      id: 'card-updates', title: 'Woodshed', pill: updatesPill(u),
      value: [u.head && `Running ${u.head}`, u.checkedAt && `checked ${since(u.checkedAt)}`, u.last && `last updated ${since(u.last.at)} by @${u.last.by}`].filter(Boolean).join(' · ') || 'The Woodshed this console runs',
    },
      h('p', { class: 'sub' }, `The Woodshed this console runs, from its git clone at ${u.clone}${u.remote ? `, against ${u.remote}` : ''}. Checked every hour. Update pulls the new commits, builds the session image again when what it is made from changed, and restarts the console: running sessions carry on, new ones start on the new image.`),
      updatesError && h('p', { class: 'form-error', role: 'alert', style: 'margin: 0' }, `Could not load it: ${updatesError}`),
      versionLine(u), commitList(u), lastLine(u), jobBlock(u.job), !u.supervisor && u.behindBy > 0 && byHand(u),
      h('div', { class: 'card-foot' },
        u.supervisor && h('button', {
          type: 'button', class: 'btn btn-open', disabled: Boolean(updateForm.busy) || Boolean(why), title: why,
          onclick: () => updateAction('update'),
        }, updateForm.busy === 'update' ? 'Starting…' : running ? 'Updating…' : 'Update to latest'),
        u.upstream && h('button', { type: 'button', class: 'btn btn-quiet', disabled: Boolean(updateForm.busy) || running, onclick: () => updateAction('check') },
          updateForm.busy === 'check' ? 'Checking…' : 'Check now'),
        updateForm.error ? h('span', { class: 'form-error', role: 'alert' }, updateForm.error)
          : h('span', { class: 'sub', role: 'status' }, u.supervisor && why && u.behindBy ? why : u.checkedAt ? `Checked ${since(u.checkedAt)}.` : '')));
  }

  async function loadUpdates() {
    try {
      updates = await W.getJson('/api/console-settings/updates');
      updatesError = null;
      return true;
    } catch (err) {
      // A console that runs from no git clone answers 404: no card. While one restarts, nothing answers.
      if (following) return false;
      if (err.status === 404) updates = null;
      else updatesError = err.message;
      return true;
    }
  }

  // Every 2 seconds while an update runs, so its steps follow; every minute otherwise. An update ends by restarting the
  // console, which then answers with no update running: the page reloads, for the new code's pages and the menu's count.
  let updatesTimer = null;
  let following = false;
  function scheduleUpdates() {
    clearTimeout(updatesTimer);
    const job = updates?.job;
    if (job && ['running', 'restarting'].includes(job.state)) following = true;
    if (job?.state === 'restarting') {
      awaitingRestart = true;
      restartSince ??= Date.now();
    }
    updatesTimer = life.timeout(async () => {
      const answered = await loadUpdates();
      if (following && answered && updates && !updates.job) {
        location.reload();
        return;
      }
      // An update with no image to build reaches its restart within a poll or two, so the page may never see it
      // restarting: a console that stops answering while one runs is taken for that restart.
      if (following && !answered) {
        awaitingRestart = true;
        restartSince ??= Date.now();
      }
      // A console that answers with its update still running (or failed) was not restarting: a read lost on the way
      // is not a restart, and the two minutes start again at the next one.
      if (answered && updates?.job && updates.job.state !== 'restarting') {
        awaitingRestart = false;
        restartSince = null;
      }
      if (updates?.job?.state === 'failed') following = false;
      if (!typing()) render();
      scheduleUpdates();
    }, following ? 2_000 : DATA_REFRESH_MS);
  }

  function refOf(r) {
    if (r.prUrl) return `PR ${r.prUrl.split('/').pop()}`;
    return r.number ? W.ref({ kind: r.sessionKind, number: r.number }) : '';
  }

  function deletesText(r) {
    if (!r.deletesAt) return 'deletion date not set yet';
    const ms = Date.parse(r.deletesAt) - Date.now();
    const on = new Date(r.deletesAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const at = ms <= 0 ? 'deleted on the next check' : `deleted in ${Math.max(1, Math.round(ms / 86_400_000))} days, on ${on}`;
    if (r.prClosedAt) return at;
    return r.prUrl ? `PR open: ${at}` : `no PR: ${at}`;
  }

  function stalledAction(r) {
    const label = r.kind === 'stuck' ? (r.status === 'stopping' ? 'Finish the stop' : 'Stop it')
      : r.kind === 'databases' ? (r.orphan ? 'Drop' : 'Drop again')
        : 'Delete';
    const what = r.kind === 'stuck' ? 'its task is stopped, and it is marked stopped without the final push'
      : r.kind === 'databases' ? `the db-admin task drops ${r.meta[0]} from ${W.providerWords.databasesPlace ?? 'its databases'}`
        : `${r.meta[0]} is deleted from ${homesPlace()}`;
    return h('button', {
      type: 'button', class: 'btn btn-open btn-sm',
      onclick: () => W.confirmChange({
        title: `${label}?`,
        before: r.why,
        after: r.kind === 'stuck' ? 'stopped' : 'gone',
        effect: `${r.title ? `${r.title}: ` : ''}${what}. This cannot be undone.`,
        word: r.kind === 'stuck' ? 'stop' : 'delete',
        goLabel: label,
        run: async () => {
          data = { ...data, ...(await W.postJson('/api/console-settings/clean', { kind: r.kind, id: r.id })) };
          render();
        },
      }),
    }, label);
  }

  function stalledRow(r) {
    return h('div', { class: 'data-row is-stalled' },
      h('div', { style: 'min-width: 0' },
        h('div', { class: 'data-title' }, h('b', null, r.title || 'No session'), refOf(r) && h('span', { class: 'rref' }, refOf(r))),
        h('div', { class: 'data-why' }, r.why),
        r.meta.length > 0 && h('div', { class: 'data-meta' }, r.meta.map((m) => h('span', null, m)))),
      h('div', { class: 'data-actions' }, stalledAction(r)));
  }

  function heldRow(r) {
    const conversation = r.home === null ? 'conversation not listed' : r.home ? 'conversation saved' : 'no conversation';
    return h('div', { class: 'data-row' },
      h('div', { style: 'min-width: 0' },
        h('div', { class: 'data-title' }, h('a', { href: `/s/${r.id}` }, h('b', null, r.title)), refOf(r) && h('span', { class: 'rref' }, refOf(r))),
        h('div', { class: 'data-meta' },
          h('span', null, `stopped: ${r.stopReason || 'no reason recorded'}`),
          h('span', null, r.database || 'no databases'),
          h('span', null, conversation),
          h('span', null, deletesText(r)))),
      h('div', { class: 'data-actions' },
        W.resumeSharedButton(r, { small: true, onDone: refreshData }),
        W.deleteSharedButton(r, refreshData)));
  }

  function homesPlace() {
    return W.providerWords.homesPlace ?? 'the saved homes store';
  }

  function totalsLine(d) {
    // A console whose installation runs no database has no place for copies, and says so.
    const place = W.providerWords.databasesPlace;
    const copies = place ? `${d.totals.databases} database ${d.totals.databases === 1 ? 'copy' : 'copies'} on ${place}` : 'no databases (this installation runs none)';
    if (d.totals.homes === null) return `Total kept: ${copies}. The saved conversations could not be listed.`;
    const mb = Math.round(d.totals.homeBytes / 1_000_000);
    return `Total kept: ${copies}, and ${d.totals.homes} saved ${d.totals.homes === 1 ? 'conversation' : 'conversations'} (${mb} MB) in ${homesPlace()}.`;
  }

  // Sessions holding data: a plain line while nothing is held, else a row whose pill says how many are stalled or kept.
  function dataRow() {
    const d = data.data;
    if (!d) return null;
    if (!d.held.length && !d.stalled.length) {
      return row({ id: 'card-data', title: 'Sessions holding data', value: `Nothing is held or stalled. ${totalsLine(d)}`, pill: h('span', { class: 'pill' }, 'None') });
    }
    const held = `${d.held.length} stopped ${d.held.length === 1 ? 'session keeps its' : 'sessions keep their'} conversation and databases`;
    return row({
      id: 'card-data', title: 'Sessions holding data',
      value: `${d.held.length ? held : 'No stopped session keeps data'} · checked every minute`,
      pill: d.stalled.length ? h('span', { class: 'pill is-bad' }, `${d.stalled.length} stalled`) : h('span', { class: 'pill' }, `${d.held.length} kept`),
    },
      h('p', { class: 'sub' }, 'Shared sessions that are stopped but keep their conversation and databases, and anything left behind or stuck. Checked again every minute.'),
      d.stalled.length > 0 && [
        h('div', { class: 'sub-head' }, 'Stalled', h('span', { class: 'count' }, d.stalled.length)),
        h('div', { class: 'data-list' }, d.stalled.map(stalledRow))],
      d.held.length > 0 && [
        h('div', { class: 'sub-head' }, 'Kept, waiting to be resumed or deleted', h('span', { class: 'count' }, d.held.length)),
        h('div', { class: 'data-list' }, d.held.map(heldRow))],
      h('p', { class: 'sub', style: 'font-size: 12.5px' }, totalsLine(d)));
  }

  // Slack: the bot, where pull requests are posted and the questions people ask it, a row each (slackSetup.mjs). Read
  // on its own, since it asks the secret store and Slack. `slackView` is null on a console that posts nothing to
  // Slack, which has no group.
  let slackView = null;
  let slackError = null;
  // The channel picker of the open Pull requests row: made when the row opens, so closing the row is its Cancel.
  let channelPicker = null;
  // What the last change said, and the row it is said on: `bot` or `pulls`.
  const slackNote = { text: null, bad: false, on: 'bot' };

  async function loadSlack() {
    try {
      slackView = await W.getJson('/api/console-settings/slack');
      slackError = null;
    } catch (err) {
      slackView = null;
      slackError = err.status === 404 ? null : err.message;
    }
  }

  function slackSay(on, text, bad = false) {
    slackNote.on = on;
    slackNote.text = text;
    slackNote.bad = bad;
  }

  function slackSaved(next, text, on = 'bot') {
    slackView = { ...slackView, ...next };
    if (data?.slack) data = { ...data, slack: { ...data.slack, channel: next.channel ?? '' } };
    // The picker starts again on what is saved now.
    channelPicker = null;
    slackSay(on, text);
    render();
  }

  // Slack keeps an app's token when it is reinstalled with new scopes, so the row asks about the saved one again.
  async function recheckSlack() {
    if (saving.has('slack-recheck')) return;
    saving.add('slack-recheck');
    render();
    try {
      const next = await W.postJson('/api/console-settings/slack/recheck', {});
      const text = next.bot && !next.bot.ok ? `Checked: Slack still refuses the saved token (${next.bot.error}).`
        : next.missingScopes?.length ? `Checked: the app still lacks ${next.missingScopes.join(', ')}. Reinstall it after adding ${next.missingScopes.length === 1 ? 'it' : 'them'}.`
          : Array.isArray(next.missingScopes) ? 'Checked: the app has every scope the console uses.'
            : 'Checked, but Slack did not say which scopes the app has.';
      slackSaved(next, text);
    } catch (err) {
      slackSay('bot', err.message, true);
    }
    saving.delete('slack-recheck');
    render();
  }

  function checkAgainButton() {
    return h('button', { type: 'button', class: 'btn btn-plain btn-sm', disabled: saving.has('slack-recheck'), onclick: recheckSlack },
      saving.has('slack-recheck') ? 'Checking…' : 'Check again');
  }

  function openSetup(mode) {
    W.openSlackSetup({
      view: slackView, mode,
      onSaved: (next) => slackSaved(next, mode === 'replace' ? 'Saved. The console uses the new keys from its next call to Slack.' : 'Slack is set up.'),
    });
  }

  const channelName = (v) => (v.channelName ? `#${v.channelName}` : v.channel);

  function channelText(v) {
    if (!v.channel) return 'Not posted: no channel. A repo can post to its own channel instead, on its Settings under Repos.';
    return `Posted to ${channelName(v)}. A repo can post to its own channel instead, on its Settings under Repos.`;
  }

  function botText(v) {
    if (v.bot && !v.bot.ok) return `Slack refuses the saved token (${v.bot.error}): nothing is posted. Replace keys with a new one.`;
    const who = v.bot?.name ? `@${v.bot.name}` : 'The bot';
    const how = v.install?.installed ? `installed with ${v.install.label}` : 'your own app';
    const set = v.bot?.setAt ? ` Set${v.bot.setBy && v.bot.setBy !== 'console' ? ` by @${v.bot.setBy}` : ''} ${W.when(v.bot.setAt)}.` : '';
    return `${who}, ${how}.${set}`;
  }

  async function saveChannel() {
    const channel = channelPicker.value().trim();
    const bad = channelPicker.problem();
    if (bad) { slackSay('pulls', bad, true); render(); return; }
    if (saving.has('slack-channel')) return;
    saving.add('slack-channel');
    try {
      const next = await W.postJson('/api/console-settings/slack', { channel });
      slackSaved(next, channel ? 'Saved. The next pull request goes to the new channel. Invite the bot to it first.' : 'Saved. Pull requests of repos without a channel of their own are not posted.', 'pulls');
    } catch (err) {
      slackSay('pulls', err.message, true);
      render();
    }
    saving.delete('slack-channel');
  }

  // What the last change on a row said, under that row's buttons.
  function slackNoteOn(on) {
    return slackNote.text && slackNote.on === on && h('p', { class: slackNote.bad ? 'form-error' : 'sub', role: slackNote.bad ? 'alert' : 'status', style: 'margin: 0' }, slackNote.text);
  }

  // A Slack row's own numbers, under its other controls: shown with the row, with no fold of their own.
  function limitsBlock(block) {
    if (!settingsOf(block).length) return null;
    return [h('h4', { class: 'sub-head' }, 'Limits'), h('div', { class: 'slack-limits', id: `slack-limits-${block}` }, settingsBlock(block))];
  }

  function botRow(v) {
    const refused = v.bot && !v.bot.ok;
    const installed = Boolean(v.install?.installed);
    const lacks = v.missingScopes?.length > 0;
    return row({
      id: 'slack-bot', title: 'Bot', value: botText(v),
      pill: refused ? h('span', { class: 'pill is-bad' }, 'Token refused')
        : lacks ? h('span', { class: 'pill is-warn' }, 'Missing scopes')
          : h('span', { class: 'pill is-ok' }, v.bot?.team ? `Connected to ${v.bot.team}` : 'Connected'),
    },
      h('p', { class: 'sub' }, botText(v)),
      (refused || lacks) && h('p', { class: 'cap-note' },
        refused ? 'Fixed it in Slack? ' : `The app lacks ${v.missingScopes.join(', ')}. Add ${v.missingScopes.length === 1 ? 'it' : 'them'} on its OAuth & Permissions page and reinstall it, then `,
        checkAgainButton(), refused ? '' : '. If Slack gave it a new token, Replace keys with that instead.'),
      h('div', { class: 'card-foot' },
        installed && v.install.href
          ? h('a', { class: 'btn btn-plain', href: v.install.href }, 'Reinstall')
          : h('button', { type: 'button', class: 'btn btn-plain', onclick: () => openSetup('replace') }, 'Replace keys'),
        v.canDisconnect && h('button', {
          type: 'button', class: 'btn btn-danger',
          onclick: () => W.confirmChange({
            title: 'Disconnect Slack?',
            before: `the bot${v.bot?.name ? ` @${v.bot.name}` : ''}, with its token and signing secret saved`,
            after: 'no token and no signing secret',
            effect: 'Nothing is posted to Slack, and no mention is answered, until Slack is set up again. The channels are kept.',
            word: 'slack',
            goLabel: 'Disconnect',
            run: async () => {
              slackSaved(await W.postJson('/api/console-settings/slack/disconnect', { confirm: 'slack' }), 'Disconnected. Set up Slack connects it again.');
            },
          }),
        }, 'Disconnect Slack')),
      slackNoteOn('bot'));
  }

  function pullsRow(v) {
    const isOpen = open.has('slack-pulls');
    if (!isOpen) channelPicker = null;
    else if (!channelPicker) channelPicker = W.slackChannelPicker({ value: v.channel, name: v.channelName, id: 'slack-channel-search' });
    return row({
      id: 'slack-pulls', title: 'Pull requests', opens: true,
      // What the last change said is not said again by a row opened anew.
      onOpen: () => { if (slackNote.on === 'pulls') slackNote.text = null; },
      value: [
        v.channel ? `Posted to ${channelName(v)}` : 'Not posted: no channel',
        qty('slackGiveUpDays') && `gives up after ${qty('slackGiveUpDays')}`, qty('qaWaitMinutes') && `waits ${qty('qaWaitMinutes')} for QA`,
      ].filter(Boolean).join(' · '),
      pill: unsavedPill('slack') ?? h('span', { class: 'pill' }, v.channel ? channelName(v) : 'No channel'),
    },
      isOpen && [
        h('p', { class: 'sub' }, channelText(v)),
        h('div', { class: 'slack-more' },
          channelPicker.el,
          h('div', { class: 'card-foot' },
            h('button', { type: 'button', class: 'btn btn-open', onclick: saveChannel }, 'Save channel'),
            v.channel && h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { channelPicker = W.slackChannelPicker({ value: '', id: 'slack-channel-search' }); render(); } }, 'No channel'))),
        slackNoteOn('pulls'),
        limitsBlock('slack'),
      ]);
  }

  function questionsRow(v) {
    const state = data.webhooks?.slack;
    // Only where the console answers questions at all: a Slack bot, and somewhere for a question's session to run.
    if (!state) return null;
    const on = !state.off;
    const reaches = data.webhooks.receiving || state.off;
    let text;
    if (!reaches) text = 'Mentions of the bot do not reach this console: it has no webhook receiver.';
    else if (!on) text = `Off${state.at ? ` since ${W.when(state.at)}${state.by && state.by !== 'console' ? `, by ${state.by}` : ''}` : ''}: ${SLACK_SWITCH.off(state.dropped ? ` (${state.dropped} so far)` : '')}`;
    else text = `${v.bot?.name ? `Mentions of @${v.bot.name}` : 'Mentions of the bot'} are answered, each in a session that reads the default branch and changes nothing.${v.lastMention ? ` Last one ${W.ago(v.lastMention)}.` : ''}`;
    return row({
      id: 'slack-questions', title: 'Questions', value: text,
      pill: unsavedPill('questions') ?? (!reaches ? h('span', { class: 'pill is-warn' }, 'Not reached') : on ? h('span', { class: 'pill is-ok' }, 'On') : h('span', { class: 'pill' }, 'Off')),
    },
      reaches && h('div', { class: `toggle-row webhook-switch${on ? '' : ' is-off'}` },
        h('button', {
          type: 'button', class: 'switch-ui', role: 'switch', 'aria-checked': String(on), 'aria-labelledby': 'webhooks-switch-slack', disabled: Boolean(switching),
          onclick: () => flipWebhooks('slack', on),
        }),
        h('span', { class: 'toggle-label', id: 'webhooks-switch-slack' }, SLACK_SWITCH.label),
        h('p', { class: 'sub' }, on ? SLACK_SWITCH.on : text),
        switchError?.source === 'slack' && h('p', { class: 'form-error', role: 'alert' }, switchError.text)),
      !reaches && h('p', { class: 'sub' }, text),
      !v.signingSecret && h('p', { class: 'cap-note' }, 'No signing secret is saved, so every mention is refused before it reaches the console: Replace keys, on the Bot row, to add it.'),
      !v.eventsUrl && h('p', { class: 'sub' }, 'This console does not know its events Request URL: the Set up Slack dialog says where to find it.'),
      limitsBlock('questions'));
  }

  function slackGroup() {
    if (!slackView && !slackError) return null;
    const v = slackView;
    const what = 'Post each pull request a shared session opens to a channel, and answer questions people ask the bot.';
    const about = { id: 'card-slack', label: 'Slack', note: v?.connected ? what : null };
    if (!v) return group(about, row({ id: 'slack-setup', title: 'Slack', value: h('span', { class: 'form-error', role: 'alert' }, `Could not load it: ${slackError}`), pill: h('span', { class: 'pill is-bad' }, 'Not loaded') }));
    // Not set up, it is one line with its button: there is nothing to open yet.
    if (!v.connected) {
      return group(about, line(['Slack ', h('span', { class: 'pill' }, 'Not set up')],
        [
          what,
          !v.available && [' This console has no secret store to keep Slack\'s keys in. Choose one on ', h('a', { href: '/secrets' }, 'Secrets & webhooks'), ' first.'],
          slackNoteOn('bot'),
        ],
        v.available && h('button', { type: 'button', class: 'btn btn-open', onclick: () => openSetup(v.install ? 'choose' : 'own') }, 'Set up Slack'),
        { id: 'slack-setup' }));
    }
    return group(about, botRow(v), pullsRow(v), questionsRow(v));
  }

  // Each source of webhooks, switched off on its own (webhookSwitch.mjs). No typed confirm: a switch is undone by
  // turning it back, and is logged with who turned it. Only where webhooks reach the console at all, or while one is off.
  // What only a GitHub webhook starts: the poll finds none of it (webhookDispatch.pollMisses).
  const WEBHOOK_ONLY = 'QA labels, QA after a review, the automatic QA label, reviews started by a commit\'s tag and Needs a human messages to the assignee';
  const GITHUB_SWITCH = {
    source: 'github', label: 'GitHub webhooks',
    on: `On: labels, comments and pull request changes reach the console within seconds. Off, it polls GitHub instead, which finds only the session label and /woodshed comments, within a minute. ${WEBHOOK_ONLY} stop until it is on again.`,
    off: (dropped) => `the console drops each GitHub delivery${dropped} and polls GitHub, so the session label and /woodshed comments take up to a minute. ${WEBHOOK_ONLY} have stopped.`,
  };
  // The Slack group's Questions switch: the same switch as GitHub's, for mentions of the bot.
  const SLACK_SWITCH = {
    source: 'slack', label: 'Answer questions',
    on: 'On: the console answers each mention of its Slack bot in a session of its own. Off, it drops them.',
    off: (dropped) => `the console drops each mention of its Slack bot${dropped}, so questions in Slack go unanswered. Webhook events lists them as ignored.`,
  };
  let switching = null;
  let switchError = null;

  async function flipWebhooks(source, off) {
    switching = source;
    switchError = null;
    render();
    try {
      data = { ...data, ...(await W.postJson('/api/console-settings/webhooks', { source, off })) };
    } catch (err) {
      switchError = { source, text: err.message };
    }
    switching = null;
    render();
  }

  // GitHub's webhooks: a line with its switch on it, applied as it is turned. Slack's questions are switched on the
  // Slack group's Questions row.
  function webhooksLine() {
    const s = GITHUB_SWITCH;
    const state = data.webhooks?.[s.source];
    if (!state || (!data.webhooks.receiving && !state.off)) return null;
    const on = !state.off;
    const since = state.at ? ` since ${W.when(state.at)}${state.by && state.by !== 'console' ? `, by ${state.by}` : ''}` : '';
    return line(s.label,
      [
        on ? s.on : `Off${since}: ${s.off(state.dropped ? ` (${state.dropped} so far)` : '')}`, ' ',
        h('a', { href: '/events' }, 'Webhook events'), ' lists what came in.',
        switchError?.source === s.source && h('p', { class: 'form-error', role: 'alert', style: 'margin: 4px 0 0' }, switchError.text),
      ],
      h('button', {
        type: 'button', class: 'switch-ui', role: 'switch', 'aria-checked': String(on), 'aria-label': s.label, disabled: Boolean(switching),
        onclick: () => flipWebhooks(s.source, on),
      }),
      { id: 'card-webhooks' });
  }

  // Whether a field of the page is being typed in: a draw the person did not ask for would take the caret out of it.
  const typing = () => Boolean(document.activeElement?.closest?.('.settings-page') && document.activeElement.matches('input, textarea'));

  // Fields render as they are typed in, so a Save turns on before the field loses focus: the page is drawn again with
  // the same field focused, its caret where it was. A row's head is a new node after the draw, found by its id. A render
  // that starts inside another (a blur the swap fired) is skipped, since the outer one draws the same state.
  let rendering = false;
  function render() {
    if (rendering) return;
    rendering = true;
    const focused = document.activeElement?.id || null;
    let caret = null;
    try { caret = [document.activeElement.selectionStart, document.activeElement.selectionEnd]; } catch { /* a number field has none */ }
    try {
      draw();
    } finally {
      rendering = false;
    }
    const again = focused && document.getElementById(focused);
    if (!again) return;
    again.focus();
    try { if (caret?.[0] !== null && caret?.[0] !== undefined) again.setSelectionRange(...caret); } catch { /* a number field has none */ }
  }

  function draw() {
    const head = h('header', { class: 'page-head' },
      h('div', null,
        h('h1', { class: 'title' }, 'Settings ', W.scopePill('/console-settings')),
        W.settingsTabs('/console-settings'),
        h('p', { class: 'sub' }, 'For every shared session on this console, and only admins can change them. A change applies on the console\'s next check, and is logged with who made it. Your own settings, for your My Woodshed sessions, are on ', h('a', { href: '/settings' }, 'My settings'), '.')));
    if (!data) {
      app.replaceChildren(h('div', { class: 'page settings-page' }, life.nav('/console-settings'), head,
        h('p', { class: 'empty' }, loadError ? `Could not load the settings: ${loadError}` : 'Loading settings…')));
      return;
    }
    // What the console is, the repos it works on, how its sessions run and what they keep, then what it talks to.
    app.replaceChildren(h('div', { class: 'page settings-page' }, life.nav('/console-settings'), head,
      group({ id: 'set-console', label: 'This console' }, updatesRow(), webhooksLine()),
      projectsGroup(),
      group({ id: 'card-sessions', label: 'Shared sessions' }, sessionRows()),
      group({ id: 'set-kept', label: 'Kept sessions' }, retentionRow(), dataRow()),
      slackGroup(),
      mcpGroup()));
  }

  // A link that names a row or a group opens it and lands on it once it is drawn: the groups come in their own
  // answers, so the browser's own scroll finds nothing. The names links used before the rows still work.
  const ALIASES = { slack: 'card-slack', webhooks: 'card-webhooks' };
  let asked = typeof location !== 'undefined' && location.hash ? location.hash.slice(1) : null;
  if (asked) {
    asked = ALIASES[asked] ?? asked;
    open.add(asked);
    // A link to the repos is most often followed to add one.
    if (asked === 'card-projects') open.add('repos-add');
  }
  // Called after each of the load's draws: a group drawn later above the target would push it down the page again.
  function showAsked() {
    if (asked) document.getElementById(asked)?.scrollIntoView?.({ block: 'start' });
  }

  async function load() {
    try {
      data = await W.getJson('/api/console-settings');
      loadError = null;
    } catch (err) {
      loadError = err.message;
    }
    // With no repo yet, the one thing to do is add one.
    if (data?.projects && !data.projects.length) open.add('repos-add');
    await loadMcp();
    render();
    showAsked();
    if (data?.projects) await loadRepoChoices();
    await loadSlack();
    render();
    showAsked();
    await loadUpdates();
    render();
    showAsked();
    asked = null;
    scheduleUpdates();
  }

  // Only the list: the rows keep what is typed into them.
  async function refreshData() {
    try {
      const next = await W.getJson('/api/console-settings');
      data = { ...data, data: next.data, projects: next.projects, palette: next.palette };
    } catch {
      return;
    }
    // Redrawing the page would take the caret out of a field being typed in.
    if (typing()) return;
    render();
  }

  // The search opens the row it found, and a link to a row followed while the page is shown opens it (settingsRows.js).
  follow(life);
  // Someone who scrolls while the page loads has left the link's target: the later draws do not take them back.
  for (const type of ['wheel', 'touchmove', 'keydown']) life.on(window, type, () => { asked = null; });
  // The names links used before the rows, followed while the page is shown, land on their rows too.
  life.on(window, 'hashchange', () => {
    const id = ALIASES[location.hash.slice(1)];
    if (!id) return;
    reveal(id);
    document.getElementById(id)?.scrollIntoView?.({ block: 'start' });
  });

  // Drawn at once, saying it loads, so the page never sits empty while the settings are on its way.
  render();
  load();
  life.interval(refreshData, DATA_REFRESH_MS);
  // Back from GitHub, where the App may have been given another repo.
  life.on(document, 'visibilitychange', () => {
    if (document.visibilityState === 'visible' && data?.projects && !repoForm.busy) loadRepoChoices();
  });
});
