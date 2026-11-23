// What a program's own markup needs to work as the console's does (settingsMarkup.mjs): its rows open and close in
// place, a link to a row (#<id>) opens it, Copy copies the value beside it, and a repo pick's line says what is picked.
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
   * Makes `root`'s rows, copy buttons and repo picks work, once. The page's own address may name a row to open.
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
    root.addEventListener('change', (e) => {
      const pick = e.target.closest('.repo-pick');
      if (pick && root.contains(pick)) pickText(pick);
    });
    root.querySelectorAll('.repo-pick').forEach(pickText);
    if (hash) {
      reveal(root, named());
      window.addEventListener('hashchange', () => reveal(root, named()));
    }
  }

  window.WoodshedHostRows = { wire, reveal, setOpen };
  // A page that stands alone (server.mjs, standalonePage) names its root on this script's tag: no inline script, which a
  // program's content security policy may refuse.
  const own = document.currentScript?.dataset.wire;
  if (own) wire(document.getElementById(own));
})();
