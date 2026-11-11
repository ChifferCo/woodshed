// The GitHub App setup page, for a console that has no App yet. Three steps: make the App (one click through GitHub's
// manifest flow, or paste the details of one already made), install it on the repo, then restart the console: from
// here when something starts it again (`canRestart`), else from its shell.
// ?created=1 and ?error= are where GitHub's redirect lands (server.mjs, /setup/github/created).
(function () {
  'use strict';
  const W = window.Woodshed;
  const { h } = W;
  const params = new URLSearchParams(window.location.search);

  let data = null;
  let loadError = params.get('error');
  let busy = false;
  let message = null;
  let showPaste = false;
  let ownerType = 'Organization';
  let restarting = false;
  const RESTART_WAIT_MS = 120_000;

  async function act(fn) {
    busy = true;
    message = null;
    render();
    try {
      await fn();
    } catch (err) {
      loadError = err.message;
    }
    busy = false;
    render();
  }

  async function load() {
    try {
      data = await W.getJson('/api/setup/github');
      if (!params.get('error')) loadError = null;
    } catch (err) {
      loadError = err.message;
    }
    render();
  }

  // GitHub takes the manifest as a form post, so the browser leaves for GitHub with it.
  async function createApp() {
    const { url, manifest } = await W.postJson('/api/setup/github/manifest', { ownerType });
    const form = h('form', { method: 'post', action: url },
      h('input', { type: 'hidden', name: 'manifest', value: JSON.stringify(manifest) }));
    document.body.append(form);
    form.submit();
  }

  async function checkInstallation(installationId) {
    const answer = await W.postJson('/api/setup/github/installation', installationId ? { installationId } : {});
    message = answer.installed ? 'The App is installed on the repo and a token can be made with it.' : 'GitHub does not show the App on the repo yet.';
    await load();
  }

  function step(n, title, done, ...body) {
    return h('section', { class: 'secret-form' },
      h('h3', null, `${done ? '✓ ' : ''}${n}. ${title}`), ...body);
  }

  function pasteForm() {
    const fields = {};
    const input = (name, label, attrs = {}) => {
      fields[name] = attrs.rows ? h('textarea', { class: 'field', rows: attrs.rows, autocomplete: 'off', spellcheck: 'false' })
        : h('input', { class: 'field', type: attrs.type || 'text', autocomplete: 'off', spellcheck: 'false' });
      return h('label', { class: 'field-label' }, label, fields[name]);
    };
    return h('form', {
      class: 'secret-form',
      onsubmit: (e) => {
        e.preventDefault();
        const body = Object.fromEntries(Object.entries(fields).map(([k, el]) => [k, el.value]).filter(([, v]) => v.trim()));
        act(async () => {
          data = await W.postJson('/api/setup/github/paste', body);
          loadError = null;
          for (const el of Object.values(fields)) el.value = '';
          showPaste = false;
        });
      },
    },
    input('appId', 'App ID (the number at the top of the App\'s settings page)'),
    input('privateKey', 'Private key (the whole .pem file, from Generate a private key)', { rows: 6 }),
    input('clientSecret', 'Client secret (optional: only for signing people in with GitHub)', { type: 'password' }),
    input('installationId', 'Installation ID (optional: the number that ends the installation page\'s URL)'),
    h('p', { class: 'msg-plain' }, 'GitHub is asked to confirm the App ID and key before anything is kept. The key and secret go to the secret store and are never shown again.'),
    h('div', null, h('button', { class: 'btn btn-open', type: 'submit', disabled: busy }, 'Check and save')));
  }

  function createStep() {
    const made = Boolean(data.appId && data.keySet);
    if (made) {
      return step(1, 'Make the GitHub App', true,
        h('p', null, 'App ', h('b', null, data.slug || data.appId), ' (ID ', h('code', null, data.appId), ') is saved, its key in the secret store.'),
        h('button', { type: 'button', class: 'btn btn-plain', onclick: () => { showPaste = !showPaste; render(); } }, showPaste ? 'Cancel' : 'Use a different App'),
        showPaste && pasteForm());
    }
    return step(1, 'Make the GitHub App', false,
      h('p', null, 'Woodshed needs a GitHub App for ', h('code', null, data.repo), ': it pushes, opens pull requests and comments as the App, and people sign in through it. ',
        'One click makes it with the right permissions: GitHub asks you to confirm the name, then brings you back here.'),
      h('label', { class: 'field-label' }, 'Make it under',
        h('select', { class: 'field', onchange: (e) => { ownerType = e.target.value; } },
          h('option', { value: 'Organization', selected: ownerType === 'Organization' }, `the ${data.repo.split('/')[0]} organization (you must be an owner of it)`),
          h('option', { value: 'User', selected: ownerType === 'User' }, 'my own GitHub account'))),
      h('div', null, h('button', { type: 'button', class: 'btn btn-open', disabled: busy, onclick: () => act(createApp) }, 'Create the App on GitHub')),
      h('p', { class: 'msg-plain' }, 'Its Callback URL will be ', h('code', null, `${data.publicUrl}/auth/callback`),
        '. GitHub only takes an http address for localhost: anywhere else this console\'s public URL must be https, and set WOODSHED_PUBLIC_URL to it first.'),
      h('details', null, h('summary', null, 'I already have an App: paste its details instead'), pasteForm()));
  }

  function installStep() {
    const made = Boolean(data.appId && data.keySet);
    const done = Boolean(data.installationId);
    if (!made) return step(2, 'Install it on the repo', false, h('p', { class: 'msg-plain' }, 'After step 1.'));
    const installUrl = data.slug ? `https://github.com/apps/${data.slug}/installations/new` : 'https://github.com/settings/apps';
    let idField;
    return step(2, 'Install it on the repo', done,
      h('p', null, 'Install the App on ', h('b', null, data.repo), ' only: choose “Only select repositories”. Then come back and check.'),
      h('p', null, h('a', { class: 'btn btn-plain', href: installUrl, target: '_blank', rel: 'noopener' }, 'Open the installation page')),
      done && h('p', null, 'Installation ', h('code', null, data.installationId), ' saved.'),
      h('div', { class: 'value-row' },
        h('button', { type: 'button', class: 'btn btn-open', disabled: busy, onclick: () => act(() => checkInstallation()) }, done ? 'Check again' : 'I installed it: find it')),
      h('details', null, h('summary', null, 'Or give the installation ID by hand'),
        h('div', { class: 'value-row' },
          idField = h('input', { class: 'field', placeholder: 'The number ending the installation page\'s URL', autocomplete: 'off' }),
          h('button', { type: 'button', class: 'btn btn-plain', disabled: busy, onclick: () => act(() => checkInstallation(idField.value)) }, 'Check and save'))));
  }

  // The new process has the App, so it has sign-in: /api/me says `supported` then, and never before.
  async function waitForRestart() {
    const until = Date.now() + RESTART_WAIT_MS;
    while (Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const me = await W.getJson('/api/me').catch(() => null);
      if (me?.supported) return window.location.replace(me.signIn && !me.login ? '/login' : '/');
    }
    restarting = false;
    throw new Error('the console has not come back after two minutes: its log says why (journalctl -u <its unit>, or docker logs)');
  }

  async function restartConsole() {
    await W.postJson('/api/setup/github/restart', {});
    restarting = true;
    render();
    await waitForRestart();
  }

  function restartStep() {
    if (!data.needsRestart) return step(3, 'Restart the console', false, h('p', { class: 'msg-plain' }, 'After steps 1 and 2.'));
    if (restarting) {
      return step(3, 'Restart the console', false,
        h('p', { role: 'status' }, 'Restarting… this page goes on to sign-in when the console is back with its App.'));
    }
    if (data.canRestart) {
      return step(3, 'Restart the console', false,
        h('p', null, 'Everything is saved. The console reads its App when it starts: restart it here, then sign in. Sessions keep running while it restarts.'),
        h('div', null, h('button', { type: 'button', class: 'btn btn-open', disabled: busy, onclick: () => act(restartConsole) }, 'Restart the console')));
    }
    return step(3, 'Restart the console', false,
      h('p', null, 'Everything is saved. The console reads its App when it starts: restart it, then sign in. On the local provider, stop it and run ',
        h('code', null, 'node woodshed/providers/console.mjs'), ' again as in providers/local/README.md; under systemd, ', h('code', null, 'systemctl restart'),
        ' its unit; in Docker, ', h('code', null, 'docker compose restart console'), '.'),
      h('p', { class: 'msg-plain' }, 'Nothing is known to start this console again if it exits, so the page offers no Restart button. ',
        'Under systemd with Restart=on-failure it offers one; in Docker with a restart policy, set ', h('code', null, 'WOODSHED_SUPERVISED=1'), '.'));
  }

  function render() {
    const app = document.getElementById('app');
    const head = h('header', { class: 'page-head' }, h('div', null,
      h('a', { class: 'side-back', href: '/' }, '‹ Back to sessions'),
      h('h1', { class: 'title' }, 'Set up the GitHub App'),
      h('p', { class: 'sub' }, 'Sessions push, open pull requests and sign people in through a GitHub App. This console has none yet.')));
    let body;
    if (!data) body = h('p', { class: 'empty' }, loadError ? `Could not load: ${loadError}` : 'Loading…');
    else if (data.configuredBy) body = h('p', { class: 'form-ok' }, `This console already runs on a GitHub App (${data.configuredBy === 'setup' ? 'from this page' : 'from its settings'}). Change its key on the Secrets page.`);
    else if (!data.hasSecretStore) body = h('p', { class: 'form-error' }, 'This console has no secret store, so it cannot keep an App\'s key. Set WOODSHED_LOCAL_SECRETS_DIR and WOODSHED_LOCAL_SECRETS_KEY_FILE (providers/local/README.md, step 4) and restart.');
    else body = h('div', { class: 'wizard-body' }, createStep(), installStep(), restartStep());
    app.replaceChildren(h('div', { class: 'page' }, head,
      params.get('created') && !params.get('error') && h('p', { class: 'form-ok' }, 'GitHub made the App and the console saved its key.'),
      message && h('p', { class: 'msg-plain' }, message),
      data && loadError && h('p', { class: 'form-error', role: 'alert' }, loadError),
      body));
  }

  load();
})();
