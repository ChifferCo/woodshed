#!/usr/bin/env node
// Proves a tainted session's lockdown in the real session image, on this machine's Docker (console/mcpRelay.mjs). The
// console's own pieces run here: the fleet with the docker launcher, the session API with its Anthropic proxy and MCP
// relay, the OIDC issuer and the egress proxy. woodshed-prod-mcp is a stand-in on 127.0.0.1 that checks each token
// against the issuer's keys, and stands in for an ordinary server (docs) too. A private session starts as usual with
// both, a call to docs goes on with no taint, a call to woodshed-prod from inside it taints it, and then
// every check runs inside the session, from a shell as its agent would run one. It prints each command and what came
// back, then stops the session, resumes it to show it starts locked down, stops it again and checks nothing is left.
//
//   node woodshed/providers/local/bin/taintInImage.mjs <image> --console-address <address sessions reach this at>
//                                                    [--reach-host <address this reaches published ports on>]
//
// Needs Docker, the image (a session image with this checkout's session/ and shared/ in it), `gh auth token` for
// the session's GitHub token, and a Claude token for the session's owner in WOODSHED_CLAUDE_TOKEN_FILE (claude in the
// session runs on it through the Anthropic proxy here, as a tainted session does). WOODSHED_PROOF_PRIVATE_REPO names
// one repo the egress proxy treats as private whatever GitHub says, for a push through it when the only repo the token
// reaches is public; say so wherever the output is shown. The push goes to WOODSHED_PROOF_BRANCH, which this deletes.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, spawnSync } from 'node:child_process';

import { createAnthropicProxy } from '../../../console/anthropicProxy.mjs';
import { createEgressCerts } from '../../../console/egressCerts.mjs';
import { anonymousVisibility, createEgressProxy } from '../../../console/egressProxy.mjs';
import { createFleet } from '../../../console/fleet.mjs';
import { GITHUB_HOSTS } from '../../../console/githubEgress.mjs';
import { createOidcIssuer, verifyJwt } from '../../../console/oidcIssuer.mjs';
import { createMcpRelay } from '../../../console/mcpRelay.mjs';
import { checkServer, createMcpServers, mcpSettings } from '../../../console/mcpServers.mjs';
import { createSessionApi } from '../../../console/sessionApi.mjs';
import { createDockerLauncher, gatewayName, lockedNetworkName } from '../dockerLauncher.mjs';

const args = process.argv.slice(2);
const IMAGE = args[0];
const ADDRESS = args[args.indexOf('--console-address') + 1];
// Where this console reaches the sessions' published ports: the machine's loopback, unless this runs in a container,
// which reaches them on the docker bridge's own address instead (172.17.0.1), never the machine's outside ones.
const REACH = args.includes('--reach-host') ? args[args.indexOf('--reach-host') + 1] : null;
if (!IMAGE || !args.includes('--console-address') || !ADDRESS) {
  console.error('usage: taintInImage.mjs <image> --console-address <address sessions reach this machine at>');
  process.exit(2);
}
const API_PORT = 47691;
const EGRESS_PORT = 47693;
const MCP_PORT = 47913;
const OWNER = 'taint-proof';
const REPO = process.env.WOODSHED_PROOF_REPO || 'ChifferCo/woodshed';
const BRANCH = process.env.WOODSHED_PROOF_BRANCH || 'woodshed/taint-proof';
const PRIVATE_STUB = (process.env.WOODSHED_PROOF_PRIVATE_REPO || '').toLowerCase();
const CONSOLE_NAME = 'woodshed-console';

