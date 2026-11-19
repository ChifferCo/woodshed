// The page goes to sign in when the console answers a call with its "sign in first" 401, read from public/common.js
// the way a page loads it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('./public/common.js', import.meta.url), 'utf8');

function loadCommon({ pathname = '/s/aaaa1111', answer, state = null, stored = {} }) {
  const assigned = [];
  const items = { ...stored };
  const sessionStorage = { getItem: (k) => items[k] ?? null, setItem: (k, v) => { items[k] = String(v); }, removeItem: (k) => { delete items[k]; } };
  const location = { pathname, search: '?tab=terminal', href: `https://console.example${pathname}?tab=terminal`, origin: 'https://console.example', assign: (to) => assigned.push(to) };
  const window = {
    WoodshedLogins: require('./public/logins.cjs'), WoodshedSetup: require('./public/setupSteps.cjs'),
    fetch: async () => answer(), addEventListener() {}, history: { state }, sessionStorage,
  };
  const context = vm.createContext({
    window, location, URL, URLSearchParams, console: { log() {} },
    document: { addEventListener() {}, createElement: () => ({}) },
    matchMedia: () => ({}),
    fetch: () => new Promise(() => {}),
  });
  vm.runInContext(source, context);
  // What was kept when the page went to sign in, read as it navigates.
  const keptAtAssign = [];
  location.assign = (to) => { assigned.push(to); keptAtAssign.push(Object.keys(items).sort()); };
  return { fetch: window.fetch, assigned, keptAtAssign, items };
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('a "sign in first" 401 from the console sends the page to sign in, and back here after', async () => {
  const { fetch, assigned } = loadCommon({ answer: () => json(401, { error: 'sign in first' }) });
  const res = await fetch('/api/sessions');
  await fetch('/api/my');
  assert.equal(res.status, 401);
  assert.deepEqual(assigned, ['/login?next=%2Fs%2Faaaa1111%3Ftab%3Dterminal']);
});

test('other answers, other origins and the login page itself stay where they are', async () => {
  for (const [pathname, url, answer] of [
    ['/s/aaaa1111', '/api/sessions', () => json(200, {})],
    ['/s/aaaa1111', '/api/sessions', () => json(401, { error: 'unauthorized' })],
    ['/s/aaaa1111', 'https://aaaa1111.apps.example/api/x', () => json(401, { error: 'sign in first' })],
    ['/s/aaaa1111', '/static/x.js', () => json(401, { error: 'sign in first' })],
    ['/login', '/api/access/ask', () => json(401, { error: 'sign in first' })],
  ]) {
    const { fetch, assigned } = loadCommon({ pathname, answer });
    await fetch(url);
    assert.deepEqual(assigned, [], `${pathname} ${url}`);
  }
});

test("the way back keeps a session page's ?tab only when the entry arrived with it", async () => {
  const signIn = () => json(401, { error: 'sign in first' });
  // Followed a link to ?tab=terminal: someone signing in comes back to it.
  let page = loadCommon({ answer: signIn, state: { tab: 'terminal', login: 'alice', linkedTab: 'terminal' } });
  await page.fetch('/api/sessions');
  assert.deepEqual(page.assigned, ['/login?next=%2Fs%2Faaaa1111%3Ftab%3Dterminal']);
  // The page wrote ?tab=terminal from Alice's memory or her click: Bob signing in there does not take it as his.
  page = loadCommon({ answer: signIn, state: { tab: 'terminal', login: 'alice', linkedTab: null } });
  await page.fetch('/api/sessions');
  assert.deepEqual(page.assigned, ['/login?next=%2Fs%2Faaaa1111']);
  // Followed a link to ?tab=diff, then picked Terminal (the address says terminal now): the way back is the link.
  page = loadCommon({ answer: signIn, state: { tab: 'terminal', login: 'alice', linkedTab: 'diff' } });
  await page.fetch('/api/sessions');
  assert.deepEqual(page.assigned, ['/login?next=%2Fs%2Faaaa1111%3Ftab%3Ddiff']);
});

test('a lost sign-in drops what the browser tab kept before it goes to sign in', async () => {
  const stored = { 'woodshed-last': '{"login":"alice"}', 'woodshed-session-tabs': '{"login":"alice","tabs":{}}', other: 'x' };
  const page = loadCommon({ answer: () => json(401, { error: 'sign in first' }), stored });
  await page.fetch('/api/sessions');
  assert.equal(page.assigned.length, 1);
  assert.deepEqual(page.keptAtAssign, [['other']], "Alice's rail and tabs are gone before the login page loads");
});
