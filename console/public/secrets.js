// The Secrets & webhooks page. Values stay hidden until Show; every change
// opens a dialog that says what it changes and needs the name typed to go
// ahead. No timed refresh: it would wipe a half-filled form.
(function () {
  'use strict';
  const W = window.Woodshed;
  const { h } = W;
  const MASK = '•••••••••••• hidden';
  const SESSION_EFFECT = 'New sessions start with the new value. Running sessions keep the old one until they stop.';
  const CLIENT_SECRET_EFFECT = 'Sign-in with GitHub becomes available. The first sign-in that works makes it required on every page; '
    + 'until then nothing changes, so a wrong Callback URL in the App’s settings locks nobody out.';

  const SLACK_EFFECT = 'The next pull request a session opens is posted with this bot, to the channel on the Console settings page.';

  const RECEIVER = W.providerWords.webhookReceiver ?? 'the webhook receiver';
  const SLACK_SIGNING_EFFECT = `${W.capitalised(RECEIVER)} checks each Slack event with it, from its next request: a mention of the bot then asks a question.`;

  function effectOf(name) {
    if (name === 'slack-bot-token') return SLACK_EFFECT;
    if (name === 'slack-signing-secret') return SLACK_SIGNING_EFFECT;
    return name === 'github-app-client-secret' ? CLIENT_SECRET_EFFECT : SESSION_EFFECT;
  }
  const GROUPS = [
    { id: 'session', title: 'Session secrets', note: 'Every session reads these when it starts. None may hold a production credential or an integration token.' },
    { id: 'console', title: 'Console only', note: 'Sessions cannot read these. They stay on the base box.' },
  ];

  let data = null;
  let manager = null;
  let managerChoice = null;
  let managerPrefix = null;
  let loadError = null;
  let open = null;
  let lastDelivery = null;
  let advancedOpen = false;
  let notice = null;
  const revealed = new Map();
  const copied = new Set();
  // Kept across renders, so a half-filled form survives another row's Show.
  const forms = new Map();

  function mono(text, cls) {
    return h('code', { class: `value-box${cls ? ` ${cls}` : ''}` }, text);
  }

  function copyButton(key, text) {
    return h('button', {
      type: 'button', class: 'btn btn-plain',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(text);
          copied.add(key);
          render();
          setTimeout(() => { copied.delete(key); render(); }, 2000);
        } catch {
          window.alert('The browser would not copy. Select the text and copy it by hand.');
        }
      },
    }, copied.has(key) ? 'Copied' : 'Copy');
  }

  async function reveal(name) {
    if (revealed.has(name)) {
      revealed.delete(name);
      return render();
    }
    try {
      revealed.set(name, (await W.postJson(`/api/secrets/${name}/reveal`)).value);
    } catch (err) {
      notice = { name, text: err.message, error: true };
    }
    render();
  }

  async function chooseManager(kind, prefix) {
    const keep = manager?.configured && manager.kind !== kind ? ' Secrets already saved in the current one stay there and are not copied.' : '';
    if (manager?.configured && !window.confirm(`Switch the secrets manager to ${kind === 'aws' ? 'AWS Secrets Manager' : 'local files'}?${keep}`)) return;
    try {
      manager = await W.postJson('/api/secrets-manager', { kind, prefix });
      managerChoice = null;
      await reload({ name: 'manager', text: 'The secrets manager is set. My settings can save a Claude token now.' });
    } catch (err) {
      notice = { name: 'manager', text: err.message, error: true };
      render();
    }
  }

  // Where this console keeps its secrets, chosen here when its settings do not fix it.
  function managerCard() {
    if (!manager?.canChoose) return null;
    const kind = managerChoice ?? manager.kind ?? 'local';
    const prefix = managerPrefix ?? manager.prefix ?? manager.defaultPrefix;
    const where = manager.kind === 'aws' ? `AWS Secrets Manager, under ${manager.prefix}` : manager.kind === 'local' ? `sealed files in ${manager.dir}` : 'none chosen yet';
    const select = h('select', {
      class: 'field', id: 'manager-kind',
      onchange: (e) => { managerChoice = e.target.value; managerPrefix = document.getElementById('manager-prefix')?.value ?? managerPrefix; render(); },
    },
      h('option', { value: 'local', selected: kind === 'local' }, 'Local files on this machine'),
      h('option', { value: 'aws', selected: kind === 'aws' }, 'AWS Secrets Manager'));
    const prefixInput = h('input', { type: 'text', id: 'manager-prefix', class: 'field mono', value: prefix, autocomplete: 'off', spellcheck: 'false' });
    const note = notice?.name === 'manager' ? h('p', { class: `form-note${notice.error ? ' is-error' : ''}`, role: 'status' }, notice.text) : null;
    return h('section', { class: 'secret-group', 'aria-labelledby': 'group-manager' },
      h('h2', { id: 'group-manager', class: 'label' }, 'Secrets manager'),
      h('p', { class: 'sub' }, `In use: ${where}. Claude tokens, session secrets and the rest are kept there.`),
      h('form', { class: 'secret-form', onsubmit: (e) => e.preventDefault() },
        h('label', { class: 'field-label' }, 'Keep secrets in', select),
        kind === 'aws' && h('label', { class: 'field-label' }, 'Name prefix', prefixInput),
        h('p', { class: 'sub' }, kind === 'aws'
          ? 'Uses the AWS credentials this console runs with, through the AWS CLI. Each secret is created under the prefix when it is first saved.'
          : 'Each secret is a file sealed with a key made on first use, in this console’s state folder. Nothing leaves this machine.'),
        h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'btn btn-open', onclick: () => chooseManager(kind, kind === 'aws' ? prefixInput.value : undefined) },
            manager.configured ? 'Switch' : 'Use this'))),
      note);
  }

  async function reload(after) {
    manager = await W.getJson('/api/secrets-manager').catch(() => null);
    try {
      data = await W.getJson('/api/secrets');
      loadError = null;
    } catch (err) {
      loadError = err.message;
    }
    if (after) notice = after;
    render();
    // GitHub's side of the last delivery, after the page is up: a slow GitHub should not hold the secrets back.
    W.getJson('/api/webhook/deliveries')
      .then((d) => { lastDelivery = d.deliveries[0] ?? null; })
      .catch(() => { lastDelivery = null; })
      .then(() => { if (data) render(); });
  }

  // Secrets Manager keeps the value before a change as AWSPREVIOUS; sealed files keep none.
  function keepsPrevious() {
    return manager?.kind === 'aws';
  }

  /** @returns {string}  where this console keeps its secrets, for a sentence */
  function storeName() {
    if (manager?.kind === 'aws') return 'AWS';
    return manager?.kind === 'local' ? 'this console’s sealed files' : 'the secret store';
  }

  function changedLine(s) {
    // Terraform makes each of AWS's; a store chosen on this page makes one when it is first saved.
    if (!s.exists && manager?.kind === 'aws' && !manager.canChoose) return 'Missing in AWS: apply Terraform to create it';
    if (!s.set) return 'No value yet';
    return `Changed ${W.when(s.changedAt)}`;
  }

  function statusFor(s) {
    if (s.set) return h('span', { class: 'status is-done' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { class: 'word' }, 'set'));
    return h('span', { class: 'status is-needs-you' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { class: 'word' }, 'not set'));
  }

  function formFor(s) {
    if (forms.has(s.name)) return forms.get(s.name);
    const fileInput = s.kind === 'line' ? null : h('input', { type: 'file', accept: s.kind === 'pem' ? '.pem' : '.env,.local,text/plain' });
    const text = s.kind === 'line'
      ? h('input', { type: 'password', autocomplete: 'off', class: 'field mono', placeholder: 'Paste the new value' })
      : h('textarea', { rows: '6', spellcheck: 'false', class: 'field mono', placeholder: s.kind === 'pem' ? '-----BEGIN RSA PRIVATE KEY-----' : 'KEY=value, one per line' });
    if (fileInput) {
      fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        if (file) text.value = await file.text();
      });
    }
    const form = h('form', { class: 'secret-form', onsubmit: (e) => e.preventDefault() },
      fileInput && h('label', { class: 'field-label' }, s.kind === 'pem' ? 'Upload the App’s .pem' : 'Upload the file', fileInput),
      h('label', { class: 'field-label' }, fileInput ? 'Or paste it' : 'New value', text),
      h('p', { class: 'sub' }, s.name === 'github-app-key'
        ? 'The console mints a test token with the new key first, and keeps the old key if GitHub refuses it.'
        : effectOf(s.name)),
      h('div', { class: 'actions' },
        h('button', {
          type: 'button', class: 'btn btn-open',
          onclick: () => W.confirmChange({
            title: `Replace ${s.name}?`,
            before: s.set ? `the value from ${W.when(s.changedAt)}` : 'no value',
            after: keepsPrevious() ? 'a new version; the one before stays restorable in AWS as AWSPREVIOUS' : 'a new value; the one before is not kept',
            effect: s.name === 'github-app-key' ? 'GitHub calls and session tokens use the new key at once.' : effectOf(s.name),
            word: s.name,
            goLabel: 'Replace',
            run: async () => {
              await W.postJson(`/api/secrets/${s.name}`, { value: text.value, confirm: s.name });
              forms.delete(s.name);
              revealed.delete(s.name);
              open = null;
              await reload({ name: s.name, text: 'Saved as a new version.' });
            },
          }),
        }, 'Review change'),
        h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { open = null; forms.delete(s.name); render(); } }, 'Cancel')));
    forms.set(s.name, form);
    return form;
  }

  function secretRow(s) {
    const value = revealed.get(s.name);
    return h('div', { class: `secret-row${open === s.name ? ' is-open' : ''}` },
      h('div', { class: 'secret-head' },
        h('div', { class: 'secret-main' },
          h('div', { class: 'card-head' }, h('code', { class: 'secret-name' }, s.name), statusFor(s)),
          s.description && h('div', { class: 'msg-plain' }, s.description),
          h('div', { class: 'meta' }, h('span', null, changedLine(s))),
          s.set && s.readable && h('div', { class: 'value-row' },
            mono(value ?? MASK, value === undefined ? 'is-masked' : ''),
            h('button', { type: 'button', class: 'btn btn-plain', 'aria-pressed': String(value !== undefined), onclick: () => reveal(s.name) }, value === undefined ? 'Show' : 'Hide'),
            value !== undefined && copyButton(s.name, value)),
          !s.readable && h('div', { class: 'msg-plain' }, 'Write-only: sessions never see this key, so the console never shows it either.')),
        s.exists && h('button', {
          type: 'button', class: 'btn btn-stop', 'aria-expanded': String(open === s.name),
          onclick: () => { open = open === s.name ? null : s.name; render(); },
        }, open === s.name ? 'Close' : s.set ? 'Replace' : 'Set')),
      open === s.name && formFor(s),
      notice?.name === s.name && h('p', { class: notice.error ? 'form-error' : 'form-ok', role: 'status' }, notice.text));
  }

  function eventsCheck(github, wanted) {
    if (!github.events) return null;
    const missing = wanted.filter((e) => !github.events.includes(e));
    if (!missing.length) return h('span', null, 'Subscribed: ', wanted.join(', '));
    return h('span', { class: 'warn' }, `Not subscribed yet: ${missing.join(', ')}. Tick them under Permissions & events in the GitHub App’s settings.`);
  }

  // The card says where the setup stands; the setup itself is the modal in webhookSetup.js.
  function webhookCard() {
    const c = W.webhookChecks(data);
    const events = data.webhook.events;
    const last = lastDelivery;
    const lastOk = last && last.statusCode >= 200 && last.statusCode < 300;
    const connected = c.secret && c.url;
    const allDone = c.active && connected && c.missingEvents?.length === 0 && lastOk;
    const line = (ok, text) => h('li', { class: `check ${ok ? 'is-done' : 'is-needs-you'}` },
      h('span', { class: 'check-mark', 'aria-hidden': 'true' }, ok ? '✓' : '✗'), h('span', null, text));
    return h('section', { class: 'settings-card', 'aria-labelledby': 'hook-title' },
      h('h2', { id: 'hook-title', class: 'label' }, 'GitHub webhook'),
      h('p', { class: 'sub' }, 'Labels and /woodshed comments reach the console in a second or two. Without it, the console only finds them on its 5-minute poll.'),
      c.githubError
        ? h('p', { class: 'warn' }, `GitHub’s side cannot be read: ${c.githubError}`)
        : h('ul', { class: 'checks' },
          line(c.active, c.active ? 'The App’s webhook is switched on' : 'The App’s webhook is switched off in GitHub'),
          line(c.missingEvents?.length === 0, c.missingEvents?.length ? `Not subscribed yet: ${c.missingEvents.map(W.eventName).join(', ')}` : `Subscribed to ${events.map(W.eventName).join(', ')}`),
          line(connected, connected ? `Connected: the App posts to ${RECEIVER}, signed with the stored secret`
            : !c.secret ? 'No secret yet' : `The App does not post to ${RECEIVER} yet`),
          line(lastOk, !last ? 'No deliveries from GitHub yet'
            : `Last delivery ${W.when(last.deliveredAt)}: ${last.event}, ${last.statusCode ? `HTTP ${last.statusCode}` : 'not delivered'}`)),
      h('div', { class: 'actions' },
        h('button', {
          type: 'button', class: allDone ? 'btn btn-plain' : 'btn btn-open',
          onclick: () => W.openWebhookSetup({ data, storeName: storeName(), reload: async () => { await reload(); return data; }, onClose: () => reload() }),
        }, allDone ? 'Check again' : 'Set up webhook')),
      h('details', { class: 'advanced', open: advancedOpen, ontoggle: (e) => { advancedOpen = e.target.open; } },
        h('summary', null, 'Advanced: the payload URL, the secret, rotating it'),
        webhookAdvanced()),
      notice?.name === 'webhook' && h('p', { class: notice.error ? 'form-error' : 'form-ok', role: 'status' }, notice.text));
  }

  function webhookAdvanced() {
    const wh = data.webhook;
    const gh = wh.github;
    const secret = data.secrets.find((s) => s.name === 'github-webhook-secret');
    const value = revealed.get('github-webhook-secret');
    const matches = Boolean(gh.url && wh.expectedUrl && gh.url === wh.expectedUrl);
    const owner = data.repo ? data.repo.split('/')[0] : '';
    const appSettings = gh.slug && owner ? `https://github.com/organizations/${owner}/settings/apps/${gh.slug}` : null;

    let state;
    if (gh.error) state = h('span', { class: 'warn' }, `GitHub’s side could not be read: ${gh.error}`);
    else if (!gh.url) state = h('span', { class: 'warn' }, 'The GitHub App has no webhook URL yet.');
    else if (!matches) state = h('span', { class: 'warn' }, `The GitHub App posts to ${gh.url}, not to ${RECEIVER}.`);
    else state = h('span', null, `The GitHub App posts to ${RECEIVER}.`);

    return h('div', { class: 'advanced-body' },
      h('p', { class: 'sub' }, 'The URL is public by design: a delivery only counts when it is signed with the secret.'),
      h('p', { class: 'msg-plain' }, state),
      h('div', { class: 'field-block' },
        h('span', { class: 'label' }, 'Payload URL'),
        h('div', { class: 'value-row' },
          mono(wh.expectedUrl || `Unknown: ${RECEIVER} has no URL`),
          wh.expectedUrl && copyButton('url', wh.expectedUrl),
          h('button', {
            type: 'button', class: 'btn btn-stop',
            onclick: () => {
              const url = window.prompt('The payload URL to set on the GitHub App', gh.url || wh.expectedUrl || 'https://');
              if (!url) return;
              W.confirmChange({
                title: 'Change the GitHub App’s payload URL?',
                before: gh.url || 'no URL', after: url,
                effect: 'GitHub sends every delivery to the new URL at once. If nothing answers there, webhooks stop and only the 5-minute poll picks up labels and commands.',
                word: 'webhook', goLabel: 'Change URL',
                run: async () => {
                  await W.postJson('/api/webhook/url', { url, confirm: 'webhook' });
                  await reload({ name: 'webhook', text: 'The GitHub App now posts to the new URL.' });
                },
              });
            },
          }, 'Change'))),
      h('div', { class: 'field-block' },
        h('span', { class: 'label' }, 'Secret'),
        secret?.set
          ? h('div', { class: 'value-row' },
            mono(value ?? MASK, value === undefined ? 'is-masked' : ''),
            h('button', { type: 'button', class: 'btn btn-plain', 'aria-pressed': String(value !== undefined), onclick: () => reveal('github-webhook-secret') }, value === undefined ? 'Show' : 'Hide'),
            value !== undefined && copyButton('hook-secret', value))
          : h('div', { class: 'msg-plain' }, 'No secret yet: Make a secret creates one and sets it on the GitHub App.'),
        secret?.set && h('div', { class: 'meta' }, h('span', null, `Changed ${W.when(secret.changedAt)}`))),
      h('div', { class: 'meta' }, h('span', null, 'Content type application/json'), h('span', null, 'SSL verification on')),
      h('p', { class: 'msg-plain' }, eventsCheck(gh, wh.events)),
      h('div', { class: 'actions' },
        h('button', {
          type: 'button', class: secret?.set ? 'btn btn-stop' : 'btn btn-open',
          onclick: () => W.confirmChange({
            title: secret?.set ? 'Rotate the webhook secret?' : 'Make the webhook secret?',
            before: secret?.set ? `the secret from ${W.when(secret.changedAt)}` : 'no secret',
            after: 'a new random secret, set on the GitHub App with the payload URL in the same step',
            effect: secret?.set
              ? 'A delivery GitHub already signed with the old secret fails with a 401. The poll still catches anything missed.'
              : 'GitHub signs every delivery with it from now on. Tick the webhook\u2019s Active box in the GitHub App\u2019s settings if it is not yet.',
            word: 'github-webhook-secret', goLabel: secret?.set ? 'Rotate' : 'Make it',
            run: async () => {
              await W.postJson('/api/webhook/rotate', { confirm: 'github-webhook-secret' });
              revealed.delete('github-webhook-secret');
              await reload({ name: 'webhook', text: 'New secret saved and set on the GitHub App.' });
            },
          }),
        }, secret?.set ? 'Rotate secret' : 'Make a secret'),
        secret?.set && h('button', {
          type: 'button', class: 'btn btn-stop',
          onclick: () => W.confirmChange({
            title: 'Set the payload URL and secret on the GitHub App?',
            before: gh.url || 'no URL', after: `${wh.expectedUrl}, with the stored secret`,
            effect: `Use this when GitHub’s Recent Deliveries show 401s, or after ${RECEIVER} was replaced.`,
            word: 'webhook', goLabel: 'Set them',
            run: async () => {
              await W.postJson('/api/webhook/apply', { confirm: 'webhook' });
              await reload({ name: 'webhook', text: 'The GitHub App has the payload URL and secret.' });
            },
          }),
        }, 'Set on the GitHub App'),
        appSettings && h('a', { class: 'btn btn-pr', href: appSettings, target: '_blank', rel: 'noopener' }, 'Open GitHub App settings'),
        appSettings && h('a', { class: 'btn btn-pr', href: `${appSettings}/advanced`, target: '_blank', rel: 'noopener' }, 'Recent deliveries')));
  }

  function render() {
    const app = document.getElementById('app');
    const head = h('header', { class: 'page-head' },
      h('div', null,
        h('h1', { class: 'title' }, 'Secrets & webhooks'),
        h('p', { class: 'sub' }, `Values stay hidden until you press Show. Every change asks you to confirm it first${keepsPrevious() ? ', and the value before it stays restorable in AWS' : ''}.`)));
    if (!data) {
      const waiting = loadError && manager?.canChoose ? `${manager.configured ? 'The other secrets are listed here once the GitHub App is set up.' : 'Choose where to keep secrets first.'}` : null;
      app.replaceChildren(h('div', { class: 'page' }, W.nav('/secrets'), head, managerCard(),
        h('p', { class: 'empty' }, waiting ?? (loadError ? `Could not load the secrets: ${loadError}` : 'Loading secrets…'))));
      return;
    }
    app.replaceChildren(h('div', { class: 'page' },
      W.nav('/secrets'),
      head,
      managerCard(),
      webhookCard(),
      GROUPS.map((g) => h('section', { class: 'secret-group', 'aria-labelledby': `group-${g.id}` },
        h('h2', { id: `group-${g.id}`, class: 'label' }, g.title),
        h('p', { class: 'sub' }, g.note),
        h('div', { class: 'secret-list' }, data.secrets.filter((s) => s.group === g.id && s.kind !== 'webhook').map(secretRow)))),
      h('p', { class: 'foot' }, 'The Postgres password is not here: RDS keeps and rotates it.')));
  }

  reload();
})();
