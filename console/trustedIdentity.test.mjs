import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { IDENTITY_HEADER, createTrustedIdentity, signIdentity, verifyIdentity } from './trustedIdentity.mjs';

const SECRET = 'a-shared-secret-of-at-least-32-characters';
const NOW = Date.parse('2026-11-10T10:00:00Z');

// The header as the host's proxy builds it, written out here rather than with signIdentity, so the format is pinned.
function hostHeader({ secret = SECRET, claims }) {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

test('a header the host signed names the person and their role until it expires', () => {
  const value = hostHeader({ claims: { login: 'octo-cat', role: 'owner', exp: NOW + 60_000 } });
  assert.deepEqual(verifyIdentity({ value, secret: SECRET, now: NOW }), { login: 'octo-cat', role: 'owner' });
  assert.deepEqual(verifyIdentity({ value: hostHeader({ claims: { login: 'mia', role: 'member', exp: NOW + 1 } }), secret: SECRET, now: NOW }), { login: 'mia', role: 'member' });
  assert.equal(signIdentity({ secret: SECRET, login: 'octo-cat', role: 'owner', exp: NOW + 60_000 }), value, 'signIdentity is the host\'s format');
});

test('an expired, forged, wrongly signed, missing or malformed header signs nobody in', () => {
  const claims = { login: 'octo-cat', role: 'owner', exp: NOW + 60_000 };
  const good = hostHeader({ claims });
  const check = (value, now = NOW) => verifyIdentity({ value, secret: SECRET, now }).refused;
  assert.equal(check(hostHeader({ claims: { ...claims, exp: NOW } })), 'expired');
  assert.equal(check(good, NOW + 60_000), 'expired', 'expired the moment exp is reached');
  assert.equal(check(hostHeader({ secret: 'another-secret-of-at-least-32-characters', claims })), 'forged', 'the wrong secret');
  const [, sig] = good.split('.');
  const raised = Buffer.from(JSON.stringify({ ...claims, role: 'owner', login: 'someone-else' })).toString('base64url');
  assert.equal(check(`${raised}.${sig}`), 'forged', 'a payload changed after signing');
  assert.equal(check(`${good.split('.')[0]}.${sig.slice(0, -2)}`), 'forged', 'a signature cut short');
  assert.equal(check(`${good.split('.')[0]}.`), 'forged', 'no signature');
  for (const value of [undefined, '']) assert.equal(check(value), 'missing');
  for (const value of ['nodot', '.sig', `${good}.more`, [good, good], 'x'.repeat(2000)]) assert.equal(check(value), 'malformed', String(value).slice(0, 20));
  const signed = (c) => hostHeader({ claims: c });
  assert.equal(check(signed({ ...claims, role: 'admin' })), 'bad identity', 'a role that is neither');
  assert.equal(check(signed({ ...claims, login: 'Octo-Cat' })), 'bad identity', 'the host sends the login lowercased');
  assert.equal(check(signed({ ...claims, login: 'a/../b' })), 'bad identity');
  assert.equal(check(signed({ login: 'octo-cat', role: 'owner' })), 'expired', 'no exp is never good');
  assert.equal(check(signed({ ...claims, exp: NOW + 5 * 60_000 })), undefined, 'five minutes ahead leaves room for the clocks');
  assert.equal(check(signed({ ...claims, exp: NOW + 5 * 60_000 + 1 })), 'too long', 'a header made to last is not one made per request');
  assert.equal(check(signed({ ...claims, exp: String(NOW + 60_000) })), 'expired', 'exp is a number');
  const notJson = Buffer.from('{not json').toString('base64url');
  assert.equal(check(`${notJson}.${crypto.createHmac('sha256', SECRET).update(notJson).digest('base64url')}`), 'malformed');
});

test('userFor reads the request\'s header, and logs a refusal that means something, once a minute for each reason', () => {
  const clock = { now: NOW };
  const identity = createTrustedIdentity({ secret: SECRET, now: () => clock.now });
  const lines = [];
  const kept = console.warn;
  console.warn = (...args) => lines.push(args);
  try {
    assert.deepEqual(identity.userFor({ [IDENTITY_HEADER]: signIdentity({ secret: SECRET, login: 'mia', role: 'member', exp: NOW + 60_000 }) }), { login: 'mia', role: 'member' });
    assert.equal(identity.userFor({}), null);
    assert.equal(identity.userFor(undefined), null);
    const forged = { [IDENTITY_HEADER]: signIdentity({ secret: 'not-the-secret-not-the-secret-not-the', login: 'mia', role: 'owner', exp: NOW + 60_000 }) };
    assert.equal(identity.userFor(forged), null);
    assert.equal(identity.userFor(forged), null);
    clock.now += 60_000;
    assert.equal(identity.userFor(forged), null);
  } finally {
    console.warn = kept;
  }
  assert.deepEqual(lines, [['trustedIdentity: identity refused', { why: 'forged' }], ['trustedIdentity: identity refused', { why: 'forged' }]], 'missing is not logged; forged twice, a minute apart');
});
