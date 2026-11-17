// The owner's full Claude login in a private session, kept by the console between their sessions
// (console/claudeLogin.mjs): taken by woodshed-login for /woodshed:remote-control, sent back by statusd each time claude
// refreshes it, and released at the stop. Anthropic rotates the refresh token at each refresh, so the console lets one
// session hold it at a time, by the generation its take gave.
//
//   node claudeLogin.mjs take    the saved login into ~/.claude/.credentials.json; prints `given`, `held <session id>`,
//                                `none` or `unavailable` (no console, or one from before these routes)
//   node claudeLogin.mjs store   the login just signed in here, sent as a fresh one; prints `stored` or `not-stored`
//
// The lease file (in /tmp, never in the Claude home) holds the generation, the expiry and a hash of the refresh token
// last sent, so statusd sends back only a login that changed. Nothing here prints or logs a token.

import { scryptSync } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isMain } from '../shared/isMain.mjs';

export const LEASE_FILE = process.env.WOODSHED_CLAUDE_LOGIN_LEASE || '/tmp/woodshed-claude-login.json';
const CALL_TIMEOUT_MS = 10_000;

export function credentialsFile(home = os.homedir()) {
  return path.join(home, '.claude', '.credentials.json');
}

// A fixed salt: the hash only tells one refresh token from the next, in a file this user alone reads.
const FINGERPRINT_SALT = 'woodshed-claude-login';

/** @returns {{refreshHash: string, expiresAt: number}}  what says a login changed, with no token in it */
export function fingerprint(oauth) {
  const refreshHash = scryptSync(String(oauth?.refreshToken ?? ''), FINGERPRINT_SALT, 16).toString('hex');
  return { refreshHash, expiresAt: Number(oauth?.expiresAt) || 0 };
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' || err instanceof SyntaxError) return null;
    throw err;
  }
}

/** @returns {Promise<object|null>}  the claudeAiOauth claude keeps in the file, or null */
export async function readLogin(file = credentialsFile()) {
  const oauth = (await readJson(file))?.claudeAiOauth;
  return oauth && typeof oauth === 'object' ? oauth : null;
}

// Mode 600 from the start, renamed into place, so claude never reads half a file and nobody else reads any of it.
async function writePrivate(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, text, { mode: 0o600 });
  await fs.rename(tmp, file);
}

/** The login into the file, beside the MCP logins it already holds. */
export async function writeLogin(oauth, file = credentialsFile()) {
  const current = (await readJson(file)) ?? {};
  await writePrivate(file, `${JSON.stringify({ ...current, claudeAiOauth: oauth })}\n`);
}

export async function readLease(file = LEASE_FILE) {
  const lease = await readJson(file);
  return Number.isInteger(lease?.generation) ? lease : null;
}

export async function writeLease(lease, file = LEASE_FILE) {
  await writePrivate(file, JSON.stringify(lease));
}

/**
 * One call to the console's session API, the session token in its header.
 * @returns {Promise<{status: number, body: object|null}>}  status 0 when the console did not answer
 */
export async function callConsole(route, body, { consoleUrl = process.env.WOODSHED_CONSOLE_URL, token = process.env.SESSION_TOKEN, fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(`${consoleUrl}${route}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {}
    return { status: res.status, body: parsed };
  } catch (err) {
    if (err?.name !== 'TimeoutError' && err?.name !== 'TypeError' && err?.name !== 'AbortError') throw err;
    return { status: 0, body: null };
  }
}

/**
 * @returns {Promise<{status: 'given'}|{status: 'held', heldBy: string}|{status: 'none'}|{status: 'unavailable', code: number}>}
 */
export async function take({ file = credentialsFile(), leaseFile = LEASE_FILE, call = callConsole } = {}) {
  const { status, body } = await call('/claude-login/take');
  if (status !== 200 || !body?.status) return { status: 'unavailable', code: status };
  if (body.status === 'held') return { status: 'held', heldBy: String(body.heldBy ?? '').replace(/[^0-9a-z-]/gi, '') };
  if (body.status !== 'given' || !body.claudeAiOauth || !Number.isInteger(body.generation)) return { status: 'none' };
  await writeLogin(body.claudeAiOauth, file);
  await writeLease({ generation: body.generation, ...fingerprint(body.claudeAiOauth) }, leaseFile);
  return { status: 'given' };
}

/** A login made here by `claude auth login`: the console keeps it and gives this session the lease. */
export async function storeFresh({ file = credentialsFile(), leaseFile = LEASE_FILE, call = callConsole } = {}) {
  const oauth = await readLogin(file);
  if (!oauth) return { stored: false, code: null };
  const { status, body } = await call('/claude-login', { fresh: true, claudeAiOauth: oauth });
  if (status !== 200 || !Number.isInteger(body?.generation)) return { stored: false, code: status };
  await writeLease({ generation: body.generation, ...fingerprint(oauth) }, leaseFile);
  return { stored: true, generation: body.generation };
}

/**
 * statusd's: sends the login back once claude refreshed it (a new refresh token or expiry). A refusal means another
 * session holds the lease now, or the login was forgotten: this session keeps its copy and stops sending.
 * @returns {Promise<'no-lease'|'no-login'|'unchanged'|'sent'|'refused'|'failed'>}
 */
export async function sendBackIfChanged({ file = credentialsFile(), leaseFile = LEASE_FILE, call = callConsole } = {}) {
  const lease = await readLease(leaseFile);
  if (!lease) return 'no-lease';
  const oauth = await readLogin(file);
  if (!oauth) return 'no-login';
  const now = fingerprint(oauth);
  if (now.refreshHash === lease.refreshHash && now.expiresAt === lease.expiresAt) return 'unchanged';
  const { status } = await call('/claude-login', { generation: lease.generation, claudeAiOauth: oauth });
  if (status === 200) {
    await writeLease({ ...lease, ...now }, leaseFile);
    return 'sent';
  }
  if (status === 409 || status === 404) {
    await fs.rm(leaseFile, { force: true });
    return 'refused';
  }
  return 'failed';
}

/** At the stop, after the last send: the next session may take it. */
export async function release({ leaseFile = LEASE_FILE, call = callConsole } = {}) {
  const lease = await readLease(leaseFile);
  if (!lease) return 'no-lease';
  const { status, body } = await call('/claude-login/release', { generation: lease.generation });
  if (status !== 200) return 'failed';
  await fs.rm(leaseFile, { force: true });
  return body?.released ? 'released' : 'not-held';
}

if (isMain(import.meta.url)) {
  const command = process.argv[2];
  if (!process.env.WOODSHED_CONSOLE_URL || !process.env.SESSION_TOKEN) {
    console.log(command === 'store' ? 'not-stored' : 'unavailable');
  } else if (command === 'take') {
    const taken = await take();
    console.log(taken.status === 'held' ? `held ${taken.heldBy}` : taken.status);
  } else if (command === 'store') {
    console.log((await storeFresh()).stored ? 'stored' : 'not-stored');
  } else {
    console.error('usage: node claudeLogin.mjs take | store');
    process.exit(2);
  }
}
