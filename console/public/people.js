// The People page: who may sign in, on top of write access to the repository. An admin can invite a handle, accept
// or decline someone asking to join, and remove another member; nobody else can open it. Read again every 30 seconds, so a
// request shows without a reload; the invite field keeps what is typed.
// It reads as the other settings pages do (settingsRows.js): Asking to join is a group of plain rows, Members a group
// whose box holds the table, a Role select and what that role can do, and inviting is the box's last row, which opens
// on its form with a role of its own. The roles, and what each gives, come from /api/people (peopleRoles.mjs).
// Behind a hosting proxy whose program hands over its list (`hosted` in /api/people), it is a tab of Settings: the
// program keeps who is in and whether each is an owner, so Add someone goes to it, and nobody asks to join.
// The program may say what it did on an add (`told`, an email sent), said in place of the hint that nothing is sent, and
// note something beside each person (`note`). Both are its plain text, drawn as text.
window.Woodshed.settingsPage('/people', (app, life) => {
  'use strict';
  const W = window.Woodshed;
  const { h } = W;
  const REFRESH_MS = 30_000;

  let data = null;
  let loadError = null;
  let me = null;
  // Known once /api/me or /api/people answers; until then the head is People's own.
  let hosted = false;
  // The member whose Slack link is being typed, and what is typed: kept across the 30-second refresh.
  let editing = null;
  // What the program said it did on the last add here, until the next one.
  let told = null;
  const invite = h('input', { id: 'invite', class: 'field', placeholder: '@handle', autocomplete: 'off', spellcheck: 'false' });
  const inviteError = h('p', { class: 'form-error', role: 'alert', hidden: true });
  // The role someone new is given, picked from a table of the roles and what each can do. Until one is picked it is
  // what someone new was before roles: behind a proxy Sessions from GitHub on and nothing else, on a console of its own
  // every switch off.
  let addAccess = null;
  const defaultAccess = () => (hosted ? 'contributor' : 'private');

  const { row, group, draw, follow } = window.WoodshedSettingsRows.create({ render });

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

  async function act(action, login, button, extra = {}) {
    const removing = hosted ? `Remove @${login}? They lose access at once.` : `Remove @${login}? They are signed out at once, and can ask to join again.`;
    if (action === 'remove' && !window.confirm(removing)) return;
    if (button) button.disabled = true;
    try {
      data = await W.postJson(`/api/people/${action}`, { login, ...extra });
      if (action === 'add') told = typeof data.told === 'string' && data.told ? data.told : null;
      W.shell?.toast({ invite: `@${login} can sign in now`, add: `@${login} can sign in now`, accept: `@${login} is in`, decline: 'Declined', remove: `@${login} removed` }[action]);
    } catch (err) {
      if (action === 'invite' || action === 'add') {
        inviteError.textContent = err.message;
        inviteError.hidden = false;
        // The last add's sentence is not this one's: the hint goes back to core's own beside the error.
        if (action === 'add' && told) {
          told = null;
          render();
        }
      } else {
        window.alert(`Not done: ${err.message}`);
      }
      if (button) button.disabled = false;
      return false;
    }
    render();
    return true;
  }

  // One plain row per person asking, with the answer on the row: there is nothing to open.
  function requestsGroup() {
    if (hosted || !data.requests.length) return null;
    return group({ id: 'requests', label: `Asking to join · ${data.requests.length}` },
      data.requests.map((r) => {
        const named = data.names?.[r.login];
        return row({
          id: `request-${r.login}`, title: named || `@${r.login}`, value: [named && `@${r.login}`, `asked ${W.ago(r.askedAt)}`].filter(Boolean).join(' · '),
          pill: h('span', { class: 'person-acts' },
            h('button', { type: 'button', class: 'btn btn-open', onclick: (e) => act('accept', r.login, e.currentTarget) }, 'Accept'),
            h('button', { type: 'button', class: 'btn btn-quiet', onclick: (e) => act('decline', r.login, e.currentTarget) }, 'Decline')),
        });
      }));
  }

  // The last row of Members' box, which opens on the form. Behind a hosting proxy it takes a handle and a role, kept by
  // the program.
  function inviteRow() {
    const action = hosted ? 'add' : 'invite';
    const button = h('button', { type: 'submit', class: 'btn btn-stop' }, hosted ? 'Add someone' : 'Invite');
    const hint = h('p', { class: 'foot', id: 'add-hint' },
      `They can sign in straight away. ${told || 'Nothing is sent to them: tell them the link.'}`);
    return row({
      id: 'invite-card', title: hosted ? 'Add someone' : 'Invite someone',
      value: hosted ? 'By GitHub handle, with a role' : 'By GitHub handle, with a role. They need write access to the repository',
    },
      h('form', {
        class: 'field-block', id: 'invite-form',
        onsubmit: async (e) => {
          e.preventDefault();
          inviteError.hidden = true;
          const login = invite.value.trim().replace(/^@/, '');
          if (!login) return invite.focus();
          if (await act(action, login, button, { access: addAccess ?? defaultAccess() })) invite.value = '';
        },
      },
        h('label', { class: 'field-label', for: 'invite' }, hosted ? 'Add someone by GitHub handle' : 'Invite by GitHub handle'),
        h('div', { class: 'invite-row' }, invite),
        rolePicker(),
        h('div', { class: 'invite-send' }, button),
        inviteError,
        hint));
  }

  // The roles as a table, one row each with what it can do: picking a row is picking the role.
  function rolePicker() {
    const roles = data?.roles ?? [];
    if (!roles.length) return null;
    const current = addAccess ?? defaultAccess();
    const word = (on) => (on ? 'Yes' : 'No');
    const pick = (id) => { addAccess = id; render(); };
    return h('fieldset', { class: 'role-pick', id: 'add-role' },
      h('legend', { class: 'field-label' }, 'Role'),
      h('div', { class: 'table-scroll' }, h('table', null,
        h('thead', null, h('tr', null,
          h('th', { scope: 'col' }, 'Role'),
          h('th', { scope: 'col' }, 'Private sessions'),
          h('th', { scope: 'col' }, 'Settings pages'),
          h('th', { scope: 'col' }, 'Sessions from GitHub'),
          h('th', { scope: 'col' }, 'Can be assigned'),
          h('th', { scope: 'col' }, 'What they can do'))),
        h('tbody', null, roles.map((r) => h('tr', { class: r.id === current ? 'is-picked' : null, onclick: () => pick(r.id) },
          h('td', null, h('label', null,
            h('input', { type: 'radio', name: 'add-role', value: r.id, checked: r.id === current, onchange: () => pick(r.id) }),
            ' ', h('b', null, r.label))),
          h('td', { class: r.privateSessions ? 'is-yes' : 'is-no' }, word(r.privateSessions)),
          h('td', { class: r.admin ? 'is-yes' : 'is-no' }, word(r.admin)),
          h('td', { class: r.githubSessions ? 'is-yes' : 'is-no' }, word(r.githubSessions)),
          h('td', { class: r.assignable ? 'is-yes' : 'is-no' }, word(r.assignable)),
          h('td', { class: 'foot' }, r.explain)))))));
  }

  function addedLine(m) {
    if (hosted) return m.note || null;
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

  const roleNamed = (id) => (data?.roles ?? []).find((r) => r.id === id) ?? null;

  // A role sets the person's three switches at once (Admin or the program's owner, Sessions from GitHub, Can be assigned).
  async function setAccess(login, access, was, select) {
    select.disabled = true;
    try {
      data = await W.postJson('/api/people/access', { login, access });
      W.shell?.toast(`@${login} is ${/^[aeiou]/i.test(roleNamed(access)?.label ?? '') ? 'an' : 'a'} ${roleNamed(access)?.label ?? access}`);
    } catch (err) {
      window.alert(`Not done: ${err.message}`);
      select.value = was;
      select.disabled = false;
      return;
    }
    render();
  }

  // An owner whose switches are not all on (a hosted owner, or an admin from before roles) is "Owner (partly)", an
  // option of its own that is not Owner, so picking Owner sends the change and turns the rest on.
  function roleCell(m) {
    const partly = Boolean(m.accessDiffers);
    const shown = partly ? '' : m.access;
    return h('td', { class: 'switch-cell' },
      h('select', { class: 'field', 'aria-label': `Role: @${m.login}`, onchange: (e) => e.currentTarget.value && setAccess(m.login, e.currentTarget.value, shown, e.currentTarget) },
        partly && h('option', { value: '', selected: true, disabled: true }, `${roleNamed(m.access)?.label ?? 'Owner'} (partly)`),
        (data.roles ?? []).map((r) => h('option', { value: r.id, selected: !partly && r.id === m.access }, r.label))));
  }

  // What the role gives, in words; an owner from before roles with a switch off says what they have instead.
  function canCell(m) {
    return h('td', { class: 'role-can' }, h('span', { class: 'foot' }, m.accessDiffers || roleNamed(m.access)?.explain || ''));
  }

  function memberRows(m) {
    const row = h('tr', null,
      h('td', null, who(m.login, addedLine(m))),
      roleCell(m),
      canCell(m),
      data.slack !== null && h('td', null, slackLine(m.login)),
      h('td', { class: 'end-cell' }, isMe(m.login) ? h('span', { class: 'foot' }, 'you')
        : h('button', { type: 'button', class: 'btn btn-delete', onclick: (e) => act('remove', m.login, e.currentTarget) }, 'Remove')));
    if (editing !== m.login) return [row];
    return [row, h('tr', { class: 'edit-row' }, h('td', { colspan: '5' }, slackEditor(m.login, data.slack?.[m.login])))];
  }

  // The table sits in the group's box, and scrolls sideways inside it on a phone.
  function membersGroup() {
    return group({
      id: 'members', label: `Members · ${data.members.length}`,
      note: 'A role says what each person can do, and saves at once. An owner is an admin here.',
    },
      h('div', { class: 'table-scroll' }, h('table', { class: 'people-table' },
        h('thead', null, h('tr', null,
          h('th', { scope: 'col' }, 'Member'),
          h('th', { scope: 'col', class: 'switch-cell' }, 'Role'),
          h('th', { scope: 'col' }, 'What they can do'),
          data.slack !== null && h('th', { scope: 'col' }, 'Slack'),
          h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Remove')))),
        h('tbody', null, data.members.flatMap(memberRows)))),
      inviteRow());
  }

  function render() {
    // Behind a hosting proxy People is a tab of Settings, as Secrets & webhooks is.
    const head = h('header', { class: 'page-head' },
      hosted
        ? h('div', null,
          h('h1', { class: 'title' }, 'Settings ', W.scopePill('/people')),
          W.settingsTabs('/people'),
          h('p', { class: 'sub' }, 'Only these people can sign in. Owners are admins here, and choose what each person can do.'))
        : h('div', null,
          h('h1', { class: 'title' }, 'People ', W.scopePill('/people')),
          h('p', { class: 'sub' }, 'Only these people can sign in, and each still needs write access to the repository. Admins choose what each member can do.')));
    const body = data ? [requestsGroup(), membersGroup()]
      : h('p', { class: 'empty' }, loadError ? `Could not load the list: ${loadError}` : 'Loading…');
    // A row's head is a new node after each draw: draw gives it its focus back.
    draw(app, h('div', { class: 'page' }, life.nav('/people'), head, body));
  }

  async function load() {
    try {
      const [people, meReply] = await Promise.all([W.getJson('/api/people'), me ? null : W.getJson('/api/me')]);
      data = people;
      hosted = Boolean(people.hosted);
      if (meReply) me = meReply.login;
      loadError = null;
    } catch (err) {
      loadError = err.message;
    }
    // A refresh leaves the page alone while the invite field has the focus, or a Slack link is being typed, so typing is never interrupted.
    if (document.activeElement !== invite && document.activeElement?.name !== 'add-role' && !editing) render();
  }

  render();
  load();
  // The search, or a link, that names the invite row opens it.
  follow(life);
  life.interval(load, REFRESH_MS);
});
