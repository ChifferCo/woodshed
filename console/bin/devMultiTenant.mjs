// Runs a multi-tenant console (console/hosted.mjs) on this machine with two made-up orgs, each with sessions of its
// own, and a stand-in host that signs people in and switches orgs, so the org switcher and each org's pages can be
// checked in a browser without AWS, GitHub or Docker. Usage: node console/bin/devMultiTenant.mjs [port]
//
// Then open http://localhost:<port>/ (the console) and pick who you are on the host's sign-in page, on the next port up.
// octocat is an owner of Acme and a member of Globex; ana-dev is in Acme only, priya-dev in Globex only. The menu
// under the avatar switches org. Everything is in memory: nothing is kept when it stops.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startMultiTenantConsole } from '../hosted.mjs';
import { secretSpecs } from '../secrets.mjs';

const port = Number(process.argv[2] || 7690);
const hostPort = port + 1;
const sessionApiPort = port + 2;
const HOST = `http://localhost:${hostPort}`;
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-dev-multi-'));

const ORGS = {
  acme: { name: 'Acme Robotics', repo: 'acme-robotics/arm-controller', people: { octocat: 'owner', 'ana-dev': 'member' } },
  globex: { name: 'Globex Labs', repo: 'globex-labs/billing-api', people: { octocat: 'member', 'priya-dev': 'owner' } },
};

const now = new Date().toISOString();
function session(id, number, title, repo, extra = {}) {
  return {
    id, repo, kind: 'pr', number, title, startedBy: 'octocat', trigger: 'console', prompt: '', owner: null, options: null,
    resumeClaude: null, branch: `woodshed/${id}`, status: 'stopped', state: null, createdAt: now, startedAt: now, stoppedAt: now,
    lastActiveAt: now, checkedAt: null, stopReason: 'idle', error: null, head: null, prUrl: `https://github.com/${repo}/pull/${number}`,
    lastMessage: null, commentId: null, token: `t${id}`, terminalToken: `x${id}`, ref: null, endpoint: null, pendingMessages: [], ...extra,
  };
}
const SESSIONS = {
  acme: [
    session('acac0001', 101, 'Acme: calibrate the gripper', ORGS.acme.repo),
    session('acac0002', 102, 'Acme: retry the arm homing', ORGS.acme.repo, { status: 'running', state: 'working', stoppedAt: null, stopReason: null, assignee: 'octocat' }),
    session('acac0003', null, 'Acme: octocat\'s private session', ORGS.acme.repo, { kind: 'task', trigger: 'my-woodshed', owner: 'octocat', prUrl: null }),
  ],
  globex: [
    session('91ab0001', 201, 'Globex: invoice rounding', ORGS.globex.repo),
    session('91ab0002', 202, 'Globex: dunning emails', ORGS.globex.repo, { status: 'running', state: 'needs-you', stoppedAt: null, stopReason: null, startedBy: 'priya-dev', assignee: 'priya-dev' }),
  ],
};

function memorySecrets() {
  const values = new Map();
  const specs = secretSpecs({ envFiles: [] });
  return {
    async list() {
      return specs.map((spec) => ({ ...spec, exists: values.has(spec.name), set: values.has(spec.name), description: '', changedAt: null }));
    },
    async read(name) { return values.get(name) ?? null; },
    async write(name, value) { values.set(name, value); },
    async save(name, value) { values.set(name, value); },
    async remove(name) { values.delete(name); },
  };
}

function memoryHomes() {
  const homes = new Map();
  return {
    async put(name, stream) {
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      homes.set(name, Buffer.concat(chunks));
      return homes.get(name).length;
    },
    async get(name) { return null; },
    async copy() {},
    async remove(name) { homes.delete(name); },
    async removeSessionsOf() {},
    async listShared() { return []; },
    async putText() {},
    async getText() { return null; },
    async removeKey() {},
  };
}

// Sessions here never get a container: a start fails with a word, as one with no room for it would.
const launcher = {
  kind: 'docker',
  refFor: (id) => `dev-${id}`,
  async start() { throw new Error('the dev console starts no containers'); },
  async isAlive() { return false; },
  async logTail() { return ''; },
  async stop() {},
};

