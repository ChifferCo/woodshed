import test from 'node:test';
import assert from 'node:assert/strict';

import { isSameOrigin, isKnownHost } from './sameOrigin.mjs';

test('the page driving its own shed is allowed, on any host it was reached by', () => {
  for (const host of ['box.tailnet.ts.net:7777', 'localhost:7777', '10.0.0.4:7777']) {
    assert.equal(isSameOrigin({ origin: 'http://' + host, host }), true);
  }
});

test('a page on another host is refused', () => {
  assert.equal(
    isSameOrigin({ origin: 'https://evil.example', host: 'box.tailnet.ts.net:7777' }),
    false,
  );
});

test('the port is part of the host, so a different one is a different origin', () => {
  assert.equal(
    isSameOrigin({ origin: 'http://localhost:3000', host: 'localhost:7777' }),
    false,
  );
});

test('a request with no Origin is not what this guards against', () => {
  assert.equal(isSameOrigin({ host: 'localhost:7777' }), true);
  assert.equal(isSameOrigin({ origin: '', host: 'localhost:7777' }), true);
});

test('an opaque or unparseable Origin names no host and cannot match one', () => {
  assert.equal(isSameOrigin({ origin: 'null', host: 'localhost:7777' }), false);
  assert.equal(isSameOrigin({ origin: 'not a url', host: 'localhost:7777' }), false);
});

test('a request with an Origin but no Host is refused', () => {
  assert.equal(isSameOrigin({ origin: 'http://localhost:7777' }), false);
});

// ---- the host has to name this box ---------------------------------------

const BOX = ['localhost', '127.0.0.1', '::1', 'dev-box', '100.64.0.7'];

test('the box answers to its own name, with or without a port', () => {
  assert.equal(isKnownHost('dev-box:7777', BOX), true);
  assert.equal(isKnownHost('dev-box', BOX), true);
});

test('and to the longer name MagicDNS hands out', () => {
  assert.equal(isKnownHost('dev-box.tail1234.ts.net:7777', BOX), true);
});

test('and to its own addresses and loopback', () => {
  assert.equal(isKnownHost('100.64.0.7:7777', BOX), true);
  assert.equal(isKnownHost('127.0.0.1:7788', BOX), true);
  assert.equal(isKnownHost('[::1]:7777', BOX), true);
});

test('a name an attacker could register is not ours, however it is spelled', () => {
  assert.equal(isKnownHost('evil.example:7777', BOX), false);
  assert.equal(isKnownHost('notdev-box:7777', BOX), false);
  assert.equal(isKnownHost('evil-dev-box.example', BOX), false);
  // The one that matters: borrowing the hostname as a first label under a
  // domain the attacker owns. Accepted only under .ts.net, which they cannot.
  assert.equal(isKnownHost('dev-box.evil.example', BOX), false);
  assert.equal(isKnownHost('dev-box.evil.example.ts.net.attacker.com', BOX), false);
});

test('no Host at all is refused', () => {
  assert.equal(isKnownHost(undefined, BOX), false);
  assert.equal(isKnownHost('', BOX), false);
});
