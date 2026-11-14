import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createOidcIssuer, OIDC_KEY_SECRET, TOKEN_TTL_SECONDS } from './oidcIssuer.mjs';
import { parseConnections } from '../shared/oidcConnections.mjs';

const ISSUER = 'https://console.example.com';
const CONNECTIONS = parseConnections([
  { name: 'aws-dev', type: 'aws', roleArn: 'arn:aws:iam::123456789012:role/woodshed-dev' },
  { name: 'vault', type: 'token', audience: 'vault' },
]);
const PRIVATE = { id: 'aaaa1111', owner: 'Octocat', repo: 'acme/app', branch: 'woodshed/task-aaaa1111', status: 'running' };

function memorySecrets() {
  const values = new Map();
  return {
    values,
    read: async (name) => values.get(name) ?? null,
    write: async (name, value) => { values.set(name, value); },
  };
}

function quiet(t) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
}

/** Checks a token as a cloud would: its signature by the key the JWKS names, and its claims. */
function verify(token, jwks) {
  const [h, p, sig] = token.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url'));
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  assert.ok(jwk, 'the JWKS has the key the token names');
  assert.equal(header.alg, 'RS256');
  const key = crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), key, Buffer.from(sig, 'base64url')), 'the signature checks out');
  return JSON.parse(Buffer.from(p, 'base64url'));
}

test('a private session gets a token a cloud can check, saying who owns it', async (t) => {
  quiet(t);
  const secrets = memorySecrets();
  const now = Date.parse('2026-11-14T10:00:00Z');
  const oidc = createOidcIssuer({ issuer: ISSUER, connections: CONNECTIONS, secrets, now: () => now });
  const { token, expiresAt, subject, audience } = await oidc.tokenFor(PRIVATE, 'aws-dev');
  assert.equal(subject, 'private:octocat');
  assert.equal(audience, 'sts.amazonaws.com');
  assert.equal(expiresAt, now + TOKEN_TTL_SECONDS * 1000);
  const claims = verify(token, await oidc.jwks());
  assert.equal(claims.iss, ISSUER);
  assert.equal(claims.sub, 'private:octocat');
  assert.equal(claims.aud, 'sts.amazonaws.com');
  assert.equal(claims.exp, now / 1000 + TOKEN_TTL_SECONDS);
  assert.equal(claims.session_id, 'aaaa1111');
  assert.equal(claims.repo, 'acme/app');
  assert.equal(claims.connection, 'aws-dev');
  assert.ok(secrets.values.get(OIDC_KEY_SECRET).startsWith('-----BEGIN PRIVATE KEY-----'), 'the key made is kept in its secret');
});

test('the discovery document points at the keys, on the issuer\'s own URL', () => {
  const oidc = createOidcIssuer({ issuer: ISSUER, connections: CONNECTIONS, secrets: memorySecrets() });
  const doc = oidc.discovery();
  assert.equal(doc.issuer, ISSUER);
  assert.equal(doc.jwks_uri, `${ISSUER}/.well-known/jwks.json`);
  assert.deepEqual(doc.id_token_signing_alg_values_supported, ['RS256']);
});

test('the key is made once, and read back the same after a restart', async (t) => {
  quiet(t);
  const secrets = memorySecrets();
  const first = await createOidcIssuer({ issuer: ISSUER, connections: CONNECTIONS, secrets }).jwks();
  const second = await createOidcIssuer({ issuer: ISSUER, connections: CONNECTIONS, secrets }).jwks();
  assert.deepEqual(second, first);
  assert.equal(first.keys.length, 1);
});

test('a key replaced by hand is used from the next read, and the one before stays in the JWKS for a while', async (t) => {
  quiet(t);
  const secrets = memorySecrets();
  let now = Date.parse('2026-11-14T10:00:00Z');
  const oidc = createOidcIssuer({ issuer: ISSUER, connections: CONNECTIONS, secrets, now: () => now });
  const old = await oidc.tokenFor(PRIVATE, 'aws-dev');
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  secrets.values.set(OIDC_KEY_SECRET, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  now += 11 * 60_000;
  const fresh = await oidc.tokenFor(PRIVATE, 'aws-dev');
  const jwks = await oidc.jwks();
  assert.equal(jwks.keys.length, 2);
  verify(old.token, jwks);
  verify(fresh.token, jwks);
  now += (TOKEN_TTL_SECONDS + 120) * 1000;
  assert.equal((await oidc.jwks()).keys.length, 1, 'the old key goes once its tokens have expired');
});

test('without a secret store the key is a file only the console reads', async (t) => {
  quiet(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oidc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, 'state', 'oidc-signing-key.pem');
  await createOidcIssuer({ issuer: ISSUER, connections: CONNECTIONS, keyFile }).jwks();
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
});

test('no token for a shared, ask, QA or review session, or a connection the console does not list', async (t) => {
  quiet(t);
  const oidc = createOidcIssuer({ issuer: ISSUER, connections: CONNECTIONS, secrets: memorySecrets() });
  for (const session of [{ id: 'b', owner: null }, { id: 'c', owner: 'octocat', kind: 'ask' }, { id: 'd', owner: 'octocat', qa: {} }, { id: 'e', owner: 'octocat', review: {} }]) {
    await assert.rejects(oidc.tokenFor(session, 'aws-dev'), (err) => err.shown && err.status === 403);
  }
  await assert.rejects(oidc.tokenFor(PRIVATE, 'gcp'), (err) => err.shown && err.status === 404);
  await assert.rejects(oidc.tokenFor(PRIVATE, { name: 'aws-dev' }), (err) => err.status === 404);
});

test('a key that cannot be saved is not used', async (t) => {
  quiet(t);
  const secrets = { read: async () => null, write: async () => { throw new Error('AccessDeniedException'); } };
  const oidc = createOidcIssuer({ issuer: ISSUER, connections: CONNECTIONS, secrets });
  await assert.rejects(oidc.tokenFor(PRIVATE, 'aws-dev'), (err) => err.shown && err.status === 503);
  await assert.rejects(oidc.jwks(), (err) => err.status === 503);
});
