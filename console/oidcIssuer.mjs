// The console as an OpenID Connect issuer, so a private session can sign in to a cloud as its owner with no key of its
// own (shared/oidcConnections.mjs lists the clouds). Each cloud is told once to trust this issuer: it fetches the two
// public documents below, and trusts a token whose signature their key checks and whose `sub` and `aud` its own policy
// names. Only on when WOODSHED_OIDC_CONNECTIONS lists a connection.
//
//   GET /.well-known/openid-configuration   the issuer and where its keys are, before sign-in (server.mjs)
//   GET /.well-known/jwks.json              the public half of the signing key, and the one before it after a change
//   POST /cloud-token on the session API    {"connection": "<name>"} -> {"token", "expiresAt"} (sessionApi.mjs)
//
// The signing key is RSA (RS256, which AWS, Azure, GCP and Vault all take), kept in the `oidc-signing-key` secret,
// made by the console the first time it is needed. It never leaves the console. A token lasts TOKEN_TTL_SECONDS; a
// session asks for a new one every few minutes (session/cloudSignIn.mjs).

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { subjectFor } from '../shared/oidcConnections.mjs';

export const OIDC_KEY_SECRET = 'oidc-signing-key';
export const DISCOVERY_PATH = '/.well-known/openid-configuration';
export const JWKS_PATH = '/.well-known/jwks.json';
export const TOKEN_TTL_SECONDS = 15 * 60;
// How often the secret is read again, so a key replaced by hand reaches tokens and the JWKS without a restart.
const KEY_CHECK_MS = 10 * 60_000;

function shown(message, status) {
  return Object.assign(new Error(message), { shown: true, status });
}

/**
 * @param {crypto.KeyObject} publicKey
 * @returns {{kty: 'RSA', n: string, e: string, kid: string, alg: 'RS256', use: 'sig'}}  `kid` is the key's RFC 7638
 *   thumbprint, so the same key always has the same id
 */
export function jwkOf(publicKey) {
  const { n, e } = publicKey.export({ format: 'jwk' });
  const kid = crypto.createHash('sha256').update(JSON.stringify({ e, kty: 'RSA', n })).digest('base64url');
  return { kty: 'RSA', n, e, kid, alg: 'RS256', use: 'sig' };
}

/**
 * @param {{header: object, payload: object, privateKey: crypto.KeyObject}} args
 * @returns {string}  a compact JWS
 */
export function signJwt({ header, payload, privateKey }) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const data = `${part(header)}.${part(payload)}`;
  return `${data}.${crypto.sign('sha256', Buffer.from(data), privateKey).toString('base64url')}`;
}

function keyPairOf(pem) {
  const privateKey = crypto.createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== 'rsa') throw new Error('the signing key is not an RSA key');
  return { pem, privateKey, jwk: jwkOf(crypto.createPublicKey(privateKey)) };
}

/**
 * @param {{issuer: string, connections: object[], secrets?: {read: (name: string) => Promise<string|null>,
 *          write: (name: string, value: string) => Promise<void>, save?: Function}|null, keyFile?: string|null,
 *          now?: () => number}} opts
 *   `secrets` is the provider's secret store; without one the key is kept in `keyFile`, readable by the console alone
 */
