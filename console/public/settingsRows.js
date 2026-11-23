// Groups of rows that open in place (designSystem/components/SettingsRows), for every settings page: a row says a
// setting's name, what it is now and its status word, and opens on its form. Each page makes its own with its render,
// since a page is drawn again on each answer and which rows are open is kept for the page's life.
(() => {
  'use strict';

  /**
   * @param {{render: () => void}} page `render` draws the page again, after a row opened or closed.
   */
  function create({ render }) {
    const { h } = window.Woodshed;
    // Several rows may be open at once. A link or the search that names a row opens it.
    const open = new Set();
    const named = () => (window.location?.hash ?? '').slice(1);
    if (named()) open.add(named());

    function toggle(id) {
      if (open.has(id)) open.delete(id);
      else open.add(id);
      render();
    }

    /**
     * One row. With nothing in `body` it is a plain line: there is nothing to open.
     * `opens` is for a row whose body is drawn only while it is open (a repo's, which is read then).
     * @param {{id: string, title: *, value?: *, pill?: *, danger?: boolean, opens?: boolean, onOpen?: () => void}} row
     */
    function row({ id, title, value, pill, danger = false, opens = false, onOpen }, ...body) {
      const parts = body.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false);
      const text = h('span', { class: 'set-fold-text' }, h('span', { class: 'set-name' }, title), value && h('span', { class: 'set-help' }, value));
      if (!parts.length && !opens) return h('section', { class: 'set-fold is-plain', id }, h('div', { class: 'set-fold-head' }, text, pill));
      const isOpen = open.has(id);
      return h('section', { class: `set-fold${isOpen ? ' is-open' : ''}${danger ? ' is-danger' : ''}`, id },
        // Its id is what gives the button its focus back after the redraw that opens or closes it (draw).
        h('h3', { class: 'set-fold-h' }, h('button', {
          type: 'button', class: 'set-fold-head', id: `${id}-head`, 'aria-expanded': String(isOpen), 'aria-controls': `${id}-body`,
          // Told before the draw that opens it, so what it sets (a repo to read again) is drawn.
          onclick: () => { if (!open.has(id)) onOpen?.(); toggle(id); },
        }, text, pill, h('span', { class: 'set-fold-chev', 'aria-hidden': 'true' }, '▸'))),
        isOpen && h('div', { class: 'set-fold-body', id: `${id}-body` }, parts));
    }

    /** A row whose control is on the row itself: nothing to open. */
    function line(name, help, control, attrs = {}) {
      return h('section', { class: 'set-line', ...attrs }, h('div', null, h('div', { class: 'set-name' }, name), h('div', { class: 'set-help' }, help)), h('div', { class: 'set-value' }, control));
    }

    /** A group of rows under its label. Rows that are not drawn (null) are left out, and a group with none is too. */
    function group({ id, label, note }, ...rows) {
      const drawn = rows.flat(Infinity).filter(Boolean);
      if (!drawn.length) return null;
      return h('div', { class: 'set-group', id },
        label && h('h2', { class: 'set-group-label' }, label),
        note && h('div', { class: 'set-group-note' }, note),
        h('div', { class: 'set-rows-box' }, drawn));
    }

    // Commands a person needs again after the first time stay under a fold (designSystem/README.md, "Commands to copy").
    function howTo(summary, ...body) {
      return h('details', { class: 'set-how' }, h('summary', null, summary), body);
    }

    /**
     * Puts the page's new nodes in `app` and gives the focus back: a box being typed in is the same node after the
     * draw, and a row's head is a new one, found by its id.
     */
    function draw(app, ...nodes) {
      const focused = document.activeElement;
      app.replaceChildren(...nodes);
      const again = focused?.id ? (focused.isConnected ? focused : document.getElementById(focused.id)) : null;
      if (again && again !== document.activeElement) again.focus({ preventScroll: true });
    }

    /** Opens the row a link or the search names, when it is closed. Says whether it drew the page again. */
    function reveal(id) {
      if (!id || open.has(id)) return false;
      open.add(id);
      render();
      return true;
    }

    /**
     * For the page's life: the search opens the row it found before outlining it (settingsSearch.js), and a link to a
     * row followed while the page is shown opens it and brings it back into the window.
     */
    function follow(life) {
      life.on(window, 'woodshed:settings-reveal', (e) => reveal(e.detail?.id));
      life.on(window, 'hashchange', () => {
        reveal(named());
        document.getElementById(named())?.scrollIntoView({ block: 'start' });
      });
    }

    return { open, toggle, row, line, group, howTo, draw, reveal, follow };
  }

  window.WoodshedSettingsRows = { create };
})();
