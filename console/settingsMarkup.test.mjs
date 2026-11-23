import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { actions, button, checkbox, checklist, dialog, dialogActions, form, textField, escapeHtml, group, howTo, html, line, linkButton, Markup, note, pageHead, pill, row, steps, table, trusted, valueBox } from './settingsMarkup.mjs';
import { standalonePage } from './server.mjs';

// The console's own rows (public/settingsRows.js), drawn with an h() that keeps a tree, then written out as HTML the way
// the server's are: the two must be the same markup, or a program's page stops looking like the console's.
function consoleRows() {
  const tree = (tag, attrs, ...children) => ({ tag, attrs: attrs || {}, children: children.flat(Infinity) });
  const window = { Woodshed: { h: tree }, location: { hash: '' } };
  vm.runInNewContext(fs.readFileSync(new URL('./public/settingsRows.js', import.meta.url), 'utf8'), { window, document: {} });
  return window.WoodshedSettingsRows.create({ render() {} });
}

function write(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node !== 'object') return escapeHtml(node);
  if (node instanceof Markup) return node.text;
  const attrs = Object.entries(node.attrs)
    .filter(([k, v]) => v !== null && v !== undefined && v !== false && !k.startsWith('on'))
    .map(([k, v]) => ` ${k}="${escapeHtml(v === true ? '' : v)}"`).join('');
  return `<${node.tag}${attrs}>${node.children.map(write).join('')}</${node.tag}>`;
}

test('a row, a plain row, a line, a group and a fold are the markup the console\'s own pages draw', () => {
  const rows = consoleRows();
  const pillNode = { tag: 'span', attrs: { class: 'pill is-ok' }, children: ['Ready'] };
  const body = { tag: 'p', attrs: { class: 'sub' }, children: ['Its form.'] };
  rows.open.add('repo-api');
  assert.equal(
    row({ id: 'repo-api', title: 'acme/api', value: 'Default project · 3 sessions', pill: pill('Ready', 'ok'), open: true }, html`<p class="sub">Its form.</p>`).text,
    write(rows.row({ id: 'repo-api', title: 'acme/api', value: 'Default project · 3 sessions', pill: pillNode }, body)),
    'an open row');
  assert.equal(
    row({ id: 'r', title: 'Leave Acme', value: 'You lose its sessions', danger: true, open: true }, 'x').text,
    (rows.open.add('r'), write(rows.row({ id: 'r', title: 'Leave Acme', value: 'You lose its sessions', danger: true }, 'x'))),
    'a row that removes');
  assert.equal(row({ id: 'm', title: 'Machine', value: 'A VM · 4 CPUs' }).text, write(rows.row({ id: 'm', title: 'Machine', value: 'A VM · 4 CPUs' })), 'a plain row');
  assert.equal(line('Sessions', 'Start one.', button('Go', { type: 'button' })).text,
    write(rows.line('Sessions', 'Start one.', { tag: 'button', attrs: { type: 'button', class: 'btn btn-plain' }, children: ['Go'] })), 'a line');
  assert.equal(group({ id: 'g', label: 'Credits', note: 'What pays.' }, row({ id: 'm', title: 'Machine' })).text,
    write(rows.group({ id: 'g', label: 'Credits', note: 'What pays.' }, rows.row({ id: 'm', title: 'Machine' }))), 'a group');
  assert.equal(group({ label: 'None' }, null).text, '', 'a group with no row is left out, as the console\'s is');
  assert.equal(howTo('Send a dump', 'curl …').text, write(rows.howTo('Send a dump', 'curl …')), 'a fold');
});

test('a closed row is there and hidden, so it opens in place with no round trip', () => {
  const closed = row({ id: 'lib', title: 'acme/lib', pill: pill('Failed', 'bad') }, 'why').text;
  assert.match(closed, /aria-expanded="false" aria-controls="lib-body"/);
  assert.match(closed, /<div class="set-fold-body" id="lib-body" hidden="">why<\/div>/);
  assert.doesNotMatch(closed, /is-open/);
});