export function createOidcIssuer({ issuer, connections, secrets = null, keyFile = null, now = Date.now }) {
  if (!secrets && !keyFile) throw new Error('the OIDC issuer needs a secret store or a key file for its signing key');
  const byName = new Map(connections.map((c) => [c.name, c]));
  let current = null;
  let previous = null;
  let checkedAt = 0;
  let loading = null;

  async function readStored() {
    if (secrets) return secrets.read(OIDC_KEY_SECRET);
    try {
      return await fs.readFile(keyFile, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async function writeStored(pem) {
    // save makes the secret where Terraform did not (a local console on Secrets Manager); on AWS it is already there.
    if (secrets?.save) return secrets.save(OIDC_KEY_SECRET, pem, 'The console\'s OpenID Connect signing key, for private sessions\' cloud sign-in. Only the console reads it');
    if (secrets) return secrets.write(OIDC_KEY_SECRET, pem);
    await fs.mkdir(path.dirname(keyFile), { recursive: true, mode: 0o700 });
    await fs.writeFile(keyFile, pem, { mode: 0o600 });
  }

  async function loadOnce() {
    let pem;
    try {
      pem = (await readStored())?.trim() || null;
    } catch (err) {
      console.warn('oidcIssuer: signing key not read', { message: String(err?.message ?? err).split('\n')[0] });
      if (current) return;
      throw shown('the console could not read its signing key', 503);
    }
    if (!pem) {
      const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      // Trimmed as a read trims it, so the next read is not taken for a new key.
      pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).trim();
      try {
        await writeStored(pem);
      } catch (err) {
        // Not kept, so not used: a key the next start could not read again would turn every cloud's trust off then.
        console.warn('oidcIssuer: signing key not saved', { message: String(err?.message ?? err).split('\n')[0] });
        throw shown('the console could not save its signing key', 503);
      }
      console.log('oidcIssuer: signing key made', { kid: jwkOf(crypto.createPublicKey(privateKey)).kid });
    }
    if (current?.pem === pem) return;
    let pair;
    try {
      pair = keyPairOf(pem);
    } catch (err) {
      console.warn('oidcIssuer: signing key refused', { message: err.message });
      if (current) return;
      throw shown('the console\'s signing key is not an RSA private key', 503);
    }
    // The key before stays in the JWKS while tokens it signed can still be in use, so a change breaks nothing.
    if (current) previous = { ...current, until: now() + (TOKEN_TTL_SECONDS + 60) * 1000 };
    current = pair;
    console.log('oidcIssuer: signing key read', { kid: current.jwk.kid, replaced: Boolean(previous) });
  }

  async function load() {
    if (current && now() - checkedAt < KEY_CHECK_MS) return;
    loading ??= loadOnce().then(() => { checkedAt = now(); }).finally(() => { loading = null; });
    await loading;
  }

  function discovery() {
    return {
      issuer,
      jwks_uri: `${issuer}${JWKS_PATH}`,
      response_types_supported: ['id_token'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      scopes_supported: ['openid'],
      claims_supported: ['iss', 'sub', 'aud', 'exp', 'iat', 'nbf', 'jti', 'login', 'session_id', 'session_kind', 'repo', 'branch', 'connection'],
    };
  }

  async function jwks() {
    await load();
    if (previous && previous.until < now()) previous = null;
    return { keys: [current.jwk, ...(previous ? [previous.jwk] : [])] };
  }

  /**
   * @param {object} session  an active session the session API found by its token
   * @param {unknown} name  the connection asked for
   * @returns {Promise<{token: string, expiresAt: number, subject: string, audience: string}>}
   * @throws {Error}  `shown`, with the `status` to answer, for a session or connection that gets none
   */
  async function tokenFor(session, name) {
    const connection = typeof name === 'string' ? byName.get(name) : null;
    if (!connection) throw shown(`this console has no connection called ${String(name).slice(0, 40)}`, 404);
    const subject = subjectFor(session);
    if (!subject || session.kind === 'ask' || session.qa || session.review) {
      throw shown('only a My Woodshed session signs in to a cloud, as its owner', 403);
    }
    await load();
    const iat = Math.floor(now() / 1000);
    const payload = {
      iss: issuer,
      sub: subject,
      aud: connection.audience,
      iat,
      // A cloud whose clock is a little behind the console's still takes it.
      nbf: iat - 60,
      exp: iat + TOKEN_TTL_SECONDS,
      jti: crypto.randomUUID(),
      login: session.owner.toLowerCase(),
      session_id: session.id,
      session_kind: 'private',
      repo: session.repo ?? null,
      branch: session.branch ?? null,
      connection: connection.name,
    };
    const token = signJwt({ header: { alg: 'RS256', typ: 'JWT', kid: current.jwk.kid }, payload, privateKey: current.privateKey });
    return { token, expiresAt: payload.exp * 1000, subject, audience: connection.audience };
  }

  /** What a private session is told at start (/settings): where to sign in, never a credential. */
  function sessionConnections() {
    return connections.map((c) => ({ ...c }));
  }

  return { issuer, discovery, jwks, tokenFor, sessionConnections, load };
}
