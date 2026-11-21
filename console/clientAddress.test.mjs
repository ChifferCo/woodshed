import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clientAddress, clientKey, normalAddress, parseTrustedProxies } from './clientAddress.mjs';

const req = (remoteAddress, xff) => ({ socket: { remoteAddress }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } });

test('X-Forwarded-For from a peer that is not a trusted proxy is ignored: the socket is the client', () => {
  const loopbackOnly = parseTrustedProxies();
  assert.equal(clientAddress(req('203.0.113.7', '198.51.100.1'), loopbackOnly), '203.0.113.7');
  assert.equal(clientAddress(req('203.0.113.7', '127.0.0.1'), loopbackOnly), '203.0.113.7', 'not even one naming loopback');
  assert.equal(clientAddress(req('::ffff:203.0.113.7', '198.51.100.1, 198.51.100.2'), loopbackOnly), '203.0.113.7');
  assert.equal(clientAddress(req('203.0.113.7'), loopbackOnly), '203.0.113.7');
  const nobody = parseTrustedProxies('none');
  assert.equal(clientAddress(req('127.0.0.1', '198.51.100.1'), nobody), '127.0.0.1', 'none trusts no proxy, loopback included');
});

test('a trusted proxy\'s X-Forwarded-For names the client, by the entry the proxy added, never one the client sent', () => {
  const loopbackOnly = parseTrustedProxies('');
  // Caddy on the same machine: loopback, with the address it saw last.
  assert.equal(clientAddress(req('127.0.0.1', '198.51.100.9'), loopbackOnly), '198.51.100.9');
  assert.equal(clientAddress(req('::ffff:127.0.0.1', '198.51.100.9'), loopbackOnly), '198.51.100.9', 'IPv4 loopback as IPv6');
  assert.equal(clientAddress(req('::1', '2001:db8::5'), loopbackOnly), '2001:db8::5');
  assert.equal(clientAddress(req('127.0.0.1', '10.9.9.9, 6.6.6.6, 198.51.100.9'), loopbackOnly), '198.51.100.9', 'what the client put first is never read');
  assert.equal(clientAddress(req('127.0.0.1', ['6.6.6.6', '198.51.100.9']), loopbackOnly), '198.51.100.9', 'a header sent twice reads as one list');
  assert.equal(clientAddress(req('127.0.0.1'), loopbackOnly), '127.0.0.1', 'nothing forwarded: a caller on this machine');
  assert.equal(clientAddress(req('127.0.0.1', 'unknown'), loopbackOnly), '127.0.0.1', 'an entry that is no address is never taken');
  assert.equal(clientAddress(req('127.0.0.1', '198.51.100.9:4431'), loopbackOnly), '127.0.0.1', 'nor one with a port');

  // A chain: a load balancer in 10.0.0.0/8, then Caddy on loopback. Each trusted hop is passed over, from the end.
  const chain = parseTrustedProxies('127.0.0.1, ::1, 10.0.0.0/8');
  assert.equal(clientAddress(req('127.0.0.1', '6.6.6.6, 198.51.100.9, 10.0.4.2'), chain), '198.51.100.9');
  assert.equal(clientAddress(req('10.0.4.2', '10.0.0.1, 10.0.0.2'), chain), '10.0.0.1', 'every hop trusted: the first one');
  assert.equal(clientAddress({ headers: {} }, chain), null, 'no socket address at all');
});

test('WOODSHED_TRUSTED_PROXIES takes addresses and ranges, and refuses anything else', () => {
  assert.deepEqual(parseTrustedProxies(undefined).names, ['127.0.0.0/8', '::1/128']);
  assert.deepEqual(parseTrustedProxies(' 172.18.0.2 , fd00::/8 ').names, ['172.18.0.2', 'fd00::/8']);
  const docker = parseTrustedProxies('172.18.0.0/16');
  assert.equal(clientAddress(req('172.18.0.3', '198.51.100.9'), docker), '198.51.100.9');
  assert.equal(clientAddress(req('127.0.0.1', '198.51.100.9'), docker), '127.0.0.1', 'a list replaces loopback, never adds to it');
  assert.throws(() => parseTrustedProxies(' , ,'), /lists no address/, 'commas alone are not none');
  for (const bad of ['caddy', '10.0.0.0/', '10.0.0.0/33', '::1/129', '10.0.0.0/8/1', '10.0.0.0/x']) {
    assert.throws(() => parseTrustedProxies(bad), /WOODSHED_TRUSTED_PROXIES has/, bad);
  }
});

test('a client is counted by its IPv4 address, or by the IPv6 /64 it is in', () => {
  assert.equal(normalAddress('::FFFF:198.51.100.9'), '198.51.100.9');
  assert.equal(normalAddress('not an address'), null);
  assert.equal(clientKey('198.51.100.9'), '198.51.100.9');
  assert.equal(clientKey('::ffff:198.51.100.9'), '198.51.100.9');
  assert.equal(clientKey('2001:db8:1:2:aaaa:bbbb:cccc:1'), '2001:db8:1:2::/64');
  assert.equal(clientKey('2001:db8:1:2::9'), '2001:db8:1:2::/64', 'another address in the same /64 is the same client');
  assert.equal(clientKey('2001:0db8:0001:0002::9'), '2001:db8:1:2::/64', 'however it is written');
  assert.notEqual(clientKey('2001:db8:1:3::9'), clientKey('2001:db8:1:2::9'));
  assert.equal(clientKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(clientKey('::1'), '0:0:0:0::/64');
  assert.equal(clientKey(null), null);
});

test('an IPv4 client in IPv6 clothing is IPv4 however it is written, and an empty last hop is never passed over', () => {
  for (const mapped of ['::ffff:192.0.2.1', '::FFFF:c000:201', '0:0:0:0:0:ffff:c000:0201', '0:0:0:0:0:ffff:192.0.2.1']) {
    assert.equal(normalAddress(mapped), '192.0.2.1', mapped);
    assert.equal(clientKey(mapped), '192.0.2.1', 'its own client, not the ::/64 every mapped address would share');
  }
  assert.equal(normalAddress('::c000:201'), '::c000:201', 'not mapped: left as IPv6');
  assert.equal(clientAddress(req('127.0.0.1', '::ffff:c000:201'), parseTrustedProxies()), '192.0.2.1');
  const loopbackOnly = parseTrustedProxies();
  assert.equal(clientAddress(req('127.0.0.1', '198.51.100.9, '), loopbackOnly), '127.0.0.1', 'the older entry is never read past an empty one');
  assert.equal(clientAddress(req('127.0.0.1', '198.51.100.9,,'), loopbackOnly), '127.0.0.1');
  assert.equal(clientAddress(req('127.0.0.1', ' '), loopbackOnly), '127.0.0.1', 'an empty header is no header');
});
