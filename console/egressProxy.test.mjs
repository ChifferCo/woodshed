import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

import { createEgressCerts } from './egressCerts.mjs';
import { createEgressProxy, proxyTokenOf } from './egressProxy.mjs';
import { GITHUB_HOSTS } from './githubEgress.mjs';

const tmp = (t, name) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const listen = (t, server) => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  t.after(() => server.close());
});

// GitHub, as far as the proxy sees it: TLS for its names (from an authority of the test's own), and what it was asked.
async function fakeGitHub(t) {
  const certs = createEgressCerts({ dir: tmp(t, 'gh-ca-'), hosts: GITHUB_HOSTS });
  const contexts = {};
  for (const host of GITHUB_HOSTS) contexts[host] = tls.createSecureContext(await certs.leaf(host));
  const seen = [];
  const server = https.createServer({ SNICallback: (name, cb) => cb(null, contexts[name]) }, (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ host: req.headers.host, method: req.method, url: req.url, body, auth: req.headers.authorization ?? null });
      if (req.url === '/graphql' && body.includes('nodes(ids')) {
        const ids = JSON.parse(body).variables.ids;
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: { nodes: ids.map((id) => (id === 'R_public' ? { __typename: 'Repository', nameWithOwner: 'acme/site', visibility: 'PUBLIC' } : { __typename: 'Repository', nameWithOwner: 'acme/api', visibility: 'PRIVATE' })) } }));
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`github says hi to ${req.method} ${req.url}`);
    });
  });
  const port = await listen(t, server);
  return { seen, port, ca: await certs.caPem() };
}

async function setup(t) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const github = await fakeGitHub(t);
  const certs = createEgressCerts({ dir: tmp(t, 'egress-ca-'), hosts: GITHUB_HOSTS });
  const sessions = [
    { id: 'aaaa1111', token: 'tok-tainted', status: 'running', taintedAt: '2026-11-19T10:00:00Z' },
    { id: 'bbbb2222', token: 'tok-guarded', status: 'running' },
  ];
  const lookup = (host, opts, cb) => (opts?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4));
  const proxy = createEgressProxy({
    sessions: () => sessions, isLocked: (s) => Boolean(s.taintedAt), orgOf: () => 'acme', certs,
    visibility: async (owner, name) => (name === 'site' || owner === 'octocat' ? 'public' : 'unknown'),
    upstream: { ca: github.ca, port: github.port, lookup },
  });
  const port = await listen(t, proxy);
  return { github, port, ca: await certs.caPem() };
}

const auth = (token) => `Basic ${Buffer.from(`woodshed:${token}`).toString('base64')}`;

function connect(port, target, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: target, headers: token ? { 'proxy-authorization': auth(token) } : {} });
    req.on('connect', (res, socket, head) => {
      if (res.statusCode === 200) return resolve({ status: 200, socket });
      let body = String(head ?? '');
      socket.on('data', (c) => { body += c; });
      socket.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// A request to GitHub as a tainted session's git or gh makes it: through the proxy, trusting the proxy's authority alone.
async function viaProxy({ port, ca, host, method = 'GET', path: p, body = null, token = 'tok-tainted' }) {
  const tunnel = await connect(port, `${host}:443`, token);
  if (tunnel.status !== 200) return tunnel;
  return new Promise((resolve, reject) => {
    const req = https.request({
      host, method, path: p, headers: { 'content-type': 'application/json', authorization: 'Bearer ghs_session' },
      createConnection: () => tls.connect({ socket: tunnel.socket, servername: host, ca }),
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: text }));
    });
    req.on('error', reject);
    req.end(body ?? undefined);
  });
}

test('without a session\'s own token the proxy takes nothing', async (t) => {
  const { port } = await setup(t);
  assert.equal((await connect(port, 'example.com:443', null)).status, 407);
  assert.equal((await connect(port, 'example.com:443', 'tok-of-nobody')).status, 407);
  assert.equal(proxyTokenOf({ 'proxy-authorization': auth('abc') }), 'abc');
});

