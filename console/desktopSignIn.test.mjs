// The desktop app's routes answered by a program that signs people in itself (a hosting proxy, the multi-tenant
// console): its own sign-in page and paths, its own sessions, core's codes and handler.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import test from 'node:test';

import { createDesktopCodes } from './auth.mjs';
import { handleDesktopSignIn } from './desktopSignIn.mjs';

function pair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

async function hostServer(t) {
  const clock = { now: 1_000_000 };
  const codes = createDesktopCodes({ now: () => clock.now });
  const minted = [];
  // The host's own sign-in: a `host` cookie names the person.
  const who = (req) => /(?:^|; )host=([a-z0-9-]+)/.exec(req.headers.cookie ?? '')?.[1] ?? null;
  const auth = {
    available: () => true,
    enabled: () => true,
    async visitorFor(cookieHeader, req) {
      const login = who(req);
      return login ? { login } : null;
    },
    async desktopCode({ req, challenge }) {
      const login = who(req);
      return login ? codes.issue({ login, org: 'acme' }, challenge) : null;
    },
    async claimDesktopCode({ code, verifier }) {
      const claimed = codes.claim(code, verifier);
      if (claimed.refused) return null;
      minted.push(claimed.data);
      return { login: claimed.data.login, setCookie: `host=${claimed.data.login}; Path=/; HttpOnly` };
    },
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://host.test');
    const answered = await handleDesktopSignIn({
      req, res, url, auth, consoleName: 'Hosted',
      signInUrl: (back) => `/account/sign-in?next=${encodeURIComponent(back)}`,
      signInPaths: ['/account/sign-in'],
    });
    if (!answered) { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  // The consent page's Sign in button, from the console's own page, which names the account the cookie is (`shown`
  // tells another, as a page left open from before would).
  const press = async (challenge, next, cookie, shown = /host=([a-z0-9-]+)/.exec(cookie ?? '')?.[1] ?? '') => {
    const res = await fetch(`${base}/auth/desktop`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, ...(cookie ? { cookie } : {}) },
      body: new URLSearchParams({ login: shown, challenge, next }).toString(),
    });
    const link = /url=(woodshed:\/\/signed-in\?[^"]+)"/.exec(await res.text())?.[1].replaceAll('&amp;', '&');
    return { status: res.status, location: res.headers.get('location'), link: link ? new URL(link) : null };
  };
  return { base, clock, minted, press };
}

const claimAt = (base, body) => fetch(`${base}/auth/desktop/claim`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-woodshed': '1' }, body: JSON.stringify(body),
});

test('a host that signs people in itself answers the desktop app with its own sign-in and sessions', async (t) => {
  const { base, minted, press } = await hostServer(t);
  const get = (path, cookie) => fetch(`${base}${path}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });

  assert.deepEqual(await (await get('/auth/desktop/ready')).json(), { desktop: true, available: true, required: true, signInPaths: ['/account/sign-in'] });

  const { verifier, challenge } = pair();
  const desktop = `/auth/desktop?challenge=${challenge}&next=%2Fs%2F0a1b2c3d`;
  const out = await get(desktop);
  assert.equal(out.status, 302);
  assert.equal(out.headers.get('location'), `/account/sign-in?next=${encodeURIComponent(desktop)}`, 'the host\'s sign-in, back to the same page');

  const ask = await (await get(desktop, 'host=octo')).text();
  assert.match(ask, /as <strong>@octo<\/strong>/, 'the host\'s person, asked first');
  assert.equal((await press(challenge, '/s/0a1b2c3d')).status, 303, 'a signed-out press goes back to sign in');

  const stale = await press(challenge, '/s/0a1b2c3d', 'host=octo', 'ana');
  assert.equal(stale.status, 303, 'a page that named another account asks again');
  assert.equal(stale.link, null);
  const { link } = await press(challenge, '/s/0a1b2c3d', 'host=octo');
  assert.equal(link.searchParams.get('next'), '/s/0a1b2c3d');
  const code = link.searchParams.get('code');
  assert.equal((await claimAt(base, { code, verifier: pair().verifier })).status, 401, 'no claim without the verifier');
  // That refusal used the code up: press again.
  const again = (await press(challenge, '/', 'host=octo')).link.searchParams.get('code');
  const claimed = await claimAt(base, { code: again, verifier });
  assert.equal(claimed.status, 200);
  assert.deepEqual(await claimed.json(), { login: 'octo' });
  assert.equal(claimed.headers.get('set-cookie'), 'host=octo; Path=/; HttpOnly', 'a session of the host\'s');
  assert.deepEqual(minted, [{ login: 'octo', org: 'acme' }], 'the claim gets what the code was issued with');
  assert.equal((await claimAt(base, { code: again, verifier })).status, 401, 'once');
});

test('a desktop code expires after two minutes', async (t) => {
  const { base, clock, press } = await hostServer(t);
  const { verifier, challenge } = pair();
  const code = (await press(challenge, '/', 'host=octo')).link.searchParams.get('code');
  clock.now += 2 * 60_000;
  assert.equal((await claimAt(base, { code, verifier })).status, 401);
});
