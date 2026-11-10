// The GitHub webhook setup, as a modal in three steps: switch the webhook on in GitHub's settings
// (its API cannot), connect the App to the webhook function, then watch a test delivery arrive. Each step reads its
// state back from GitHub, so it says what is done rather than what was clicked.
(function () {
  'use strict';
  const W = window.Woodshed;
  const { h } = W;
  const POLL_MS = 4000;
  const RECEIVER = W.providerWords.webhookReceiver ?? 'the webhook receiver';
  const EVENT_NAMES = {
    issues: 'Issues', issue_comment: 'Issue comment', pull_request: 'Pull request', pull_request_review: 'Pull request review', workflow_run: 'Workflow run',
  };
  const STEPS = ['Switch it on in GitHub', 'Connect', 'Test'];

  /**
   * @returns {{active: boolean|null, secret: boolean, url: boolean, missingEvents: string[]|null, githubError: string|null}}
   *   `active` and `missingEvents` are null while GitHub's side cannot be read
   */
  function webhookChecks(data) {
    const wh = data.webhook;
    const gh = wh.github || {};
    const secret = data.secrets.find((s) => s.name === 'github-webhook-secret');
    return {
      active: gh.error ? null : Boolean(gh.active),
      secret: Boolean(secret?.set),
      url: Boolean(gh.url && wh.expectedUrl && gh.url === wh.expectedUrl),
      missingEvents: gh.events ? wh.events.filter((e) => !gh.events.includes(e)) : null,
      githubError: gh.error || null,
    };
  }

  function appSettingsUrl(data) {
    const slug = data.webhook.github?.slug;
    const owner = data.repo ? data.repo.split('/')[0] : '';
    return slug && owner ? `https://github.com/organizations/${owner}/settings/apps/${slug}` : null;
  }

  function check(ok, text, pending) {
    const cls = ok ? 'is-done' : pending ? 'is-idle' : 'is-needs-you';
    return h('li', { class: `check ${cls}` }, h('span', { class: 'check-mark', 'aria-hidden': 'true' }, ok ? '✓' : pending ? '…' : '✗'),
      h('span', null, text));
  }

  // What a delivery's status code means here, in the words someone fixing it needs.
  function deliveryMeaning(d) {
    if (d.statusCode >= 200 && d.statusCode < 300) return { ok: true, text: 'accepted' };
    if (d.statusCode === 401) return { ok: false, text: 'refused: GitHub signed it with a different secret' };
    if (!d.statusCode) return { ok: false, text: `not delivered: ${d.status || 'no answer'}` };
    const log = W.providerWords.webhookLog ? `. Its log: ${W.providerWords.webhookLog}` : '';
    return { ok: false, text: `${RECEIVER} answered ${d.statusCode}${log}` };
  }

  function consoleResult(e) {
    if (e.outcome === 'started') return `started session ${e.sessionId}`;
    if (e.outcome === 'sent') return `sent to session ${e.sessionId}`;
    if (e.outcome === 'failed') return `failed: ${e.reason || 'no reason recorded'}`;
    return `${e.outcome === 'duplicate' ? 'skipped' : 'ignored'}: ${e.reason || 'nothing to do'}`;
  }

  /**
   * @param {{data: object, reload: () => Promise<object>, onClose?: () => void, storeName?: string}} args
   *   `reload` fetches /api/secrets again and returns it; `storeName` is where the console keeps its secrets
   */
  function openWebhookSetup({ data: initial, reload, onClose, storeName = 'the secret store' }) {
    const openedAt = new Date();
    const state = { step: 0, data: initial, busy: false, error: null, deliveries: null, events: [], deliveriesError: null, checked: false };
    let timer = null;
    const body = h('div', { class: 'wizard-body' });
    const steps = h('ol', { class: 'wizard-steps' });
    const dialog = h('dialog', { class: 'confirm wizard', 'aria-labelledby': 'wizard-title' },
      h('h2', { id: 'wizard-title' }, 'Set up the GitHub webhook'), steps, body);

    async function act(fn) {
      state.busy = true;
      state.error = null;
      render();
      try {
        await fn();
      } catch (err) {
        state.error = err.message;
      }
      state.busy = false;
      render();
    }

    async function refreshData() {
      state.data = await reload();
    }

    async function pollTest() {
      try {
        const [d, e] = await Promise.all([W.getJson('/api/webhook/deliveries'), W.getJson('/api/webhook-events')]);
        // The Reconnect note is about the delivery it answered; a newer one speaks for itself.
        if (state.note && d.deliveries[0]?.guid !== state.noteGuid) state.note = null;
        state.deliveries = d.deliveries;
        state.deliveriesError = null;
        state.events = e.events.filter((x) => new Date(x.receivedAt) >= openedAt);
      } catch (err) {
        state.deliveriesError = err.message;
      }
      if (state.step === 2) render();
    }

    function go(step) {
      state.step = step;
      state.error = null;
      clearInterval(timer);
      timer = null;
      if (step === 2) {
        pollTest();
        timer = setInterval(pollTest, POLL_MS);
      }
      render();
    }

    function nav({ back = true, next = true, nextLabel = 'Next', nextDisabled = false } = {}) {
      return h('div', { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => dialog.close() }, 'Close'),
        back && state.step > 0 && h('button', { type: 'button', class: 'btn btn-plain', onclick: () => go(state.step - 1) }, 'Back'),
        next && h('button', {
          type: 'button', class: 'btn btn-open', disabled: nextDisabled || state.busy,
          onclick: () => (state.step < STEPS.length - 1 ? go(state.step + 1) : dialog.close()),
        }, nextLabel));
    }

    // GitHub's API cannot switch the webhook on, and will not take a secret for a webhook that is off,
    // so this comes first.
    function githubStep() {
      const c = webhookChecks(state.data);
      const wh = state.data.webhook;
      const settings = appSettingsUrl(state.data);
      const wanted = wh.events;
      if (c.githubError) {
        return [h('p', { class: 'warn' }, `GitHub’s side cannot be read: ${c.githubError}.`),
          h('p', { class: 'sub' }, 'Upload the GitHub App key under Console only, below, then open this again.'), nav({ next: false })];
      }
      if (!wh.expectedUrl) {
        return [h('p', { class: 'warn' }, `${W.capitalised(RECEIVER)} has no URL yet: ${W.providerWords.webhookUrlFix ?? 'its provider has not given it one'}.`), nav({ next: false })];
      }
      const ready = c.active && c.missingEvents?.length === 0;
      return [
        h('p', { class: 'sub' }, 'Two pages in the GitHub App’s settings, once. Each link opens in a new tab.'),
        h('ol', { class: 'todo' },
          h('li', null,
            settings ? h('a', { href: settings, target: '_blank', rel: 'noopener' }, 'Open the App’s settings') : 'Open the GitHub App’s settings',
            '. Under ', h('b', null, 'Webhook'), ': tick ', h('b', null, 'Active'), ', paste this as the ', h('b', null, 'Webhook URL'),
            ', leave ', h('b', null, 'Secret'), ' empty (the next step sets it), then ', h('b', null, 'Save changes'), ' at the bottom.',
            h('div', { class: 'value-row' }, h('code', { class: 'value-box' }, wh.expectedUrl), copyButton(wh.expectedUrl))),
          h('li', null,
            settings ? h('a', { href: `${settings}/permissions`, target: '_blank', rel: 'noopener' }, 'Open Permissions & events') : 'Open Permissions & events',
            '. Under ', h('b', null, 'Subscribe to events'), ', tick ', h('b', null, wanted.map(eventName).join(', ')),
            ', then ', h('b', null, 'Save changes'), '.')),
        h('ul', { class: 'checks' },
          check(c.active, c.active ? 'The webhook is switched on' : 'The webhook is switched off'),
          wanted.map((e) => check(c.missingEvents ? !c.missingEvents.includes(e) : false, `Subscribed to ${eventName(e)}`))),
        state.checked && !ready && h('p', { class: 'msg-plain' }, 'Still showing ✗ after Save changes? Reload that settings page: GitHub keeps the old values when a save did not go through.'),
        state.error && h('p', { class: 'form-error', role: 'alert' }, state.error),
        h('div', { class: 'dialog-actions' },
          h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => dialog.close() }, 'Close'),
          h('button', {
            type: 'button', class: ready ? 'btn btn-plain' : 'btn btn-open', disabled: state.busy,
            onclick: () => act(async () => { await refreshData(); state.checked = true; }),
          }, state.busy ? 'Checking…' : 'Check'),
          h('button', { type: 'button', class: ready ? 'btn btn-open' : 'btn btn-plain', disabled: state.busy || !c.active, onclick: () => go(1) }, 'Next')),
        !c.active && h('p', { class: 'foot' }, 'Next unlocks once the webhook is switched on: Connect cannot set a secret before.'),
      ];
    }

    function connectStep() {
      const c = webhookChecks(state.data);
      const wh = state.data.webhook;
      if (c.secret && c.url) {
        return [h('ul', { class: 'checks' }, check(true, `A secret is stored in ${storeName}, and set on the App`), check(true, `The App posts to ${wh.expectedUrl}`)),
          h('p', { class: 'sub' }, 'Connected. If the test shows a 401, Reconnect there sets the stored secret on the App again.'),
          nav()];
      }
      const doing = [
        !c.secret && `Make a random secret and store it in ${storeName} as github-webhook-secret`,
        'Set the same secret on the GitHub App, so GitHub signs every delivery with it',
        !c.url && `Set the App’s Webhook URL to ${wh.expectedUrl}${wh.github?.url ? ` (now ${wh.github.url})` : ''}`,
      ].filter(Boolean);
      return [
        h('p', { class: 'sub' }, 'Connect does this, in one step:'),
        h('ul', { class: 'doing' }, doing.map((d) => h('li', null, d))),
        state.error && h('p', { class: 'form-error', role: 'alert' }, state.error),
        h('div', { class: 'dialog-actions' },
          h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => dialog.close() }, 'Close'),
          h('button', { type: 'button', class: 'btn btn-plain', onclick: () => go(0) }, 'Back'),
          h('button', {
            type: 'button', class: 'btn btn-open', disabled: state.busy,
            onclick: () => act(async () => {
              // The server still checks the word; this page is where it was confirmed.
              if (c.secret) await W.postJson('/api/webhook/apply', { confirm: 'webhook' });
              else await W.postJson('/api/webhook/rotate', { confirm: 'github-webhook-secret' });
              await refreshData();
            }),
          }, state.busy ? 'Connecting…' : 'Connect')),
      ];
    }

    function copyButton(text) {
      const button = h('button', {
        type: 'button', class: 'btn btn-plain',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(text);
            button.textContent = 'Copied';
            setTimeout(() => { button.textContent = 'Copy'; }, 2000);
          } catch {
            button.textContent = 'Select it and copy';
          }
        },
      }, 'Copy');
      return button;
    }

    function testStep() {
      const repo = state.data.repo;
      const fresh = (state.deliveries || []).filter((d) => new Date(d.deliveredAt) >= openedAt);
      const shown = fresh.length ? fresh : (state.deliveries || []).slice(0, 3);
      // Judged by the newest delivery only: an older success must not hide a 401 that came after it.
      const latest = fresh[0];
      const accepted = Boolean(latest && deliveryMeaning(latest).ok);
      const refused = latest?.statusCode === 401;
      // The Lambda passes GitHub's delivery id through, so the console's record of this very delivery can be found.
      const handledEvent = latest ? state.events.find((e) => e.deliveryId === latest.guid) : null;
      const handled = Boolean(handledEvent);
      const done = accepted && handled;
      return [
        h('p', { class: 'sub' }, 'Add any label to an issue in ', h('a', { href: `https://github.com/${repo}/issues`, target: '_blank', rel: 'noopener' }, repo),
          ', for example ', h('code', null, 'documentation'), '. The console records it and starts nothing. (The ', h('code', null, 'woodshed'), ' label would start a real session.)'),
        h('ul', { class: 'checks' },
          check(accepted, accepted ? `GitHub delivered it, and ${RECEIVER} accepted it` : 'Waiting for GitHub to send a delivery…', !accepted && !refused),
          check(handled, handled ? `The console took it off the queue: ${consoleResult(handledEvent)}` : 'Waiting for the console to take it off the queue…', !handled && !refused)),
        state.note && !done && h('p', { class: 'msg-plain', role: 'status' }, state.note),
        done && h('p', { class: 'form-ok', role: 'status' }, 'Webhooks work. Labels and /woodshed comments now reach the console in a second or two.'),
        refused && !state.note && h('div', { class: 'value-row' },
          h('span', { class: 'warn' }, 'GitHub signed it with a different secret.'),
          h('button', {
            type: 'button', class: 'btn btn-stop', disabled: state.busy,
            onclick: () => act(async () => {
              await W.postJson('/api/webhook/apply', { confirm: 'webhook' });
              await refreshData();
              state.note = 'Reconnected: the App has the stored secret again. Add another label to check.';
              state.noteGuid = latest.guid;
            }),
          }, state.busy ? 'Reconnecting…' : 'Reconnect')),
        !fresh.length && state.deliveries && h('p', { class: 'msg-plain' }, 'Nothing new from GitHub yet. If it stays empty after the label, the webhook is not Active: step 1.'),
        state.deliveriesError && h('p', { class: 'form-error' }, `GitHub’s deliveries could not be read: ${state.deliveriesError}`),
        shown.length > 0 && h('div', { class: 'deliveries' },
          h('span', { class: 'label' }, fresh.length ? 'Deliveries since you opened this' : 'GitHub’s last deliveries'),
          h('ul', null, shown.map((d) => {
            const m = deliveryMeaning(d);
            return h('li', { class: m.ok ? 'is-done' : 'is-needs-you' },
              h('span', { class: 'mono' }, `${W.when(d.deliveredAt)}  ${d.event}${d.action ? `.${d.action}` : ''}  ${d.statusCode || '—'}`),
              ' ', h('span', { class: 'msg-plain' }, m.text));
          }))),
        state.error && h('p', { class: 'form-error', role: 'alert' }, state.error),
        nav({ nextLabel: 'Done' }),
      ];
    }

    function render() {
      steps.replaceChildren(...STEPS.map((s, i) => h('li', { 'aria-current': i === state.step ? 'step' : null, class: i < state.step ? 'is-past' : '' },
        h('span', { class: 'step-n' }, String(i + 1)), s)));
      body.replaceChildren(...[githubStep, connectStep, testStep][state.step]().flat().filter(Boolean));
    }

    dialog.addEventListener('close', () => {
      clearInterval(timer);
      dialog.remove();
      onClose?.();
    });
    const c = webhookChecks(initial);
    // Start where the work is.
    if (c.active && c.missingEvents?.length === 0) state.step = c.secret && c.url ? 2 : 1;
    document.body.append(dialog);
    dialog.showModal();
    go(state.step);
  }

  function eventName(e) {
    return EVENT_NAMES[e] || e;
  }

  Object.assign(W, { webhookChecks, openWebhookSetup, eventName });
})();