test('a tainted session reaches no host but GitHub\'s, and is told why', async (t) => {
  const { port } = await setup(t);
  for (const target of ['example.com:443', 'registry.npmjs.org:443', 'pypi.org:443', 'api.anthropic.com:443', 'github.com:22', 'gist.github.com:443', 'objects.githubusercontent.com:443']) {
    const refused = await connect(port, target, 'tok-tainted');
    assert.equal(refused.status, 403, target);
    assert.match(refused.body, /refused by this session's lockdown/);
  }
});

test('an untainted guarded session goes wherever it asks, untouched', async (t) => {
  const { port } = await setup(t);
  const echo = net.createServer((s) => s.pipe(s));
  const echoPort = await listen(t, echo);
  const tunnel = await connect(port, `127.0.0.1:${echoPort}`, 'tok-guarded');
  assert.equal(tunnel.status, 200);
  const back = await new Promise((resolve) => {
    tunnel.socket.once('data', (d) => resolve(String(d)));
    tunnel.socket.write('ping');
  });
  assert.equal(back, 'ping');
  tunnel.socket.destroy();
});

test('a tainted session reaches its organization\'s private repos over git and the API, and nothing public or anyone else\'s', async (t) => {
  const { port, ca, github } = await setup(t);
  const fetch = await viaProxy({ port, ca, host: 'github.com', path: '/acme/api.git/info/refs?service=git-upload-pack' });
  assert.equal(fetch.status, 200);
  assert.equal(github.seen[0].url, '/acme/api.git/info/refs?service=git-upload-pack');
  assert.equal(github.seen[0].auth, 'Bearer ghs_session', 'the session\'s own credential goes on as it was');
  const push = await viaProxy({ port, ca, host: 'github.com', method: 'POST', path: '/acme/api.git/git-receive-pack', body: 'PACK' });
  assert.equal(push.status, 200);
  assert.equal(github.seen[1].body, 'PACK');

  const before = github.seen.length;
  const refusals = [
    [{ host: 'github.com', path: '/octocat/Hello-World.git/info/refs?service=git-upload-pack' }, /not acme's/],
    [{ host: 'github.com', method: 'POST', path: '/acme/site.git/git-receive-pack', body: 'PACK' }, /public/],
    [{ host: 'api.github.com', method: 'POST', path: '/gists', body: '{"files":{}}' }, /only reads|writes a tainted session/],
    [{ host: 'api.github.com', method: 'POST', path: '/user/repos', body: '{"name":"leak"}' }, /writes a tainted session/],
    [{ host: 'api.github.com', method: 'PATCH', path: '/repos/acme/api', body: '{"private":false}' }, /writes a tainted session/],
  ];
  for (const [request, why] of refusals) {
    const refused = await viaProxy({ port, ca, ...request });
    assert.equal(refused.status, 403, request.path);
    assert.match(refused.body, why, request.path);
  }
  assert.equal(github.seen.length, before, 'none of them reached GitHub');
});

test('a tainted session\'s GraphQL mutation goes on only once GitHub says it acts on the organization\'s private repo', async (t) => {
  const { port, ca, github } = await setup(t);
  const mutation = (repositoryId) => JSON.stringify({
    query: 'mutation PullRequestCreate($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { url } } }',
    variables: { input: { repositoryId, baseRefName: 'main', headRefName: 'fix', title: 'Fix' } },
  });
  const ok = await viaProxy({ port, ca, host: 'api.github.com', method: 'POST', path: '/graphql', body: mutation('R_private') });
  assert.equal(ok.status, 200);
  assert.deepEqual(github.seen.map((s) => s.body.includes('nodes(ids') ? 'check' : 'mutation'), ['check', 'mutation']);
  const refused = await viaProxy({ port, ca, host: 'api.github.com', method: 'POST', path: '/graphql', body: mutation('R_public') });
  assert.equal(refused.status, 403);
  assert.match(refused.body, /public/);
  assert.equal(github.seen.length, 3, 'the check went, the mutation did not');
  const query = await viaProxy({ port, ca, host: 'api.github.com', method: 'POST', path: '/graphql', body: JSON.stringify({ query: '{ viewer { login } }' }) });
  assert.equal(query.status, 200);
});
