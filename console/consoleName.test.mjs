import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { DEFAULT_CONSOLE_NAME, consoleName, loadConfig } from './config.mjs';
import { failedComment, refusalComment, resumeComment, startComment } from './fleet.mjs';
import { appManifest } from './githubAppSetup.mjs';
import { createHandler, pageShell } from './server.mjs';

const BASE_ENV = { GH_TOKEN: 'x', WOODSHED_REPO: 'acme/app' };

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function getBody(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers: { host: `localhost:${port}` } }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve(raw));
    }).on('error', reject);
  });
}

async function consoleOn(t, env) {
  const config = loadConfig({ ...BASE_ENV, ...env });
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null } });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  return port;
}

function warnings(t) {
  const seen = [];
  t.mock.method(console, 'warn', (...args) => { seen.push(args); });
  return seen;
}

test('the console is called Woodshed unless the installation names it', () => {
  assert.equal(DEFAULT_CONSOLE_NAME, 'Woodshed');
  assert.equal(loadConfig(BASE_ENV).consoleName, 'Woodshed');
  assert.equal(consoleName({ WOODSHED_CONSOLE_NAME: '   ' }), 'Woodshed', 'blank is unset');
  assert.equal(consoleName({ WOODSHED_CONSOLE_NAME: '  Acme Woodshed ' }), 'Acme Woodshed', 'trimmed');
  assert.equal(consoleName({ WOODSHED_CONSOLE_NAME: 'Café: the shed #2 & co.' }), 'Café: the shed #2 & co.');
  assert.equal(consoleName({ WOODSHED_CONSOLE_NAME: 'x'.repeat(40) }), 'x'.repeat(40));
});

test('a name the console cannot show safely gives the default, with one warning for each value', (t) => {
  const seen = warnings(t);
  for (const bad of ['<script>alert(1)</script>', 'Acme "Woodshed"', "Acme's", 'a`b', 'x'.repeat(41), 'line\nbreak', 'tab\there']) {
    assert.equal(consoleName({ WOODSHED_CONSOLE_NAME: bad }), 'Woodshed', JSON.stringify(bad));
  }
  assert.equal(seen.length, 7);
  assert.equal(consoleName({ WOODSHED_CONSOLE_NAME: '<script>alert(1)</script>' }), 'Woodshed');
  assert.equal(seen.length, 7, 'the same bad value warns once');
  assert.match(seen[0][0], /WOODSHED_CONSOLE_NAME/);
  assert.doesNotMatch(JSON.stringify(seen), /<script/i, 'the warning does not repeat the value');
});

test('the page shell escapes the name wherever it writes it', () => {
  const shell = pageShell({ title: '"><script>alert(1)</script>&\'`', script: 'login.js' });
  assert.doesNotMatch(shell, /<script>alert/);
  assert.match(shell, /<title>&#34;&#62;&#60;script&#62;alert\(1\)&#60;\/script&#62;&#38;&#39;&#96;<\/title>/);
  assert.match(shell, /<meta name="woodshed-console-name" content="&#34;&#62;&#60;script&#62;/);
  assert.match(shell, /<meta name="apple-mobile-web-app-title" content="&#34;&#62;/);
});

test('by default the pages and the installed app are called Woodshed', async (t) => {
  const port = await consoleOn(t, {});
  const manifest = JSON.parse(await getBody(port, '/manifest.webmanifest'));
  assert.equal(manifest.name, 'Woodshed');
  assert.equal(manifest.short_name, 'Woodshed');
  const home = await getBody(port, '/');
  assert.match(home, /<title>Woodshed<\/title>/);
  assert.match(home, /<meta name="woodshed-console-name" content="Woodshed">/);
  assert.match(home, /<meta name="apple-mobile-web-app-title" content="Woodshed">/);
});

test('a configured name is the page title, the installed app\'s name and what the sign-in page reads', async (t) => {
  const port = await consoleOn(t, { WOODSHED_CONSOLE_NAME: 'Acme Woodshed' });
  const manifest = JSON.parse(await getBody(port, '/manifest.webmanifest'));
  assert.equal(manifest.name, 'Acme Woodshed');
  assert.equal(manifest.short_name, 'Acme Woodshed');
  for (const page of ['/', '/settings', '/login']) {
    const html = await getBody(port, page);
    assert.match(html, /<title>Acme Woodshed<\/title>/, page);
    assert.match(html, /<meta name="woodshed-console-name" content="Acme Woodshed">/, page);
    assert.match(html, /<meta name="apple-mobile-web-app-title" content="Acme Woodshed">/, page);
  }
});

test('a hostile name never reaches a page or the manifest', async (t) => {
  warnings(t);
  const port = await consoleOn(t, { WOODSHED_CONSOLE_NAME: '</title><script>alert(1)</script>' });
  assert.equal(JSON.parse(await getBody(port, '/manifest.webmanifest')).name, 'Woodshed');
  const login = await getBody(port, '/login');
  assert.doesNotMatch(login, /alert\(1\)/);
  assert.match(login, /<title>Woodshed<\/title>/);
});

test('the console\'s GitHub comments and its new GitHub App use its name', () => {
  const session = { id: 'abcd1234', status: 'starting', startedBy: 'joel', resumedBy: 'joel', branch: 'woodshed/1-abcd1234' };
  const consoleName = 'Acme Woodshed';
  assert.match(startComment({ session, publicUrl: null, maxRunning: 5, consoleName }), /^Started a session on Acme Woodshed for @joel[^]*from Acme Woodshed\./);
  assert.match(startComment({ session: { ...session, status: 'queued' }, publicUrl: null, maxRunning: 5, consoleName }), /^Queued a session on Acme Woodshed for @joel/);
  assert.match(resumeComment({ session, publicUrl: null, consoleName }), /^Resumed the Acme Woodshed session[^]*from Acme Woodshed\.$/);
  assert.match(failedComment({ session, publicUrl: null, consoleName }), /^The Acme Woodshed session for @joel failed/);
  assert.match(refusalComment({ login: 'sam', label: 'woodshed', unlabeled: false, member: true, publicUrl: null, consoleName }), /^@sam can't start Acme Woodshed sessions/);
  assert.equal(appManifest({ publicUrl: 'https://w.example', repo: 'acme/app', consoleName }).name, 'Acme Woodshed acme');
  assert.equal(appManifest({ publicUrl: 'https://w.example', repo: 'acme/app' }).name, 'Woodshed acme');
});
