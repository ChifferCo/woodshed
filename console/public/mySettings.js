// My settings: what the signed-in person's own My Woodshed sessions are given. Only they see this page's values,
// and the token is write-only: once saved, the console never shows it again, not even to them.
window.Woodshed.settingsPage('/settings', (app, life) => {
  'use strict';
  const W = window.Woodshed;
  const { h } = W;

  let me = null;
  let loadError = null;
  // Your own lines for tmux's config and a few dotfiles (shared/dotfiles.mjs). Your own lines for the repo's env files
  // are Repo settings (myRepoSettings.js).
  const FILE_ROWS = {
    'tmux-conf': {
      id: 'my-tmux', title: 'tmux', placeholder: 'set -g prefix C-a',
      about: 'Added after the image\'s tmux config. Yours wins where both set the same thing. Your next session picks it up.',
      after: 'Prefix then r reloads it in a running session.',
    },
    gitconfig: {
      id: 'my-gitconfig', title: 'git', placeholder: '[alias]\n\tco = checkout\n[pull]\n\trebase = true',
      about: 'Aliases, colors, and how diff, merge, pull, push and rebase behave. [user], credentials, URLs, includes, pagers, editors and paths are refused: the session already commits and signs in as you.',
      after: 'woodshed settings push fills this from ~/.gitconfig, leaving out what a session does not take.',
    },
    inputrc: {
      id: 'my-inputrc', title: 'readline', placeholder: 'set editing-mode vi',
      about: 'Your ~/.inputrc for the bash in your terminals, after the system\'s. An $include only of a file under /etc.',
      after: 'woodshed settings push fills this from ~/.inputrc.',
    },
    'bash-aliases': {
      id: 'my-bash-aliases', title: 'Shell aliases', placeholder: "alias ll='ls -la'",
      about: 'Alias lines only, one per line. No variables, no commands that run as the file is read, and no credentials.',
      after: 'woodshed settings push fills this from the aliases in ~/.bash_aliases, ~/.bashrc and ~/.zshrc.',
    },
  };
  const fileKeys = () => Object.keys(me?.files ?? {}).filter((key) => FILE_ROWS[key]);
  const files = {};
  // Each file's own editor, status line and pill, made the first time its row is drawn.
  const fileUi = {};
  function uiOf(key) {
    if (fileUi[key]) return fileUi[key];
    const editor = h('textarea', { id: `file-text-${key}`, class: 'field mono file-text', rows: key === 'tmux-conf' ? '14' : '8', spellcheck: 'false' });
    const ui = { editor, status: h('p', { class: 'form-note', role: 'status' }), pill: h('span', { class: 'pill' }) };
    editor.addEventListener('input', () => {
      if (files[key]) files[key].draft = editor.value;
      renderFilePill(key);
    });
    fileUi[key] = ui;
    return ui;
  }
  const repoSettings = window.WoodshedMyRepoSettings.create({ render, row: (...args) => row(...args), isOpen: (id) => open.has(id), setOpen: (id) => open.add(id) });
  const tokenInput = h('input', { id: 'claude-token', type: 'password', class: 'field mono', autocomplete: 'off', spellcheck: 'false', placeholder: 'sk-ant-oat01-…' });
  const status = h('p', { class: 'form-note', role: 'status' });
  const noStore = () => h('p', { class: 'form-note is-error' }, 'Nothing can be saved here yet. ', h('a', { href: '/secrets' }, 'Choose a store on Secrets & webhooks.'));

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

  // The page is groups of rows (settingsRows.js): which are open is kept for the page's life, since it is drawn again
  // on each answer. A link or the search that names a row opens it.
  const { open, row, line, group, howTo } = window.WoodshedSettingsRows.create({ render });

  function change(path, body, done, working) {
    return act({
      card: 'token', note: status, working, done, call: async () => {
        me = await W.postJson(path, body);
        tokenInput.value = '';
        tokenInput.type = 'password';
        loadReviews();
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
    return act({ card: 'codex', note: codexStatus, working, done, call: async () => { me = await W.postJson(path, body); codexInput.value = ''; loadReviews(); } });
  }

  const codexInput = h('textarea', { id: 'codex-auth', class: 'field mono', rows: '3', autocomplete: 'off', spellcheck: 'false', placeholder: 'sk-… or the contents of ~/.codex/auth.json' });

  function codexCard() {
    const set = me.codexAuth?.set;
    const pill = set
      ? h('span', { class: 'pill is-ok' }, `Saved ${W.when(me.codexAuth.savedAt)}`)
      : h('span', { class: 'pill' }, 'Not set');
    const how = [
      steps(
        { text: 'Sign in to Codex on your laptop:', command: 'codex login' },
        { text: 'Print the sign-in it saved:', command: 'cat ~/.codex/auth.json' },
        { text: 'Paste all of it below and press Save. A ChatGPT login is saved back when a session stops.' },
      ),
      h('p', { class: 'form-note' }, 'Or paste an OpenAI API key (', h('code', null, 'sk-…'), ') instead.'),
    ];
    return row({
      id: 'codex', title: 'Codex', pill,
      value: set ? `Your own sign-in, for Codex sessions${me.ownCodexForReviews ? ' and reviews of your pull requests' : ''}` : 'Codex sessions run on the team\u2019s OpenAI key, if the console has one',
    },
      h('p', { class: 'sub' }, 'Codex in New session. With nothing saved here, it uses the team\u2019s OpenAI key, if there is one.'),
      set ? howTo('How to get a sign-in', how) : how,
      h('label', { class: 'field-label', for: 'codex-auth' }, h('span', null, set ? 'Replace the sign-in' : 'Paste your sign-in')),
      codexInput,
      h('div', { class: 'set-actions' },
        h('button', { type: 'button', class: 'btn btn-open', disabled: !me.available || busy.has('codex'), onclick: () => codexChange('/api/my/codex-auth', { value: codexInput.value }, 'Saved. Your next Codex session uses it.') }, 'Save'),
        set && h('button', {
          type: 'button', class: 'btn btn-quiet', disabled: busy.has('codex'), onclick: () => {
            if (window.confirm('Remove your Codex sign-in? Codex sessions then run on the team key, if there is one.')) codexChange('/api/my/codex-auth/remove', {}, 'Removed.', 'Removing…');
          },
        }, 'Remove')),
      codexReviewsSwitch(),
      !me.available && noStore(),
      codexStatus);
  }

  // Grok Build and OpenCode: each runs only on its owner's own sign-in (shared/agents.cjs), saved here as
  // users/<login>/<agent>-auth and handed to that person's own My Woodshed sessions alone. One card each, from the
  // registry's words. Their boxes and notes are made once and kept across draws, as Codex's are.
  const A = window.WoodshedAgents;
  const agentInputs = Object.fromEntries(A.OWN_SIGN_IN_AGENTS.map((id) => [id, h('textarea', {
    id: `${id}-auth`, class: 'field mono', rows: '3', autocomplete: 'off', spellcheck: 'false', placeholder: A.agent(id).signIn.placeholder,
  })]));
  const agentStatus = Object.fromEntries(A.OWN_SIGN_IN_AGENTS.map((id) => [id, h('p', { class: 'form-note', role: 'status' })]));

  function agentChange(id, path, body, done, working) {
    return act({ card: id, note: agentStatus[id], working, done, call: async () => { me = await W.postJson(path, body); agentInputs[id].value = ''; loadReviews(); } });
  }

  // Whether reviews of your pull requests may run this agent on your sign-in. On once a sign-in is saved here, unless
  // turned off; a first save from the command line starts it off until they turn it on. The default then includes it
  // (console/reviewAgents.mjs). A sign-in already saved when that default shipped,
  // or found in the secret store without a save on My settings since,
  // stays out until Reviews of my pull requests is set back to the default. A saved choice that leaves it out does
  // not, unless none of that choice can run, in which case the same default runs. The console adds the sign-in to the
  // agent's calls (console/reviewAgentProxy.mjs), never into the review session.
  function agentReviewsSwitch(id) {
    const a = A.agent(id);
    if (!a.reviews) return null;
    const saved = Boolean(me.agentAuth?.[id]?.set);
    const on = Boolean(saved && me.ownAgentForReviews?.[id]);
    // The reviews answer is newer than `me` after Include every reviewer: that save returns `expanded` before the
    // next /api/my, and this switch's note has to follow it on the same draw.
    const widened = me.expandedReviewDefault !== false;
    const what = id === 'opencode' ? 'your Anthropic or OpenAI API key, of those saved here' : 'your sign-in';
    const onNote = widened
      ? `On: ${a.name} reviews the pull requests you open on ${what}, with the other reviewers that can, unless your own choice under Reviews of my pull requests leaves it out. If none of that choice can run, the default runs, and ${a.name} is included.`
      : `On: ${a.name} reviews a pull request you open when your reviewer choice names it. It is not in the default yet: include every reviewer under Reviews of my pull requests. Until then, a choice that can no longer run falls back to Claude Code and Codex.`;
    return h('div', { class: `toggle-row${on ? '' : ' is-off'}` },
      h('button', {
        type: 'button', class: 'switch-ui', role: 'switch', 'aria-checked': String(on), 'aria-labelledby': `${id}-reviews-label`, disabled: !saved || !me.available || busy.has(id),
        onclick: () => agentChange(id, `/api/my/agent-auth/${id}/reviews`, { on: !on }, on ? `Off: ${a.name} does not review your pull requests.` : widened ? `On: ${a.name} reviews your pull requests, unless your own reviewer choice leaves it out. If none of that choice can run, the default includes it.` : `On: ${a.name} reviews your pull requests when your choice names it. Include every reviewer to put it in the default.`),
      }),
      h('span', { class: 'toggle-label', id: `${id}-reviews-label` }, 'Also use it for reviews of my pull requests'),
      h('p', { class: 'sub' }, on
        ? `${onNote} The console adds it to ${a.name}\u2019s calls; it never goes into the review session.${a.signIn.rotates && id === 'grok' ? ' A login that has expired is not used: a Grok session of yours refreshes it.' : ''}`
        : `Off: ${a.name} never reviews your pull requests. There is no team key for it.`),
      !saved && h('p', { class: 'why-off' }, 'Save a sign-in above to turn this on.'));
  }

  function agentCard(id) {
    const a = A.agent(id);
    const saved = me.agentAuth?.[id];
    const set = Boolean(saved?.set);
    const pill = set ? h('span', { class: 'pill is-ok' }, `Saved ${W.when(saved.savedAt)}`) : h('span', { class: 'pill' }, 'Not set');
    const how = [
      steps(...a.signIn.steps, { text: `Paste it below and press Save.${a.signIn.rotates ? ` A login ${a.product} refreshes is saved back when a session stops.` : ''}` }),
    ];
    return row({
      id, title: a.product, pill,
      value: set ? `Your own sign-in, for ${a.name} sessions${a.reviews && me.ownAgentForReviews?.[id] ? ' and reviews of your pull requests' : ''}` :`Save ${a.signIn.kinds}, and New session offers ${a.name}`,
    },
      h('p', { class: 'sub' }, `${a.name} runs only on your sign-in, in your My Woodshed sessions. Never in a shared session.`),
      set ? howTo('How to get a sign-in', how) : how,
      h('label', { class: 'field-label', for: `${id}-auth` }, h('span', null, set ? 'Replace the sign-in' : 'Paste your sign-in')),
      agentInputs[id],
      h('div', { class: 'set-actions' },
        h('button', { type: 'button', class: 'btn btn-open', disabled: !me.available || busy.has(id), onclick: () => agentChange(id, `/api/my/agent-auth/${id}`, { value: agentInputs[id].value }, `Saved. Your next ${a.name} session uses it.`) }, 'Save'),
        set && h('button', {
          type: 'button', class: 'btn btn-quiet', disabled: busy.has(id), onclick: () => {
            if (window.confirm(`Remove your ${a.product} sign-in? New ${a.name} sessions are refused until you save one again.`)) agentChange(id, `/api/my/agent-auth/${id}/remove`, {}, 'Removed.', 'Removing…');
          },
        }, 'Remove')),
      agentReviewsSwitch(id),
      !me.available && noStore(),
      agentStatus[id]);
  }

  // Whether reviews of your pull requests run Codex on your sign-in, when an admin has Codex review beside Claude Code.
  // On once a sign-in is saved, unless turned off, as the Claude token's switch is; the console adds the sign-in to
  // Codex's calls, never into the session.
  function codexReviewsSwitch() {
    const saved = me.codexAuth?.set;
    const on = Boolean(saved && me.ownCodexForReviews);
    return h('div', { class: `toggle-row${on ? '' : ' is-off'}` },
      h('button', {
        type: 'button', class: 'switch-ui', role: 'switch', 'aria-checked': String(on), 'aria-labelledby': 'codex-reviews-label', disabled: !saved || !me.available || busy.has('codex'),
        onclick: () => codexChange('/api/my/codex-auth/reviews', { on: !on }, on ? 'Off: reviews of your pull requests run Codex on the team key.' : 'On: reviews of your pull requests run Codex on your sign-in.'),
      }),
      h('span', { class: 'toggle-label', id: 'codex-reviews-label' }, 'Also use it for reviews of my pull requests'),
      h('p', { class: 'sub' }, on
        ? 'On: Codex reviews of your pull requests use your sign-in. It stays in the console. An expired ChatGPT login is skipped until a Codex session refreshes it.'
        : 'Off: those reviews use the team\u2019s OpenAI key, or Codex does not review.'),
      !saved && h('p', { class: 'why-off' }, 'Save a sign-in above to turn this on.'));
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
    const how = steps(
      { text: 'Make a token on your laptop:', command: 'claude setup-token' },
      { text: 'Paste the token it prints below and press Save. Sessions already running keep the one they started with.' },
    );
    return row({
      id: 'claude', title: 'Claude', pill,
      value: set ? `Your own Claude plan${me.ownTokenForShared ? ', also for shared sessions you start from GitHub' : ', for your My Woodshed sessions'}` : 'Save a token, and your My Woodshed sessions run on your own Claude plan',
    },
      set ? howTo('How to make a token', how) : how,
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
      !me.available && noStore(),
      status);
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
        ? 'On: sessions you start from GitHub run on your plan. Everyone can see them and type into them, on your plan. Your token stays in the console.'
        : 'Off: those sessions run on the team key.'),
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
    // No App at all, on one person's machine: sessions push with its gh login, as that person.
    if (!gh.connected && !me.githubConnect && me.pushesWithGh) {
      return row({ id: 'my-github', title: 'GitHub', pill: h('span', { class: 'pill' }, 'Pushes as you'), value: 'Sessions push as you, with this machine\'s gh login.' });
    }
    // No App sign-in to connect through (a console that borrows its GitHub access from its host): sessions push as the App.
    if (!gh.connected && !me.githubConnect) {
      const app = me.app?.login ?? 'the GitHub App';
      return row({ id: 'my-github', title: 'GitHub', pill: h('span', { class: 'pill' }, `Pushes as ${app}`), value: `Sessions push and open pull requests as ${app}.` });
    }
    // Behind a host that connects people on its own, being unconnected is the exception: someone signed in to GitHub as
    // another account, or who disconnected. The card says so, and Connect is the quiet way back.
    if (!gh.connected && me.githubConnectAutomatic) {
      return row({ id: 'my-github', title: 'GitHub', pill: h('span', { class: 'pill' }, `Pushes as ${bot}`), value: 'Connect to have your sessions push and open pull requests as you' },
        h('p', { class: 'sub' }, `Sessions push as ${bot} until you connect. GitHub usually connects on its own; it did not this time, or you disconnected.`),
        h('div', { class: 'set-actions' }, h('a', { class: 'btn btn-quiet', href: me.githubConnectHref }, 'Connect GitHub')),
        githubStatus);
    }
    if (!gh.connected) {
      return row({ id: 'my-github', title: 'GitHub', pill: h('span', { class: 'pill' }, `Pushes as ${bot}`), value: 'Connect to have your sessions push and open pull requests as you' },
        h('p', { class: 'sub' }, `Connect so sessions push as you, marked “via ${via}”. The console keeps the token, and only your private sessions get it.`),
        h('div', { class: 'set-actions' }, h('a', { class: 'btn btn-open', href: me.githubConnectHref ?? '/auth/connect' }, 'Connect GitHub')),
        githubStatus);
    }
    if (document.activeElement !== gitName && !gitTyped) gitName.value = gh.name ?? '';
    if (document.activeElement !== gitEmail && !gitTyped) gitEmail.value = gh.email ?? '';
    return row({
      id: 'my-github', title: 'GitHub',
      pill: h('span', { class: 'pill is-ok' }, me.githubConnectAutomatic ? `Pushes as ${W.personText(me.login)}` : `Connected as ${W.personText(me.login)}`),
      value: gh.name || gh.email ? `Commits as ${[gh.name, gh.email].filter(Boolean).join(' \u00b7 ')}` : 'Your sessions push and open pull requests as you',
    },
      h('p', { class: 'sub' }, me.githubConnectAutomatic
        ? `Sessions push as you, marked “via ${via}”. Disconnect ends the token, and running sessions push as ${bot} within 5 minutes.`
        : `Disconnect ends the token, and running sessions push as ${bot} within 5 minutes.`),
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
    dbRefresh = life.timeout(() => W.getJson('/api/my').then((answer) => { me = answer; render(); }, () => watchDatabases()), 10_000);
  }

  const restore = window.WoodshedRestore.createRestore({ getMe: () => me, setMe: (answer) => { me = answer; }, render, life });

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
      `. Copied from the shared template. Only your private sessions connect, and the user reaches nothing else. Open ${several ? 'them' : 'it'} from Open ▾.`,
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
      h('p', { class: 'sub' }, 'Run the command, then connect to the ', tunnel.kinds.length === 1 ? 'string' : 'strings', ' it prints. Needs Node 18.3 or later. The token lasts 12 hours. Making a new one, or Revoke, ends it and closes its connections.'),
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

  // The computers the woodshed command line is signed in on as you (console/cliSignIn.mjs), each with Revoke. A sign-in
  // is made by `woodshed login` and approved on the console's /cli page, never here: this row only lists and ends them.
  const cliStatus = h('p', { class: 'form-note', role: 'status' });

  function cliCard() {
    if (!me.cli) return null;
    const tokens = me.cli.tokens ?? [];
    const pill = tokens.length
      ? h('span', { class: 'pill is-ok' }, `${tokens.length} signed in`)
      : h('span', { class: 'pill' }, 'None');
    // Run from a Woodshed checkout until the command line has an installer (cli/README.md).
    const command = `node cli/woodshed.mjs login --console ${window.location.origin}`;
    return row({
      id: 'my-cli', title: 'Command line', pill,
      value: tokens.length ? tokens.map((t) => t.name).join(', ') : 'Sign the woodshed command line in on your computer',
    },
      h('p', { class: 'sub' }, 'One sign-in per computer, approved in this browser. Each lasts 90 days. Revoke ends it at once.'),
      tokens.length ? howTo('How to sign in on another computer', steps({ text: 'In a terminal on that computer, from a Woodshed checkout:', command }))
        : steps({ text: 'In a terminal on your computer, from a Woodshed checkout:', command },
          { text: 'It opens this console on a page with a code. Check it is the one your terminal shows, and press Sign in the CLI.' }),
      tokens.length > 0 && h('div', { class: 'set-rows' }, tokens.map((t) => h('div', { class: 'set-row' },
        h('div', null,
          h('div', { class: 'set-name' }, t.name),
          h('div', { class: 'set-help' }, `Signed in ${W.when(t.createdAt)} · last used ${W.when(t.lastUsedAt ?? t.createdAt)} · ends ${W.when(t.expiresAt)}`)),
        h('div', { class: 'set-value' }, h('button', {
          type: 'button', class: 'btn btn-quiet', disabled: busy.has('cli'),
          onclick: () => act({ card: 'cli', note: cliStatus, working: 'Revoking…', done: `${t.name} is signed out.`, call: async () => { me = await W.postJson(`/api/my/cli-tokens/${t.id}/revoke`, {}); } }),
        }, 'Revoke'))))),
      cliStatus);
  }

  // Each repo whose sessions cannot start (databaseGate.mjs), where the console makes no databases of yours to show
  // them beside: every other repo still starts.
  function blockersCard() {
    const blockers = Object.values(me.projectBlockers ?? {});
    if (!blockers.length) return null;
    return h('section', { class: 'set-card', id: 'my-blockers' },
      h('div', { class: 'set-head' }, h('h2', null, 'Repos that need setup')),
      h('p', { class: 'sub' }, 'Sessions cannot start on these yet. Every other repo still starts.'),
      ...blockers.map((blocker) => W.blockerCard(blocker)));
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
    const named = (db.labels ?? []).join(' and ');
    const value = {
      none: me.claudeToken.set ? 'Your own copy of the databases, for your private sessions alone' : 'Made when you save your Claude token',
      working: 'Copying takes about a minute, and New session waits for it',
      ready: [named ? `${named}, called ` : 'Called ', h('code', null, db.name), ': only your private sessions connect'],
      failed: 'The last try failed: open this for why',
    }[db.status];
    // A copy or a restore under way keeps its row open: its progress is what the person came for.
    if (db.status === 'working' || restore.busy()) open.add('my-databases');
    return row({ id: 'my-databases', title: 'Your databases', pill, value },
      h('p', { class: 'sub' }, ...databasesLine(db)),
      db.status === 'working' && h('p', { class: 'sub' }, `Started ${W.when(db.startedAt)}.`),
      db.status === 'failed' && h('p', { class: 'form-note is-error' }, `The last try failed: ${db.error ?? 'no reason given'}.`),
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
    return row({
      id: 'my-home', title: 'MCP logins and Claude memory',
      pill: home.saved ? h('span', { class: 'pill is-ok' }, `Kept · ${(home.bytes / 1024 / 1024).toFixed(1)} MB`) : h('span', { class: 'pill' }, 'Nothing kept yet'),
      value: home.saved ? `Your ~/.claude, last kept ${W.when(home.savedAt)}` : 'Your ~/.claude is kept from your first private session on',
    },
      h('p', { class: 'sub' }, 'Log in to an MCP in any private session. Your ', h('code', null, '~/.claude'),
        ' is kept while one runs and when it stops, and the next session starts with it. Settings stay in step across running sessions within 20 seconds. Forget it once none is running.'),
      home.saved && h('div', { class: 'set-actions' }, h('button', {
        type: 'button', class: 'btn btn-quiet', disabled: busy.has('home'), onclick: () => {
          if (!window.confirm('Forget your kept Claude home? MCP logins, memory, your shared settings and the conversations Resume would reopen are deleted.')) return;
          act({ card: 'home', note: homeStatus, working: 'Forgetting…', done: 'Forgotten.', call: async () => { me = await W.postJson('/api/my/home/forget', {}); } });
        },
      }, 'Forget it')),
      homeStatus);
  }

  async function openFile(key) {
    const { status } = uiOf(key);
    status.textContent = '';
    if (!files[key]) {
      try {
        files[key] = await W.getJson(`/api/my/files/${key}`);
      } catch (err) {
        status.textContent = err.message;
        status.classList.add('is-error');
      }
    }
    render();
  }

  // `reloadEditor` puts the answer in the editor, as Clear mine needs. It is done once the answer is in: the render
  // that shows "Saving…" would otherwise fill the editor with the lines being cleared.
  function fileChange(key, path, body, done, { reloadEditor = false } = {}) {
    const { editor, status } = uiOf(key);
    return act({
      card: `files-${key}`, note: status, done, call: async () => {
        files[key] = await W.postJson(path, body);
        if (reloadEditor) editor.dataset.key = '';
        me = await W.getJson('/api/my');
      },
    });
  }

  function renderFilePill(key) {
    const f = files[key];
    const { pill } = uiOf(key);
    if (!f) return pill.replaceChildren('…');
    const changed = f.draft !== undefined && f.draft !== f.text;
    const saved = me.files?.[key]?.savedAt;
    pill.className = `pill${changed ? ' is-warn' : f.custom ? ' is-ok' : ''}`;
    if (changed) pill.textContent = 'Unsaved changes';
    else if (f.sharedText) pill.textContent = f.custom ? `Shared + yours, saved ${W.when(saved)}` : 'Shared only';
    else pill.textContent = f.custom ? `Yours, saved ${W.when(saved)}` : 'None';
  }

  function sharedFileBlock(f, name) {
    const lines = f.sharedText ? f.sharedText.replace(/\n+$/, '').split('\n').length : 0;
    return h('details', { class: 'shared-file' },
      h('summary', null, h('span', null, `Shared ${name}`), h('span', { class: 'sub' }, lines ? ` · ${lines} line${lines === 1 ? '' : 's'}` : ' · empty')),
      h('pre', { class: 'mono shared-text' }, f.sharedText || 'Nothing yet.'),
      h('p', { class: 'sub' }, 'It comes with the session image (session/tmux.conf in the repo).'));
  }

  function fileRow(key) {
    const f = files[key];
    const { editor, status, pill } = uiOf(key);
    const text = FILE_ROWS[key];
    const busyHere = busy.has(`files-${key}`);
    if (f && editor.dataset.key !== key) {
      editor.value = f.draft ?? f.text;
      editor.dataset.key = key;
    }
    editor.disabled = !f || !me.available;
    // Read-only, not disabled, while it saves: the text stays selectable, and what is typed then can't be lost to the
    // answer, which has no draft and would not show it as unsaved.
    editor.readOnly = busyHere;
    editor.placeholder = text.placeholder;
    renderFilePill(key);
    const label = me.files?.[key]?.label ?? key;
    const shared = Boolean(f?.sharedText);
    const cleared = shared ? `Your sessions use the shared ${label} alone.` : `Your sessions get none of your own lines for ${label}.`;
    return row({
      id: text.id, title: text.title, pill,
      value: f?.custom ? `Your own lines, after the ${shared ? 'shared' : 'session\'s'} ${label}` : shared ? `The shared ${label}, and your own lines after it once you add some` : `Your own lines for ${label}, once you add some`,
    },
    h('p', { class: 'sub' }, text.about),
    shared && sharedFileBlock(f, label),
    h('label', { class: 'field-label', for: editor.id }, h('span', null, `Your own lines for ${label}`)),
    editor,
    text.after && h('p', { class: 'sub' }, text.after),
    h('div', { class: 'set-actions' },
      h('button', {
        type: 'button', class: 'btn btn-open', disabled: !f || !me.available || busyHere,
        onclick: () => fileChange(key, `/api/my/files/${key}`, { text: editor.value }, editor.value.trim()
          ? `Saved your lines for ${label}. Your next session uses them.`
          : cleared),
      }, 'Save'),
      f?.custom && h('button', {
        type: 'button', class: 'btn btn-quiet', disabled: busyHere,
        onclick: () => {
          if (!window.confirm(`Clear your own lines for ${label}? ${cleared}`)) return;
          fileChange(key, `/api/my/files/${key}/reset`, {}, cleared, { reloadEditor: true });
        },
      }, 'Clear mine')),
    status);
  }

  function fileRows() {
    return me ? fileKeys().map(fileRow) : [];
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
    projectSelect.disabled = busy.has('project');
    return line('My default project', [
      projects.saved ? 'The repo New session opens on.' : 'New session opens on the console\u2019s default until you pick one.',
      ' You can still pick another for one session.', projectStatus,
    ], [h('label', { class: 'sr-only', for: 'default-project' }, 'My default project'), projectSelect], { id: 'my-project' });
  }
  // Saved as it is picked, as a switch is: the row has no Save.
  projectSelect.addEventListener('change', () => act({
    card: 'project', note: projectStatus, done: 'Saved.',
    call: async () => { projects = await W.postJson('/api/my/projects/default', { project: projectSelect.value }); },
  }));

  // What your private sessions run claude or codex in (session/agentPane.mjs): tmux, or Herdr's terminal runtime, which
  // your own Herdr can attach to. One pick, saved as it is picked (designSystem/components/SettingsRows). Your next
  // private session reads it; shared sessions, reviews, QA and questions are in tmux whatever it says.
  const terminalStatus = h('p', { class: 'form-note', role: 'status' });
  function terminalCard() {
    const current = me.terminal === 'herdr' ? 'herdr' : 'tmux';
    const pick = (terminal) => act({
      card: 'terminal', note: terminalStatus, done: 'Saved. Your next private session starts in it; running ones keep theirs.',
      call: async () => { me = { ...me, ...(await W.postJson('/api/my/terminal', { terminal })) }; },
    });
    return line('Agent terminal', [
      current === 'herdr'
        ? 'Your private sessions run their agent in Herdr. The TUI tab attaches to it, and so can your own Herdr.'
        : 'Your private sessions run their agent in tmux.',
      ' Shared sessions, reviews and the Terminal tab use tmux either way.', terminalStatus,
    ], seg('Agent terminal', [['tmux', 'tmux', 'Run the agent in tmux'], ['herdr', 'Herdr', 'Run the agent in Herdr’s terminal runtime']], current, pick, busy.has('terminal') || !me.available), { id: 'my-terminal' });
  }

  // How the console looks to you, once a sheet of its own (⇧⌘, comes here now). The theme and review files are this
  // browser's (localStorage, as theme.js and the shed's review page read them); the tab a session opens on is yours on
  // every device (viewPrefs.mjs), one for a desktop and one for a phone, since a phone's narrow screen is where TUI and
  // Chat differ most. Each pick applies at once.
  const THEME_KEY = 'woodshed-theme';
  // Read by the shed's review page, which is framed on this origin: writing it fires a storage event there.
  const REVIEW_EXPAND_KEY = 'shed.review.expand';
  let sessionView = null;
  let viewLoaded = false;
  const displayStatus = h('p', { class: 'form-note', role: 'status' });
  const loadSessionView = () => W.getJson('/api/my/session-view').then((answer) => { sessionView = answer; }, (err) => {
    displayStatus.textContent = `Could not load your session views: ${err.message}`;
    displayStatus.classList.add('is-error');
  }).finally(() => { viewLoaded = true; if (me) render(); });

  function currentTheme() {
    return document.documentElement.dataset.theme || 'system';
  }
  function setTheme(theme) {
    try {
      if (theme === 'system') window.localStorage.removeItem(THEME_KEY);
      else window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      // A private window keeps it for this page.
    }
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    render();
  }
  // Expanded unless folded by choice: the review page reads 'collapsed' as folded and anything else as open.
  function reviewExpands() {
    try {
      return window.localStorage.getItem(REVIEW_EXPAND_KEY) !== 'collapsed';
    } catch {
      return true;
    }
  }
  function setReviewExpand(value) {
    try {
      if (value === 'collapsed') window.localStorage.setItem(REVIEW_EXPAND_KEY, 'collapsed');
      else window.localStorage.removeItem(REVIEW_EXPAND_KEY);
    } catch {
      // A private window keeps nothing.
    }
    render();
  }
  function setSessionView(where, view) {
    const before = sessionView;
    sessionView = { ...sessionView, [where]: view };
    return act({ card: 'display', note: displayStatus, done: 'Saved. Sessions you open from now on start there.', call: async () => {
      try {
        sessionView = await W.postJson('/api/my/session-view', { [where]: view });
      } catch (err) {
        sessionView = before;
        throw err;
      }
    } });
  }

  function seg(label, options, current, onPick, disabled = false) {
    return h('div', { class: 'theme-seg', role: 'group', 'aria-label': label }, options.map(([value, text, title]) => h('button', {
      type: 'button', class: 'theme-opt', title, disabled, 'aria-pressed': String(value === current), onclick: () => { if (value !== current) onPick(value); },
    }, text)));
  }
  function displayRow(name, help, control) {
    return line(name, help, control);
  }

  function displayCard() {
    const VIEWS = [['chat', 'Chat', 'The conversation, with a box to type in'], ['tui', 'TUI', 'The agent\u2019s own live terminal']];
    const viewRow = (where, name, help) => displayRow(name, help, seg(name, VIEWS, sessionView?.[where] ?? 'chat', (view) => setSessionView(where, view), !sessionView || busy.has('display')));
    return group({
      id: 'my-display', label: 'Display',
      note: ['Theme and review files stay in this browser. The tab a session opens on follows you. ', W.shell ? h('kbd', null, W.shell.keyText('settings')) : null, W.shell ? ' opens this from anywhere.' : null, displayStatus],
    },
        displayRow('Theme', 'Follow the device, or pick one. Terminals stay dark either way.',
          seg('Theme', [['system', 'device', 'Follow my device'], ['light', 'light', 'Always light'], ['dark', 'dark', 'Always dark']], currentTheme(), setTheme)),
        displayRow('Review files', 'Whether a review opens with every file\u2019s diff showing or folded. Files you mark as viewed stay folded.',
          seg('Review files', [['collapsed', 'folded', 'Open a review with every file folded'], ['all', 'expanded', 'Open a review with every file\u2019s diff showing']], reviewExpands() ? 'all' : 'collapsed', setReviewExpand)),
        viewRow('desktop', 'Sessions on a desktop', 'The tab a session opens on in a wide window.'),
        viewRow('phone', 'Sessions on a phone', 'The same for a window under 720px wide.'));
  }

  // Who reviews the pull requests you open (console/reviewAgents.mjs), as a grid: each agent that reviews on its own row
  // (shared/agents.cjs), Off and On across the top (designSystem/components/OnOffGrid). Several on is all of them, all
  // off is no code review. On is offered only while the team's key or your own sign-in can run it: Grok Build and
  // OpenCode have no team key. With nothing saved, every reviewer that can run does, except a Grok Build or OpenCode
  // sign-in already saved when that default shipped, or found in the secret store without a save on My settings
  // since: those stay Claude Code and Codex until Include every reviewer.
  // A pick saves at once.
  let reviews = null;
  const reviewStatus = h('p', { class: 'form-note', role: 'status' });
  let reviewsLoaded = false;
  // `expanded` on the reviews answer is what the card and the sign-in switches say after a save. `me` is the last
  // /api/my, so without this the switches keep the old note until the next full load.
  function rememberReviews(answer) {
    reviews = answer;
    if (me && answer && Object.hasOwn(answer, 'expanded')) me.expandedReviewDefault = answer.expanded !== false;
  }
  const loadReviews = () => W.getJson('/api/my/reviews').then(rememberReviews, () => {}).finally(() => { reviewsLoaded = true; if (me) render(); });

  function saveReviews(choice, done) {
    return act({ card: 'reviews', note: reviewStatus, done, call: async () => { rememberReviews(await W.postJson('/api/my/reviews', { choice })); } });
  }

  // Which model each reviewer runs on: `models` is your own picks, and a reviewer with none runs on its default
  // (`modelDefaults`: Claude Code's opus, the others' own). Saved at once; it replaces your picks as a whole.
  function saveReviewModels(models) {
    return act({ card: 'reviews', note: reviewStatus, done: 'Saved. It applies to the next review.', call: async () => { rememberReviews(await W.postJson('/api/my/reviews', { models })); } });
  }
  function modelControl(id, label) {
    const picks = reviews.models ?? {};
    const change = (value) => saveReviewModels({ ...picks, [id]: value.trim() });
    const aria = `${label} model`;
    if (id === 'claude') {
      const fallback = reviews.modelDefaults?.claude ?? 'opus';
      return h('select', { class: 'field onoff-model', 'aria-label': aria, disabled: busy.has('reviews'), onchange: (e) => change(e.target.value) },
        h('option', { value: '', selected: !picks.claude }, `Default (${fallback})`),
        ...(reviews.claudeModels ?? []).map((m) => h('option', { value: m, selected: picks.claude === m }, m)));
    }
    const input = h('input', {
      class: 'field mono onoff-model', type: 'text', value: picks[id] ?? '', placeholder: A.agent(id).modelHint || 'its default', 'aria-label': aria,
      maxlength: '200', autocomplete: 'off', spellcheck: 'false', disabled: busy.has('reviews'),
      onchange: () => { if (input.value.trim() !== (picks[id] ?? '')) change(input.value); },
    });
    return input;
  }

  function reviewsCard() {
    if (!reviews) return null;
    const { available, best, choice, ownWhy = {}, expanded = true } = reviews;
    const widened = expanded !== false;
    const on = new Set(A.reviewersOf(choice ?? best) ?? []);
    const needs = {
      claude: 'Needs a Claude token (Sign-ins), or the team\u2019s Anthropic key.',
      codex: 'Needs a Codex sign-in (Sign-ins), or the team\u2019s OpenAI key.',
      grok: 'Needs your Grok Build sign-in (Sign-ins), on for reviews. There is no team key for it.',
      opencode: 'Needs an Anthropic or OpenAI API key in your OpenCode sign-ins (Sign-ins), on for reviews. There is no team key for it.',
    };
    const rows = A.REVIEW_AGENT_IDS.map((id) => [id, A.agent(id).product, ownWhy[id] ? `${ownWhy[id].replace(/^the author's/, 'Your')}.` : needs[id]]);
    const pick = (agent, value) => {
      const next = new Set(on);
      if (value) next.add(agent); else next.delete(agent);
      saveReviews(A.reviewChoiceOf([...next]), 'Saved. It applies to the next review.');
    };
    const radio = (agent, label, value) => h('input', {
      type: 'radio', name: `reviews-${agent}`, value: value ? 'on' : 'off', checked: on.has(agent) === value,
      disabled: busy.has('reviews') || (value && !available[agent]), 'aria-label': `${label} ${value ? 'on' : 'off'}`,
      onchange: () => pick(agent, value),
    });
    const chosen = A.reviewersOf(choice) ?? [];
    // A saved choice that cannot run at all falls back to the default, which can include an agent the choice left out.
    const noneLeft = Boolean(choice) && chosen.length > 0 && chosen.every((id) => !available[id]);
    const cantRun = Boolean(choice) && chosen.some((id) => !available[id]);
    // Who the fallback actually runs now. For someone still on the previous default that is Claude Code and Codex
    // only, so `best` of none can mean those two cannot run while Grok Build or OpenCode still can.
    const fallbackIds = A.reviewersOf(best) ?? [];
    const fallbackNames = A.REVIEW_AGENT_IDS.filter((id) => fallbackIds.includes(id)).map((id) => A.agent(id).product);
    const fallbackListed = fallbackNames.length > 1 ? `${fallbackNames.slice(0, -1).join(', ')} and ${fallbackNames.at(-1)}` : fallbackNames[0];
    const keptOutCan = !widened && A.REVIEW_AGENT_IDS.some((id) => !['claude', 'codex'].includes(id) && available[id]);
    // The fallback is no review when this console can run nobody the default includes. Saying "the default reviews"
    // would be false, and so would "nothing else can" while a reviewer the previous default leaves out still can.
    const nothingElse = noneLeft && best === 'none' && !keptOutCan;
    const names = A.REVIEW_AGENT_IDS.filter((id) => on.has(id)).map((id) => A.agent(id).product);
    const listed = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
    // The grid stays the saved choice, so a click edits that choice. The summary says who will review when none of
    // the choice can: the default, or no review when nothing else can. A choice that can only partly run keeps its
    // own names here; the note under the grid says the review gets what of it can.
    const who = (nothingElse || (noneLeft && best === 'none')) ? 'No code review of'
      : noneLeft ? (widened ? 'None of your choice can run, so the default reviews' : `None of your choice can run, so ${fallbackNames.length === 1 ? `${fallbackListed} reviews` : `${fallbackListed} review`}`)
      : !names.length ? 'No code review of' : names.length === 2 ? `${listed} both review` : names.length > 2 ? `${listed} all review` : `${listed} reviews`;
    const keptNote = 'This is the default from before Grok Build and OpenCode joined it. Include every reviewer that can run, and each one whose sign-in or team key can take part. A choice that can no longer run stays on Claude Code and Codex until you do.';
    return row({ id: 'my-reviews', title: 'Reviews of my pull requests', pill: h('span', { class: choice ? 'pill is-ok' : 'pill' }, choice ? 'Your own' : widened ? 'Default' : 'As before'), value: `${who} the pull requests you open` },
      h('p', { class: 'sub' }, 'Who reviews a pull request you open, in repos that review with Woodshed sessions. With several on, the strictest verdict wins, so it is approved only when all of them approve. With all off, there is no code review, and the Slack post and QA go on without one. Grok Build and OpenCode review only on your own sign-in, which the console adds to their calls: it never enters the review. Model picks the one each runs on; empty is its default (Claude Code on opus), and OpenCode takes provider/model.'),
      h('table', { class: 'onoff-grid' },
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Reviewer')), h('th', { scope: 'col' }, 'Off'), h('th', { scope: 'col' }, 'On'), h('th', { scope: 'col' }, 'Model'))),
        h('tbody', null, rows.map(([agent, label, needs]) => h('tr', { class: available[agent] ? null : 'is-unavailable' },
          h('th', { scope: 'row' }, h('span', { class: 'onoff-name' }, label), available[agent] ? null : h('span', { class: 'onoff-note' }, needs)),
          h('td', null, radio(agent, label, false)),
          h('td', null, radio(agent, label, true)),
          h('td', null, modelControl(agent, label)))))),
      h('p', { class: 'form-note' }, choice
        ? (nothingElse ? 'None of what you chose can run now, and nothing else can, so there is no code review.'
          : noneLeft && !widened && best === 'none' ? 'None of what you chose can run now. Claude Code and Codex cannot either, so there is no code review until you include every reviewer that can run.'
          : noneLeft ? (widened
            ? 'None of what you chose can run now, so your reviews get the default: every reviewer that can.'
            : `None of what you chose can run now, so your reviews get ${fallbackListed}, as before. Include every reviewer that can run to use the new default.`)
          : cantRun ? 'What you chose cannot all run now, so your reviews get what of it can.' : 'Your own choice.')
        : (widened
          ? 'Default: every reviewer that can run, from your sign-ins and the team\u2019s keys. Grok Build and OpenCode are included when their sign-in is on for reviews.'
          : keptNote),
      // The link sits in this paragraph. A space of its own keeps it off the period; a trailing space on only some of
      // the sentences left "can.Back to the default" on the ones without it.
      (choice || !widened) ? ' ' : null,
      widened
        ? choice && h('button', { type: 'button', class: 'btn-link', disabled: busy.has('reviews'), onclick: () => saveReviews(null, 'Back to the default.') }, 'Back to the default')
        : h('button', { type: 'button', class: 'btn-link', disabled: busy.has('reviews'), onclick: () => saveReviews(null, 'Saved. Every reviewer that can run reviews the pull requests you open.') }, 'Include every reviewer that can run')),
      reviewStatus);
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
    const hours = (key) => { const n = own[key] ?? me.limitDefaults?.[key]; return n === undefined || n === null ? null : `${n} hour${Number(n) === 1 ? '' : 's'}`; };
    const value = hours('idleHours') && hours('lifetimeHours') ? `Pause after ${hours('idleHours')} waiting for you \u00b7 stop after ${hours('lifetimeHours')} working` : 'When your sessions pause and stop by themselves';
    return row({ id: 'my-timeouts', title: 'My session timeouts', pill: h('span', { class: custom ? 'pill is-ok' : 'pill' }, custom ? 'Your own' : 'Console defaults'), value },
      h('p', { class: 'sub' }, 'When your sessions pause or stop. Work is pushed first, and Resume picks it up. An empty box uses the console\'s number. Running sessions pick up a change within seconds. Shared sessions use the numbers on ', W.isAdmin() ? h('a', { href: '/console-settings#card-sessions' }, 'Settings') : 'Settings (admins)', '.'),
      h('div', { class: 'lgrid2' },
        h('label', { class: 'field-label', for: 'limit-idle' }, h('span', null, 'Pause when waiting for input (hours, 0.25 to 24)'), limitInputs.idleHours),
        h('label', { class: 'field-label', for: 'limit-lifetime' }, h('span', null, 'Stop a working session after (hours, 1 to 24)'), limitInputs.lifetimeHours)),
      h('div', { class: 'set-actions' },
        h('button', { type: 'button', class: 'btn btn-open', disabled: busy.has('limits'), onclick: () => saveLimits({ idleHours: limitInputs.idleHours.value, lifetimeHours: limitInputs.lifetimeHours.value }, 'Saved.') }, 'Save'),
        custom && h('button', { type: 'button', class: 'btn btn-quiet', disabled: busy.has('limits'), onclick: () => saveLimits({}, 'Back to the console\'s numbers.') }, 'Use the console\'s')),
      limitStatus);
  }

  // Remove My Woodshed, confirmed by typing your login: every private session stops and leaves the list, and
  // everything saved here is deleted. What is on GitHub stays, and so do shared sessions.
  const removeStatus = h('p', { class: 'form-note', role: 'status' });
  function removeCard() {
    const live = me.running;
    return row({ id: 'my-remove', title: 'Remove My Woodshed', danger: true, pill: !me.setUp && !live ? h('span', { class: 'pill' }, 'Nothing to remove') : null, value: 'Stops your private sessions and deletes everything saved on this page' },
      h('p', { class: 'sub' }, `Stops your ${live} running private session${live === 1 ? '' : 's'} (each branch is pushed first), takes every private session off the list, including stopped ones, and deletes your token, GitHub connection, databases, repo settings, tmux lines and Claude home. What is on GitHub stays, and so do shared sessions.`),
      h('div', { class: 'set-actions' }, h('button', {
        type: 'button', class: 'btn btn-danger',
        onclick: () => W.confirmChange({
          title: 'Remove My Woodshed?',
          before: `${live} running private session${live === 1 ? '' : 's'}${me.claudeToken.set ? ', a Claude token' : ''}`,
          after: 'Nothing: every private session off the list, including stopped ones, and the token and your files deleted',
          effect: 'This cannot be undone. Work in progress is pushed to each branch before its session stops.',
          word: me.login,
          goLabel: 'Remove My Woodshed',
          run: async () => {
            const answer = await W.postJson('/api/my/remove', { confirm: me.login });
            me = answer;
            for (const key of fileKeys()) {
              delete files[key];
              uiOf(key).editor.dataset.key = '';
              openFile(key);
            }
            repoSettings.reload();
            removeStatus.textContent = `My Woodshed removed: ${answer.stopped} stopped, ${answer.removed} taken off the list.`;
            render();
          },
        }),
      }, 'Remove My Woodshed…')),
      removeStatus);
  }

  function render() {
    if (!me) {
      app.replaceChildren(h('div', { class: 'page' }, life.nav('/settings'), h('p', { class: 'empty' }, loadError ? `Could not load your settings: ${loadError}` : 'Loading…')));
      return;
    }
    // The page is rebuilt on each answer (the projects, a save): a box being typed in keeps its focus.
    const focused = document.activeElement;
    app.replaceChildren(h('div', { class: 'page settings-page' },
      life.nav('/settings'),
      h('header', { class: 'page-head' }, h('div', null,
        h('h1', { class: 'title' }, 'My settings ', W.scopePill('/settings')),
        h('p', { class: 'sub' }, `Your My Woodshed sessions. Shared sessions are separate, except the Claude token switch below. What applies to everyone is on `, W.isAdmin() ? h('a', { href: '/console-settings' }, 'Settings') : 'Settings (admins)', '.'))),
      // A repo sessions cannot start on is said first: it is what stops the person, whatever else is set.
      blockersCard(),
      // What a new person does first, then how their sessions run, what is kept between them, each repo's own, and the look.
      group({ id: 'set-signins', label: 'Sign-ins' }, tokenCard(), codexCard(), A.OWN_SIGN_IN_AGENTS.map(agentCard), githubCard(), cliCard()),
      group({ id: 'set-sessions', label: 'Sessions' }, projectCard(), terminalCard(), reviewsCard(), limitsCard()),
      group({ id: 'set-kept', label: 'Kept for you' }, databasesCard(), homeCard()),
      group({
        id: 'repo-settings', label: 'Repos and files',
        note: 'Your env values, instructions and files, in your private sessions on repos you can write to.',
      }, repoSettings.rows(), fileRows()),
      displayCard(),
      group({ id: 'set-remove' }, removeCard())));
    // A box is the same node after the draw; a row's head is a new one, found by its id.
    const again = focused?.id ? (focused.isConnected ? focused : document.getElementById(focused.id)) : null;
    if (again && again !== document.activeElement) again.focus({ preventScroll: true });
    watchDatabases();
    showAsked();
    repoSettings.afterRender();
  }

  // A link that names a row (the setup card's #claude, #codex and the other agents', the search's sections, ⇧⌘,'s
  // #my-display) opens it, scrolls to it once its group is drawn, and puts the caret in the box of those that have one.
  // Once per page load.
  const FOCUS = { claude: 'claude-token', codex: 'codex-auth', ...Object.fromEntries(A.OWN_SIGN_IN_AGENTS.map((id) => [id, `${id}-auth`])) };
  let asked = window.location.hash.slice(1) || null;
  if (new URLSearchParams(window.location.search).get('connected')) open.add('my-github');
  function showAsked() {
    // The rows above Display (reviews, the default project) come in their own answers: scrolling before they are drawn
    // leaves it pushed down the page once they are.
    if (asked === 'my-display' && !(reviewsLoaded && projectsLoaded && viewLoaded)) return;
    const target = asked && document.getElementById(asked);
    if (!target) return;
    const input = document.getElementById(FOCUS[asked]);
    asked = null;
    target.scrollIntoView({ block: 'start' });
    input?.focus({ preventScroll: true });
  }
  // The search, on this page already: its section is opened before it is outlined (settingsSearch.js).
  // A link to a row followed while the page is shown does the same.
  function openNamed(id) {
    if (!id || open.has(id)) return;
    open.add(id);
    render();
  }
  life.on(window, 'woodshed:settings-reveal', (e) => openNamed(e.detail?.id));
  // The browser scrolled to it before the draw that opened it, which can leave it off the window: it is brought back.
  life.on(window, 'hashchange', () => {
    const id = window.location.hash.slice(1);
    openNamed(id);
    document.getElementById(id)?.scrollIntoView({ block: 'start' });
    document.getElementById(FOCUS[id])?.focus({ preventScroll: true });
  });

  W.getJson('/api/my').then((answer) => { me = answer; }, (err) => { loadError = err.message; }).then(() => (me ? Promise.all(fileKeys().map(openFile)) : render()));
  let projectsLoaded = false;
  W.getJson('/api/my/projects').then((answer) => { projects = answer; }, () => {}).finally(() => { projectsLoaded = true; if (me) render(); });
  loadReviews();
  loadSessionView();
  render();
  life.on(window, 'woodshed:me', render);
});
