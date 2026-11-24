import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consolePath, consoleUrlFrom, destination, isConsoleMe, isLoopbackHost } from './links.mjs';

test('a typed console address becomes its origin', () => {
  assert.equal(consoleUrlFrom('woodshed.example.com'), 'https://woodshed.example.com/');
  assert.equal(consoleUrlFrom('  https://woodshed.example.com/s/aaaa1111?tab=review '), 'https://woodshed.example.com/');
  assert.equal(consoleUrlFrom('localhost:7690'), 'http://localhost:7690/');
  assert.equal(consoleUrlFrom('127.0.0.1:7690/'), 'http://127.0.0.1:7690/');
  assert.equal(consoleUrlFrom('https://localhost:7690'), 'https://localhost:7690/');
});

test('an address the app will not open says why', () => {
  assert.throws(() => consoleUrlFrom(''), /Type the address/);
  assert.throws(() => consoleUrlFrom('http://woodshed.example.com'), /Only a console on this computer may use http/);
  assert.throws(() => consoleUrlFrom('file:///etc/passwd'), /must start with https:\/\/ or http/);
  assert.throws(() => consoleUrlFrom('https://me:secret@woodshed.example.com'), /user name and password/);
  assert.throws(() => consoleUrlFrom('https://exa mple.com'), /is not an address/);
});

test('loopback hosts', () => {
  for (const h of ['localhost', 'app.localhost', '127.0.0.1', '127.1.2.3', '[::1]', '::1']) assert.ok(isLoopbackHost(h), h);
  for (const h of ['localhost.example.com', '128.0.0.1', 'example.com']) assert.ok(!isLoopbackHost(h), h);
});

test('where each link of a hosted console goes', () => {
  const where = { consoleUrl: 'https://woodshed.example.com/', appDomain: 'apps.example.com' };
  assert.equal(destination('https://woodshed.example.com/s/aaaa1111', where), 'console');
  assert.equal(destination('https://woodshed.example.com/shell/aaaa1111/', where), 'console');
  assert.equal(destination('https://aaaa1111.apps.example.com/', where), 'app');
  assert.equal(destination('https://aaaa1111.apps.example.com/__woodshed/code/', where), 'app');
  // An app domain over plain http, or one that only ends in the same letters, is not the console's.
  assert.equal(destination('http://aaaa1111.apps.example.com/', where), 'external');
  assert.equal(destination('https://evilapps.example.com/', where), 'external');
  assert.equal(destination('https://github.com/login/oauth/authorize?client_id=x', where), 'signIn');
  assert.equal(destination('https://github.com/sessions/two-factor/app', where), 'signIn');
  assert.equal(destination('https://github.com/session', where), 'signIn');
  assert.equal(destination('https://github.com/example-org/example-repo/pull/26325', where), 'external');
  assert.equal(destination('https://github.com/loginx', where), 'external');
  assert.equal(destination('https://woodshed.example.com.evil.test/', where), 'external');
  assert.equal(destination('about:blank', where), 'blank');
  assert.equal(destination('mailto:someone@example.com', where), 'external');
  assert.equal(destination('javascript:alert(1)', where), 'external');
  assert.equal(destination('not a url', where), 'external');
});

test('with no app domain known yet, only the console stays in the app', () => {
  const where = { consoleUrl: 'https://woodshed.example.com/', appDomain: null };
  assert.equal(destination('https://aaaa1111.apps.example.com/', where), 'external');
  assert.equal(destination('https://woodshed.example.com/', where), 'console');
});

test('a local console keeps its app ports in the app', () => {
  const where = { consoleUrl: 'http://localhost:7690/', appDomain: 'localhost' };
  assert.equal(destination('http://localhost:7690/s/aaaa1111', where), 'console');
  assert.equal(destination('http://localhost:7701/', where), 'app');
  assert.equal(destination('http://127.0.0.1:7701/', where), 'external');
});

test('a local console\'s apps on a loopback app domain stay in the app over http', () => {
  const where = { consoleUrl: 'http://localhost:7690/', appDomain: 'apps.localhost' };
  assert.equal(destination('http://aaaa1111.apps.localhost:7690/', where), 'app');
  assert.equal(destination('http://aaaa1111.apps.localhost:7690/__woodshed/code/', where), 'app');
});

test('only a Woodshed console\'s /api/me passes setup, not any web app', () => {
  assert.ok(isConsoleMe({ supported: true, signIn: true, available: true, login: null, visitor: null, admin: false }));
  assert.ok(isConsoleMe({ supported: false, signIn: false, available: false, login: null, admin: true }), 'a console with no sign-in');
  assert.ok(isConsoleMe({ supported: true, signIn: true, available: true, hosted: true, login: 'octocat', admin: false }), 'the hosted console');
  for (const other of [null, {}, { name: 'Some PWA' }, { supported: 'yes', signIn: true, login: null, admin: false }, { supported: true, signIn: true }, 'text']) {
    assert.equal(isConsoleMe(other), false, JSON.stringify(other));
  }
});

test('a path to open after signing in stays on the console', () => {
  const home = 'http://localhost:7690/';
  assert.equal(consolePath(home, '/s/aaaa1111?tab=review'), 'http://localhost:7690/s/aaaa1111?tab=review');
  assert.equal(consolePath(home, '/'), home);
  for (const away of ['//evil.test/x', '/\\evil.test', 'https://evil.test/', 'https:evil.test', 'javascript:alert(1)', '', null, 's/aaaa1111']) {
    assert.equal(consolePath(home, away), home, String(away));
  }
  // What stripping the slash used to make of it: a scheme, and so another site.
  assert.equal(consolePath(home, '/https:evil.test'), 'http://localhost:7690/https:evil.test');
});

test('the session a console page shows', async () => {
  const { sessionShown } = await import('./links.mjs');
  const base = 'https://console.example.com/';
  assert.equal(sessionShown('https://console.example.com/s/aaaa1111', base), 'aaaa1111');
  assert.equal(sessionShown('https://console.example.com/s/aaaa1111?tab=tui', base), 'aaaa1111');
  for (const url of ['https://console.example.com/', 'https://console.example.com/all', 'https://evil.example/s/aaaa1111', 'https://console.example.com/s/aaaa1111/x', 'file:///setup.html', 'not a url']) {
    assert.equal(sessionShown(url, base), null, url);
  }
  assert.equal(sessionShown('https://console.example.com/s/aaaa1111', null), null);
});
