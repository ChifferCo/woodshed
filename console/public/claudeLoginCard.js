// My settings' Remote Control card: whether a full Claude login is kept for your private sessions, when it was saved
// and last refreshed, which session uses it now, and Forget. The login itself is never on the page: a session saves it
// after /woodshed:remote-control signs it in, and the next one takes it from there (console/claudeLogin.mjs).
(function () {
  'use strict';
  const W = window.Woodshed;
  const { h } = W;

  /**
   * @param {{me: () => object, setMe: (me: object) => void, render: () => void}} page  the page's answer from /api/my,
   *   and how it redraws
   * @returns {{card: () => object|null}}
   */
  function createClaudeLoginCard({ me, setMe, render }) {
    const note = h('p', { class: 'form-note', role: 'status' });
    let busy = false;

    async function forget() {
      if (!window.confirm('Forget your saved Claude login? Your next /woodshed:remote-control signs in with the browser again. A session using it now keeps it until it stops.')) return;
      busy = true;
      note.textContent = 'Forgetting…';
      note.classList.remove('is-error');
      render();
      try {
        setMe(await W.postJson('/api/my/claude-login/forget', {}));
        note.textContent = 'Forgotten.';
      } catch (err) {
        note.textContent = err.message;
        note.classList.add('is-error');
      }
      busy = false;
      render();
    }

    function pill(login) {
      if (!login.saved) return h('span', { class: 'pill' }, 'Not saved');
      return login.heldBy ? h('span', { class: 'pill is-work' }, 'In use') : h('span', { class: 'pill is-ok' }, 'Saved');
    }

    function card() {
      const login = me()?.claudeLogin;
      if (!login) return null;
      return h('section', { class: 'set-card', id: 'claude-login' },
        h('div', { class: 'set-head' }, h('h2', null, 'Remote Control login'), pill(login)),
        h('p', { class: 'sub' }, 'Remote Control needs a full Claude login, which your token is not. Sign in once with ',
          h('code', null, '/woodshed:remote-control'), ' in a private session, and your next sessions use the same login without the browser: one session at a time, since each refresh replaces it. Claude asks for a new sign-in 30 days after the first.'),
        login.saved && h('p', { class: 'sub' }, `Saved ${W.when(login.savedAt)}`, login.refreshedAt && login.refreshedAt !== login.savedAt ? ` · refreshed ${W.when(login.refreshedAt)}` : '', '.'),
        login.saved && h('p', { class: 'sub' }, login.heldBy
          ? ['In use by session ', h('a', { href: `/s/${login.heldBy}` }, login.heldBy), '. Another session signs in with the browser until it stops.']
          : 'No session is using it: the next one to turn on Remote Control takes it.'),
        login.saved && h('div', { class: 'set-actions' }, h('button', { type: 'button', class: 'btn btn-quiet', disabled: busy, onclick: forget }, 'Forget')),
        note);
    }

    return { card };
  }

  window.WoodshedClaudeLoginCard = { create: createClaudeLoginCard };
})();