test('every value is text unless it is markup: a name, a repo or an error never becomes markup', () => {
  const evil = '<img src=x onerror="alert(1)">';
  for (const made of [row({ id: 'x', title: evil, value: evil, pill: pill(evil) }), line(evil, evil, evil), group({ label: evil, note: evil }, evil),
    pill(evil), button(evil), note(evil, { error: true }), steps([evil, { text: evil, href: '/a', label: evil }]), valueBox(evil), table([evil], [[evil]]),
    checklist([{ label: evil, state: 'now' }]), pageHead({ title: evil, lead: evil, tabs: [{ label: evil, href: '/t' }] }), html`<p>${evil}</p>`]) {
    assert.ok(made instanceof Markup);
    assert.doesNotMatch(made.text, /<img/, made.text);
  }
  assert.equal(html`<b>${trusted('<i>ok</i>')}</b>`.text, '<b><i>ok</i></b>', 'what the program made safe itself goes in as it is');
  assert.equal(row({ id: 'q', title: 'a"b' }).text.includes('id="q"'), true);
  assert.match(row({ id: 'a" onclick="x', title: 't' }, 'b').text, /id="a&quot; onclick=&quot;x"/, 'an attribute cannot be closed early');
});

test('buttons say their kind, a link away says so, and steps carry their links', () => {
  assert.equal(button('Delete Acme', { kind: 'danger' }).text, '<button type="submit" class="btn btn-danger">Delete Acme</button>');
  assert.equal(button('Go', { kind: 'nonsense', type: 'button' }).text, '<button type="button" class="btn btn-plain">Go</button>', 'an unknown kind is plain');
  assert.equal(linkButton('Install the reviewer', 'https://github.com/apps/x', { kind: 'plain' }).text,
    '<a class="btn btn-plain" href="https://github.com/apps/x" target="_blank" rel="noopener">Install the reviewer ↗</a>');
  assert.equal(linkButton('Repos', '/console-settings#card-projects').text, '<a class="btn btn-plain" href="/console-settings#card-projects">Repos</a>');
  assert.match(steps([{ text: 'Add the token.', href: '/secrets', label: 'Go there' }]).text, /<li><p>Add the token\.<\/p><div class="blocker-link"><a class="btn btn-plain btn-sm" href="\/secrets">Go there<\/a><\/div><\/li>/);
  assert.equal(actions(button('Save', { kind: 'primary' })).text, '<div class="set-actions"><button type="submit" class="btn btn-primary">Save</button></div>');
  assert.match(group({ label: 'Ledger', wide: true }, table(['When', ['Amount', { end: true }]], [['2026-11-22', '−$2.40']])).text,
    /style="max-width: none".*<th class="end-cell">Amount<\/th>.*<td class="end-cell">−\$2\.40<\/td>/, 'a table\'s group takes the width, its sums at the end');
});

test('a checklist is the session start\'s: its marks, the step now named for a screen reader', () => {
  const made = checklist([{ label: 'Org', state: 'done' }, { label: 'GitHub', state: 'now' }, { label: 'Repositories', state: 'next' }]).text;
  assert.match(made, /<li class="is-done"><span class="start-mark" aria-hidden="true">✓<\/span><span class="start-label">Org<\/span><\/li>/);
  assert.match(made, /<li class="is-now" aria-current="step">/);
});

