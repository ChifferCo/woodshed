// Tests an MCP server from the Console settings page (server.mjs, POST /api/console-settings/mcp-servers/test): the
// console calls it as its relay would (mcpRelay.mjs), with the same auth, and says whether it answered as an MCP server.
//
//   initialize -> notifications/initialized -> tools/list (when the server says it has tools) -> DELETE of its session
//
// Streamable HTTP: each answer is JSON or an SSE stream, read until the message with the call's id, never past 1 MB.
// What comes back to the page is the status, the server's name and version, how many tools it has and how long it
// took; never a body, a header's value or a token, and none of them is logged. A test involves no session, so it
// taints nothing, and a production server is tested wherever the console runs.

import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

import { checkServer, linkLocalRefusal, mcpLookup } from './mcpServers.mjs';

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'woodshed-console', version: 'test' };
const TIMEOUT_MS = 10_000;
const DELETE_TIMEOUT_MS = 2_000;
const MAX_ANSWER_BYTES = 1024 * 1024;
const MAX_HEADER_BYTES = 8 * 1024;
const TOKEN_TTL_SECONDS = 60;
const TEXT_MAX = 100;

const shown = (message, status = 400) => Object.assign(new Error(message), { shown: true, status });
// A call that went wrong, with the sentence the page shows.
const failed = (status, error) => Object.assign(new Error(error), { failed: true, status });

