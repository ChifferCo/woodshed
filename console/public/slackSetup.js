// The Set up Slack dialog (Console settings' Slack card) and the channel picker it shares with Change channel and a
// repo's own channel. The dialog writes the same two secrets the Secrets page used to (slackSetup.mjs); a value is
// never shown again once saved, so Replace keys opens with both fields empty, and an empty field keeps what is saved.
(function () {
  'use strict';
  const W = window.Woodshed;
  const { h } = W;
  // As slack.mjs checks it: a channel's name would be refused by Slack as channel_not_found.
  const CHANNEL_RE = /^[CG][A-Z0-9]{8,}$/;
  const TOKEN_RE = /^xoxb-[A-Za-z0-9-]{10,}$/;
  const SEARCH_PAUSE_MS = 300;
  const RECEIVER = W.providerWords?.webhookReceiver ?? 'the webhook receiver';
  const URL_FIX = W.providerWords?.webhookUrlFix ?? 'its provider has not given it one';

  function channelProblem(raw) {
    const value = String(raw ?? '').trim();
    return value && !CHANNEL_RE.test(value) ? 'Give the channel\'s ID, such as C0123456789, not its name.' : null;
  }

  /**
   * A searchable list of the workspace's channels, saying whether the bot is in each. Where Slack will not list them
   * (an app made without channels:read and groups:read), a channel ID field instead, with how to get the list.
   * Built once and updated in place, so a redraw of the page around it keeps what is typed and the focus.
   * @param {{value?: string, name?: string|null, botToken?: () => string|null, needsToken?: boolean, onChange?: (id: string) => void, id?: string}} opts
   *   `value` is the channel saved now; `botToken` a token pasted but not saved yet, to list with; `needsToken` when no
   *   token is saved, so the list waits for one to be pasted (reload lists it then)
   * @returns {{el: HTMLElement, value: () => string, problem: () => string|null, reload: () => void}}
   */
  function slackChannelPicker({ value = '', name = null, botToken = () => null, needsToken = false, onChange = () => {}, id = 'slack-channel-search' } = {}) {
    let picked = value;
    let pickedName = name;
    let fallback = null;
    let asked = 0;
    let timer = null;
    const search = h('input', {
      id, class: 'field', type: 'search', autocomplete: 'off', spellcheck: 'false', placeholder: 'Search channels',
      role: 'combobox', 'aria-expanded': 'true', 'aria-controls': `${id}-list`, 'aria-label': 'Search channels',
    });
    const list = h('div', { class: 'channel-list', id: `${id}-list`, role: 'listbox', 'aria-label': 'Channels' });
    const status = h('p', { class: 'sub channel-note', role: 'status' });
    const idField = h('input', { id: `${id}-id`, class: 'field mono is-channel', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'C0123456789', 'aria-label': 'Channel ID' });
    const idError = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const chosen = h('p', { class: 'sub channel-chosen' });
    const el = h('div', { class: 'channel-pick' });

    function chosenLine() {
      if (!picked) return 'No channel chosen.';
      return pickedName ? `Chosen: #${pickedName} (${picked})` : `Chosen: ${picked}`;
    }

    function pick(c) {
      picked = c.id;
      pickedName = c.name;
      for (const row of list.children) row.setAttribute('aria-selected', String(row.dataset?.id === c.id || row.attrs?.['data-id'] === c.id));
      chosen.textContent = chosenLine();
      onChange(picked);
    }

    function option(c) {
      const row = h('button', {
        type: 'button', class: 'channel-option', role: 'option', 'aria-selected': String(c.id === picked), 'data-id': c.id,
        onclick: () => pick(c),
      },
      h('span', { class: 'channel-name' }, `#${c.name}`, c.private ? h('span', { class: 'pill' }, 'private') : null),
      c.member ? h('span', { class: 'pill is-ok' }, 'bot is in it') : h('span', { class: 'pill is-warn' }, 'invite the bot first'));
      return row;
    }

    function showFallback(why) {
      fallback = why;
      idField.value = picked;
      el.replaceChildren(
        h('label', { class: 'field-label', for: `${id}-id` }, 'Channel ID'),
        idField, idError,
        h('p', { class: 'cap-note', role: 'status' }, why),
        h('p', { class: 'sub' }, 'The ID is at the bottom of the channel\'s About tab in Slack: open the channel\'s name at its top. Invite the bot to the channel first.'));
    }

    async function load() {
      const mine = ++asked;
      const q = search.value.trim();
      const token = botToken();
      if (needsToken && !token) {
        list.replaceChildren(h('p', { class: 'sub channel-empty' }, 'The channels are listed once Slack has taken the bot token above.'));
        return;
      }
      try {
        const got = token
          ? await W.postJson('/api/console-settings/slack/channels', { q, botToken: token })
          : await W.getJson(`/api/console-settings/slack/channels?q=${encodeURIComponent(q)}`);
        if (mine !== asked) return;
        if (got.missingScope) {
          showFallback(`Slack would not list the channels: the app lacks the ${got.needed.join(' and ')} scopes. Add them on the app's OAuth & Permissions page, reinstall it, and replace its token on the Slack card. Until then, give the channel's ID.`);
          return;
        }
        if (fallback) return;
        // The saved channel is named once the list has it.
        if (picked && !pickedName) {
          pickedName = got.found.find((c) => c.id === picked)?.name ?? null;
          chosen.textContent = chosenLine();
        }
        list.replaceChildren(...(got.found.length ? got.found.map(option)
          : [h('p', { class: 'sub channel-empty' }, q ? 'No channel matches.' : 'Slack lists no channel yet.')]));
        const more = got.total > got.found.length ? `Showing ${got.found.length} of ${got.total}: type to narrow them.` : '';
        status.textContent = [more, got.truncated ? 'Only the first 2,000 channels are searched.' : ''].filter(Boolean).join(' ');
      } catch (err) {
        if (mine !== asked) return;
        showFallback(`The channels could not be listed: ${err.message} Give the channel's ID instead.`);
      }
    }

    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, SEARCH_PAUSE_MS); });
    idField.addEventListener('input', () => {
      picked = idField.value.trim();
      pickedName = null;
      const bad = channelProblem(picked);
      idError.textContent = bad ?? '';
      idError.hidden = !bad;
      onChange(picked);
    });
    chosen.textContent = chosenLine();
    el.replaceChildren(search, list, status, chosen);
    load();

    return {
      el,
      value: () => picked,
      problem: () => (fallback ? channelProblem(picked) : null),
      reload: () => { fallback = null; el.replaceChildren(search, list, status, chosen); load(); },
    };
  }

  function copyButton(text, label) {
    const button = h('button', { type: 'button', class: 'btn btn-plain' }, label);
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = 'Copied';
        setTimeout(() => { button.textContent = label; }, 2000);
      } catch {
        window.alert('The browser would not copy. Select the text and copy it by hand.');
      }
    });
    return button;
  }

  /**
   * @param {{view: object, mode?: 'choose'|'own'|'replace', onSaved: (view: object) => void}} args  `view` is GET
   *   /api/console-settings/slack's; `mode` where it opens: the choice (when the program embedding the console offers an
   *   install of its own), the own app's steps, or those steps for Replace keys, with the manifest folded away
   */
  function openSlackSetup({ view, mode = view.install ? 'choose' : 'own', onSaved }) {
    const replacing = mode === 'replace';
    const state = { screen: replacing ? 'own' : mode, choice: 'own', busy: false, error: null, check: null };
    const title = h('h2', { id: 'slack-setup-title' });
    const body = h('div', { class: 'wizard-body' });
    const foot = h('div', { class: 'dialog-actions' });
    const dialog = h('dialog', { class: 'confirm wizard slack-setup', 'aria-labelledby': 'slack-setup-title' }, title, body, foot);

    const keep = replacing ? 'Leave it empty to keep the saved one.' : '';
    const token = h('input', { id: 'slack-bot-token', class: 'field mono', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: replacing ? 'Empty keeps the saved token' : 'xoxb-…' });
    const secret = h('input', { id: 'slack-signing-secret', class: 'field mono', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: replacing ? 'Empty keeps the saved secret' : 'Signing Secret' });
    const checkLine = h('p', { class: 'sub', role: 'status' });
    let checkTimer = null;
    let checked = '';

    // Who the pasted token is, from Slack, as soon as it looks like one: the line under the field.
    async function checkToken() {
      const value = token.value.trim();
      if (value === checked) return;
      checked = value;
      state.check = null;
      if (!value) { drawCheck(); return; }
      if (!TOKEN_RE.test(value)) { state.check = { bad: 'A bot token starts with xoxb-.' }; drawCheck(); return; }
      state.check = { busy: true };
      drawCheck();
      try {
        const who = await W.postJson('/api/console-settings/slack/check', { botToken: value });
        if (token.value.trim() !== value) return;
        state.check = { who };
        picker.reload();
      } catch (err) {
        if (token.value.trim() !== value) return;
        state.check = { bad: err.message };
      }
      drawCheck();
    }

    function drawCheck() {
      const c = state.check;
      checkLine.className = c?.bad ? 'form-error' : c?.who ? 'empty-ok' : 'sub';
      if (!c) checkLine.textContent = replacing ? 'The saved token stays unless you paste a new one.' : 'Checked with Slack as soon as it is pasted.';
      else if (c.busy) checkLine.textContent = 'Checking with Slack…';
      else if (c.bad) checkLine.textContent = c.bad;
      else {
        const missing = c.who.missingScopes?.length ? ` It lacks ${c.who.missingScopes.join(', ')}: add them under OAuth & Permissions and reinstall the app.` : '';
        checkLine.textContent = `✓ ${c.who.team ?? 'Slack'} workspace, bot @${c.who.name ?? 'unknown'}.${missing}`;
      }
    }
    token.addEventListener('input', () => { clearTimeout(checkTimer); checkTimer = setTimeout(checkToken, 400); });
    token.addEventListener('change', checkToken);

    // Listed with the pasted token once Slack took it, else with the saved one.
    const picker = slackChannelPicker({ value: view.channel ?? '', name: view.channelName ?? null, botToken: () => (state.check?.who ? token.value.trim() : null), needsToken: !view.connected, id: 'slack-setup-channel' });

    function close() { dialog.close(); }

    function manifestStep() {
      const url = view.eventsUrl
        ? h('p', { class: 'sub' }, 'It already has the bot\'s scopes and this console\'s events Request URL, ', h('code', null, view.eventsUrl), ', which Slack checks when the app is made.')
        : h('p', { class: 'cap-note' }, `This console does not know the address Slack should send its events to, so the manifest has none and questions from Slack stay off until it does. It is ${RECEIVER}'s URL, at /slack: ${URL_FIX}. Pull requests are posted without it.`);
      const parts = [
        h('p', { class: 'sub' }, 'At ', h('a', { href: 'https://api.slack.com/apps', target: '_blank', rel: 'noopener' }, 'api.slack.com/apps ↗'), ', choose ', h('b', null, 'Create New App'), ', then ', h('b', null, 'From a manifest'), ', pick your workspace and paste this in its YAML tab.'),
        url,
        h('div', { class: 'value-row' }, h('pre', { class: 'value-box slack-manifest' }, view.manifest), copyButton(view.manifest, 'Copy manifest')),
      ];
      return replacing
        ? h('details', { class: 'advanced' }, h('summary', null, 'The app\'s manifest, to make the app again'), h('div', { class: 'advanced-body' }, parts))
        : parts;
    }

    function step(n, head, ...content) {
      return h('li', { class: 'slack-step' }, h('span', { class: 'step-n', 'aria-hidden': 'true' }, String(n)),
        h('div', { class: 'slack-step-body' }, h('h3', null, head), content));
    }

    function ownScreen() {
      title.textContent = replacing ? 'Replace Slack\'s keys' : 'Connect your Slack app';
      drawCheck();
      let n = 0;
      body.replaceChildren(
        h('ol', { class: 'slack-steps' },
          step(++n, replacing ? 'The app' : 'Create the app from this manifest', manifestStep()),
          step(++n, 'Install it, then paste its bot token',
            h('p', { class: 'sub' }, 'On ', h('b', null, 'OAuth & Permissions'), ', choose Install to Workspace and copy the ', h('b', null, 'Bot User OAuth Token'), `. ${keep}`),
            h('label', { class: 'sr-only', for: 'slack-bot-token' }, 'Bot User OAuth Token'), token, checkLine),
          step(++n, 'Paste its signing secret',
            h('p', { class: 'sub' }, 'On ', h('b', null, 'Basic Information'), `, under App Credentials. ${keep}`),
            h('label', { class: 'sr-only', for: 'slack-signing-secret' }, 'Signing Secret'), secret,
            h('p', { class: 'sub' }, view.signingSecret ? 'One is saved.' : 'Needed for questions only. Without it, pull requests are still posted.')),
          step(++n, 'Choose a channel for pull requests',
            h('p', { class: 'sub' }, 'Each pull request a shared session opens is posted there, unless its repo has a channel of its own (Repo settings). Invite the bot to it.'),
            picker.el)),
        h('p', { class: 'form-error', role: 'alert', hidden: !state.error }, state.error ?? ''));
      foot.replaceChildren(
        h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => (view.install && !replacing ? go('choose') : close()) }, view.install && !replacing ? 'Back' : 'Cancel'),
        h('button', { type: 'button', class: 'btn btn-open', disabled: state.busy, onclick: save }, state.busy ? 'Saving…' : replacing ? 'Save' : 'Save and connect'));
    }

    function choiceScreen() {
      title.textContent = 'Set up Slack';
      const install = view.install;
      const radio = (key, label, description, { disabled = false, tag = null } = {}) => h('button', {
        type: 'button', class: 'slack-option', role: 'radio', 'aria-checked': String(state.choice === key), 'aria-disabled': disabled ? 'true' : null,
        onclick: () => { if (disabled) return; state.choice = key; render(); },
      },
      h('span', { class: 'radio', 'aria-hidden': 'true' }),
      h('span', { class: 'slack-option-title' }, label, tag),
      description && h('span', { class: 'sub' }, description));
      body.replaceChildren(
        h('p', { class: 'sub' }, 'Choose how the console connects to your workspace.'),
        h('div', { class: 'slack-options', role: 'radiogroup', 'aria-label': 'How to connect' },
          radio('own', 'Use your own Slack app', 'Make an app in your workspace from a manifest this console gives you, then paste its bot token and signing secret here.'),
          // Every word of this option is the program's own.
          radio('install', install.label, install.description, { disabled: !install.available, tag: install.available ? null : h('span', { class: 'pill is-warn' }, 'Coming soon') })));
      foot.replaceChildren(
        h('button', { type: 'button', class: 'btn btn-quiet', onclick: close }, 'Cancel'),
        h('button', {
          type: 'button', class: 'btn btn-open',
          onclick: () => {
            if (state.choice === 'install' && install.available && install.href) location.assign(install.href);
            else go('own');
          },
        }, 'Continue'));
    }

    async function save() {
      const botToken = token.value.trim();
      const signingSecret = secret.value.trim();
      const channel = picker.value().trim();
      const bad = picker.problem() ?? (botToken && !TOKEN_RE.test(botToken) ? 'A bot token starts with xoxb-.' : null)
        ?? (!botToken && !view.connected ? 'Paste the bot token first.' : null);
      if (bad) { state.error = bad; render(); return; }
      const change = {
        ...(botToken && { botToken }), ...(signingSecret && { signingSecret }), ...(channel !== (view.channel ?? '') && { channel }),
      };
      if (!Object.keys(change).length) { close(); return; }
      state.busy = true;
      state.error = null;
      render();
      try {
        const next = await W.postJson('/api/console-settings/slack', change);
        token.value = '';
        secret.value = '';
        close();
        onSaved(next);
      } catch (err) {
        state.busy = false;
        state.error = err.message;
        render();
      }
    }

    function go(screen) { state.screen = screen; state.error = null; render(); }
    function render() { (state.screen === 'choose' ? choiceScreen : ownScreen)(); }

    dialog.addEventListener('close', () => { clearTimeout(checkTimer); dialog.remove(); });
    document.body.append(dialog);
    render();
    dialog.showModal();
    return dialog;
  }

  Object.assign(W, { slackChannelPicker, openSlackSetup, slackChannelProblem: channelProblem });
})();
