import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createCliSignIn } from '../console/cliSignIn.mjs';
import { createHandler } from '../console/server.mjs';
import { createCredentials } from './credentials.mjs';
import { approvalUrl, consoleOrigin, DEFAULT_CONSOLE, EXIT, main, parseArgs } from './woodshed.mjs';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// A console with the command line's sign-in, a clock the CLI's sleeps move, and a person signed in by cookie.
async function consoleFor(t, { decision = 'approve', approves = true, people = null } = {}) {
  let clock = Date.parse('2026-11-20T10:00:00Z');
  const now = () => clock;
  const store = { state: {}, save() {} };
  const cli = createCliSignIn({ store, now, allowed: (login) => !people || people.has(login) });
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => (cookie ? { login: /woodshed_session=([\w-]+)/.exec(cookie)[1] } : null) };
  const config = {
    host: '127.0.0.1', publicUrl: 'http://pending', extraHosts: [], repo: 'acme/app', label: 'woodshed', consoleName: 'Acme Woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, auth, cli });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const origin = `http://localhost:${port}`;
  config.publicUrl = origin;
  const cookie = 'woodshed_session=mia-dev';
  const opened = [];
  // The person's browser: the page the CLI opens, then its button, from the console's own origin.
  async function approve(url) {
    opened.push(url);
    if (!approves) return;
    const page = await fetch(url, { headers: { cookie } });
    assert.equal(page.status, 200);
    const text = await page.text();
    const code = new URL(url).searchParams.get('code');
    assert.ok(text.includes(code), 'the page shows the code the terminal does');
    assert.ok(text.includes('@mia-dev'), 'and who it signs in as');
    const done = await fetch(`${origin}/cli`, {
      method: 'POST', headers: { cookie, origin, 'content-type': 'application/x-www-form-urlencoded' },
      // What the page's form sends: each hidden field it holds, as a browser would, and the button pressed.
      body: new URLSearchParams([...[...text.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)]
        .map(([, name, value]) => [name, value.replaceAll('&quot;', '"').replaceAll('&amp;', '&')]), ['decision', decision]]).toString(),
    });
    assert.equal(done.status, 200);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = async (args) => {
    let out = '';
    let err = '';
    const code = await main(args, {
      env: { XDG_CONFIG_HOME: dir }, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } },
      sleep: async (ms) => { clock += ms; }, now, hostname: 'mia-laptop', platform: 'test',
      credentials: createCredentials({ platform: 'test', dir: path.join(dir, 'woodshed') }),
      openBrowser: (url) => { approve(url).catch((e) => { err += e.stack; }); },
    });
    // The browser's approval runs beside the polls: let it finish before the next command.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { code, out, err, lines: out.trim().split('\n').filter(Boolean).map((l) => (l.startsWith('{') ? JSON.parse(l) : l)) };
  };
  return { origin, run, dir, cookie, opened, cli, tick: (ms) => { clock += ms; } };
}

