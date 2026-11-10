// Your own databases from your own computer. public/woodshed-db.mjs listens on localhost and turns each connection
// your database tool makes into one request here; the console answers 101 and then copies bytes both ways.
//
//   GET      /api/tunnel/connection          your user, password and database name, for the script to print
//   UPGRADE  /api/tunnel/pg, /api/tunnel/mongo   `Upgrade: woodshed-tunnel`: a raw pipe to RDS, or to the box's Mongo
//
// A program on a laptop has no sign-in cookie, so both take a token from My settings instead, as
// `Authorization: Bearer wt_...`. It lasts 12 hours, the console keeps only its SHA-256, and making another one or
// Revoke ends it, along with every tunnel it opened: a database tool can hold a connection open for days. The client never names a host: each path goes to one fixed address, so this is no way into the VPC
// at large, and the database still asks for the person's own password.

import crypto from 'node:crypto';
import net from 'node:net';
import logins from './public/logins.cjs';
const { loginKey } = logins;

const TOKEN_TTL_MS = 12 * 3_600_000;
const PROTOCOL = 'woodshed-tunnel';
const TUNNEL_RE = /^\/api\/tunnel\/(pg|mongo)$/;
const BEARER_RE = /^Bearer (wt_[0-9a-f]{64})$/;
export const CONNECTION_PATH = '/api/tunnel/connection';
const DATABASE_NAMES = { pg: 'Postgres', mongo: 'Mongo' };
// Each tunnel path's database.
const DATABASE_KINDS = { pg: 'postgres', mongo: 'mongo' };

