// The console as an OpenID Connect issuer: it signs short-lived tokens that a service outside Woodshed trusts, so a
// session can be given access through the console without ever holding a credential that service takes. Today the one
// such service is woodshed-prod-mcp (mcpRelay.mjs): the console's MCP relay adds a token from here to each call it
// forwards. The service is told once to trust this issuer: it fetches the two public documents below, and trusts a
// token whose signature their key checks and whose `aud` is its own.
//
//   GET /.well-known/openid-configuration   the issuer and where its keys are, before sign-in (server.mjs)
//   GET /.well-known/jwks.json              the public half of the signing key, and the one before it after a change
//
// The signing key is RSA (RS256, which every OIDC library takes), kept in the `oidc-signing-key` secret, made by the
// console the first time it is needed. It never leaves the console. Only on while something signs with it: the console
// builds an issuer only when WOODSHED_PROD_MCP_URL is set.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const OIDC_KEY_SECRET = 'oidc-signing-key';
export const DISCOVERY_PATH = '/.well-known/openid-configuration';
export const JWKS_PATH = '/.well-known/jwks.json';
// The longest a token may last: the relay asks for less.
export const MAX_TOKEN_TTL_SECONDS = 15 * 60;
// How often the secret is read again, so a key replaced by hand reaches tokens and the JWKS without a restart.
const KEY_CHECK_MS = 10 * 60_000;
// Claims the issuer sets itself; a caller's own claims never replace them.
const OWN_CLAIMS = new Set(['iss', 'sub', 'aud', 'iat', 'nbf', 'exp', 'jti']);

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

/**
 * Checks a token against a JWKS as a relying party does: the tests' stand-in for woodshed-prod-mcp, and the proof's.
 * @param {string} token
 * @param {{keys: object[]}} jwks
 * @returns {{header: object, payload: object}|null}  null when no key in the set signed it
 */
export function verifyJwt(token, jwks) {
  const [h, p, s] = String(token).split('.');
  if (!h || !p || !s) return null;
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk || header.alg !== 'RS256') return null;
  const key = crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' });
  const ok = crypto.verify('sha256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'));
  return ok ? { header, payload: JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) } : null;
}

function keyPairOf(pem) {
  const privateKey = crypto.createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== 'rsa') throw new Error('the signing key is not an RSA key');
  return { pem, privateKey, jwk: jwkOf(crypto.createPublicKey(privateKey)) };
}

/**
 * @param {string} value  WOODSHED_OIDC_ISSUER, or the console's public URL
 * @returns {string}  the issuer as a relying party matches it: the bare origin and path, no trailing slash
 * @throws {Error}  for anything else, which no relying party would accept
 */
export function issuerFrom(value) {
  const issuer = String(value ?? '').replace(/\/+$/, '');
  let url;
  try {
    url = new URL(issuer);
  } catch {
    throw new Error(`WOODSHED_OIDC_ISSUER is not a URL: ${issuer.slice(0, 100)}`);
  }
  if (url.search || url.hash || !/^https?:$/.test(url.protocol)) throw new Error('WOODSHED_OIDC_ISSUER must be an http(s) URL with no query or fragment');
  return issuer;
}

/**
 * @param {{issuer: string, secrets?: {read: (name: string) => Promise<string|null>,
 *          write: (name: string, value: string) => Promise<void>, save?: Function}|null, keyFile?: string|null,
 *          now?: () => number}} opts
 *   `secrets` is the provider's secret store; without one the key is kept in `keyFile`, readable by the console alone
 */
export function createOidcIssuer({ issuer, secrets = null, keyFile = null, now = Date.now }) {
  if (!secrets && !keyFile) throw new Error('the OIDC issuer needs a secret store or a key file for its signing key');
  let current = null;
  let previous = null;
  let checkedAt = 0;
  let loading = null;
  // The longest-lived token signed with the current key, so a key replaced by hand stays in the JWKS while it is used.
  let longestTtl = MAX_TOKEN_TTL_SECONDS;

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
    // save makes the secret where Terraform did not (a local console's store); on AWS it is already there.
    if (secrets?.save) return secrets.save(OIDC_KEY_SECRET, pem, 'The console\'s OpenID Connect signing key, for the tokens its MCP relay adds. Only the console reads it');
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
        // Not kept, so not used: a key the next start could not read again would turn every relying party's trust off then.
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
    if (current) previous = { ...current, until: now() + (longestTtl + 60) * 1000 };
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
      claims_supported: ['iss', 'sub', 'aud', 'exp', 'iat', 'nbf', 'jti', 'login', 'session_id', 'session_kind', 'repo'],
    };
  }

  async function jwks() {
    await load();
    if (previous && previous.until < now()) previous = null;
    return { keys: [current.jwk, ...(previous ? [previous.jwk] : [])] };
  }

  /**
   * @param {{audience: string, subject: string, ttlSeconds: number, claims?: Record<string, unknown>}} args
   * @returns {Promise<{token: string, expiresAt: number}>}  expiresAt in ms
   */
  async function sign({ audience, subject, ttlSeconds, claims = {} }) {
    if (!audience || !subject) throw new Error('a token needs an audience and a subject');
    const ttl = Math.min(Math.max(30, Math.floor(ttlSeconds)), MAX_TOKEN_TTL_SECONDS);
    longestTtl = Math.max(longestTtl, ttl);
    await load();
    const iat = Math.floor(now() / 1000);
    const own = Object.fromEntries(Object.entries(claims).filter(([name]) => !OWN_CLAIMS.has(name)));
    // A relying party whose clock is a little behind the console's still takes it.
    const payload = { ...own, iss: issuer, sub: subject, aud: audience, iat, nbf: iat - 60, exp: iat + ttl, jti: crypto.randomUUID() };
    const token = signJwt({ header: { alg: 'RS256', typ: 'JWT', kid: current.jwk.kid }, payload, privateKey: current.privateKey });
    return { token, expiresAt: payload.exp * 1000 };
  }

  return { issuer, discovery, jwks, sign, load };
}
