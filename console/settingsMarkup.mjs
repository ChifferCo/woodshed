// The settings pages' components (designSystem/components/SettingsRows and the rest), as HTML a program embedding the
// console renders on its server: its own pages in the settings frame (server.mjs, settingsFrame), its groups on a repo's
// settings page (installation.mjs, `repoPage`), and its pages that stand alone (server.mjs, standalonePage). Each makes
// the same markup the console's own pages draw in the browser (public/settingsRows.js and the rest), so a program's page
// looks like the console's and follows the design system as it changes; settingsMarkup.test.mjs holds the two together.
// Rows open and close with public/hostRows.js, which every one of those pages loads.
//
// Every value is escaped unless it is itself markup (`html`'s, or one of these functions'): a name, a repo or an error
// can never become markup. Plain text goes in as a string; markup goes in as what `html` made.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** @returns {string}  `value` with every character HTML gives a meaning escaped */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Markup made here or by `html`: put in a page as it is. Anything else is text, and escaped. */
export class Markup {
  /** @param {string} text */
  constructor(text) { this.text = text; }
  toString() { return this.text; }
}

/** @returns {string}  a value as it goes in a page: markup as it is, a list one after another, nothing for none */
function piece(value) {
  if (value instanceof Markup) return value.text;
  if (Array.isArray(value)) return value.map(piece).join('');
  if (value === null || value === undefined || value === false || value === '') return '';
  return escapeHtml(value);
}

/**
 * Markup from a template: the literal parts as they are, every value escaped unless it is markup.
 * @example html`<p class="sub">${name} is ready. ${link}</p>`
 */
export function html(strings, ...values) {
  return new Markup(strings.reduce((out, s, i) => out + s + (i < values.length ? piece(values[i]) : ''), ''));
}

/** Markup the program has made safe itself, such as an icon. Never a value that came from a person or a request. */
export function trusted(text) {
  return new Markup(String(text ?? ''));
}

// Elements HTML closes itself: never given a closing tag, nor children.
const VOID = new Set(['input', 'br', 'hr', 'img', 'meta', 'link']);

/** @returns {Markup}  an element; `attrs` with null, undefined or false left out and true as an empty attribute */
function el(tag, attrs, ...children) {
  const list = Object.entries(attrs || {})
    .filter(([, v]) => v !== null && v !== undefined && v !== false)
    .map(([k, v]) => ` ${k}="${escapeHtml(v === true ? '' : v)}"`).join('');
  if (VOID.has(tag)) return new Markup(`<${tag}${list}>`);
  return new Markup(`<${tag}${list}>${piece(children.flat(Infinity))}</${tag}>`);
}

/** @returns {boolean}  whether a body holds anything to show */
const holds = (body) => [body].flat(Infinity).some((x) => x !== null && x !== undefined && x !== false && x !== '');

/**
 * One row of a group (components/SettingsRows): its name, what it is now, its status word, and its form under it.
 * With nothing in `body` it is a plain row, with nothing to open. Closed, its body is there and hidden, so it opens
 * with no round trip; a link to `#<id>` opens it too (hostRows.js).
 * @param {{id: string, title: *, value?: *, pill?: *, danger?: boolean, open?: boolean}} row
 */
export function row({ id, title, value = null, pill = null, danger = false, open = false }, ...body) {
  const text = el('span', { class: 'set-fold-text' }, el('span', { class: 'set-name' }, title), value !== null && value !== '' && el('span', { class: 'set-help' }, value));
  if (!holds(body)) return el('section', { class: 'set-fold is-plain', id }, el('div', { class: 'set-fold-head' }, text, pill));
  return el('section', { class: `set-fold${open ? ' is-open' : ''}${danger ? ' is-danger' : ''}`, id },
    el('h3', { class: 'set-fold-h' }, el('button', {
      type: 'button', class: 'set-fold-head', id: `${id}-head`, 'aria-expanded': String(open), 'aria-controls': `${id}-body`,
    }, text, pill, el('span', { class: 'set-fold-chev', 'aria-hidden': 'true' }, '▸'))),
    el('div', { class: 'set-fold-body', id: `${id}-body`, hidden: !open }, body));
}