function sha256(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function shown(message) {
  return Object.assign(new Error(message), { shown: true });
}

/**
 * The tunnel's addresses for the databases the installation runs alone: an address for any other is dropped.
 * @param {{pg: string|null, mongo: string|null}} targets  WOODSHED_CLOUD_TUNNEL_*
 * @param {string[]} kinds  `postgres`, `mongo`
 * @returns {{pg: string|null, mongo: string|null}}
 */
export function tunnelTargetsFor(targets, kinds) {
  return { pg: kinds.includes('postgres') ? targets.pg ?? null : null, mongo: kinds.includes('mongo') ? targets.mongo ?? null : null };
}

/** @returns {{host: string, port: number}|null}  from `host:port` */
export function parseTarget(value) {
  const match = /^(.+):(\d{1,5})$/.exec(String(value || ''));
  return match ? { host: match[1], port: Number(match[2]) } : null;
}

function refuse(socket, status, text, message) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(message)}\r\n`
    + `connection: close\r\n\r\n${message}`);
}

/**
 * @param {{store: {state: object, save: () => void},
 *          targets: {pg: string|null, mongo: string|null},
 *          databases: ReturnType<import('./databases.mjs').createDatabases>|null, now?: () => number,
 *          allowed?: (login: string) => boolean}} deps
 *   `targets` are `host:port`, as the console reaches them; each database with one has a tunnel, and without own
 *   databases there is none. `allowed` says whether a login may still use the console (on the People list); a token
 *   whose person was taken off it stops working at once, not when it expires
 */
export function createTunnel({ store, targets, databases, now = Date.now, allowed = () => true }) {
  const addresses = { pg: parseTarget(targets.pg), mongo: parseTarget(targets.mongo) };
  // The databases the tunnel reaches, named as databases.mjs names them; its paths are /pg and /mongo.
  const kinds = databases?.available ? Object.entries(DATABASE_KINDS).filter(([path]) => addresses[path]).map(([, kind]) => kind) : [];
  const available = kinds.length > 0;
  // Each person's open tunnels, as the sockets to close when their token ends.
  const open = new Map();

  function all() {
    store.state.tunnelTokens ??= {};
    return store.state.tunnelTokens;
  }

  function live(record) {
    return record && Date.parse(record.expiresAt) > now() ? record : null;
  }

  /** @returns {{available: boolean, kinds: string[], expiresAt: string|null}}  never the token: only its hash is kept */
  function view(login) {
    return { available, kinds, expiresAt: live(all()[loginKey(login)])?.expiresAt ?? null };
  }

  /** A new token, shown this once; the person's earlier one stops working. */
  function issue(login) {
    if (!available) throw shown('this console has no tunnel to your databases');
    if (databases.view(login).status !== 'ready') throw shown('your databases are not ready yet');
    const key = loginKey(login);
    closeAll(key, 'a new token');
    const token = `wt_${crypto.randomBytes(32).toString('hex')}`;
    const expiresAt = new Date(now() + TOKEN_TTL_MS).toISOString();
    all()[key] = { hash: sha256(token), createdAt: new Date(now()).toISOString(), expiresAt };
    store.save();
    console.log('tunnel: token made', { login, expiresAt });
    return { token, expiresAt };
  }

  function revoke(login) {
    const key = loginKey(login);
    if (!all()[key]) return;
    delete all()[key];
    store.save();
    console.log('tunnel: token revoked', { login });
    closeAll(key, 'revoked');
  }

  function closeAll(login, reason) {
    const sockets = open.get(login);
    if (!sockets?.size) return;
    console.log('tunnel: closing open tunnels', { login, reason, count: sockets.size });
    for (const socket of sockets) socket.destroy();
  }

  /** @returns {string|null}  whose token the request carries, while it lasts */
  function loginFor(headers) {
    const token = BEARER_RE.exec(String(headers.authorization || ''))?.[1];
    if (!token) return null;
    const hash = sha256(token);
    const found = Object.entries(all()).find(([, record]) => record.hash === hash);
    if (!found || !live(found[1])) return null;
    if (!allowed(found[0])) {
      console.warn('tunnel: refused, the token\'s person is no longer a member', { login: found[0] });
      return null;
    }
    return found[0];
  }

  async function connection(req, res) {
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (!available) return send(404, { error: 'this console has no tunnel to your databases' });
    const login = loginFor(req.headers);
    if (!login) return send(401, { error: 'the token is wrong or has expired: make a new one on My settings' });
    const credentials = await databases.credentials(login);
    if (!credentials) return send(409, { error: 'your databases are not ready: My settings shows why' });
    console.log('tunnel: connection details handed out', { login });
    return send(200, { login, user: credentials.user, password: credentials.password, database: credentials.name, kinds });
  }

  /** @returns {boolean}  false when the path is not the tunnel's */
  function handleUpgrade(req, socket, head) {
    // The raw path, not new URL(): a path like //a:99999 makes it throw, and nothing above this catches.
    const kind = TUNNEL_RE.exec(String(req.url || '/').split('?')[0])?.[1];
    if (!kind) return false;
    const login = available ? loginFor(req.headers) : null;
    if (!available) refuse(socket, 404, 'Not Found', 'this console has no tunnel to your databases\n');
    else if (!addresses[kind]) refuse(socket, 404, 'Not Found', `this installation runs no ${DATABASE_NAMES[kind]}\n`);
    else if (String(req.headers.upgrade).toLowerCase() !== PROTOCOL) refuse(socket, 400, 'Bad Request', `upgrade to ${PROTOCOL}\n`);
    else if (!login) {
      console.warn('tunnel: refused, no valid token', { database: kind });
      refuse(socket, 401, 'Unauthorized', 'the token is wrong or has expired: make a new one on My settings\n');
    } else if (databases.view(login).status !== 'ready') refuse(socket, 409, 'Conflict', 'your databases are not ready: My settings shows why\n');
    else pipe({ login, kind, socket, head, expiresAt: all()[login].expiresAt });
    return true;
  }

  function pipe({ login, kind, socket, head, expiresAt }) {
    const { host, port } = addresses[kind];
    const openedAt = now();
    let connected = false;
    if (!open.has(login)) open.set(login, new Set());
    open.get(login).add(socket);
    const expiry = setTimeout(() => socket.destroy(), Date.parse(expiresAt) - now());
    const upstream = net.connect(port, host, () => {
      connected = true;
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\nupgrade: ${PROTOCOL}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
      console.log('tunnel: opened', { login, database: kind });
    });
    upstream.on('error', (err) => {
      if (connected) return socket.destroy();
      console.warn('tunnel: database unreachable', { login, database: kind, message: err.message });
      refuse(socket, 502, 'Bad Gateway', `${DATABASE_NAMES[kind]} did not answer the console\n`);
    });
    upstream.on('close', () => {
      socket.destroy();
      if (!connected) return;
      console.log('tunnel: closed', {
        login, database: kind, seconds: Math.round((now() - openedAt) / 1000), sent: upstream.bytesWritten, received: upstream.bytesRead,
      });
    });
    socket.on('close', () => {
      clearTimeout(expiry);
      open.get(login)?.delete(socket);
      upstream.destroy();
    });
    socket.on('error', () => upstream.destroy());
  }

  return { available, kinds, view, issue, revoke, connection, handleUpgrade };
}
