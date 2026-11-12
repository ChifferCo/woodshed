// The Console settings page: the limits, retention numbers and Slack channel, one save per card, each behind the
// typed confirm; then the sessions holding data, and anything stalled, with what fixes it. The data list is read
// again every minute; the cards are left alone, so a half-typed change survives.
(function () {
  'use strict';
  const W = window.Woodshed;
  const { h } = W;
  const DATA_REFRESH_MS = 60_000;
  const CARDS = [
    { id: 'sessions', title: 'Sessions', note: 'How many shared sessions run at once, and when one stops by itself. Its work is pushed first, and Resume picks it up where it was.' },
    { id: 'questions', title: 'Questions from Slack', note: 'Sessions that answer a mention of the bot. Each reads the default branch and changes nothing, and its conversation is kept for a follow-up in its thread.' },
    { id: 'retention', title: 'Retention', note: 'How long a stopped shared session keeps its conversation and databases, so it can be resumed. After that the branch alone stays, on GitHub, and the card says Deleted until it is taken off the list.' },
    { id: 'slack', title: 'Slack', note: 'Each pull request a shared session opens is posted once it passed what the repo\'s project file asks of it (pullRequests: its review approved and its suites passed), with its decision brief in the thread of the post once its QA check finished. It goes to its repo\'s own channel when the Repos card gives one, and to the channel below otherwise. The bot token is on Secrets & webhooks.' },
  ];
  const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
  const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  const CHANNEL_RE = /^[CG][A-Z0-9]{8,}$/;

  let data = null;
  let loadError = null;
  // What has been typed into each field, by setting key (and `slackChannel`), until it is saved or reloaded.
  const typed = new Map();
  // What the last save on each settings card said: {text, bad}.
  const notices = new Map();
  // Each card or row whose save is on its way, so a second click does not send it twice.
  const saving = new Set();
  // What the last Slack channel save or Remove on a repo's row said, by project name, until the page is drawn again.
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

  function channelProblem(raw) {
    const value = String(raw).trim();
    return value && !CHANNEL_RE.test(value) ? 'Give the channel\'s ID, such as C0123456789, not its name.' : null;
  }

  // The fields of a card that differ from what is saved, and whether any of them is no good.
  function pending(cardId) {
    const changes = [];
    let bad = false;
    for (const s of data.settings.filter((x) => x.group === cardId)) {
      if (!typed.has(s.key)) continue;
      const raw = typed.get(s.key);
      if (problem(s, raw)) bad = true;
      else if (Number(raw) !== s.value) changes.push({ key: s.key, label: s.label, from: `${s.value} ${s.unit}`, to: `${Number(raw)} ${s.unit}`, value: Number(raw) });
    }
    if (cardId === 'slack' && data.slack && typed.has('slackChannel')) {
      const raw = typed.get('slackChannel').trim();
      if (channelProblem(raw)) bad = true;
      else if (raw !== data.slack.channel) changes.push({ key: 'slackChannel', label: 'Channel', from: data.slack.channel || 'none', to: raw || 'none', value: raw });
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

  function channelRow() {
    const raw = typed.has('slackChannel') ? typed.get('slackChannel') : data.slack.channel;
    const bad = typed.has('slackChannel') ? channelProblem(raw) : null;
    const changed = !bad && raw.trim() !== data.slack.channel;
    return h('div', { class: `set-row${changed ? ' is-changed' : ''}${bad ? ' is-bad' : ''}` },
      h('div', null,
        h('label', { class: 'set-name', for: 'set-channel' }, 'Channel'),
        h('div', { class: 'set-help' }, 'Its ID, at the bottom of the channel\'s About tab. Invite the bot to it first. Empty turns the posts off.'),
        h('div', { class: 'set-bounds' }, data.slack.channel ? `posting to ${data.slack.channel}` : 'nothing is posted')),
      h('div', { class: 'set-value' },
        h('input', {
          id: 'set-channel', class: 'field is-text', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'C0123456789', value: raw,
          'aria-invalid': bad ? 'true' : null,
          oninput: (e) => { typed.set('slackChannel', e.target.value); render(); },
        })),
      bad && h('p', { class: 'form-error', role: 'alert' }, bad));
  }

  async function save(card) {
    const { changes } = pending(card.id);
    if (saving.has(card.id) || !changes.length) return;
    saving.add(card.id);
    render();
    try {
      const values = Object.fromEntries(changes.filter((c) => c.key !== 'slackChannel').map((c) => [c.key, c.value]));
      const channel = changes.find((c) => c.key === 'slackChannel');
      data = { ...data, ...(await W.postJson('/api/console-settings', { values, ...(channel ? { slackChannel: channel.value } : {}) })) };
      for (const c of changes) typed.delete(c.key);
      notices.set(card.id, { text: `Saved. ${changes.map((c) => `${c.label}: ${c.from} → ${c.to}`).join('; ')}. Applies on the next check, with no restart.` });
    } catch (err) {
      notices.set(card.id, { text: err.message, bad: true });
    }
    saving.delete(card.id);
    render();
  }

  function settingsCard(card) {
    const rows = data.settings.filter((s) => s.group === card.id);
    const { changes, bad } = pending(card.id);
    return h('section', { class: 'settings-card', 'aria-labelledby': `card-${card.id}` },
      h('h2', { id: `card-${card.id}`, class: 'label' }, card.title),
      h('p', { class: 'sub' }, card.note),
      card.id === 'sessions' && W.providerWords.capacityNote && h('p', { class: 'cap-note' }, W.providerWords.capacityNote),
      h('div', { class: 'set-rows' }, rows.map(settingRow), card.id === 'slack' && data.slack && channelRow()),
      h('div', { class: 'card-foot' },
        h('button', { type: 'button', class: 'btn btn-open', disabled: bad || !changes.length || saving.has(card.id), onclick: () => save(card) },
          saving.has(card.id) ? 'Saving…' : changes.length > 1 ? `Save ${changes.length} changes` : 'Save'),
        notices.get(card.id)?.bad && !bad
          ? h('span', { class: 'form-error', role: 'alert' }, notices.get(card.id).text)
          : h('span', { class: 'sub', role: 'status' }, bad ? 'Fix the value in red first.'
            : changes.length ? `${changes.length} changed. Takes effect on the next check, with no restart.`
              : notices.get(card.id)?.text || 'Saved values. Each change is logged with who made it.')));
  }

  // The repos sessions can start on: the installation's own (read-only here), and the ones added on this page.
  // `error` is {message, link?}: the server's refusal, shown under the field with the page that fixes it.
  const repoForm = { repo: '', name: '', error: null, notice: null, busy: false };
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

  // A repo's own Slack channel, one field per row: empty sends its pull requests to the Slack card's channel.
  function channelField(p) {
    const key = `channel:${p.name}`;
    const saved = p.slackChannel ?? '';
    const raw = typed.has(key) ? typed.get(key) : saved;
    const bad = channelProblem(raw);
    const next = raw.trim();
    return [
      h('input', {
        id: `channel-${p.name}`, class: 'field is-text', type: 'text', autocomplete: 'off', spellcheck: 'false', size: 13, placeholder: 'Slack channel ID', value: raw,
        'aria-label': `Slack channel for ${p.repo}`, 'aria-invalid': bad ? 'true' : null, title: bad || 'Its pull requests go here. Empty: the Slack card\'s channel.',
        oninput: (e) => { typed.set(key, e.target.value); render(); },
      }),
      h('button', {
        type: 'button', class: 'btn btn-quiet btn-sm', disabled: Boolean(bad) || next === saved,
        onclick: () => rowAction(p, async () => {
          data = { ...data, ...(await W.postJson('/api/console-settings/projects/slack-channel', { name: p.name, channel: next })) };
          typed.delete(key);
          return `Its next pull request goes to ${next || 'the Slack card\'s channel'}. Invite the bot to the channel first.`;
        }),
      }, 'Save'),
    ];
  }

  function projectRow(p) {
    const live = p.sessions ? `${p.sessions} ${p.sessions === 1 ? 'session' : 'sessions'} running or kept` : 'no sessions running';
    return h('div', { class: 'data-row' },
      h('div', { style: 'min-width: 0' },
        h('div', { class: 'data-title' }, h('b', null, p.repo), h('span', { class: 'rref' }, p.name)),
        h('div', { class: 'data-meta' },
          h('span', null, p.default ? 'default project' : p.removable ? `added by @${p.addedBy || 'unknown'}` : 'set in the installation\'s configuration'),
          h('span', null, live),
          data.slack && h('span', null, p.slackChannel ? `PRs to ${p.slackChannel}` : 'PRs to the Slack card\'s channel')),
        data.palette && colorPicker(p)),
      h('div', { class: 'data-actions' }, data.slack && channelField(p), p.removable && h('button', {
        type: 'button', class: 'btn btn-quiet btn-sm', disabled: p.sessions > 0, title: p.sessions ? 'Stop or delete its sessions first' : null,
        onclick: () => rowAction(p, async () => {
          data = { ...data, ...(await W.postJson('/api/console-settings/projects/remove', { name: p.name })) };
          loadRepoChoices();
          repoForm.error = null;
          repoForm.notice = `${p.repo} removed: new sessions can no longer start on it. Its pull requests and branches on GitHub are not touched. Add it again to undo.`;
          return null;
        }),
      }, 'Remove')),
      rowNotes.get(p.name) && h('p', { class: rowNotes.get(p.name).bad ? 'form-error' : 'sub', role: rowNotes.get(p.name).bad ? 'alert' : 'status', style: 'grid-column: 1 / -1; margin: 0' }, rowNotes.get(p.name).text));
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
      repoForm.error = { message: picking() ? 'Choose a repo first.' : 'Give the repo as owner/name, such as acme/api.' };
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
      repoForm.notice = `${repo} added: sessions can start on it now. Remove takes it off again.`;
      loadRepoChoices();
    } catch (err) {
      repoForm.error = err;
    }
    repoForm.busy = false;
    render();
  }

  const picking = () => Array.isArray(repoChoices?.repos);

  function repoSelect() {
    const repos = repoChoices.repos;
    return h('select', {
      id: 'repo-new', class: 'field is-repo', 'aria-invalid': repoForm.error ? 'true' : null, disabled: repos.length === 0,
      onchange: (e) => { repoForm.repo = e.target.value; },
    },
    h('option', { value: '', selected: !repoForm.repo }, repos.length ? 'Choose a repo' : 'No repo left to add'),
    repos.map((r) => h('option', { value: r.repo, selected: r.repo === repoForm.repo }, r.private ? `${r.repo} (private)` : r.repo)));
  }

  // Where the App is given more repos: each account's installation settings, or the App's install page for another
  // account. A repo granted there shows here once the list is read again, on List again or when the tab comes back.
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
      if (picking() && repoForm.repo && !repoChoices.repos.some((r) => r.repo === repoForm.repo)) repoForm.repo = '';
    } catch (err) {
      repoChoices = null;
      repoChoicesError = err.message;
    }
    if (data) render();
  }

  function projectsCard() {
    if (!data.projects) return null;
    return h('section', { class: 'settings-card', 'aria-labelledby': 'card-projects' },
      h('h2', { id: 'card-projects', class: 'label' }, 'Repos'),
      h('p', { class: 'sub' }, 'The repos sessions can start on. The default one is what questions from Slack, the poll and the database check use. The GitHub App must be given access to a repo before it is added here. An added repo applies at once, with no restart. With more than one, each repo\'s colour marks its sessions on the rail: pick one and it is saved at once. A repo\'s Slack channel takes its pull requests; empty sends them to the Slack card\'s channel.'),
      data.projects.length ? h('div', { class: 'data-list' }, data.projects.map(projectRow))
        : h('p', { class: 'cap-note' }, 'No repo yet, so no session can start. The first one added becomes the default.'),
      h('div', { class: `set-row${repoForm.error ? ' is-bad' : ''}`, style: 'margin-top: 8px' },
        h('div', null,
          h('label', { class: 'set-name', for: 'repo-new' }, 'Add a repo'),
          h('div', { class: 'set-help' }, picking()
            ? 'One of the repos the GitHub App may reach. The name sessions show for it is the repo\'s own, unless you give one.'
            : 'As owner/name. The name sessions show for it is the repo\'s own, unless you give one.')),
        h('div', { class: 'set-value' },
          picking() ? repoSelect() : h('input', {
            id: 'repo-new', class: 'field is-text', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'owner/name', value: repoForm.repo,
            'aria-invalid': repoForm.error ? 'true' : null,
            oninput: (e) => { repoForm.repo = e.target.value; },
            onkeydown: (e) => { if (e.key === 'Enter') addRepo(); },
          }),
          h('input', {
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

  function dataCard() {
    const d = data.data;
    if (!d) return null;
    const nothing = !d.held.length && !d.stalled.length;
    return h('section', { class: 'settings-card', 'aria-labelledby': 'card-data' },
      h('h2', { id: 'card-data', class: 'label' }, 'Sessions holding data'),
      h('p', { class: 'sub' }, 'Shared sessions that are stopped but keep their conversation and databases, and anything left behind or stuck. Checked again every minute.'),
      nothing && h('p', { class: 'empty-ok' }, 'Nothing is held or stalled.'),
      d.stalled.length > 0 && [
        h('div', { class: 'sub-head' }, 'Stalled', h('span', { class: 'count' }, d.stalled.length)),
        h('div', { class: 'data-list' }, d.stalled.map(stalledRow))],
      d.held.length > 0 && [
        h('div', { class: 'sub-head' }, 'Kept, waiting to be resumed or deleted', h('span', { class: 'count' }, d.held.length)),
        h('div', { class: 'data-list' }, d.held.map(heldRow))],
      h('p', { class: 'sub', style: 'font-size: 12.5px' }, totalsLine(d)));
  }

  // Fields render as they are typed in, so a Save turns on before the field loses focus: the page is drawn again with
  // the same field focused, its caret where it was. A render that starts inside another (a blur the swap fired) is
  // skipped, since the outer one draws the same state.
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
    const app = document.getElementById('app');
    const head = h('header', { class: 'page-head' },
      h('div', null,
        h('h1', { class: 'title' }, 'Console settings'),
        h('p', { class: 'sub' }, 'Only admins can change these. A change applies on the console\'s next check, and is logged with who made it.')));
    if (!data) {
      app.replaceChildren(h('div', { class: 'page' }, W.nav('/console-settings'), head,
        h('p', { class: 'empty' }, loadError ? `Could not load the settings: ${loadError}` : 'Loading settings…')));
      return;
    }
    app.replaceChildren(h('div', { class: 'page' }, W.nav('/console-settings'), head, projectsCard(), CARDS.map(settingsCard), dataCard()));
  }

  async function load() {
    try {
      data = await W.getJson('/api/console-settings');
      loadError = null;
    } catch (err) {
      loadError = err.message;
    }
    render();
    if (data?.projects) await loadRepoChoices();
  }

  // Only the list: the cards keep what is typed into them.
  async function refreshData() {
    try {
      const next = await W.getJson('/api/console-settings');
      data = { ...data, data: next.data, projects: next.projects, palette: next.palette };
    } catch {
      return;
    }
    // Redrawing the page would take the caret out of a field being typed in.
    if (document.activeElement?.closest?.('.settings-card') && document.activeElement.matches('input')) return;
    render();
  }

  load();
  setInterval(refreshData, DATA_REFRESH_MS);
  // Back from GitHub, where the App may have been given another repo.
  document.addEventListener?.('visibilitychange', () => {
    if (document.visibilityState === 'visible' && data?.projects && !repoForm.busy) loadRepoChoices();
  });
})();
