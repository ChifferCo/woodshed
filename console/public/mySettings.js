// My settings: what the signed-in person's own My Woodshed sessions are given. Only they see this page's values,
// and the token is write-only: once saved, the console never shows it again, not even to them.
(function () {
  'use strict';
  const W = window.Woodshed;
  const { h } = W;

  let me = null;
  let loadError = null;
  // Your own tmux config. /api/my still lists the Terraform env files' own lines beside it, for pages from before
  // Repo settings, which hold those now (myRepoSettings.js).
  const fileKeys = () => Object.keys(me?.files ?? {}).filter((key) => key === 'tmux-conf');
  const files = {};
  let fileKey = null;
  const editor = h('textarea', { id: 'file-text', class: 'field mono file-text', rows: '14', spellcheck: 'false' });
  const fileStatus = h('p', { class: 'form-note', role: 'status' });
  editor.addEventListener('input', () => {
    if (files[fileKey]) files[fileKey].draft = editor.value;
    renderFilePill();
  });
  const repoSettings = window.WoodshedMyRepoSettings.create({ render });
  const tokenInput = h('input', { id: 'claude-token', type: 'password', class: 'field mono', autocomplete: 'off', spellcheck: 'false', placeholder: 'sk-ant-oat01-…' });
  const status = h('p', { class: 'form-note', role: 'status' });

  // The cards whose change the console is still making. Most go through the AWS CLI and take a few seconds, so the
  // card says so and its buttons wait, rather than look as if the click did nothing.
  const busy = new Set();

  async function act({ card, note, working = 'Saving…', done, call }) {
    busy.add(card);
    note.textContent = working;
    note.classList.remove('is-error');
    render();
    try {
      await call();
      note.textContent = done;
    } catch (err) {
      note.textContent = err.message;
      note.classList.add('is-error');
    }
    busy.delete(card);
    render();
  }

  function change(path, body, done, working) {
    return act({
      card: 'token', note: status, working, done, call: async () => {
        me = await W.postJson(path, body);
        tokenInput.value = '';
        tokenInput.type = 'password';
      },
    });
  }

  // Shows what was pasted, to check it before Save. It is the person's own paste: a saved token is never sent back.
  function revealButton() {
    const shown = tokenInput.type === 'text';
    return h('button', {
      type: 'button', class: 'btn btn-plain', 'aria-pressed': String(shown), 'aria-controls': 'claude-token',
      onclick: (e) => {
        tokenInput.type = shown ? 'password' : 'text';
        e.currentTarget.replaceWith(revealButton());
      },
    }, shown ? 'Hide' : 'Show');
  }

  const codexStatus = h('p', { class: 'form-note', role: 'status' });

  function codexChange(path, body, done, working) {
    return act({ card: 'codex', note: codexStatus, working, done, call: async () => { me = await W.postJson(path, body); codexInput.value = ''; } });
  }

  const codexInput = h('textarea', { id: 'codex-auth', class: 'field mono', rows: '3', autocomplete: 'off', spellcheck: 'false', placeholder: 'sk-… or the contents of ~/.codex/auth.json' });

  function codexCard() {
    const set = me.codexAuth?.set;
    const pill = set
      ? h('span', { class: 'pill is-ok' }, `Saved ${W.when(me.codexAuth.savedAt)}`)
      : h('span', { class: 'pill' }, 'Not set');
    return h('section', { class: 'set-card', id: 'codex' },
      h('div', { class: 'set-head' }, h('h2', null, 'Codex'), pill),
      h('p', { class: 'sub' }, 'Choose Codex as the agent in New session. With no sign-in saved here, it runs on the team\u2019s OpenAI key, if the console has one.'),
      steps(
        { text: 'Sign in to Codex on your laptop:', command: 'codex login' },
        { text: 'Print the sign-in it saved:', command: 'cat ~/.codex/auth.json' },
        { text: 'Paste all of it below and press Save. A ChatGPT login is saved back when a session stops, since OpenAI rotates it.' },
      ),
      h('p', { class: 'form-note' }, 'Or paste an OpenAI API key (', h('code', null, 'sk-…'), ') instead.'),
      h('label', { class: 'field-label', for: 'codex-auth' }, h('span', null, set ? 'Replace the sign-in' : 'Paste your sign-in')),
      codexInput,
      h('div', { class: 'set-actions' },
        h('button', { type: 'button', class: 'btn btn-open', disabled: !me.available || busy.has('codex'), onclick: () => codexChange('/api/my/codex-auth', { value: codexInput.value }, 'Saved. Your next Codex session uses it.') }, 'Save'),
        set && h('button', {
          type: 'button', class: 'btn btn-quiet', disabled: busy.has('codex'), onclick: () => {
            if (window.confirm('Remove your Codex sign-in? Codex sessions then run on the team key, if there is one.')) codexChange('/api/my/codex-auth/remove', {}, 'Removed.', 'Removing…');
          },
        }, 'Remove')),
      !me.available && h('p', { class: 'form-note is-error' }, 'This console has no secrets manager yet, so nothing can be saved here. ', h('a', { href: '/secrets' }, 'Choose one on the Secrets page.')),
      codexStatus);
  }

  // Numbered steps for a card, each { text, command }: a command gets its own box and Copy, so copying one never
  // runs another (designSystem/README.md, "Commands to copy").
  function steps(...items) {
    return h('ol', { class: 'cmd-steps' }, items.map(({ text, command }) => h('li', null,
      h('p', null, text),
      command && h('div', { class: 'value-row' }, h('code', { class: 'value-box' }, command), window.WoodshedRestoreParts.copyButton(command)))));
  }

  function tokenCard() {
    const set = me.claudeToken.set;
    const pill = set
      ? h('span', { class: 'pill is-ok' }, `Saved ${W.when(me.claudeToken.savedAt)}`)
      : h('span', { class: 'pill is-warn' }, 'Not set');
    return h('section', { class: 'set-card', id: 'claude' },
      h('div', { class: 'set-head' }, h('h2', null, 'Claude'), pill),
      h('p', { class: 'sub' }, 'Your My Woodshed sessions run on your own Claude plan, not the team key.'),
      steps(
        { text: 'Make a token on your laptop:', command: 'claude setup-token' },
        { text: 'Paste the token it prints below and press Save. Sessions already running keep the one they started with.' },
      ),
      h('label', { class: 'field-label', for: 'claude-token' }, h('span', null, set ? 'Replace the token' : 'Paste your token')),
      tokenInput,
      h('div', { class: 'set-actions' },
        h('button', { type: 'button', class: 'btn btn-open', disabled: !me.available || busy.has('token'), onclick: () => change('/api/my/claude-token', { value: tokenInput.value }, 'Saved. Your next session uses it.') }, 'Save'),
        revealButton(),
        set && h('button', {
          type: 'button', class: 'btn btn-quiet', disabled: busy.has('token'), onclick: () => {
            if (window.confirm('Remove your Claude token? New My Woodshed sessions are refused until you save one again.')) {
              change('/api/my/claude-token/remove', {}, 'Removed.', 'Removing…');
            }
          },
        }, 'Remove')),
      sharedSwitch(),
      !me.available && h('p', { class: 'form-note is-error' }, 'This console has no secrets manager yet, so nothing can be saved here. ', h('a', { href: '/secrets' }, 'Choose one on the Secrets page.')),
      status,
      h('div', { class: 'cmd-aside' },
        h('p', { class: 'form-note' }, 'Remote Control needs more than this token can do. In a session, type this in claude, or use Sign in for Remote Control in the session\u2019s ⋯ menu:'),
        h('div', { class: 'value-row' }, h('code', { class: 'value-box' }, '/woodshed:remote-control'), window.WoodshedRestoreParts.copyButton('/woodshed:remote-control'))));
  }

  // Whether the shared sessions you start from GitHub run on your token too. Only with a token saved: removing it
  // turns this off in effect, though the choice is kept for the next token.
  function sharedSwitch() {
    const saved = me.claudeToken.set;
    const on = saved && me.ownTokenForShared;
    return h('div', { class: `toggle-row${on ? '' : ' is-off'}` },
      h('button', {
        type: 'button', class: 'switch-ui', role: 'switch', 'aria-checked': String(on), 'aria-labelledby': 'own-shared-label', disabled: !saved || !me.available || busy.has('token'),
        onclick: () => change('/api/my/claude-token/shared', { on: !on }, on ? 'Off: shared sessions you start run on the team key.' : 'On: shared sessions you start run on your plan.'),
      }),
      h('span', { class: 'toggle-label', id: 'own-shared-label' }, 'Also use it for shared sessions I start from GitHub'),
      h('p', { class: 'sub' }, on
        ? 'On: a label you add, or a /woodshed comment that starts a session, runs on your plan. The session stays shared: everyone sees it and can type into it, on your plan, but your token never leaves the console. A resume or review fix keeps running on your plan.'
        : 'Off: sessions you start from GitHub run on the team key.'),
      !saved && h('p', { class: 'why-off' }, 'Save a token above to turn this on.'));
  }

  // Connect GitHub: a sign-in that keeps its token, so your sessions push and open pull requests as you.
  const gitName = h('input', { id: 'git-name', class: 'field', autocomplete: 'name' });
  const gitEmail = h('input', { id: 'git-email', class: 'field mono', autocomplete: 'email' });
  const githubStatus = h('p', { class: 'form-note', role: 'status' });
  if (new URLSearchParams(window.location.search).get('connected')) {
    githubStatus.textContent = 'Connected. Your next session pushes as you.';
    window.history.replaceState(null, '', window.location.pathname);
  }

  // From a name and email save until one is saved: the fields hold what was typed, so a save that fails can be
  // corrected and sent again instead of typed from the start.
  let gitTyped = false;

  function githubChange(path, body, done, working) {
    return act({ card: 'github', note: githubStatus, working, done, call: async () => { me = await W.postJson(path, body); gitTyped = false; } });
  }

  function saveIdentity() {
    gitTyped = true;
    return githubChange('/api/my/github/identity', { name: gitName.value, email: gitEmail.value }, 'Saved. Your next session commits with it.');
  }

  function githubCard() {
    const gh = me.github;
    // The App's own name for itself, read from GitHub; before the console has read it, a plain description.
    const bot = me.app?.login ?? 'the console\'s GitHub App';
    const via = me.app?.slug ?? 'the App';
    // No App sign-in to connect through (a console that borrows its GitHub access from its host): sessions push as the App.
    if (!gh.connected && !me.githubConnect) {
      const app = me.app?.login ?? 'the GitHub App';
      return h('section', { class: 'set-card' },
        h('div', { class: 'set-head' }, h('h2', null, 'GitHub'), h('span', { class: 'pill' }, `Pushes as ${app}`)),
        h('p', { class: 'sub' }, `Your My Woodshed sessions push and open pull requests as ${app}, with the GitHub access this console has.`));
    }
    if (!gh.connected) {
      return h('section', { class: 'set-card' },
        h('div', { class: 'set-head' }, h('h2', null, 'GitHub'), h('span', { class: 'pill' }, `Pushes as ${bot}`)),
        h('p', { class: 'sub' }, `Connect to have your My Woodshed sessions commit, push and open pull requests as you, marked “via ${via}”. It is the same GitHub sign-in again; this time the console keeps the token, and only your private sessions get it, a few minutes at a time.`),
        h('div', { class: 'set-actions' }, h('a', { class: 'btn btn-open', href: '/auth/connect' }, 'Connect GitHub')),
        githubStatus);
    }
    if (document.activeElement !== gitName && !gitTyped) gitName.value = gh.name ?? '';
    if (document.activeElement !== gitEmail && !gitTyped) gitEmail.value = gh.email ?? '';
    return h('section', { class: 'set-card' },
      h('div', { class: 'set-head' }, h('h2', null, 'GitHub'), h('span', { class: 'pill is-ok' }, `Connected as ${W.personText(me.login)}`)),
      h('p', { class: 'sub' }, `Your My Woodshed sessions push and open pull requests as you. Disconnect here ends your token at GitHub, and running sessions push as ${bot} again within 5 minutes.`),
      h('div', { class: 'lgrid2' },
        h('label', { class: 'field-label', for: 'git-name' }, h('span', null, 'Commits as'), gitName),
        h('label', { class: 'field-label', for: 'git-email' }, h('span', null, 'Email'), gitEmail)),
      h('div', { class: 'set-actions' },
        h('button', { type: 'button', class: 'btn btn-open', disabled: busy.has('github'), onclick: saveIdentity }, 'Save'),
        h('button', {
          type: 'button', class: 'btn btn-quiet', disabled: busy.has('github'), onclick: () => {
            if (window.confirm(`Disconnect GitHub? Your sessions go back to pushing as ${bot}.`)) githubChange('/api/my/github/disconnect', {}, 'Disconnected.', 'Disconnecting…');
          },
        }, 'Disconnect')),
      githubStatus);
  }

  // Your own Postgres and Mongo, which only your private sessions connect to. The db-admin task makes, resets and drops
  // them in about a minute, copying the template; the page asks again while one runs.
  const DB_WORK = { create: 'Making them…', reset: 'Copying the template again…', remove: 'Removing them…' };
  const dbStatus = h('p', { class: 'form-note', role: 'status' });
  let dbRefresh = null;

  function databasesChange(body, working) {
    return act({ card: 'databases', note: dbStatus, working, done: '', call: async () => { me = await W.postJson('/api/my/databases', body); } });
  }

  function watchDatabases() {
    clearTimeout(dbRefresh);
    if (me.databases?.status !== 'working') return;
    dbRefresh = setTimeout(() => W.getJson('/api/my').then((answer) => { me = answer; render(); }, () => watchDatabases()), 10_000);
  }

  const restore = window.WoodshedRestore.createRestore({ getMe: () => me, setMe: (answer) => { me = answer; }, render });

  // From your computer: a token for woodshed-db.mjs, shown once, since the console keeps only its hash.
  let tunnelToken = null;
  let tunnelCopied = false;
  const tunnelStatus = h('p', { class: 'form-note', role: 'status' });

  function tunnelChange(path, working) {
    return act({
      card: 'tunnel', note: tunnelStatus, working, done: '', call: async () => {
        const answer = await W.postJson(path, {});
        tunnelToken = answer.tunnelToken ?? null;
        tunnelCopied = false;
        me = answer;
      },
    });
  }

  function tunnelCommand(token) {
    const origin = window.location.origin;
    return `curl -fsSO ${origin}/static/woodshed-db.mjs\nWOODSHED_TOKEN=${token} node woodshed-db.mjs ${origin}`;
  }

  // What the installation hosts: a database on each engine, all with the one name.
  function databasesLine(db) {
    const labels = db.labels ?? [];
    const several = labels.length > 1;
    const named = labels.join(' and ');
    return [
      several ? `A ${named} database, each called ` : `A ${named} database called `, h('code', null, db.name),
      `, copied from the same template as every shared session's. ${several ? 'Their' : 'Its'} user reaches nothing else, and only your private sessions are given it. `,
      `Open ${several ? `them with the ${named} buttons` : `it with the ${named} button`} in Data ▾ on any of your running private sessions.`,
    ];
  }

  function tunnelSection() {
    const tunnel = me.tunnel;
    if (!tunnel?.available || me.databases.status !== 'ready') return null;
    const command = tunnelToken && tunnelCommand(tunnelToken);
    const copy = command && h('button', {
      type: 'button', class: 'btn btn-plain',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(command);
          tunnelCopied = true;
          render();
        } catch {
          window.alert('The browser would not copy. Select the text and copy it by hand.');
        }
      },
    }, tunnelCopied ? 'Copied' : 'Copy');
    return h('div', { class: 'tunnel' },
      h('h3', null, 'From your computer'),
      h('p', { class: 'sub' }, 'Open them in TablePlus, DataGrip, psql or Compass. Make a token, run the command it gives you in a terminal, ',
        `and connect to the ${tunnel.kinds.length === 1 ? 'string' : 'two strings'} it prints. It needs Node 18.3 or later.`, ' The token lasts 12 hours; making another, or Revoke, ends it and closes its connections.'),
      command && h('div', { class: 'value-row' }, h('code', { class: 'value-box' }, command), copy),
      command && h('p', { class: 'form-note' }, 'Shown this once: the console keeps only a hash of it.'),
      !command && tunnel.expiresAt && h('p', { class: 'form-note' }, `A token works until ${W.when(tunnel.expiresAt)}.`),
      h('div', { class: 'set-actions' },
        h('button', { type: 'button', class: 'btn btn-open', disabled: busy.has('tunnel'), onclick: () => tunnelChange('/api/my/tunnel-token', 'Making a token…') }, tunnel.expiresAt ? 'Make a new token' : 'Make a token'),
        tunnel.expiresAt && h('button', {
          type: 'button', class: 'btn btn-quiet', disabled: busy.has('tunnel'), onclick: () => { tunnelToken = null; tunnelChange('/api/my/tunnel-token/remove', 'Revoking…'); },
        }, 'Revoke')),
      tunnelStatus);
  }

  function databasesCard() {
    const db = me.databases;
    if (!db?.available) return null;
    const pill = {
      none: h('span', { class: 'pill' }, 'Not made yet'),
      working: h('span', { class: 'pill is-warn' }, DB_WORK[db.action] ?? 'Working…'),
      ready: me.restore?.status === 'applying'
        ? h('span', { class: 'pill is-work' }, 'Swapping in a restore')
        : h('span', { class: 'pill is-ok' }, `Ready since ${W.when(db.finishedAt)}`),
      failed: h('span', { class: 'pill is-warn' }, 'Failed'),
    }[db.status];
    const make = h('button', { type: 'button', class: 'btn btn-open', disabled: busy.has('databases'), onclick: () => databasesChange({}, 'Starting the copy…') }, db.status === 'failed' ? 'Try again' : 'Make my databases');
    const restoreBusy = restore.busy();
    const reset = h('button', {
      type: 'button', class: 'btn btn-quiet', disabled: busy.has('databases') || restoreBusy,
      onclick: () => W.confirmChange({
        title: 'Reset your databases?',
        before: `${db.name}, with whatever your sessions put in it`,
        after: 'A fresh copy of the template: the default branch\'s migrations and seed data, as of the last session image',
        effect: 'Your private sessions lose their connection while it runs, about a minute. Shared sessions are not touched.',
        word: 'reset',
        goLabel: 'Reset my databases',
        run: () => databasesChange({ confirm: 'reset' }, 'Starting the reset…'),
      }),
    }, 'Reset my data…');
    return h('section', { class: 'set-card' },
      h('div', { class: 'set-head' }, h('h2', null, 'Your databases'), pill),
      h('p', { class: 'sub' }, ...databasesLine(db)),
      me.databasesRefusal && h('p', { class: 'form-error', role: 'alert' }, `No session can start: ${me.databasesRefusal}. Whoever runs this console adds the engine, or the project file drops that database.`),
      db.status === 'none' && !me.claudeToken.set && h('p', { class: 'sub' }, 'They are made when you save your Claude token.'),
      db.status === 'working' && h('p', { class: 'sub' }, `Started ${W.when(db.startedAt)}. Copying takes about a minute, and New session waits for it.`),
      db.status === 'failed' && h('p', { class: 'form-note is-error' }, `The last try failed: ${db.error ?? 'no reason given'}. The db-admin task's log in CloudWatch says more.`),
      db.status !== 'working' && h('div', { class: 'set-actions' }, db.status === 'ready' ? reset : make,
        db.status === 'ready' && restoreBusy && h('span', { class: 'form-note' }, 'Waits for the restore to finish.')),
      dbStatus,
      restore.section(),
      tunnelSection());
  }

  // What your private sessions keep between them: MCP logins, Claude's memory and settings, and transcripts.
  const homeStatus = h('p', { class: 'form-note', role: 'status' });

  function homeCard() {
    const home = me.home;
    return h('section', { class: 'set-card' },
      h('div', { class: 'set-head' }, h('h2', null, 'MCP logins and Claude memory'),
        home.saved ? h('span', { class: 'pill is-ok' }, `Kept · ${(home.bytes / 1024 / 1024).toFixed(1)} MB`) : h('span', { class: 'pill' }, 'Nothing kept yet')),
      h('p', { class: 'sub' }, 'Log in to an MCP once, inside any of your private sessions. While one runs, and when it stops, your ', h('code', null, '~/.claude'),
        ' is kept, and your next session starts with it: logins, memory, settings, and the conversations Resume reopens. Your settings, skills, agents and MCP logins are also kept the same in every running session, within 20 seconds. Forget it works once none is running.'),
      home.saved && h('p', { class: 'sub' }, `Last kept ${W.when(home.savedAt)}.`),
      home.saved && h('div', { class: 'set-actions' }, h('button', {
        type: 'button', class: 'btn btn-quiet', disabled: busy.has('home'), onclick: () => {
          if (!window.confirm('Forget your kept Claude home? MCP logins, memory, your shared settings and the conversations Resume would reopen are deleted.')) return;
          act({ card: 'home', note: homeStatus, working: 'Forgetting…', done: 'Forgotten.', call: async () => { me = await W.postJson('/api/my/home/forget', {}); } });
        },
      }, 'Forget it')),
      homeStatus);
  }

  async function openFile(key) {
    fileKey = key;
    fileStatus.textContent = '';
    if (!files[key]) {
      try {
        files[key] = await W.getJson(`/api/my/files/${key}`);
      } catch (err) {
        fileStatus.textContent = err.message;
        fileStatus.classList.add('is-error');
      }
    }
    render();
  }

  // `reloadEditor` puts the answer in the editor, as Clear mine needs. It is done once the answer is in: the render
  // that shows "Saving…" would otherwise fill the editor with the lines being cleared.
  function fileChange(path, body, done, { reloadEditor = false } = {}) {
    const key = fileKey;
    return act({
      card: 'files', note: fileStatus, done, call: async () => {
        files[key] = await W.postJson(path, body);
        if (reloadEditor) editor.dataset.key = '';
        me = await W.getJson('/api/my');
      },
    });
  }

  const filePill = h('span', { class: 'pill' });
  function renderFilePill() {
    const f = files[fileKey];
    if (!f) return filePill.replaceChildren('…');
    const changed = f.draft !== undefined && f.draft !== f.text;
    const saved = me.files?.[fileKey]?.savedAt;
    filePill.className = `pill${changed ? ' is-warn' : f.custom ? ' is-ok' : ''}`;
    filePill.textContent = changed ? 'Unsaved changes' : f.custom ? `Shared + yours, saved ${W.when(saved)}` : 'Shared only';
  }

  function sharedFileBlock(f, name) {
    const lines = f.sharedText ? f.sharedText.replace(/\n+$/, '').split('\n').length : 0;
    return h('details', { class: 'shared-file' },
      h('summary', null, h('span', null, `Shared ${name}`), h('span', { class: 'sub' }, lines ? ` · ${lines} line${lines === 1 ? '' : 's'}` : ' · empty')),
      h('pre', { class: 'mono shared-text' }, f.sharedText || 'Nothing yet.'),
      h('p', { class: 'sub' }, 'It comes with the session image (session/tmux.conf in the repo).'));
  }

  function filesCard() {
    const f = files[fileKey];
    if (f && editor.dataset.key !== fileKey) {
      editor.value = f.draft ?? f.text;
      editor.dataset.key = fileKey;
    }
    editor.disabled = !f || !me.available;
    // Read-only, not disabled, while it saves: the text stays selectable, and what is typed then can't be lost to the
    // answer, which has no draft and would not show it as unsaved.
    editor.readOnly = busy.has('files');
    editor.placeholder = 'set -g prefix C-a';
    renderFilePill();
    const label = (key) => me.files?.[key]?.label ?? key;
    if (!fileKey) return null;
    return h('section', { class: 'set-card is-wide' },
      h('div', { class: 'set-head' }, h('h2', null, 'tmux'), filePill),
      h('p', { class: 'sub' }, 'Your sessions use the image\'s tmux config, and add your own lines after it, so a setting in both uses yours. Your next My Woodshed session picks up what you save; running ones keep theirs. Your own values for a repo\'s env files are under Repo settings.'),
      f && sharedFileBlock(f, label(fileKey)),
      h('label', { class: 'field-label', for: 'file-text' }, h('span', null, `Your own lines for ${label(fileKey)}`)),
      editor,
      h('p', { class: 'sub' }, 'Loaded by claude\'s tmux. Prefix then r reloads it in a running session.'),
      h('div', { class: 'set-actions' },
        h('button', {
          type: 'button', class: 'btn btn-open', disabled: !f || !me.available || busy.has('files'),
          onclick: () => fileChange(`/api/my/files/${fileKey}`, { text: editor.value }, editor.value.trim()
            ? `Saved your lines for ${label(fileKey)}. Your next session uses them.`
            : `Your sessions use the shared ${label(fileKey)} alone.`),
        }, 'Save'),
        f?.custom && h('button', {
          type: 'button', class: 'btn btn-quiet', disabled: busy.has('files'),
          onclick: () => {
            if (!window.confirm(`Clear your own lines for ${label(fileKey)}? Your sessions then use the shared file alone.`)) return;
            fileChange(`/api/my/files/${fileKey}/reset`, {}, `Your sessions use the shared ${label(fileKey)} alone.`, { reloadEditor: true });
          },
        }, 'Clear mine')),
      fileStatus);
  }

  // Your own whole files (an app/.env.production), which your sessions write into the checkout where git ignores
  // them. All of them come in one read, the first time the card is drawn; `ownPath` is the one open, '' a new one.
  let ownFiles = null;
  let ownLoad = null;
  // A read that failed is not tried again by itself: render() would otherwise ask the console again at once, for as
  // long as the secret store is down. Try again asks.
  let ownLoadFailed = false;
  let ownPath = null;
  const ownPathInput = h('input', { id: 'own-file-path', class: 'field mono', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'app/.env.production' });
  const ownEditor = h('textarea', { id: 'own-file-text', class: 'field mono file-text', rows: '10', spellcheck: 'false', placeholder: 'NOTION_TOKEN=…' });
  const ownStatus = h('p', { class: 'form-note', role: 'status' });

  function loadOwnFiles() {
    ownLoad ??= W.getJson('/api/my/own-files').then((answer) => {
      ownFiles = answer.files ?? {};
      openOwnFile(Object.keys(ownFiles).sort()[0] ?? '');
    }, (err) => {
      ownStatus.textContent = err.message;
      ownStatus.classList.add('is-error');
      ownLoad = null;
      ownLoadFailed = true;
      render();
    });
  }

  function retryOwnFiles() {
    ownLoadFailed = false;
    ownStatus.textContent = 'Reading your files…';
    ownStatus.classList.remove('is-error');
    loadOwnFiles();
    render();
  }

  function openOwnFile(file) {
    ownPath = file;
    ownPathInput.value = file;
    ownEditor.value = file ? ownFiles?.[file] ?? '' : '';
    ownStatus.textContent = '';
    ownStatus.classList.remove('is-error');
    render();
  }

  function saveOwnFile(file, text, done) {
    return act({
      card: 'own-files', note: ownStatus, done, call: async () => {
        const answer = await W.postJson('/api/my/own-files', { path: file, text });
        ownFiles = answer.files;
        me = answer.view;
        const next = ownFiles[file.trim()] !== undefined ? file.trim() : Object.keys(ownFiles).sort()[0] ?? '';
        ownPath = next;
        ownPathInput.value = next;
        ownEditor.value = next ? ownFiles[next] : '';
      },
    });
  }

  function ownFilesCard() {
    if (me.available && ownFiles === null && !ownLoadFailed) loadOwnFiles();
    const paths = (me.ownFiles ?? []).map((f) => f.path);
    const savedAt = (file) => me.ownFiles?.find((f) => f.path === file)?.savedAt;
    const working = busy.has('own-files');
    ownPathInput.readOnly = working || Boolean(ownPath);
    ownEditor.readOnly = working;
    ownPathInput.disabled = ownEditor.disabled = !me.available || ownFiles === null;
    return h('section', { class: 'set-card is-wide' },
      h('div', { class: 'set-head' }, h('h2', null, 'Your own files'),
        h('span', { class: `pill${paths.length ? ' is-ok' : ''}` }, paths.length ? `${paths.length} file${paths.length === 1 ? '' : 's'}` : 'None')),
      h('p', { class: 'sub' }, 'Whole files your sessions write into the repo at start, such as the ', h('code', null, '.env.production'),
        ' your MCP servers read. A file is written only where git ignores it, so it never reaches a commit. Your next My Woodshed session picks up what you save; running ones keep theirs.'),
      h('div', { class: 'file-tabs', role: 'group', 'aria-label': 'Your file' },
        paths.map((file) => h('button', { type: 'button', 'aria-pressed': String(file === ownPath), disabled: working, onclick: () => openOwnFile(file) }, file)),
        h('button', { type: 'button', 'aria-pressed': String(ownPath === ''), disabled: working || ownFiles === null, onclick: () => openOwnFile('') }, '+ Add a file')),
      h('label', { class: 'field-label', for: 'own-file-path' }, h('span', null, 'Path in the repo')),
      ownPathInput,
      h('label', { class: 'field-label', for: 'own-file-text' }, h('span', null, ownPath ? `${ownPath}${savedAt(ownPath) ? `, saved ${W.when(savedAt(ownPath))}` : ''}` : 'Its text')),
      ownEditor,
      h('div', { class: 'set-actions' },
        ownLoadFailed && h('button', { type: 'button', class: 'btn btn-quiet', onclick: retryOwnFiles }, 'Try again'),
        h('button', {
          type: 'button', class: 'btn btn-open', disabled: !me.available || ownFiles === null || working,
          onclick: () => {
            const file = ownPathInput.value.trim();
            if (!ownEditor.value.trim()) {
              ownStatus.textContent = 'Write the file\'s text first. To delete a file, use Remove.';
              ownStatus.classList.add('is-error');
              return;
            }
            saveOwnFile(file, ownEditor.value, `Saved ${file}. Your next session writes it.`);
          },
        }, 'Save'),
        ownPath && h('button', {
          type: 'button', class: 'btn btn-quiet', disabled: working,
          onclick: () => {
            if (!window.confirm(`Remove ${ownPath}? Your next sessions no longer write it.`)) return;
            saveOwnFile(ownPath, '', `Removed ${ownPath}.`);
          },
        }, 'Remove')),
      ownStatus);
  }

  // Your own pause and stop times, for your My Woodshed sessions. Empty is the console's number.
  const limitInputs = {
    idleHours: h('input', { id: 'limit-idle', class: 'field mono', type: 'number', min: '0.25', max: '24', step: '0.25', inputmode: 'decimal' }),
    lifetimeHours: h('input', { id: 'limit-lifetime', class: 'field mono', type: 'number', min: '1', max: '24', step: '1', inputmode: 'decimal' }),
  };
  const limitStatus = h('p', { class: 'form-note', role: 'status' });
  let limitsTyped = false;

  // The project New session opens on for you, on a console with more than one (GET /api/my/projects).
  let projects = null;
  const projectSelect = h('select', { id: 'default-project', class: 'field' });
  const projectStatus = h('p', { class: 'form-note', role: 'status' });

  function projectCard() {
    if (!projects || projects.projects.length < 2) return null;
    if (document.activeElement !== projectSelect && !busy.has('project')) {
      projectSelect.replaceChildren(...projects.projects.map((p) => h('option', { value: p.name }, `${p.name} \u00b7 ${p.repo}`)));
      projectSelect.value = projects.defaultProject;
    }
    return h('section', { class: 'set-card' },
      h('div', { class: 'set-head' }, h('h2', null, 'Default project'), h('span', { class: projects.saved ? 'pill is-ok' : 'pill' }, projects.saved ? 'Your own' : 'Console default')),
      h('p', { class: 'sub' }, 'The repo New session opens on for you. You can still pick another there for one session. Only projects whose repo you can write to are listed.'),
      h('label', { class: 'field-label', for: 'default-project' }, h('span', null, 'Project')),
      projectSelect,
      h('div', { class: 'set-actions' },
        h('button', {
          type: 'button', class: 'btn btn-open', disabled: busy.has('project'),
          onclick: () => act({ card: 'project', note: projectStatus, done: 'Saved.', call: async () => { projects = await W.postJson('/api/my/projects/default', { project: projectSelect.value }); } }),
        }, 'Save')),
      projectStatus);
  }

  function saveLimits(values, done) {
    limitsTyped = true;
    return act({ card: 'limits', note: limitStatus, done, call: async () => { me = await W.postJson('/api/my/limits', { limits: values }); limitsTyped = false; } });
  }

  function limitsCard() {
    const own = me.limits ?? {};
    for (const [key, input] of Object.entries(limitInputs)) {
      input.placeholder = String(me.limitDefaults?.[key] ?? '');
      if (document.activeElement !== input && !limitsTyped) input.value = own[key] ?? '';
    }
    const custom = Object.keys(own).length > 0;
    return h('section', { class: 'set-card' },
      h('div', { class: 'set-head' }, h('h2', null, 'Session timeouts'), h('span', { class: custom ? 'pill is-ok' : 'pill' }, custom ? 'Your own' : 'Console defaults')),
      h('p', { class: 'sub' }, 'How long your My Woodshed sessions wait for you before they pause, and how long one that works may run before it is stopped. Either way its work is pushed first, and Resume picks it up. Leave a box empty to use the console\'s number, shown in it. Sessions already running use the new numbers within a few seconds.'),
      h('label', { class: 'field-label', for: 'limit-idle' }, h('span', null, 'Pause a session waiting for input after (hours, 0.25 to 24)')),
      limitInputs.idleHours,
      h('label', { class: 'field-label', for: 'limit-lifetime' }, h('span', null, 'Stop a working session after (hours, 1 to 24)')),
      limitInputs.lifetimeHours,
      h('div', { class: 'set-actions' },
        h('button', { type: 'button', class: 'btn btn-open', disabled: busy.has('limits'), onclick: () => saveLimits({ idleHours: limitInputs.idleHours.value, lifetimeHours: limitInputs.lifetimeHours.value }, 'Saved.') }, 'Save'),
        custom && h('button', { type: 'button', class: 'btn btn-quiet', disabled: busy.has('limits'), onclick: () => saveLimits({}, 'Back to the console\'s numbers.') }, 'Use the console\'s')),
      limitStatus);
  }

  // Remove My Woodshed, confirmed by typing your login: every private session stops and leaves the list, and
  // everything saved here is deleted. What is on GitHub stays, and so do shared sessions.
  function removeCard() {
    const live = me.running;
    return h('section', { class: 'set-card is-danger' },
      h('div', { class: 'set-head' }, h('h2', null, 'Remove My Woodshed'), !me.setUp && !live && h('span', { class: 'pill' }, 'Nothing to remove')),
      h('p', { class: 'sub' }, `Stops your ${live} running private session${live === 1 ? '' : 's'}, each pushing its branch first, takes all your private sessions off the list, and deletes your Claude token, GitHub connection, your own databases, your repo settings, tmux lines and kept Claude home. Branches and pull requests stay on GitHub, and shared sessions you started stay on Shared. You can set it up again from scratch later.`),
      h('div', { class: 'set-actions' }, h('button', {
        type: 'button', class: 'btn btn-danger',
        onclick: () => W.confirmChange({
          title: 'Remove My Woodshed?',
          before: `${live} running private session${live === 1 ? '' : 's'}${me.claudeToken.set ? ', a Claude token' : ''}`,
          after: 'Nothing: the sessions stopped and gone from the list, the token and your files deleted',
          effect: 'This cannot be undone. Work in progress is pushed to each branch before its session stops.',
          word: me.login,
          goLabel: 'Remove My Woodshed',
          run: async () => {
            const answer = await W.postJson('/api/my/remove', { confirm: me.login });
            me = answer;
            for (const key of fileKeys()) delete files[key];
            ownFiles = null;
            ownLoad = null;
            ownLoadFailed = false;
            repoSettings.reload();
            editor.dataset.key = '';
            openFile(fileKey);
            status.textContent = `My Woodshed removed: ${answer.stopped} stopped, ${answer.removed} taken off the list.`;
            render();
          },
        }),
      }, 'Remove My Woodshed…')));
  }

  function render() {
    const app = document.getElementById('app');
    if (!me) {
      app.replaceChildren(h('div', { class: 'page' }, W.nav('/settings'), h('p', { class: 'empty' }, loadError ? `Could not load your settings: ${loadError}` : 'Loading…')));
      return;
    }
    // The page is rebuilt on each answer (the projects, a save): a box being typed in keeps its focus.
    const focused = document.activeElement;
    app.replaceChildren(h('div', { class: 'page settings-page' },
      W.nav('/settings'),
      h('header', { class: 'page-head' }, h('div', null,
        h('h1', { class: 'title' }, 'My settings'),
        h('p', { class: 'sub' }, `For ${W.personText(me.login)}'s My Woodshed sessions. Shared sessions get none of it, but for your Claude token when you switch that on below.`))),
      tokenCard(),
      codexCard(),
      projectCard(),
      limitsCard(),
      databasesCard(),
      githubCard(),
      homeCard(),
      repoSettings.card(),
      filesCard(),
      ownFilesCard(),
      removeCard()));
    if (focused?.id && focused !== document.activeElement && focused.isConnected) focused.focus({ preventScroll: true });
    watchDatabases();
    showAsked();
    repoSettings.afterRender();
  }

  // The setup card's Claude and Codex go to #claude and #codex: once the cards are there, that one is scrolled to and
  // its box focused, so whichever agent was picked is the one in front of the person. Once per page load.
  let asked = ({ '#claude': 'claude-token', '#codex': 'codex-auth' })[window.location.hash] ?? null;
  function showAsked() {
    const input = asked && document.getElementById(asked);
    if (!input) return;
    asked = null;
    input.closest('.set-card')?.scrollIntoView({ block: 'start' });
    input.focus({ preventScroll: true });
  }

  W.getJson('/api/my').then((answer) => { me = answer; }, (err) => { loadError = err.message; }).then(() => (me ? openFile(fileKey ?? fileKeys()[0]) : render()));
  W.getJson('/api/my/projects').then((answer) => { projects = answer; if (me) render(); }, () => {});
  render();
  window.addEventListener('woodshed:me', render);
})();
