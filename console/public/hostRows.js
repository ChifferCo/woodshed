// What a program's own markup needs to work as the console's does (settingsMarkup.mjs): its rows open and close in
// place, a link to a row (#<id>) opens it, Copy copies the value beside it, Show shows a secret field's paste, and a
// repo pick's line says what is picked.
// The console's own pages draw these themselves (settingsRows.js); a program renders them on its server, into the
// settings frame (hostSettings.js), a repo's settings page (repoSettings.js) or a page of its own (server.mjs,
// standalonePage), and each of those runs this over them. No dependency: a page of its own loads this alone.
(() => {
  'use strict';

  /** Opens or closes one row: its head says which, and its body shows or hides. */
  function setOpen(fold, open) {
    const head = fold.querySelector(':scope > .set-fold-h > .set-fold-head');
    const body = fold.querySelector(':scope > .set-fold-body');
    if (!head || !body) return;
    fold.classList.toggle('is-open', open);
    head.setAttribute('aria-expanded', String(open));
    body.hidden = !open;
  }

  /** @returns {string}  the row the address names, or none for an address that does not decode */
  function named() {
    try {
      return decodeURIComponent(location.hash.slice(1));
    } catch {
      return '';
    }
  }

  /** Opens the row `id` names, when it is one of `root`'s, and brings it into the window. */
  function reveal(root, id) {
    if (!id) return;
    const target = root.querySelector(`#${CSS.escape(id)}`);
    const fold = target?.closest('.set-fold');
    if (fold && root.contains(fold)) setOpen(fold, true);
    target?.scrollIntoView({ block: 'start' });
  }

  /** Shows or masks a secret field's paste, its button saying which press undoes it. */
  function showSecret(field, button, shown) {
    field.type = shown ? 'text' : 'password';
    button.textContent = shown ? 'Hide' : 'Show';
    button.setAttribute('aria-pressed', String(shown));
  }

  // A pick's line says what is picked, in the order of its list, or what its summary says with none.
  function pickText(pick) {
    const text = pick.querySelector('.repo-pick-text');
    if (!text) return;
    const none = text.dataset.none ?? text.textContent;
    text.dataset.none = none;
    const picked = [...pick.querySelectorAll('input[type="checkbox"]:checked')].map((b) => b.closest('label')?.textContent.trim()).filter(Boolean);
    text.textContent = picked.length ? picked.join(', ') : none;
  }

  /**
   * Makes `root`'s rows, copy and show buttons and repo picks work, once. The page's own address may name a row to open.
   * @param {Element} root
   * @param {{hash?: boolean}} [options]  `hash: false` where the page is the console's and opens its own rows
   */
  function wire(root, { hash = true } = {}) {
    if (!root || root.dataset.hostRows === 'on') return;
    root.dataset.hostRows = 'on';
    root.addEventListener('click', async (e) => {
      const head = e.target.closest('.set-fold-head[aria-expanded]');
      if (head && root.contains(head)) {
        const fold = head.closest('.set-fold');
        setOpen(fold, !fold.classList.contains('is-open'));
        return;
      }
      const show = e.target.closest('.secret-field > [data-reveal]');
      if (show && root.contains(show)) {
        const field = show.parentElement.querySelector('input');
        if (!field) return;
        showSecret(field, show, field.type === 'password');
        return;
      }
      const copy = e.target.closest('[data-copy]');
      if (copy && root.contains(copy)) {
        const box = copy.parentElement?.querySelector('.value-box');
        if (!box) return;
        try {
          await navigator.clipboard.writeText(box?.textContent ?? '');
          copy.textContent = 'Copied';
        } catch {
          // A browser that will not write the clipboard: the value is selected, for the keys.
          const range = document.createRange();
          range.selectNodeContents(box);
          window.getSelection()?.removeAllRanges();
          window.getSelection()?.addRange(range);
        }
      }
    });
    // A secret left shown is masked again as its form is sent: a browser may keep a text field's value in its form
    // history, and offer the secret again later, but never a password field's.
    root.addEventListener('submit', (e) => {
      e.target.querySelectorAll?.('.secret-field').forEach((secret) => {
        const field = secret.querySelector('input');
        const button = secret.querySelector('[data-reveal]');
        if (field && button && field.type === 'text') showSecret(field, button, false);
      });
    });
    root.addEventListener('change', (e) => {
      const pick = e.target.closest('.repo-pick');
      if (pick && root.contains(pick)) pickText(pick);
    });
    root.querySelectorAll('.repo-pick').forEach(pickText);
    if (hash) {
      reveal(root, named());
      followed.add(root);
    }
  }

  // A link followed while a page is shown opens its row: one listener for the document, over the pages wired since,
  // as the settings frame shows a program's page anew on each visit. A page no longer shown is let go.
  const followed = new Set();
  window.addEventListener('hashchange', () => {
    for (const root of followed) {
      if (root.isConnected) reveal(root, named());
      else followed.delete(root);
    }
  });

  window.WoodshedHostRows = { wire, reveal, setOpen };
  // A page that stands alone (server.mjs, standalonePage) names its root on this script's tag: no inline script, which a
  // program's content security policy may refuse.
  const own = document.currentScript?.dataset.wire;
  if (own) wire(document.getElementById(own));
})();
