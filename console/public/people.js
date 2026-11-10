// The People page: who may sign in, on top of write access to the repository. An admin can invite a handle, accept
// or decline someone asking to join, and remove another member; nobody else can open it. Read again every 30 seconds, so a
// request shows without a reload; the invite field keeps what is typed.
(function () {
  'use strict';
  const W = window.Woodshed;
  const { h } = W;
  const REFRESH_MS = 30_000;

  let data = null;
  let loadError = null;
  let me = null;
  // The member whose Slack link is being typed, and what is typed: kept across the 30-second refresh.
  let editing = null;
  const invite = h('input', { id: 'invite', class: 'field', placeholder: '@handle', autocomplete: 'off', spellcheck: 'false' });
  const inviteError = h('p', { class: 'form-error', role: 'alert', hidden: true });

  function isMe(login) {
    return W.sameLogin(me, login);
  }

  function day(iso) {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function who(login, line) {
    const named = data.names?.[login];
    return h('div', { class: 'who' },
      h('b', null, named || `@${login}`),
      h('div', { class: 'meta' }, [named && `@${login}`, line].filter(Boolean).join(' · ')));
  }

  async function act(action, login, button) {
    if (action === 'remove' && !window.confirm(`Remove @${login}? They are signed out at once, and can ask to join again.`)) return;
    if (button) button.disabled = true;
    try {
      data = await W.postJson(`/api/people/${action}`, { login });
      W.shell?.toast({ invite: `@${login} can sign in now`, accept: `@${login} is in`, decline: 'Declined', remove: `@${login} removed` }[action]);
    } catch (err) {
      if (action === 'invite') {
        inviteError.textContent = err.message;
        inviteError.hidden = false;
      } else {
        window.alert(`Not done: ${err.message}`);
      }
      if (button) button.disabled = false;
      return false;
    }
    render();
    return true;
  }

  function requestsCard() {
    if (!data.requests.length) return null;
    return h('section', { class: 'people-card is-asking' },
      h('div', { class: 'set-head' }, h('b', null, `Asking to join · ${data.requests.length}`)),
      data.requests.map((r) => h('div', { class: 'person-row' },
        who(r.login, `asked ${W.ago(r.askedAt)}`),
        h('button', { type: 'button', class: 'btn btn-open', onclick: (e) => act('accept', r.login, e.currentTarget) }, 'Accept'),
        h('button', { type: 'button', class: 'btn btn-quiet', onclick: (e) => act('decline', r.login, e.currentTarget) }, 'Decline'))));
  }

  function inviteCard() {
    const button = h('button', { type: 'submit', class: 'btn btn-stop' }, 'Invite');
    return h('form', {
      class: 'field-block',
      onsubmit: async (e) => {
        e.preventDefault();
        inviteError.hidden = true;
        const login = invite.value.trim().replace(/^@/, '');
        if (!login) return invite.focus();
        if (await act('invite', login, button)) invite.value = '';
      },
    },
      h('label', { class: 'field-label', for: 'invite' }, 'Invite by GitHub handle'),
      h('div', { class: 'invite-row' }, invite, button),
      inviteError,
      h('p', { class: 'foot' }, 'They can sign in straight away. Nothing is sent to them: tell them the link.'));
  }

  function addedLine(m) {
    if (m.how === 'first to sign in') return 'the first to sign in';
    if (m.how === 'already using the console') return `already using the console when the list started, ${day(m.addedAt)}`;
    const by = isMe(m.addedBy) ? 'you' : W.personText(m.addedBy);
    return `${m.how === 'accepted' ? 'accepted' : 'invited'} by ${by} · ${day(m.addedAt)}`;
  }

  async function saveSlack(login, value, button, error) {
    button.disabled = true;
    error.hidden = true;
    try {
      data = await W.postJson('/api/people/slack', { login, slack: value });
      editing = null;
      W.shell?.toast(value ? `@${login} is linked to Slack` : 'Slack link removed');
      render();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      button.disabled = false;
    }
  }

  function slackEditor(login, link) {
    const input = h('input', { class: 'field', placeholder: 'Search a name, or paste U01ABC2DEF3 or @handle', autocomplete: 'off', spellcheck: 'false', 'aria-label': `Slack user of @${login}` });
    const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const matches = h('div', { class: 'slack-matches', role: 'listbox', hidden: true });
    const save = h('button', { type: 'submit', class: 'btn btn-stop' }, 'Save');
    let timer = null;
    let asked = 0;
    function pick(user) {
      input.value = user.id;
      matches.hidden = true;
      saveSlack(login, user.id, save, error);
    }
    async function search() {
      const text = input.value.trim();
      const mine = ++asked;
      // A member ID (it has a digit, so `william` is a name) or an @handle is saved as typed; only a name is searched.
      if (text.length < 2 || /^@|^[UW](?=[A-Z0-9]*\d)[A-Z0-9]{6,}$/i.test(text)) { matches.hidden = true; return; }
      try {
        const { found, truncated } = await W.getJson(`/api/people/slack-search?q=${encodeURIComponent(text)}`);
        if (mine !== asked) return;
        matches.replaceChildren(...(found.length
          ? found.map((u) => h('button', { type: 'button', class: 'slack-match', role: 'option', onclick: () => pick(u) },
            h('b', null, u.name || u.handle), u.handle && u.name !== u.handle ? h('span', { class: 'meta' }, ` @${u.handle}`) : null))
          : [h('p', { class: 'foot' }, truncated ? 'No match among the first 2,000 Slack members: paste a member ID' : 'Nobody in Slack matches')]));
        matches.hidden = false;
      } catch (err) {
        if (mine !== asked) return;
        matches.hidden = true;
        error.textContent = err.message;
        error.hidden = false;
      }
    }
    input.addEventListener('input', () => { error.hidden = true; clearTimeout(timer); timer = setTimeout(search, 400); });
    return h('form', {
      class: 'slack-edit',
      onsubmit: (e) => {
        e.preventDefault();
        saveSlack(login, input.value, save, error);
      },
    },
      h('div', { class: 'invite-row' }, input, save,
        h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { editing = null; render(); } }, 'Cancel')),
      matches,
      error,
      h('p', { class: 'foot' }, link?.how === 'manual' ? 'Leave it empty to take the link away; the next sign-in matches by email again.' : 'Pick a person from the list, or paste a Slack member ID (profile, Copy member ID) or an @handle.'));
  }

  function slackLine(login) {
    const link = data.slack?.[login];
    if (data.slack === null) return null;
    const state = link
      ? h('span', null, link.name || link.slackId, link.how === 'manual' ? ' (set by hand)' : '')
      : h('span', { class: 'foot' }, 'Not linked');
    return h('div', { class: 'slack-line' }, state,
      h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { editing = login; render(); } }, link ? 'Change' : 'Link'));
  }

  // The table's switches, one column each. Can be assigned needs sessions from GitHub, so it is greyed out without it;
  // the console checks the same, and turning GitHub off turns it off too. Each starts off for a new member.
  const SWITCHES = [
    { field: 'admin', label: 'Admin', note: 'opens these pages', path: 'admin', body: (on) => ({ admin: on }),
      toast: (login, on) => (on ? `@${login} is an admin` : `@${login} is no longer an admin`) },
    { field: 'githubSessions', label: 'Sessions from GitHub', note: 'label, /woodshed, Everyone', path: 'github-sessions', body: (on) => ({ on }), split: true,
      toast: (login, on) => (on ? `@${login} can start sessions from GitHub` : `@${login} can no longer start sessions from GitHub`) },
    { field: 'assignable', label: 'Can be assigned', note: 'has shared sessions', path: 'assignable', body: (on) => ({ on }), needs: 'githubSessions',
      toast: (login, on) => (on ? `@${login} can be assigned sessions` : `@${login} cannot be assigned sessions`) },
  ];

  async function setSwitch(sw, login, on, box) {
    box.disabled = true;
    try {
      data = await W.postJson(`/api/people/${sw.path}`, { login, ...sw.body(on) });
      W.shell?.toast(sw.toast(login, on));
    } catch (err) {
      window.alert(`Not done: ${err.message}`);
      box.checked = !on;
      box.disabled = false;
      return;
    }
    render();
  }

  function switchCell(sw, m) {
    const on = Boolean(m[sw.field]);
    const blocked = sw.needs && !m[sw.needs];
    const by = m[`${sw.field}By`];
    const title = blocked ? 'Needs Sessions from GitHub first'
      : on && by ? `Turned on by ${isMe(by) ? 'you' : W.personText(by)}, ${day(m[`${sw.field}At`])}` : null;
    return h('td', { class: `switch-cell${sw.split ? ' is-split' : ''}`, title },
      h('input', {
        type: 'checkbox', checked: on, disabled: blocked, 'aria-label': `${sw.label}: @${m.login}`,
        onchange: (e) => setSwitch(sw, m.login, e.currentTarget.checked, e.currentTarget),
      }));
  }

  function memberRows(m) {
    const row = h('tr', null,
      h('td', null, who(m.login, addedLine(m))),
      SWITCHES.map((sw) => switchCell(sw, m)),
      data.slack !== null && h('td', null, slackLine(m.login)),
      h('td', { class: 'end-cell' }, isMe(m.login) ? h('span', { class: 'foot' }, 'you')
        : h('button', { type: 'button', class: 'btn btn-delete', onclick: (e) => act('remove', m.login, e.currentTarget) }, 'Remove')));
    if (editing !== m.login) return [row];
    return [row, h('tr', { class: 'edit-row' }, h('td', { colspan: String(SWITCHES.length + 3) }, slackEditor(m.login, data.slack?.[m.login])))];
  }

  function membersCard() {
    return h('section', { class: 'people-card' },
      h('div', { class: 'set-head' }, h('b', null, `Members · ${data.members.length}`),
        h('span', { class: 'foot' }, 'A tick is on. Each change saves at once; new members start with all of them off.')),
      h('div', { class: 'table-scroll' }, h('table', { class: 'people-table' },
        h('thead', null, h('tr', null,
          h('th', { scope: 'col' }, 'Member'),
          SWITCHES.map((sw) => h('th', { scope: 'col', class: `switch-cell${sw.split ? ' is-split' : ''}` }, sw.label, h('div', { class: 'th-note' }, sw.note))),
          data.slack !== null && h('th', { scope: 'col' }, 'Slack'),
          h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Remove')))),
        h('tbody', null, data.members.flatMap(memberRows)))));
  }

  function render() {
    const app = document.getElementById('app');
    const head = h('header', { class: 'page-head' },
      h('div', null,
        h('h1', { class: 'title' }, 'People'),
        h('p', { class: 'sub' }, 'Only these people can sign in, and each still needs write access to the repository. Admins choose what each member can do.')));
    const body = data ? [requestsCard(), inviteCard(), membersCard()]
      : h('p', { class: 'empty' }, loadError ? `Could not load the list: ${loadError}` : 'Loading…');
    app.replaceChildren(h('div', { class: 'page' }, W.nav('/people'), head, body));
  }

  async function load() {
    try {
      const [people, meReply] = await Promise.all([W.getJson('/api/people'), me ? null : W.getJson('/api/me')]);
      data = people;
      if (meReply) me = meReply.login;
      loadError = null;
    } catch (err) {
      loadError = err.message;
    }
    // A refresh leaves the page alone while the invite field has the focus, or a Slack link is being typed, so typing is never interrupted.
    if (document.activeElement !== invite && !editing) render();
  }

  render();
  load();
  setInterval(load, REFRESH_MS);
})();