function tenantOf(id) {
  const org = ORGS[id];
  let saved = { sessions: SESSIONS[id], github: null };
  return {
    id,
    name: org.name,
    settings: { projects: [{ name: org.repo.split('/')[1], repo: org.repo }], sessionApiUrl: `http://127.0.0.1:${sessionApiPort}`, pollGitHub: false },
    services: {
      store: { load: async () => saved, save: async (state) => { saved = state; } },
      secrets: memorySecrets(),
      homes: memoryHomes(),
      github: { token: async ({ permissions }) => ({ token: 'dev', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: permissions ?? {} }) },
      launcher,
      dbAdmin: null,
      databases: null,
      projectFiles: null,
    },
  };
}
const TENANTS = Object.keys(ORGS).map(tenantOf);

function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter(([k]) => k).map(([k, v]) => [k, decodeURIComponent(v ?? '')]));
}

const tenancy = {
  async tenants() { return TENANTS; },
  async identify(req) {
    const { dev_login: login, dev_org: org } = cookies(req);
    const mine = Object.entries(ORGS).filter(([, o]) => o.people[login]);
    if (!login || !mine.length) return null;
    const current = mine.find(([id]) => id === org) ?? mine[0];
    return {
      login, role: current[1].people[login], tenantId: current[0],
      tenants: mine.map(([id, o]) => ({ id, name: o.name, role: o.people[login] })),
    };
  },
  signInUrl: (req) => `${HOST}/sign-in?next=${encodeURIComponent(req.url || '/')}`,
  switchUrl: (tenantId, returnTo) => `${HOST}/switch?org=${encodeURIComponent(tenantId)}&next=${encodeURIComponent(returnTo)}`,
  menuLinks: () => [{ label: 'Account ↗', href: `${HOST}/account` }],
};

// The stand-in host: who you are, and which org you are in, as two cookies on localhost (cookies ignore the port).
const back = (next) => `http://localhost:${port}${String(next || '/').startsWith('/') ? next : '/'}`;
const host = http.createServer((req, res) => {
  const url = new URL(req.url, HOST);
  const send = (code, headers, body = '') => { res.writeHead(code, headers); res.end(body); };
  if (url.pathname === '/sign-in' && url.searchParams.get('login')) {
    return send(302, { location: back(url.searchParams.get('next')), 'set-cookie': [`dev_login=${encodeURIComponent(url.searchParams.get('login'))}; Path=/`, 'dev_org=; Path=/; Max-Age=0'] });
  }
  if (url.pathname === '/sign-in') {
    const next = encodeURIComponent(url.searchParams.get('next') || '/');
    const people = ['octocat', 'ana-dev', 'priya-dev'].map((p) => `<li><a href="/sign-in?login=${p}&next=${next}">${p}</a></li>`).join('');
    return send(200, { 'content-type': 'text/html' }, `<!doctype html><title>Stand-in host</title><h1>Sign in as</h1><ul>${people}</ul>`);
  }
  if (url.pathname === '/switch') {
    return send(302, { location: back(url.searchParams.get('next')), 'set-cookie': `dev_org=${encodeURIComponent(url.searchParams.get('org') || '')}; Path=/` });
  }
  if (url.pathname === '/account') return send(200, { 'content-type': 'text/html' }, '<!doctype html><title>Account</title><h1>The host\'s account page</h1><p><a href="/sign-in">Sign in as someone else</a></p>');
  return send(404, { 'content-type': 'text/plain' }, 'not found');
});
host.listen(hostPort, '127.0.0.1');

const consoleProcess = await startMultiTenantConsole({
  config: { host: '127.0.0.1', port, publicUrl: `http://localhost:${port}`, appDomain: 'apps.localhost', sessionApi: { host: '127.0.0.1', port: sessionApiPort }, stateDir },
  tenancy,
});
console.log(`devMultiTenant: open http://localhost:${port}/ and sign in on ${HOST}`);

async function stop() {
  await consoleProcess.close();
  host.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
