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
    { id: 'slack', title: 'Slack', note: 'Each pull request a shared session opens is posted once it passed what the repo\'s project file asks of it (pullRequests: its review approved and its suites passed), with its decision brief in the thread of the post once its QA check finished. The bot token is on Secrets & webhooks.' },
  ];
  const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
  const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  const CHANNEL_RE = /^[CG][A-Z0-9]{8,}$/;

  let data = null;
  let loadError = null;
  // What has been typed into each field, by setting key (and `slackChannel`), until it is saved or reloaded.
  const typed = new Map();
  const notices = new Map();

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
          id: `set-${s.key}`, class: 'field', type: 'number', inputmode: 'decimal', min: s.min, max: s.max, step: s.step, value: raw,
          'aria-invalid': bad ? 'true' : null,
          oninput: (e) => { typed.set(s.key, e.target.value); },
          onchange: (e) => { typed.set(s.key, e.target.value); render(); },
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
          oninput: (e) => { typed.set('slackChannel', e.target.value); },
          onchange: (e) => { typed.set('slackChannel', e.target.value); render(); },
        })),
      bad && h('p', { class: 'form-error', role: 'alert' }, bad));
  }

  function review(card) {
    const { changes } = pending(card.id);
    W.confirmChange({
      title: `Change ${changes.length} setting${changes.length > 1 ? 's' : ''}?`,
      rows: changes.map((c) => [c.label, c.from, c.to]),
      effect: 'They apply on the console\'s next check, with no restart, to sessions already running too. Each change is logged with who made it.',
      word: 'settings',
      goLabel: 'Save',
      run: async () => {
        const values = Object.fromEntries(changes.filter((c) => c.key !== 'slackChannel').map((c) => [c.key, c.value]));
        const channel = changes.find((c) => c.key === 'slackChannel');
        data = { ...data, ...(await W.postJson('/api/console-settings', { values, ...(channel ? { slackChannel: channel.value } : {}) })) };
        for (const c of changes) typed.delete(c.key);
        notices.set(card.id, 'Saved.');
        render();
      },
    });
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
        h('button', { type: 'button', class: 'btn btn-open', disabled: bad || !changes.length, onclick: () => review(card) }, 'Review changes'),
        h('span', { class: 'sub' }, bad ? 'Fix the value in red first.'
          : changes.length ? `${changes.length} changed. Takes effect on the next check, with no restart.`
            : notices.get(card.id) || 'Saved values. Each change is logged with who made it.')));
  }

  // The repos sessions can start on: the installation's own (read-only here), and the ones added on this page.
  const repoForm = { repo: '', name: '', error: null, busy: false };

  function projectRow(p) {
    const live = p.sessions ? `${p.sessions} ${p.sessions === 1 ? 'session' : 'sessions'} running or kept` : 'no sessions running';
    return h('div', { class: 'data-row' },
      h('div', { style: 'min-width: 0' },
        h('div', { class: 'data-title' }, h('b', null, p.repo), h('span', { class: 'rref' }, p.name)),
        h('div', { class: 'data-meta' },
          h('span', null, p.default ? 'default project' : p.removable ? `added by @${p.addedBy || 'unknown'}` : 'set in the installation\'s configuration'),
          h('span', null, live))),
      h('div', { class: 'data-actions' }, p.removable && h('button', {
        type: 'button', class: 'btn btn-quiet btn-sm', disabled: p.sessions > 0, title: p.sessions ? 'Stop or delete its sessions first' : null,
        onclick: () => W.confirmChange({
          title: `Remove ${p.repo}?`,
          before: 'a project',
          after: 'not a project',
          effect: 'New sessions can no longer start on it. Its pull requests and branches on GitHub are not touched.',
          word: 'remove',
          goLabel: 'Remove',
          run: async () => {
            data = { ...data, ...(await W.postJson('/api/console-settings/projects/remove', { name: p.name })) };
            render();
          },
        }),
      }, 'Remove')));
  }

  function addRepo() {
    const repo = repoForm.repo.trim();
    const name = repoForm.name.trim();
    if (!REPO_RE.test(repo)) { repoForm.error = 'Give the repo as owner/name, such as acme/api.'; render(); return; }
    if (name && !NAME_RE.test(name)) { repoForm.error = 'The name is lowercase letters and digits, in words joined by single dashes.'; render(); return; }
    repoForm.error = null;
    W.confirmChange({
      title: `Add ${repo}?`,
      before: 'not a project',
      after: 'a project sessions can start on',
      effect: 'The console checks that the GitHub App is installed on it. A My Woodshed session can then start on it from New session. Shared sessions, the image and the databases stay the default project\'s.',
      word: 'add',
      goLabel: 'Add repo',
      run: async () => {
        data = { ...data, ...(await W.postJson('/api/console-settings/projects', { repo, name })) };
        repoForm.repo = '';
        repoForm.name = '';
        render();
      },
    });
  }

  function projectsCard() {
    if (!data.projects) return null;
    return h('section', { class: 'settings-card', 'aria-labelledby': 'card-projects' },
      h('h2', { id: 'card-projects', class: 'label' }, 'Repos'),
      h('p', { class: 'sub' }, 'The repos sessions can start on. The default one is what shared sessions use. The GitHub App must be installed on a repo before it is added here. An added repo applies at once, with no restart.'),
      h('div', { class: 'data-list' }, data.projects.map(projectRow)),
      h('div', { class: `set-row${repoForm.error ? ' is-bad' : ''}`, style: 'margin-top: 8px' },
        h('div', null,
          h('label', { class: 'set-name', for: 'repo-new' }, 'Add a repo'),
          h('div', { class: 'set-help' }, 'As owner/name. The name sessions show for it is the repo\'s own, unless you give one.')),
        h('div', { class: 'set-value' },
          h('input', {
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
        repoForm.error && h('p', { class: 'form-error', role: 'alert' }, repoForm.error)),
      h('div', { class: 'card-foot' },
        h('button', { type: 'button', class: 'btn btn-open', onclick: addRepo }, 'Add repo'),
        h('span', { class: 'sub' }, 'Each change is logged with who made it.')));
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

  function render() {
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
  }

  // Only the list: the cards keep what is typed into them.
  async function refreshData() {
    try {
      const next = await W.getJson('/api/console-settings');
      data = { ...data, data: next.data, projects: next.projects };
    } catch {
      return;
    }
    // Redrawing the page would take the caret out of a field being typed in.
    if (document.activeElement?.closest?.('.settings-card') && document.activeElement.matches('input')) return;
    render();
  }

  load();
  setInterval(refreshData, DATA_REFRESH_MS);
})();