/** A row whose control is on the row itself, such as a switch or a button: nothing to open. */
export function line(name, help, control, attrs = {}) {
  return el('section', { class: 'set-line', ...attrs }, el('div', null, el('div', { class: 'set-name' }, name), el('div', { class: 'set-help' }, help)), el('div', { class: 'set-value' }, control));
}

/** A group of rows under its label. Rows that are not drawn (null, or markup of nothing) are left out, and a group with none is too. */
export function group({ id = null, label = null, note = null, wide = false }, ...rows) {
  const drawn = rows.flat(Infinity).filter((r) => r !== null && r !== undefined && r !== false && r !== '' && !(r instanceof Markup && r.text === ''));
  if (!drawn.length) return new Markup('');
  // A group holding a table takes the page's width, as People's members do: a table is read across.
  return el('div', { class: 'set-group', id, style: wide ? 'max-width: none' : null },
    label && el('h2', { class: 'set-group-label' }, label),
    note && el('div', { class: 'set-group-note' }, note),
    el('div', { class: 'set-rows-box' }, drawn));
}

/** Commands a person needs again after the first time, under a fold (designSystem/README.md, "Commands to copy"). */
export function howTo(summary, ...body) {
  return el('details', { class: 'set-how' }, el('summary', null, summary), body);
}

/** A sentence that holds for a whole group's box, in the box. */
export function rowsNote(...body) {
  return el('div', { class: 'set-rows-note' }, body);
}

/** Lines of a row's form, each a name and help over its control (`set-rows` of `set-row`). */
export function fields(...items) {
  return el('div', { class: 'set-rows' }, items.filter(Boolean).map(({ name, help = null, control, top = false }) =>
    el('div', { class: `set-row${top ? ' is-top' : ''}` }, el('div', null, el('div', { class: 'set-name' }, name), help && el('div', { class: 'set-help' }, help)), el('div', { class: 'set-value' }, control))));
}

/** A status word (components/Tag's pill): `kind` is ok, warn, work, bad, or none for a quiet one. */
export function pill(word, kind = null) {
  return el('span', { class: kind ? `pill is-${kind}` : 'pill' }, word);
}

const BUTTON_KINDS = new Set(['primary', 'plain', 'quiet', 'danger', 'link']);

/**
 * A button (components/Button): `primary` (orange, the one action of a view), `plain` (outlined, the rest), `quiet`,
 * `danger` (outlined red, what removes), `link`. A form's submit unless `type` says otherwise.
 */
export function button(label, { kind = 'plain', type = 'submit', name = null, value = null, disabled = false, small = false, form = null } = {}) {
  const k = BUTTON_KINDS.has(kind) ? kind : 'plain';
  return el('button', { type, class: `btn btn-${k}${small ? ' btn-sm' : ''}`, name, value, disabled, form }, label);
}

/**
 * @returns {string|null}  a link the page may follow: a path on this address, an anchor, or an http(s) address; null
 *   for anything else (`javascript:`, `data:`, a path a browser reads as another site's, `//host` or `/\\host` or one
 *   with a tab or a newline in it, which browsers drop), which a value from elsewhere could carry
 */
export function safeHref(href) {
  const text = String(href ?? '').trim();
  if (/[\u0000-\u001f\u007f\\]/.test(text)) return null;
  if (text.startsWith('#')) return text;
  if (text.startsWith('/')) {
    try {
      return new URL(text, 'http://console.invalid').origin === 'http://console.invalid' ? text : null;
    } catch {
      return null;
    }
  }
  return /^https?:\/\/[^/]/i.test(text) ? text : null;
}

/** A link that looks like a button; one that leaves for another site says so (↗) and opens beside the console. */
export function linkButton(label, href, { kind = 'plain', small = false } = {}) {
  href = safeHref(href);
  const away = /^https?:/i.test(String(href));
  const k = BUTTON_KINDS.has(kind) ? kind : 'plain';
  return el('a', { class: `btn btn-${k}${small ? ' btn-sm' : ''}`, href, target: away ? '_blank' : null, rel: away ? 'noopener' : null }, label, away ? ' ↗' : '');
}

/** A dialog's buttons, at its foot on the right, the primary last (dialog.confirm's `dialog-actions`). */
export function dialogActions(...items) {
  return el('div', { class: 'dialog-actions' }, items);
}