const clip = (value, max = TEXT_MAX) => {
  // eslint-disable-next-line no-control-regex
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

function unreachable(host, err, timedOut) {
  if (timedOut) return `The console could not reach ${host}: it did not answer within ${TIMEOUT_MS / 1000} seconds.`;
  const code = err?.cause?.code ?? err?.code ?? '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `The console could not reach ${host}: no such host name was found.`;
  if (code === 'ECONNREFUSED') return `The console could not reach ${host}: nothing is listening on that port.`;
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return `The console could not reach ${host}: the connection was cut.`;
  if (/CERT|SSL|TLS|SELF_SIGNED/i.test(code)) return `The console could not reach ${host}: its TLS certificate was not accepted.`;
  return `The console could not reach ${host}.`;
}

function refusedSentence(host, status, server, issuer, unsigned = false) {
  if (server.auth === 'oidc' && unsigned) {
    return `${host} answered ${status} to a call with no token: the console signs one only for a saved server, at its saved address. Add it, then press Test on its row.`;
  }
  if (server.auth === 'oidc') {
    const at = issuer ? ` (${issuer}) and its keys at ${issuer}/.well-known/jwks.json` : '';
    return `${host} answered ${status}: it did not accept what the console added, a token for audience ${server.audience}. It must trust this console's issuer${at}, with that audience.`;
  }
  if (server.auth === 'header') return `${host} answered ${status}: it did not accept what the console added, the ${server.header} header. Check its value.`;
  return `${host} answered ${status}: it wants a sign-in, and the console adds nothing. Set its auth to oidc or header.`;
}

/**
 * fetch, over node's http(s) with the console's own lookup (mcpLookup), so the address the link-local check passed is
 * the one connected to: a name cannot resolve elsewhere between the check and the call. Redirects are never followed.
 * @returns {Promise<Response>}
 */
export function lookupFetch(url, { method = 'GET', headers = {}, body, signal } = {}) {
  const target = new URL(url);
  const transport = target.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = transport.request(target, { method, headers, lookup: mcpLookup, signal }, (res) => {
      const plain = {};
      for (const [name, value] of Object.entries(res.headers)) if (value !== undefined) plain[name] = Array.isArray(value) ? value.join(', ') : value;
      const empty = [101, 204, 205, 304].includes(res.statusCode) || method === 'HEAD';
      if (empty) res.resume();
      try {
        resolve(new Response(empty ? null : Readable.toWeb(res), { status: res.statusCode, headers: plain }));
      } catch (err) {
        res.destroy();
        reject(err);
      }
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Reads a body up to MAX_ANSWER_BYTES, handing each piece to `seen` until it returns something. */
async function readAnswer(response, seen) {
  if (!response.body) return seen('', true);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        bytes += value.byteLength;
        if (bytes > MAX_ANSWER_BYTES) return { tooLarge: true };
        text += decoder.decode(value, { stream: true });
      }
      const found = seen(text, done);
      if (found !== undefined || done) return found;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

const isMessage = (m, id) => m && typeof m === 'object' && m.jsonrpc === '2.0' && m.id === id && ('result' in m || 'error' in m);

/** The JSON-RPC answer with `id` in a JSON body, or in an SSE stream (each event's data lines, joined). */
function answerOf(id, sse) {
  return (text, done) => {
    if (!sse) {
      if (!done) return undefined;
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return null;
      }
      return (Array.isArray(parsed) ? parsed : [parsed]).find((m) => isMessage(m, id)) ?? null;
    }
    // Complete events only, unless the stream ended.
    const events = text.replace(/\r\n?/g, '\n').split('\n\n');
    if (!done) events.pop();
    for (const event of events) {
      const data = event.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
      if (!data) continue;
      try {
        const parsed = JSON.parse(data);
        if (isMessage(parsed, id)) return parsed;
      } catch { /* not JSON: the next event */ }
    }
    return done ? null : undefined;
  };
}

/**
 * @param {{servers: ReturnType<typeof import('./mcpServers.mjs').createMcpServers>,
 *          issuer?: {issuer?: string, sign: Function}|null, fetch?: typeof fetch, timeoutMs?: number, now?: () => number}} deps
 */
export function createMcpTester({ servers, issuer = null, fetch: fetchImpl = lookupFetch, timeoutMs = TIMEOUT_MS, now = Date.now, lookup = undefined }) {
  /** The server to test and its saved header value's source, from the page's body. */
  function serverOf({ name, server, value }) {
    if (value !== undefined && value !== null && typeof value !== 'string') throw shown('value must be a string');
    const typed = String(value ?? '').trim();
    if (Buffer.byteLength(typed) > MAX_HEADER_BYTES) throw shown(`a header value is at most ${MAX_HEADER_BYTES / 1024} KB`);
    if (/[\r\n]/.test(typed)) throw shown('a header value is one line');
    if (server !== undefined && server !== null) {
      const checked = checkServer(server);
      const saved = servers.get(checked.name);
      const sameOrigin = Boolean(saved) && new URL(saved.url).origin === new URL(checked.url).origin;
      // The saved value goes with the header's name, as save keeps it (mcpServers.mjs), and only to the saved address's
      // origin: a typed address never gets a value the admin cannot read back.
      const savedHeader = saved && sameOrigin && saved.source !== 'environment' && saved.auth === 'header' && saved.header === checked.header ? saved : null;
      // A token only for a saved server, to its saved address and audience: never one an admin could catch at an address
      // of their own and replay to a server that trusts this console.
      const signs = Boolean(saved) && saved.auth === 'oidc' && saved.url === checked.url && saved.audience === checked.audience;
      return { server: checked, typed, savedHeader, signs };
    }
    const wanted = String(name ?? '').trim().toLowerCase();
    if (!wanted) throw shown('send the server to test, or the name of a saved one');
    const saved = servers.get(wanted);
    if (!saved) throw shown(`there is no MCP server called ${wanted}`, 404);
    return { server: saved, typed, savedHeader: saved.auth === 'header' ? saved : null, signs: saved.auth === 'oidc' };
  }

  async function authOf({ server, typed, savedHeader, signs }, by) {
    if (server.auth === 'oidc' && !signs) return {};
    if (server.auth === 'oidc') {
      if (!issuer) throw failed(null, 'This console signs no tokens, so it cannot add what a server whose auth is oidc takes.');
      let made;
      try {
        made = await issuer.sign({ audience: server.audience, subject: 'console:test', ttlSeconds: TOKEN_TTL_SECONDS, claims: { test: true, by } });
      } catch (err) {
        console.warn('mcpServers: test token not signed', { name: server.name, message: err?.message });
        throw failed(null, err?.shown ? `The console could not sign a token: ${err.message}.` : 'The console could not sign a token; the console log says why.');
      }
      return { authorization: `Bearer ${made.token}` };
    }
    if (server.auth === 'header') {
      let headerValue = typed;
      if (!headerValue && savedHeader) {
        try {
          headerValue = String((await servers.headerValue(savedHeader)) ?? '').trim();
        } catch (err) {
          console.warn('mcpServers: saved header not read for a test', { name: server.name, message: err?.message });
          throw failed(null, 'The console could not read the saved header value; the console log says why.');
        }
      }
      if (!headerValue) throw failed(null, `${server.name}'s ${server.header} header has no value yet: type one to test with, or save one.`);
      return { [server.header]: headerValue };
    }
    return {};
  }

  /**
   * Tests a server.
   * @param {{name?: string, server?: object, value?: string, by: string}} args
   *   `server` an unsaved or edited one, in the shape save takes; or `name` a saved one, the environment's included.
   *   `value` the header value to use instead of the saved one
   * @returns {Promise<{ok: true, status: number, serverInfo: {name: string, version: string}|null, tools: number|null, ms: number}
   *   |{ok: false, status: number|null, error: string}>}
   * @throws {Error}  shown, 400 for a server that does not check, 404 for an unknown name
   */
  async function run({ name, server: input, value, by }) {
    const picked = serverOf({ name, server: input, value });
    const { server } = picked;
    const target = new URL(server.url);
    const host = target.host;
    // Never the instance's metadata, or anything else link-local, whatever the name resolves to.
    const linkLocal = await linkLocalRefusal(target.hostname, lookup);
    if (linkLocal) {
      console.log('mcpServers: server tested', { name: server.name, host, ok: false, status: null, by });
      return { ok: false, status: null, error: `The console will not call ${host}: ${linkLocal}.` };
    }
    const started = now();
    const abort = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; abort.abort(); }, timeoutMs);
    let sessionId = null;
    let protocol = null;
    let lastStatus = null;

    async function call(body, { method = 'POST', signal = abort.signal } = {}) {
      const headers = { accept: 'application/json, text/event-stream', ...added };
      if (method === 'POST') headers['content-type'] = 'application/json';
      if (sessionId) headers['mcp-session-id'] = sessionId;
      if (protocol) headers['mcp-protocol-version'] = protocol;
      try {
        return await fetchImpl(target.toString(), { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual', signal });
      } catch (err) {
        throw failed(null, unreachable(host, err, timedOut));
      }
    }

    /** Sends a request and reads its JSON-RPC answer's result. */
    async function request(id, method, params) {
      const response = await call({ jsonrpc: '2.0', id, method, params });
      lastStatus = response.status;
      const status = response.status;
      const drop = () => response.body?.cancel().catch(() => {});
      if (status === 401 || status === 403) { drop(); throw failed(status, refusedSentence(host, status, server, issuer?.issuer ?? servers.settings?.issuer ?? null, server.auth === 'oidc' && !picked.signs)); }
      if (status === 404 || status === 405) { drop(); throw failed(status, `${host} answered ${status}: there is no MCP endpoint at that path. Is it the server's Streamable HTTP URL, which often ends in /mcp?`); }
      if (status >= 300 && status < 400) { drop(); throw failed(status, `${host} answered ${status}, sending the console elsewhere: use the URL it sends to.`); }
      if (status < 200 || status >= 300) { drop(); throw failed(status, `${host} answered ${status} to the console's ${method} call.`); }
      const type = String(response.headers.get('content-type') ?? '').toLowerCase();
      const sse = type.includes('text/event-stream');
      if (!sse && !type.includes('json')) { drop(); throw failed(status, `${host} answered, but not as an MCP server: use its Streamable HTTP URL.`); }
      if (method === 'initialize') sessionId = response.headers.get('mcp-session-id') || null;
      let message;
      try {
        message = await readAnswer(response, answerOf(id, sse));
      } catch (err) {
        throw failed(status, timedOut ? unreachable(host, err, true) : `${host}'s answer was cut off.`);
      }
      if (message?.tooLarge) throw failed(status, `${host} answered with more than 1 MB, which is not an MCP server's answer.`);
      if (!message) throw failed(status, `${host} answered, but not as an MCP server: use its Streamable HTTP URL.`);
      if (message.error) {
        const text = clip(message.error?.message ?? 'no message', 200);
        throw failed(status, `${host} refused the console's ${method} call: ${text}${/[.!?]$/.test(text) ? '' : '.'}`);
      }
      if (!message.result || typeof message.result !== 'object') throw failed(status, `${host} answered, but not as an MCP server: use its Streamable HTTP URL.`);
      return message.result;
    }

    let added = {};
    let result;
    try {
      added = await authOf(picked, by);
      const init = await request(1, 'initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO });
      const initStatus = lastStatus;
      protocol = typeof init.protocolVersion === 'string' && /^[\w.-]{1,40}$/.test(init.protocolVersion) ? init.protocolVersion : PROTOCOL_VERSION;
      const info = init.serverInfo && typeof init.serverInfo === 'object' ? { name: clip(init.serverInfo.name), version: clip(init.serverInfo.version) } : null;
      // The handshake ends with this notification, which a server must accept (202, or any 2xx) for a session to work.
      const sent = await call({ jsonrpc: '2.0', method: 'notifications/initialized' });
      sent.body?.cancel().catch(() => {});
      lastStatus = sent.status;
      if (sent.status === 401 || sent.status === 403) {
        throw failed(sent.status, refusedSentence(host, sent.status, server, issuer?.issuer ?? servers.settings?.issuer ?? null, server.auth === 'oidc' && !picked.signs));
      }
      if (sent.status < 200 || sent.status >= 300) throw failed(sent.status, `${host} answered ${sent.status} to the console's notifications/initialized, which ends the MCP handshake.`);
      let tools = null;
      if (init.capabilities?.tools) {
        const listed = await request(2, 'tools/list', {});
        tools = Array.isArray(listed.tools) ? listed.tools.length : null;
      }
      result = { ok: true, status: initStatus, serverInfo: info, tools, ms: now() - started };
    } catch (err) {
      if (!err?.failed) {
        console.warn('mcpServers: test failed', { name: server.name, host, message: err?.message });
        result = { ok: false, status: lastStatus, error: `The test of ${server.name} failed; the console log says why.` };
      } else {
        result = { ok: false, status: err.status ?? null, error: err.message };
      }
    } finally {
      clearTimeout(timer);
    }
    if (sessionId) {
      // The server's session for the test ends with it; a server that keeps it anyway is no failure.
      const signal = AbortSignal.timeout(DELETE_TIMEOUT_MS);
      await call(null, { method: 'DELETE', signal }).then((r) => r.body?.cancel().catch(() => {}), () => {});
    }
    console.log('mcpServers: server tested', { name: server.name, host, ok: result.ok, status: result.status, by });
    return result;
  }

  return { run };
}

