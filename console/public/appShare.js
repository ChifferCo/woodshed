// Share the app: who besides its owner may open a My Woodshed session's app (appShares.mjs). Only the app; the
// terminal, Review, the databases and Start/Stop stay the owner's. Opened from the session's ⋯ menu and the palette.
(function () {
  'use strict';
  const W = window.Woodshed;
  const { h } = W;
  const EXPIRIES = [[1, '1 hour'], [24, '1 day'], [168, '7 days']];

  /** @param {{id: string}} s  a running My Woodshed session of this person's */
  function shareApp(s) {
    const base = `/api/sessions/${s.id}/app-share`;
    let state = null;
    let fresh = null;
    let busy = false;
    const body = h('div', null);
    const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const dialog = h('dialog', { class: 'confirm', 'aria-labelledby': 'share-title' },
      h('h2', { id: 'share-title' }, 'Share the app'),
      h('p', { class: 'sub' }, 'Only the app. The terminal, Review, the databases and Start/Stop stay yours. Whoever opens it uses the app as this session\'s signed-in user, so they can change its data. Sharing ends when the session stops.'),
      body,
      error,
      h('div', { class: 'dialog-actions' }, h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => dialog.close() }, 'Done')));

    async function run(path, payload) {
      busy = true;
      error.hidden = true;
      render();
      try {
        const answer = await W.postJson(path, payload);
        state = answer;
        fresh = answer.url ? { url: answer.url, id: answer.created } : fresh;
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
      }
      busy = false;
      render();
    }

    function membersRow() {
      const on = state.members;
      return h('div', { class: `toggle-row${on ? '' : ' is-off'}` },
        h('button', {
          type: 'button', class: 'switch-ui', role: 'switch', 'aria-checked': String(on), 'aria-labelledby': 'share-members-label', disabled: busy,
          onclick: () => run(`${base}/members`, { on: !on }),
        }),
        h('span', { class: 'toggle-label', id: 'share-members-label' }, 'Members of this console'),
        h('p', { class: 'sub' }, on
          ? `On: anyone signed in to the console can open ${state.appUrl}. Turn it off to take that back.`
          : 'Off: only you can open the app.'));
    }

    function linkRow(link) {
      return h('li', { class: 'share-link' },
        h('span', { class: 'share-link-what' }, `Link ${link.id}`, h('span', { class: 'sub' }, ` · ends ${W.when(new Date(link.expiresAt).toISOString())}`)),
        h('button', { type: 'button', class: 'btn btn-stop', disabled: busy, onclick: () => run(`${base}/links/${link.id}/revoke`, {}) }, 'Revoke'));
    }

    function freshLink() {
      if (!fresh) return null;
      const field = h('input', { type: 'text', class: 'field mono', readonly: true, value: fresh.url, 'aria-label': 'The new link' });
      const copy = h('button', {
        type: 'button', class: 'btn btn-open',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(fresh.url);
            copy.textContent = 'Copied';
          } catch {
            field.select();
          }
        },
      }, 'Copy');
      return h('div', { class: 'share-fresh' },
        h('p', { class: 'sub' }, 'Anyone who has this link can open the app until it ends or you revoke it. It is shown once.'),
        h('div', { class: 'share-fresh-row' }, field, copy));
    }

    function render() {
      body.replaceChildren();
      if (!state) {
        body.append(h('p', { class: 'sub' }, 'Loading…'));
        return;
      }
      const hours = h('select', { class: 'field', 'aria-label': 'How long the link lasts', disabled: busy },
        EXPIRIES.map(([value, label]) => h('option', { value, selected: value === 24 }, label)));
      body.append(
        membersRow(),
        h('h3', { class: 'share-heading' }, 'A link anyone can open'),
        h('p', { class: 'sub' }, 'For someone with no account here. It expires, and you can revoke it.'),
        h('div', { class: 'share-new' }, hours,
          h('button', { type: 'button', class: 'btn btn-open', disabled: busy, onclick: () => run(`${base}/links`, { hours: Number(hours.value) }) }, 'Make a link')),
        freshLink(),
        state.links.length ? h('ul', { class: 'share-links' }, state.links.map(linkRow)) : null);
    }

    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    render();
    dialog.showModal();
    W.getJson(base).then((answer) => {
      state = answer;
      render();
    }, (err) => {
      error.textContent = err.message;
      error.hidden = false;
    });
  }

  W.shareApp = shareApp;
})();