test('login prints a code, the person approves it in the console, and status says the console, org and who is signed in', async (t) => {
  const c = await consoleFor(t);
  const signed = await c.run(['login', '--console', c.origin, '--json']);
  assert.equal(signed.code, EXIT.done, signed.err);
  const [code, done] = signed.lines;
  assert.equal(code.event, 'code');
  assert.match(code.userCode, /^[A-Z]{4}-[A-Z]{4}$/);
  assert.equal(code.verificationUrlComplete, `${c.origin}/cli?code=${code.userCode}`);
  assert.deepEqual(c.opened, [code.verificationUrlComplete], 'it opens the page with the code on it');
  assert.equal(done.event, 'signed-in');
  assert.deepEqual([done.login, done.org, done.name, done.store], ['mia-dev', 'acme', 'Acme Woodshed', 'file']);
  const file = path.join(c.dir, 'woodshed', 'credentials.json');
  assert.equal(done.credentialsFile, file, 'the file it fell back to is named');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'only this user reads it');
  assert.ok(!fs.readFileSync(path.join(c.dir, 'woodshed', 'cli.json'), 'utf8').includes('wsc_'), 'cli.json never holds the token');

  const status = await c.run(['status', '--json']);
  assert.equal(status.code, EXIT.done, 'the console signed in to last is the one asked about');
  assert.deepEqual(
    [status.lines[0].signedIn, status.lines[0].login, status.lines[0].org, status.lines[0].name, status.lines[0].device],
    [true, 'mia-dev', 'acme', 'Acme Woodshed', 'mia-laptop'],
  );
  const text = await c.run(['status']);
  assert.match(text.out, /Console: +Acme Woodshed \(http:\/\/localhost:\d+\)\nOrg: +acme\nSigned in: +@mia-dev\n/);

  const mine = await (await fetch(`${c.origin}/api/my`, { headers: { cookie: c.cookie } })).json();
  assert.deepEqual(mine.cli.tokens.map((x) => x.name), ['mia-laptop'], 'My settings lists the computer');
  assert.ok(!JSON.stringify(mine).includes('wsc_') && !JSON.stringify(mine).includes('hash'), 'never the token or its hash');

  const again = await c.run(['login', '--json']);
  assert.equal(again.code, EXIT.done);
  assert.equal(c.cli.list('mia-dev').length, 1, 'signing in again on the computer ends its earlier sign-in');

  const out = await c.run(['logout', '--json']);
  assert.equal(out.code, EXIT.done);
  assert.deepEqual([out.lines[0].wasSignedIn, out.lines[0].endedAtConsole], [true, true]);
  assert.deepEqual(c.cli.list('mia-dev'), [], 'logout ends it at the console too');
  assert.equal((await c.run(['status', '--console', c.origin, '--json'])).code, EXIT.waiting, 'signed out: waiting on a person to sign in');
});

