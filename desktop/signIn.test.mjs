import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { browserUrl, createPending, linkInArgs, parseSignedInLink, pkcePair, signInStep } from './signIn.mjs';

test('the challenge is the verifier\'s SHA-256, as the console checks it', () => {
  const { verifier, challenge } = pkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(crypto.createHash('sha256').update(verifier).digest('base64url'), challenge);
  assert.notEqual(pkcePair().verifier, verifier);
});

test('only the console\'s own Sign in with GitHub goes to the browser', () => {
  const home = 'https://woodshed.example.com/';
  assert.deepEqual(signInStep('https://woodshed.example.com/auth/start?next=%2Fs%2Faaaa1111', home), { next: '/s/aaaa1111' });
  assert.deepEqual(signInStep('https://woodshed.example.com/auth/start', home), { next: '/' });
  assert.equal(signInStep('https://woodshed.example.com/login?next=/', home), null);
  assert.equal(signInStep('https://woodshed.example.com/auth/connect', home), null, 'Connect GitHub keeps its token, in the window');
  assert.equal(signInStep('https://elsewhere.example.com/auth/start', home), null);
  assert.equal(signInStep('nonsense', home), null);
});

test('the browser opens the console\'s desktop sign-in', () => {
  assert.equal(browserUrl('https://woodshed.example.com/', { challenge: 'c'.repeat(43), next: '/s/aaaa1111' }),
    `https://woodshed.example.com/auth/desktop?challenge=${'c'.repeat(43)}&next=%2Fs%2Faaaa1111`);
});

test('a signed-in link is read, and anything else is not', () => {
  const code = 'ab'.repeat(24);
  assert.deepEqual(parseSignedInLink(`woodshed://signed-in?code=${code}&next=%2Fs%2Faaaa1111`), { code, next: '/s/aaaa1111' });
  assert.deepEqual(parseSignedInLink(`woodshed://signed-in?code=${code}`), { code, next: '/' });
  assert.deepEqual(parseSignedInLink(`woodshed://signed-in?code=${code}&next=%2F%2Fevil.test`), { code, next: '/' });
  assert.deepEqual(parseSignedInLink(`woodshed://signed-in?code=${code}&next=https%3A%2F%2Fevil.test`), { code, next: '/' });
  assert.equal(parseSignedInLink('woodshed://signed-in?code=not-hex'), null);
  assert.equal(parseSignedInLink(`woodshed://other?code=${code}`), null);
  assert.equal(parseSignedInLink(`https://signed-in/?code=${code}`), null);
  assert.equal(parseSignedInLink('garbage'), null);
});

test('a sign-in is claimed once, and only within ten minutes', () => {
  const clock = { now: 0 };
  const pending = createPending({ now: () => clock.now });
  assert.equal(pending.take(), null, 'nothing started');
  const started = pending.begin('/s/aaaa1111');
  assert.ok(pending.waiting());
  assert.deepEqual(pending.take(), started);
  assert.equal(pending.take(), null);
  pending.begin('/');
  clock.now += 10 * 60_000;
  assert.equal(pending.waiting(), false);
  assert.equal(pending.take(), null);
});

test('the link among the arguments Windows and Linux start the app with', () => {
  assert.equal(linkInArgs(['/opt/Woodshed/woodshed', '--flag', 'woodshed://signed-in?code=ab']), 'woodshed://signed-in?code=ab');
  assert.equal(linkInArgs(['/opt/Woodshed/woodshed']), null);
});