/** A form's buttons, side by side under it. */
export function actions(...items) {
  return el('div', { class: 'set-actions' }, items);
}

/**
 * A form that posts: `fields` are its hidden values, `body` its controls. No script: the program answers the post and
 * sends the page back where it was.
 */
export function form({ action, method = 'post', hidden = {}, id = null, inline = false }, ...body) {
  return el('form', { method, action: safeHref(action), id, class: inline ? 'inline-form' : 'set-form' },
    Object.entries(hidden).map(([name, value]) => el('input', { type: 'hidden', name, value })), body);
}

/** A labelled field: the label's words over its control. */
export function labelled(label, control) {
  return el('label', { class: 'field-label' }, el('span', null, label), control);
}

/** A text box (`field is-text`), the width of its form unless `width` says. */
export function textField({ name, value = '', placeholder = null, required = false, width = null, id = null, mono = false, autocomplete = 'off', inputmode = null, maxlength = null }) {
  return el('input', {
    class: 'field is-text', type: 'text', id, name, value, placeholder, required, autocomplete, inputmode, maxlength,
    style: `${width ? `width: ${width}` : 'width: 100%; box-sizing: border-box'}${mono ? '; font-family: var(--mono)' : ''}`,
  });
}

/**
 * A field for a secret someone pastes, such as a token (components/SecretField): masked as it is typed, never offered
 * a saved password nor spell-checked, with **Show** beside it to check the paste before it is sent (hostRows.js). It
 * takes no value: a secret the program keeps is never sent back to the page, so the field is always the person's own
 * paste. `id` names the field for its label and for the button, which says what it controls.
 */
export function secretField({ name, id, placeholder = null, required = false, maxlength = null }) {
  if (!id) throw new Error('secretField needs an id, for its Show button');
  return el('div', { class: 'secret-field' },
    el('input', {
      class: 'field is-text', type: 'password', id, name, placeholder, required, maxlength,
      // `off` is ignored for a password field: `new-password` keeps a browser from filling in one it saved.
      autocomplete: 'new-password', spellcheck: 'false', autocapitalize: 'off',
    }),
    el('button', { type: 'button', class: 'btn btn-plain', 'data-reveal': '', 'aria-controls': id, 'aria-pressed': 'false' }, 'Show'));
}

/** A box of several lines, in mono for code. */
export function textArea({ name, value = '', rows = 8, id = null, mono = true }) {
  // `.field` sets the font after `.mono` does, so code says its font itself.
  return el('textarea', { class: 'field', id, name, rows: String(rows), spellcheck: 'false', style: `width: 100%; box-sizing: border-box${mono ? '; font-family: var(--mono); font-size: 12.5px' : ''}` }, value);
}

/** A select of `options` ([value, label] or a value), `selected` picked. */
export function select({ name, options, selected = null, id = null }) {
  return el('select', { class: 'field is-text', name, id }, options.map((o) => {
    const [value, label] = Array.isArray(o) ? o : [o, o];
    return el('option', { value, selected: value === selected }, label);
  }));
}

/** A checkbox with its words beside it. */
export function checkbox({ name, label, checked = false, value = 'on' }) {
  return el('label', { class: 'check-line' }, el('input', { type: 'checkbox', name, value, checked }), ' ', label);
}

/** A sentence under a form: `error` in `bad`, `ok` (what was just done) in `green`, as the console's own forms say. */
export function note(text, { error = false, ok = false } = {}) {
  if (ok) return el('p', { class: 'form-ok', role: 'status' }, text);
  return el('p', { class: `form-note${error ? ' is-error' : ''}`, role: error ? 'alert' : null }, text);
}

/** A short paragraph in `sub`. */
export function sub(...text) {
  return el('p', { class: 'sub' }, text);
}

/** Numbered steps (`cmd-steps`): each a sentence, and an optional link under it. */
export function steps(items) {
  return el('ol', { class: 'cmd-steps' }, items.map((step) => {
    const { text, href = null, label = null } = typeof step === 'object' && !(step instanceof Markup) ? step : { text: step };
    return el('li', null, el('p', null, text), href && el('div', { class: 'blocker-link' }, linkButton(label ?? 'Open', href, { small: true })));
  }));
}