test('Revoke on My settings ends a computer\'s sign-in, and status says so', async (t) => {
  const c = await consoleFor(t);
  assert.equal((await c.run(['login', '--console', c.origin])).code, EXIT.done);
  const [{ id }] = c.cli.list('mia-dev');
  const revoked = await fetch(`${c.origin}/api/my/cli-tokens/${id}/revoke`, {
    method: 'POST', headers: { cookie: c.cookie, origin: c.origin, 'x-woodshed': '1', 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(revoked.status, 200);
  assert.deepEqual((await revoked.json()).cli.tokens, []);
  const status = await c.run(['status', '--json']);
  assert.equal(status.code, EXIT.waiting);
  assert.deepEqual(status.lines[0], { console: c.origin, signedIn: false, ended: true });
});

test('a denied sign-in is refused, and one nobody approves expires waiting on a person', async (t) => {
  const denied = await consoleFor(t, { decision: 'deny' });
  const out = await denied.run(['login', '--console', denied.origin, '--json']);
  assert.equal(out.code, EXIT.refused);
  assert.deepEqual(out.lines.at(-1), { event: 'error', status: 'denied', error: 'The sign-in was denied in the browser.' });

  const ignored = await consoleFor(t, { approves: false });
  const waited = await ignored.run(['login', '--console', ignored.origin, '--no-browser']);
  assert.equal(waited.code, EXIT.waiting);
  assert.deepEqual(ignored.opened, [], '--no-browser opens nothing');
  assert.match(waited.out, /^Your code: [A-Z]{4}-[A-Z]{4}\nOpen http:\/\/localhost:\d+\/cli\?code=/, 'it prints the address to open instead');
  assert.match(waited.err, /expired before anyone approved it/);
});

test('someone taken off People is refused, at the approval and after', async (t) => {
  const people = new Set(['mia-dev']);
  const c = await consoleFor(t, { people });
  assert.equal((await c.run(['login', '--console', c.origin])).code, EXIT.done);
  people.delete('mia-dev');
  assert.equal((await c.run(['status', '--json'])).code, EXIT.waiting, 'the token stops working at once');
});

test('the console refuses a browser\'s call to start a sign-in, and the CLI refuses plain http off this machine', async (t) => {
  const c = await consoleFor(t);
  const fromPage = await fetch(`${c.origin}/api/cli/device`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(fromPage.status, 403);
  assert.equal((await fetch(`${c.origin}/api/cli/me`, { headers: { authorization: `Bearer wsc_${'0'.repeat(64)}` } })).status, 401);
  const page = await fetch(`${c.origin}/cli?code=BCDF-GHJK`, { headers: { cookie: c.cookie } });
  assert.equal(page.status, 404, 'a code nobody asked for');
  const forged = await fetch(`${c.origin}/cli`, { method: 'POST', headers: { cookie: c.cookie, origin: 'https://evil.example' }, body: 'code=BCDF-GHJK&decision=approve&login=mia-dev' });
  assert.equal(forged.status, 403, 'another site cannot press the button');

  assert.equal(consoleOrigin('console.example.com/settings'), 'https://console.example.com');
  assert.equal(consoleOrigin('http://localhost:7690/'), 'http://localhost:7690');
  const plain = await c.run(['status', '--console', 'http://console.example.com', '--json']);
  assert.equal(plain.code, EXIT.refused);
  assert.equal(plain.lines[0].status, 'refused');
});

test('the arguments: one command, --console, --json, and the default console', () => {
  assert.deepEqual(parseArgs(['status', '--console=https://c.example', '--json']), { command: 'status', args: [], rest: null, console: 'https://c.example', json: true, browser: true, help: false });
  assert.throws(() => parseArgs(['status', '--colsone', 'x']), /unknown option --colsone/);
  assert.equal(DEFAULT_CONSOLE, 'https://console.woodshed.run');
});

test('the page opened is built from the code on the console named, never taken from its answer', async (t) => {
  assert.equal(approvalUrl('https://c.example', 'BCDF-GHJK'), 'https://c.example/cli?code=BCDF-GHJK');
  assert.equal(approvalUrl('https://c.example', '-a Calculator'), null);
  // A console that answers with a code that is not one, and an address of somewhere else to open.
  const opened = [];
  const fake = async () => new Response(JSON.stringify({ deviceCode: 'd', userCode: '& calc', verificationUrlComplete: 'file:///etc/passwd', expiresIn: 600, interval: 5 }), { status: 200 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const code = await main(['login', '--console', 'https://c.example', '--json'], {
    env: { XDG_CONFIG_HOME: dir }, stdout: { write() {} }, stderr: { write() {} }, fetch: fake, platform: 'test',
    credentials: createCredentials({ platform: 'test', dir }), openBrowser: (url) => opened.push(url),
  });
  assert.equal(code, EXIT.failed);
  assert.deepEqual(opened, []);
});

test('a network that drops while the person approves is asked again, and console text reaches the terminal printable only', async (t) => {
  const answers = [
    () => new Response(JSON.stringify({ deviceCode: 'd'.repeat(64), userCode: 'BCDF-GHJK', expiresIn: 600, interval: 5 }), { status: 200 }),
    () => { throw new TypeError('fetch failed'); },
    () => new Response(JSON.stringify({ status: 'pending' }), { status: 202 }),
    () => new Response(JSON.stringify({ status: 'approved', token: `wsc_${'e'.repeat(64)}`, id: 'f'.repeat(16), login: 'mia-dev', console: 'Acme\u001b]0;pwned\u0007', org: 'acme' }), { status: 200 }),
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let out = '';
  let err = '';
  const code = await main(['login', '--console', 'https://c.example', '--no-browser'], {
    env: { XDG_CONFIG_HOME: dir }, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } },
    fetch: async () => answers.shift()(), sleep: async () => {}, platform: 'test', credentials: createCredentials({ platform: 'test', dir }),
  });
  assert.equal(code, EXIT.done);
  assert.match(err, /could not reach https:\/\/c\.example: fetch failed; trying again/);
  assert.match(out, /Signed in to Acme\]0;pwned as @mia-dev\./);
  assert.ok(!/[\u0000-\u001f\u007f]/.test(out.replace(/\n/g, '')), 'no control characters');
});

test('a console that hands out something other than a command line token gets a plain error, and nothing is kept', async (t) => {
  const answers = [
    () => new Response(JSON.stringify({ deviceCode: 'd'.repeat(64), userCode: 'BCDF-GHJK', expiresIn: 600, interval: 5 }), { status: 200 }),
    () => new Response(JSON.stringify({ status: 'approved', token: 'not-a-token', id: 'x', login: 'mia-dev' }), { status: 200 }),
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let err = '';
  const code = await main(['login', '--console', 'https://c.example', '--no-browser'], {
    env: { XDG_CONFIG_HOME: dir }, stdout: { write() {} }, stderr: { write: (s) => { err += s; } },
    fetch: async () => answers.shift()(), sleep: async () => {}, platform: 'test', credentials: createCredentials({ platform: 'test', dir }),
  });
  assert.equal(code, EXIT.failed);
  assert.match(err, /^woodshed: https:\/\/c\.example answered 200: it is not a Woodshed console/);
  assert.equal(fs.existsSync(path.join(dir, 'credentials.json')), false);
});

test('on Windows login refuses before it asks the console for a code', async () => {
  let asked = false;
  let err = '';
  const code = await main(['login', '--console', 'https://c.example'], {
    env: { XDG_CONFIG_HOME: os.tmpdir() }, stdout: { write() {} }, stderr: { write: (s) => { err += s; } }, platform: 'win32',
    fetch: async () => { asked = true; throw new Error('not reached'); },
  });
  assert.equal(code, EXIT.refused);
  assert.equal(asked, false);
  assert.match(err, /does not run on Windows yet/);
});

test('login refused for too many sign-ins waiting says to try again later, in the minutes the console gives, and fails', async (t) => {
  const c = await consoleFor(t);
  // Sign-ins this computer started and left: the CLI reaches the console from loopback, with nothing forwarded.
  for (let i = 0; i < 5; i++) c.cli.start({ name: 'left', from: '127.0.0.1' });
  const out = await c.run(['login', '--console', c.origin, '--json']);
  assert.equal(out.code, EXIT.failed);
  assert.deepEqual(out.lines, [{ event: 'error', status: 'busy', error: `Too many sign-ins from this address are waiting at ${c.origin}. Try again in 10 minutes.` }]);
  assert.deepEqual(c.opened, [], 'nothing opened');
  const text = await c.run(['login', '--console', c.origin]);
  assert.equal(text.err, `woodshed: Too many sign-ins from this address are waiting at ${c.origin}. Try again in 10 minutes.\n`);

  // What a console sends is never printed: only its Retry-After, as a number of minutes, and a known scope.
  const answers = [
    [{ 'retry-after': '61' }, { scope: 'console', error: '\u001b]0;pwned\u0007' }, 'has too many sign-ins waiting. Try again in 2 minutes.'],
    [{ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }, {}, 'has too many sign-ins waiting. Try again in a few minutes.'],
    [{ 'retry-after': '99999' }, { scope: 'client' }, 'Try again in 60 minutes.'],
  ];
  for (const [headers, body, said] of answers) {
    let err = '';
    const code = await main(['login', '--console', 'https://console.example'], {
      env: { XDG_CONFIG_HOME: c.dir }, stdout: { write: () => {} }, stderr: { write: (s) => { err += s; } }, platform: 'test',
      credentials: createCredentials({ platform: 'test', dir: path.join(c.dir, 'woodshed') }),
      fetch: async () => new Response(JSON.stringify(body), { status: 429, headers: { 'content-type': 'application/json', ...headers } }),
    });
    assert.equal(code, EXIT.failed);
    assert.ok(err.includes(said) && !err.includes('pwned'), err);
  }
});