const say = (...line) => console.log(`\n### ${line.join(' ')}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quietLog = console.log.bind(console);

const claudeToken = fs.readFileSync(process.env.WOODSHED_CLAUDE_TOKEN_FILE ?? '', 'utf8').trim();
const ghToken = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taint-proof-'));

// woodshed-prod-mcp, as far as the relay sees it: it checks each token against the issuer's keys, as auth.oidc does.
// It answers as the ordinary docs server too, for a token whose audience is docs.
const AUDIENCES = new Set(['woodshed-prod-mcp', 'docs']);
const mcpCalls = [];
function startMcp(issuer) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
      const checked = verifyJwt(token, await issuer.jwks());
      const msg = body ? JSON.parse(body) : {};
      mcpCalls.push({ method: msg.method ?? req.method, claims: checked?.payload ?? null });
      if (!checked || !AUDIENCES.has(checked.payload.aud)) return res.writeHead(401).end();
      if (req.method !== 'POST') return res.writeHead(405).end();
      if (msg.id === undefined) return res.writeHead(202).end();
      const result = msg.method === 'initialize'
        ? { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'prod-mcp-stand-in', version: '0' } }
        : msg.method === 'tools/list' ? { tools: [{ name: 'orders_lookup', description: 'Look an order up (masked)', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } }] }
          : msg.method === 'tools/call' ? { content: [{ type: 'text', text: 'order 42: status=shipped, email=j***@e***.com (masked)' }] } : {};
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'proof-1' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
  return new Promise((resolve) => server.listen(MCP_PORT, '127.0.0.1', () => resolve(server)));
}

// Never synchronous: the console answering the session is this same process.
function inSession(session, script) {
  return new Promise((resolve) => {
    execFile('docker', ['exec', '-u', 'node', '-w', '/work/woodshed', `woodshed-${session.id}`, 'bash', '-lc', script], { encoding: 'utf8', timeout: 240_000 }, (err, stdout, stderr) => {
      resolve(`${stdout ?? ''}${stderr ?? ''}`.trim());
    });
  });
}

async function check(session, title, command) {
  const output = await inSession(session, `${command} 2>&1; echo "[exit $?]"`);
  console.log(`\n$ ${command}\n${output.split('\n').slice(-12).join('\n')}`);
  return output;
}

async function waitFor(what, fn, ms = 300_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return;
    await sleep(2_000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const networksOf = (name) => {
  try {
    return Object.keys(JSON.parse(execFileSync('docker', ['inspect', '-f', '{{json .NetworkSettings.Networks}}', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })));
  } catch {
    return null;
  }
};

async function main() {
  const settings = mcpSettings({ WOODSHED_PROD_MCP_URL: `http://127.0.0.1:${MCP_PORT}/mcp`, WOODSHED_PROD_MCP_PEOPLE: OWNER, WOODSHED_PROD_MCP_REPOS: REPO }, `http://${CONSOLE_NAME}:7690`);
  const issuer = createOidcIssuer({ issuer: settings.issuer, keyFile: path.join(stateDir, 'oidc.pem') });
  const certs = createEgressCerts({ dir: path.join(stateDir, 'egress'), hosts: GITHUB_HOSTS });
  const mcp = await startMcp(issuer);

  const docker = createDockerLauncher({ image: IMAGE, memory: '6g', cpus: '2', hostDocker: true, addHosts: [`${CONSOLE_NAME}:${ADDRESS}`], reachHost: REACH });
  // The proof's own: a session that ends is shown with the end of its log, which the fleet never reads for a tainted one.
  const launcher = {
    ...docker,
    async stop(ref) {
      const tail = spawnSync('docker', ['logs', '--tail', '25', ref], { encoding: 'utf8' });
      if (tail.status === 0) console.log(`--- the end of ${ref}'s log ---\n${`${tail.stdout}${tail.stderr}`.trim()}\n---`);
      return docker.stop(ref);
    },
  };
  const config = {
    projects: [{ name: 'proof', repo: REPO, default: true }], label: 'woodshed', publicUrl: `http://${CONSOLE_NAME}:7690`, maxRunning: 5,
    limits: { idleMs: 10 * 3_600_000, lifetimeMs: 10 * 3_600_000, startTimeoutMs: 900_000 }, maxPrivatePerPerson: 3,
    sessionEnv: { WOODSHED_CONSOLE_URL: `http://${CONSOLE_NAME}:${API_PORT}` }, ghToken: null, pollMs: 30_000, fallbackPollMs: 300_000,
  };
  const egress = { sessionUrl: `http://${CONSOLE_NAME}:${EGRESS_PORT}`, caPem: () => certs.caPem() };
  // An ordinary server beside the environment's production one, as an admin adds it on Console settings.
  const store = { state: { sessions: [], github: null, mcpServers: [checkServer({ name: 'docs', url: `http://127.0.0.1:${MCP_PORT}/mcp`, auth: 'oidc' })] }, save() {} };
  const mcpServers = createMcpServers({ store, settings, lockdown: () => ({ available: true }) });
  const fleet = createFleet({ config, store, launcher, github: {}, mcpServers, egress, appShares: { clearSession() {} } });
  const userSettings = {
    view: () => ({ setUp: true, claudeToken: { savedAt: 'proof' } }), claudeToken: async () => claudeToken, ownFiles: async () => ({}),
    gitIdentity: () => ({ name: 'Woodshed taint proof', email: 'taint-proof@woodshed.invalid' }), noteHome() {}, limitsFor: () => null,
  };
  const relay = createMcpRelay({ servers: mcpServers, issuer, fleet, repoOf: () => REPO });
  const api = createSessionApi({
    fleet, userSettings, anthropic: createAnthropicProxy({ userSettings }), mcpRelay: relay, egress,
    tokens: { token: async () => ({ token: ghToken, expiresAt: Date.now() + 3_600_000 }) },
  });
  const apiServer = http.createServer((req, res) => api(req, res).catch((err) => { console.error('proof: api failed', err.message); res.writeHead(502).end(); }));
  await new Promise((r) => apiServer.listen(API_PORT, '0.0.0.0', r));
  const anonymous = anonymousVisibility();
  const egressServer = createEgressProxy({
    sessions: () => fleet.sessions(), isLocked: fleet.isLocked, orgOf: () => REPO.split('/')[0], certs,
    visibility: async (owner, name) => (`${owner}/${name}`.toLowerCase() === PRIVATE_STUB ? 'private' : anonymous(owner, name)),
  });
  await new Promise((r) => egressServer.listen(EGRESS_PORT, '0.0.0.0', r));

  say('A private session that may use production starts as any other, on the open network');
  const session = await fleet.createSession({
    kind: 'task', number: null, title: 'taint proof', startedBy: OWNER, owner: OWNER, trigger: 'my-woodshed', branch: BRANCH,
    prompt: 'Reply with the single word READY, then stop and wait.', options: { model: 'haiku' },
  });
  if (session.status !== 'starting') throw new Error(`the session did not start: ${session.error}`);
  console.log({ id: session.id, docker: session.endpoint?.docker ?? null, networks: networksOf(`woodshed-${session.id}`) });
  await waitFor('claude to open', async () => { await fleet.tick(); return session.status === 'running' && session.claudeSession; });
  console.log({ status: session.status, claudeState: session.state });
  await check(session, 'before', 'curl -sS -o /dev/null -w "%{http_code}\\n" --max-time 10 https://example.com');
  await check(session, 'servers', `jq -c '.mcpServers | keys' /tmp/woodshed-mcp.json; jq -c '.projects["/work/woodshed"].disabledMcpServers' ~/.claude.json`);
  say('An ordinary server\'s call goes on, and taints nothing');
  await check(session, 'docs', `curl -sS --max-time 20 -o /dev/null -w "%{http_code}\\n" -H "Authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' "$WOODSHED_CONSOLE_URL/mcp/docs" -d '{"jsonrpc":"2.0","id":9,"method":"tools/list"}'`);
  console.log({ taintedAt: session.taintedAt ?? null, docsCalls: mcpCalls.filter((c) => c.claims?.aud === 'docs').map((c) => c.method) });

  say('From inside the session: a call to the MCP relay, which taints it before it is forwarded (the call\'s own connection goes with the network it was on)');
  await check(session, 'taint', `curl -sS --max-time 20 -H "Authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' "$WOODSHED_CONSOLE_URL/prod-mcp" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'`);
  console.log({ taintedAt: session.taintedAt, endpoint: session.endpoint, session: networksOf(`woodshed-${session.id}`), gateway: networksOf(gatewayName(session.id)) });
  console.log('MCP server saw:', mcpCalls.map((c) => ({ method: c.method, aud: c.claims?.aud, sub: c.claims?.sub, session_id: c.claims?.session_id, repo: c.claims?.repo })));

  say('statusd is told, and claude reopens on the console\'s proxy with woodshed-prod on');
  await waitFor('the session to be told', async () => { await fleet.tick(); return Boolean(session.taintNoticedAt); }, 120_000);
  await waitFor('claude to call woodshed-prod after it reopened', async () => mcpCalls.some((c) => c.method === 'tools/list'), 180_000);
  console.log('MCP server saw:', mcpCalls.map((c) => c.method));
  await check(session, 'servers', `jq -c '.mcpServers | keys' /tmp/woodshed-mcp.json; jq -c '.projects["/work/woodshed"].disabledMcpServers' ~/.claude.json`);

  say('Refused, from inside the tainted session');
  await check(session, 'docs', `curl -sS --max-time 20 -o /dev/null -w "%{http_code}\\n" -H "Authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' "$WOODSHED_CONSOLE_URL/mcp/docs" -d '{"jsonrpc":"2.0","id":9,"method":"tools/list"}'`);
  const refused = [
    'curl -sS --max-time 15 https://example.com',
    'curl -sS --max-time 15 --noproxy "*" https://example.com',
    'curl -sS --max-time 15 --noproxy "*" https://1.1.1.1',
    'cd /tmp && npm install --no-audit --no-fund left-pad',
    'pip install requests',
    `python3 -c 'import urllib.request; print(urllib.request.urlopen("https://pypi.org/simple/requests/", timeout=15).status)'`,
    'cd /tmp && git clone https://github.com/octocat/Hello-World',
    'echo leak > /tmp/leak.txt && gh gist create /tmp/leak.txt',
    'docker run --rm curlimages/curl https://example.com',
    'curl -sS --max-time 15 https://api.anthropic.com/v1/models',
    'getent hosts example.com || echo "no DNS for example.com"',
    'ip route 2>/dev/null || cat /proc/net/route',
  ];
  for (const command of refused) await check(session, 'refused', command);

  say('Allowed, from inside the tainted session');
  await check(session, 'model', 'claude -p --model haiku "Reply with exactly: tainted-model-call-ok"');
  await check(session, 'mcp', `curl -sS --max-time 30 -H "Authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H 'mcp-session-id: proof-1' "$WOODSHED_CONSOLE_URL/prod-mcp" -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"orders_lookup","arguments":{"id":"42"}}}'`);
  await check(session, 'push', `git checkout -q -B ${BRANCH} && git commit -q --allow-empty -m "test: taint proof, deleted by the harness" && git push -q origin HEAD:refs/heads/${BRANCH} && git ls-remote origin refs/heads/${BRANCH}`);
  console.log('MCP server saw, in all:', mcpCalls.map((c) => c.method).join(', '));

  say('Stopped, then resumed: it starts locked down');
  await fleet.stop(session, 'proof');
  console.log({ status: session.status, gateway: networksOf(gatewayName(session.id)), network: spawnSync('docker', ['network', 'inspect', lockedNetworkName(session.id)]).status === 0 ? 'still there' : 'removed' });
  await fleet.resumePrivate({ owner: OWNER, id: session.id });
  await waitFor('the resumed session to run', async () => { await fleet.tick(); return session.status === 'running'; });
  console.log({ taintedAt: session.taintedAt, session: networksOf(`woodshed-${session.id}`), gateway: networksOf(gatewayName(session.id)) });
  await check(session, 'resumed', 'curl -sS --max-time 15 https://example.com');
  await check(session, 'resumed', `grep -c 'production data' /tmp/woodshed-rules.md; cat /tmp/woodshed-deps`);

  say('Removed: the container, its gateway and its network are gone');
  await fleet.removePrivateSession({ owner: OWNER, id: session.id });
  console.log({ session: networksOf(`woodshed-${session.id}`), gateway: networksOf(gatewayName(session.id)), network: spawnSync('docker', ['network', 'inspect', lockedNetworkName(session.id)]).status === 0 ? 'still there' : 'removed' });

  apiServer.close();
  egressServer.close();
  mcp.close();
}

console.log = (...a) => quietLog(...a);
main().then(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  process.exit(0);
}, (err) => {
  console.error('proof failed:', err.message);
  process.exit(1);
});
