// The sign-in page's words, read from public/login.js the way the page runs it, against a made-up /api/me.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import { CONSOLE_FAILED } from './auth.mjs';

const source = fs.readFileSync(new URL('./public/login.js', import.meta.url), 'utf8');

function h(tag, attrs, ...children) {
  return { tag, attrs: attrs ?? {}, children: children.flat().filter((c) => c !== null && c !== undefined && c !== false) };
}

function textOf(node) {
  if (typeof node === 'string') return node;
  return node.children.map(textOf).join('');
}

async function render({ me, search = '', forgetSignedIn = () => {} }) {
  const shown = [];
  const window = {
    location: { search, origin: 'https://console.example', replace() {}, reload() {} },
    Woodshed: { h, getJson: async () => me, postJson: async () => ({}), ago: () => 'just now', forgetSignedIn },
  };
  const document = { getElementById: () => ({ replaceChildren: (...nodes) => shown.push(nodes) }) };
  vm.runInNewContext(source, { window, document, URL, URLSearchParams, setTimeout() {} });
  await new Promise((resolve) => setImmediate(resolve));
  const page = shown.at(-1)[0];
  const errors = [];
  (function find(node) {
    if (typeof node === 'string') return;
    if (/form-error/.test(node.attrs.class ?? '')) errors.push(textOf(node));
    node.children.forEach(find);
  })(page);
  return { text: textOf(page), errors, page };
}

function findAll(node, match, out = []) {
  if (typeof node === 'string') return out;
  if (match(node)) out.push(node);
  node.children.forEach((c) => findAll(c, match, out));
  return out;
}

const signInOn = { available: true, signIn: true, login: null, visitor: null, repo: null };

test('the page names no provider, and names the repo only when /api/me does', async () => {
  const hidden = await render({ me: signInOn });
  assert.doesNotMatch(hidden.text, /AWS/);
  assert.match(hidden.text, /Claude sessions for the team\. Anyone on its list, with write access to the repository it works on, can sign in\./);
  const named = await render({ me: { ...signInOn, signIn: false, repo: 'acme/erp' } });
  assert.match(named.text, /with write access to acme\/erp, can sign in\./);
});

test('the error the console sent back is shown as it is, and nothing when there is none', async () => {
  assert.deepEqual((await render({ me: signInOn })).errors, []);
  const failed = await render({ me: signInOn, search: `?error=${encodeURIComponent(CONSOLE_FAILED)}&next=%2Fs%2Faaaa1111` });
  assert.deepEqual(failed.errors, ['The console could not check your access with GitHub. Ask whoever runs it to look at its log.']);
});

test('a console that requires sign-in with no client secret says so without naming a provider', async () => {
  const { text } = await render({ me: { ...signInOn, available: false } });
  assert.match(text, /Nobody can sign in/);
  assert.match(text, /secret store as github-app-client-secret/);
  assert.doesNotMatch(text, /AWS/);
});

test("a visitor's Sign out drops what the pages kept in the browser tab, as the menu's does", async () => {
  let forgot = 0;
  const { page } = await render({ me: { ...signInOn, visitor: 'octocat' }, forgetSignedIn: () => { forgot++; } });
  const forms = findAll(page, (n) => n.tag === 'form' && n.attrs.action === '/auth/sign-out');
  assert.equal(forms.length, 1, 'the visitor card has its Sign out');
  forgot = 0;
  forms[0].attrs.onsubmit();
  assert.equal(forgot, 1, "the rail's snapshot and each session's last tab go (common.js, forgetSignedIn)");
});

test('the sign-in page drops what pages kept in the browser tab, for a sign-in lost elsewhere', async () => {
  let forgot = 0;
  await render({ me: signInOn, forgetSignedIn: () => { forgot++; } });
  assert.equal(forgot, 1, "signed out in another browser tab: this one's kept sessions go");
  forgot = 0;
  await render({ me: { ...signInOn, visitor: 'octocat' }, forgetSignedIn: () => { forgot++; } });
  assert.equal(forgot, 1, 'a visitor, no longer a member, keeps nothing either');
});