test('a page that stands alone: the settings frame drawn by the server, with the program\'s links, sign-out and dialog', () => {
  const page = standalonePage({
    title: 'Get started', body: pageHead({ title: 'Get started' }).text, brand: { label: 'Woodshed Cloud', href: '/account', icon: '/assets/logo.svg' },
    groups: [{ label: 'You', items: [{ label: 'Your workspaces', href: '/account' }, { label: 'Away', href: 'https://x.test' }, { label: 'Protocol', href: '//x.test' }] }],
    current: '/account', login: 'joel', signOut: '/account/sign-out', dialog: '<div class="host-dialog">step</div>', refresh: 4,
    styles: ['/assets/own.css', 'https://x.test/a.css'], scripts: ['/assets/own.js'],
  });
  assert.match(page, /<a class="side-back" href="\/account"><img src="\/assets\/logo.svg" width="20" height="20" alt="" class="side-brand-icon"><b>Woodshed Cloud<\/b><\/a>/, 'its mark and name head the side list');
  assert.match(page, /<a class="side-item" href="\/account" aria-current="page">Your workspaces<\/a>/);
  assert.doesNotMatch(page, /x\.test/, 'only paths on its own address');
  assert.match(page, /<span class="side-item side-who">@joel<\/span><form class="inline-form" method="post" action="\/account\/sign-out"><button type="submit" class="side-item">Sign out<\/button><\/form>/);
  assert.match(page, /<div class="page" inert aria-hidden="true">/, 'the page behind a dialog is inert');
  assert.match(page, /<meta http-equiv="refresh" content="4">/);
  assert.match(page, /\/static\/style\.css\?v=[0-9a-f]{12}/, 'the design system\'s stylesheet');
  assert.match(page, /<script src="\/static\/hostRows\.js\?v=[0-9a-f]{12}" data-wire="app"><\/script>/, 'its rows open, with no inline script');
  assert.match(page, /<link rel="stylesheet" href="\/assets\/own\.css">/);
  assert.match(page, /<script src="\/assets\/own\.js"><\/script>/);
  assert.doesNotMatch(page, /common\.js|\/api\/me/, 'nothing on it asks a console anything');
  const bare = standalonePage({ title: 'x', body: '', brand: { label: 'W', href: 'javascript:alert(1)', icon: 'https://x.test/i.svg' }, login: 'not a login!', signOut: '/out' });
  assert.match(bare, /<a class="side-back" href="\/"><b>W<\/b>/, 'a home that is not a path goes to /, and an icon from elsewhere is left out');
  assert.doesNotMatch(bare, /Sign out|inert|refresh/);
});

test('a dialog is drawn over the page with its title named for a screen reader, its buttons at its foot', () => {
  const made = dialog({ title: 'Connect GitHub' }, dialogActions(button('Finish later', { kind: 'quiet', type: 'button' }), button('Install on GitHub', { kind: 'primary' }))).text;
  assert.match(made, /^<div class="host-dialog"><div class="host-dialog-box" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><h2 id="dialog-title">Connect GitHub<\/h2>/);
  assert.match(made, /<div class="dialog-actions"><button type="button" class="btn btn-quiet">Finish later<\/button><button type="submit" class="btn btn-primary">Install on GitHub<\/button><\/div>/);
});

test('a field is a void element, never closed, and a form carries its hidden values', () => {
  assert.equal(checkbox({ name: 'credits', label: 'Use my $20', checked: true }).text,
    '<label class="check-line"><input type="checkbox" name="credits" value="on" checked=""> Use my $20</label>');
  assert.equal(textField({ name: 'name', value: 'Acme', required: true }).text,
    '<input class="field is-text" type="text" name="name" value="Acme" required="" autocomplete="off" style="width: 100%; box-sizing: border-box">');
  assert.equal(form({ action: '/orgs/acme/leave', hidden: { login: 'ada' } }, button('Leave')).text,
    '<form method="post" action="/orgs/acme/leave" class="set-form"><input type="hidden" name="login" value="ada"><button type="submit" class="btn btn-plain">Leave</button></form>');
});

test('a link is a path, an anchor or an http(s) address: any other scheme, which a value from elsewhere could carry, is no link', () => {
  for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,x', '//evil.example/x', '/\\evil.example/x', 'vbscript:x', '/\t/evil.example/x', '/\n/evil.example/x', 'java\tscript:alert(1)']) {
    assert.equal(linkButton('Go', bad).text, '<a class="btn btn-plain">Go</a>', bad);
    assert.doesNotMatch(pageHead({ title: 't', tabs: [{ label: 'x', href: bad }], crumb: { label: 'c', href: bad } }).text, /href=/, bad);
  }
  assert.match(linkButton('Go', '/orgs/acme').text, /href="\/orgs\/acme"/);
  assert.equal(form({ action: 'javascript:alert(1)' }, button('Go')).text, '<form method="post" class="set-form"><button type="submit" class="btn btn-plain">Go</button></form>', 'a form posts nowhere but its own address or http(s)');
  assert.match(linkButton('Go', '#credits').text, /href="#credits"/);
  assert.match(linkButton('Go', 'HTTPS://github.com/x').text, /href="HTTPS:\/\/github\.com\/x" target="_blank"/);
});