/** A value shown to be copied, such as a command or a token shown once (`value-box`). */
export function valueBox(text, { copy = true } = {}) {
  return el('div', { class: 'value-row' }, el('div', { class: 'value-box' }, text), copy && el('button', { type: 'button', class: 'btn btn-plain', 'data-copy': '' }, 'Copy'));
}

/**
 * A table in a group's box, as People's members (`people-table`): `columns` are [label, {end}] or labels, `rows` lists
 * of cells. It scrolls on its own when wider than the page.
 */
export function table(columns, rows, { minWidth = 640 } = {}) {
  const cols = columns.map((c) => (Array.isArray(c) ? { label: c[0], ...(c[1] ?? {}) } : { label: c }));
  return el('div', { class: 'table-scroll' }, el('table', { class: 'people-table', style: `min-width: ${minWidth}px` },
    el('thead', null, el('tr', null, cols.map((c) => el('th', { class: c.end ? 'end-cell' : null }, c.label)))),
    el('tbody', null, rows.map((r) => el('tr', null, r.map((cell, i) => el('td', { class: cols[i]?.end ? 'end-cell' : null }, cell)))))));
}

/**
 * A group's numbers, read at a glance (components/Figures): each a label, its value in mono, and an optional line
 * under it. They go in a group's box, as rows do: `group({ label }, figures([...]))`. With none, nothing is drawn.
 * @param {{label: *, value: *, sub?: *}[]} items
 */
export function figures(items) {
  const drawn = items.filter(Boolean);
  // None to show draws nothing, so a group holding only figures is left out, as one with no rows is.
  if (!drawn.length) return new Markup('');
  return el('div', { class: 'figures' }, drawn.map(({ label, value, sub: under = null }) => el('div', { class: 'figure' },
    el('div', { class: 'figure-label' }, label),
    el('div', { class: 'figure-value' }, value),
    under !== null && under !== '' && el('div', { class: 'figure-sub' }, under))));
}

/** A line of a log, as Webhook events draws one: when, what, its details, and its status word. */
export function eventLine({ when, what, details = [], word, kind = null }) {
  return el('section', { class: 'set-fold is-plain event-line' }, el('div', { class: 'set-fold-head' },
    el('span', { class: 'event-when mono' }, when),
    el('span', { class: 'set-fold-text' }, el('span', { class: 'set-name' }, what), details.length > 0 && el('span', { class: 'event-meta mono' }, details.map((d) => el('span', null, d)))),
    pill(word, kind)));
}

/**
 * A job of steps, as a session's start shows one (components/Checklist), each `done`, `now`, `next` or `failed`:
 * session.js's startSteps, with no seconds.
 */
export function checklist(items) {
  const marks = { done: '✓', now: '', next: '', failed: '✗' };
  return el('ol', { class: 'start-steps' }, items.map(({ label, state }) => el('li', { class: `is-${state}`, 'aria-current': state === 'now' ? 'step' : null },
    el('span', { class: 'start-mark', 'aria-hidden': 'true' }, marks[state] ?? ''),
    el('span', { class: 'start-label' }, label))));
}

/** The head of a page: its title, an optional `Only you` or `Everyone` tag, a row of tabs, and a sentence under it. */
export function pageHead({ title, scope = null, tabs = null, current = null, lead = null, crumb = null }) {
  return el('header', { class: 'page-head' }, el('div', null,
    crumb && el('p', { class: 'crumb' }, el('a', { href: safeHref(crumb.href) }, '‹ ', crumb.label)),
    el('h1', { class: 'title' }, title, scope && [' ', el('span', { class: 'pill' }, scope)]),
    tabs?.length > 0 && el('nav', { class: 'rail-seg settings-tabs', 'aria-label': typeof title === 'string' ? title : null },
      tabs.map((t) => el('a', { class: 'rail-seg-link', href: safeHref(t.href), 'aria-current': t.href === current ? 'page' : null }, t.label))),
    lead && el('p', { class: 'sub' }, lead)));
}

/**
 * A dialog over the page (the console's dialog's look), drawn by the server, for a page that is one step of
 * several: the page behind it is inert.
 */
export function dialog({ title, id = 'dialog-title' }, ...body) {
  return el('div', { class: 'host-dialog' }, el('div', { class: 'host-dialog-box', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': id },
    el('h2', { id }, title), body));
}
