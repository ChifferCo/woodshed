// Share the app: who besides its owner may open a My Woodshed session's app (appShares.mjs). Only the app; the
// terminal, Review, the databases and Start/Stop stay the owner's. Opened from Share beside the app's button in the pane
// bar, the phone's ⋯ and the palette.
(function () {
  'use strict';
  const W = window.Woodshed;
  const { h } = W;
  const EXPIRIES = [[1, '1 hour'], [24, '1 day'], [168, '7 days']];
  // What each session's share was last read as, for the bar's Shared: the dialog keeps it current, and the bar reads
  // it again after a minute, since a link runs out and the command line can share too.
  const READ_AGAIN_MS = 60_000;
  const known = new Map();
  // Each answer kept here or read for the bar takes the next number: a read answered after a newer answer is dropped.
  let answers = 0;

  // Only who may open the app and when each link ends: never a new link's URL, which stays in its dialog.
  function remember(id, view, n = ++answers) {
    const was = known.get(id);
    if (was?.n > n) return false;
    const kept = { members: Boolean(view.members), links: (view.links ?? []).map((l) => ({ id: l.id, expiresAt: l.expiresAt })) };
    known.set(id, { view: kept, at: Date.now(), n });
    return JSON.stringify(was?.view ?? null) !== JSON.stringify(kept);
  }

  /**
   * Who else opens the app now, as far as the page knows; reads it when it does not know or knew a minute ago.
   * @param {{id: string}} s  a running My Woodshed session of this person's
   * @param {() => void} onChange  called when a read changed the answer
   * @returns {{members: boolean, links: number}|null}  null until read
   */
  function appShared(s, onChange) {
    const entry = known.get(s.id);
    if (!entry || (!entry.reading && Date.now() - entry.at > READ_AGAIN_MS)) {
      const n = ++answers;
      known.set(s.id, { ...entry, at: entry?.at ?? 0, reading: true });
      W.getJson(`/api/sessions/${s.id}/app-share`).then((view) => {
        if (remember(s.id, view, n)) onChange?.();
      }, () => {
        // Not read: what was known stays, read again in a minute, unless a newer answer came meanwhile.
        const now = known.get(s.id);
        if (!(now?.n > n)) known.set(s.id, { view: now?.view ?? null, at: Date.now(), n });
      });
    }
    const view = entry?.view;
    if (!view) return null;
    return { members: Boolean(view.members), links: (view.links ?? []).filter((l) => l.expiresAt > Date.now()).length };
  }

  /** @returns {string|null}  who besides the owner opens the app, in words, or null when nobody does */
  function sharedWords(shared) {
    if (!shared || (!shared.members && !shared.links)) return null;
    const links = shared.links ? `${shared.links} link${shared.links === 1 ? '' : 's'}` : null;
    return [shared.members && 'the console\'s members', links].filter(Boolean).join(' and ');
  }

  /**
   * @param {{id: string}} s  a running My Woodshed session of this person's
   * @param {{onChange?: () => void}} [opts]  `onChange` redraws what shows the share, as the dialog changes it
   */
  function shareApp(s, { onChange = null } = {}) {
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
        if (remember(s.id, answer)) onChange?.();
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
      // append, unlike h(), writes a null as the text 'null': what is not there is left out first.
      body.append(...[
        membersRow(),
        h('h3', { class: 'share-heading' }, 'A link anyone can open'),
        h('p', { class: 'sub' }, 'For someone with no account here. It expires, and you can revoke it.'),
        h('div', { class: 'share-new' }, hours,
          h('button', { type: 'button', class: 'btn btn-open', disabled: busy, onclick: () => run(`${base}/links`, { hours: Number(hours.value) }) }, 'Make a link')),
        freshLink(),
        state.links.length > 0 && h('ul', { class: 'share-links' }, state.links.map(linkRow)),
      ].filter(Boolean));
    }

    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    render();
    dialog.showModal();
    const first = ++answers;
    W.getJson(base).then((answer) => {
      state = answer;
      if (remember(s.id, answer, first)) onChange?.();
      render();
    }, (err) => {
      error.textContent = err.message;
      error.hidden = false;
    });
  }

  W.shareApp = shareApp;
  W.appShared = appShared;
  W.appSharedWords = sharedWords;
})();
