import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TAINTED_CLAUDE_FLAGS, applyTaint, isTaintSetUp, isTainted, markTaintSetUp, egressEnvText, mcpConfig, noProxyFor, proxyWithToken, serversOf, withProdServers, writeMcpConfig } from './taint.mjs';

const ENV = {
  WOODSHED_CONSOLE_URL: 'http://host.docker.internal:7691', PGHOST: 'postgres', WOODSHED_MONGO_HOST: 'mongo:27017',
  WOODSHED_SERVICES: 'S3_ENDPOINT', S3_ENDPOINT: 'http://s3:4566',
};

test('everything goes through the egress proxy but the console, the databases, the services and loopback', () => {
  assert.equal(noProxyFor(ENV), 'localhost,127.0.0.1,::1,host.docker.internal,postgres,mongo,s3');
  assert.equal(proxyWithToken('http://10.42.1.10:7693', 'abc'), 'http://woodshed:abc@10.42.1.10:7693');
  const text = egressEnvText({ proxy: 'http://10.42.1.10:7693', token: 'abc', env: ENV, caBundle: '/tmp/ca.pem' });
  for (const line of ["export HTTPS_PROXY='http://woodshed:abc@10.42.1.10:7693'", "export no_proxy='localhost,127.0.0.1,::1,host.docker.internal,postgres,mongo,s3'",
    "export GIT_SSL_CAINFO='/tmp/ca.pem'", "export SSL_CERT_FILE='/tmp/ca.pem'", "export NODE_EXTRA_CA_CERTS='/tmp/ca.pem'"]) {
    assert.ok(text.includes(line), line);
  }
  assert.ok(!egressEnvText({ proxy: 'http://10.42.1.10:7693', token: 'abc', env: ENV }).includes('CAINFO'), 'a guarded session trusts nothing new');
});

test('production servers are off for the checkout until one is turned on, the other servers as they were', () => {
  const off = JSON.parse(withProdServers(JSON.stringify({ projects: { '/work/r': { disabledMcpServers: ['slack'] } }, x: 1 }), '/work/r', ['woodshed-prod'], false));
  assert.deepEqual(off.projects['/work/r'].disabledMcpServers, ['slack', 'woodshed-prod']);
  assert.equal(off.x, 1);
  const on = JSON.parse(withProdServers(JSON.stringify(off), '/work/r', ['woodshed-prod'], true));
  assert.deepEqual(on.projects['/work/r'].disabledMcpServers, ['slack']);
  assert.deepEqual(JSON.parse(withProdServers(null, '/w', ['a', 'b'], false)).projects['/w'].disabledMcpServers, ['a', 'b']);
});

test('claude\'s MCP config points each server at the console\'s relay with the session\'s token, a tainted one\'s at production alone', () => {
  const servers = serversOf({ WOODSHED_MCP_SERVERS: JSON.stringify([{ name: 'woodshed-prod', production: true }, { name: 'docs', production: false }, { name: 'Bad name' }]) });
  assert.deepEqual(servers, [{ name: 'woodshed-prod', production: true }, { name: 'docs', production: false }]);
  assert.deepEqual(serversOf({ WOODSHED_MCP_SERVERS: 'not json' }), []);
  const open = mcpConfig({ servers, consoleUrl: 'http://host.docker.internal:7691/', token: 'tok', tainted: false });
  assert.deepEqual(open.mcpServers.docs, { type: 'http', url: 'http://host.docker.internal:7691/mcp/docs', headers: { Authorization: 'Bearer tok' } });
  assert.deepEqual(Object.keys(mcpConfig({ servers, consoleUrl: 'http://c', token: 'tok', tainted: true }).mcpServers), ['woodshed-prod']);
});

test('applyTaint writes the marker, the egress variables readable by the session alone, a bundle of both authorities, and turns woodshed-prod on', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taint-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = { marker: path.join(dir, 'tainted'), envFile: path.join(dir, 'egress.env'), bundle: path.join(dir, 'ca.pem'), claudeJson: path.join(dir, 'claude.json'), mcpConfig: path.join(dir, 'mcp.json'), profiles: [path.join(dir, '.profile')] };
  const env = { ...ENV, SESSION_TOKEN: 'tok', WOODSHED_MCP_SERVERS: JSON.stringify([{ name: 'woodshed-prod', production: true }, { name: 'docs', production: false }]) };
  await writeMcpConfig({ env, repoDir: '/work/r', tainted: false, file: files.mcpConfig, claudeJson: files.claudeJson });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(files.mcpConfig, 'utf8')).mcpServers), ['woodshed-prod', 'docs']);
  assert.equal((fs.statSync(files.mcpConfig).mode & 0o777).toString(8), '600', 'it holds the session token');
  assert.deepEqual(JSON.parse(fs.readFileSync(files.claudeJson, 'utf8')).projects['/work/r'].disabledMcpServers, ['woodshed-prod']);
  const result = await applyTaint({ proxy: 'http://gw:7693', ca: '-----BEGIN CERTIFICATE-----\nWOODSHED\n-----END CERTIFICATE-----', token: 'tok', env, repoDir: '/work/r', files });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(files.mcpConfig, 'utf8')).mcpServers), ['woodshed-prod'], 'its other servers are gone from claude\'s config');
  assert.equal(result.egress, true);
  assert.equal(result.variables.GIT_SSL_CAINFO, files.bundle);
  assert.equal(result.variables.HTTPS_PROXY, 'http://woodshed:tok@gw:7693');
  assert.match(fs.readFileSync(files.profiles[0], 'utf8'), /\. \/tmp\/woodshed-egress\.env/, 'new shells, the Terminal tab\'s among them, go through it too');
  assert.ok(fs.existsSync(files.marker));
  assert.equal((fs.statSync(files.envFile).mode & 0o777).toString(8), '600', 'it holds the session token');
  assert.match(fs.readFileSync(files.bundle, 'utf8'), /WOODSHED\n-----END CERTIFICATE-----\n$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(files.claudeJson, 'utf8')).projects['/work/r'].disabledMcpServers, []);
  await applyTaint({ proxy: 'http://gw:7693', ca: 'x', token: 'tok', env, repoDir: '/work/r', files });
  assert.equal(fs.readFileSync(files.profiles[0], 'utf8').split('\n').filter((l) => l.includes('woodshed-egress')).length, 1, 'once');
});

test('the entrypoint and statusd add the same flags to a tainted claude', () => {
  const entrypoint = fs.readFileSync(path.join(import.meta.dirname, 'entrypoint.sh'), 'utf8');
  assert.ok(entrypoint.includes(`TAINTED_CLAUDE_FLAGS='${TAINTED_CLAUDE_FLAGS}'`));
  assert.match(TAINTED_CLAUDE_FLAGS, /--disallowedTools WebSearch,WebFetch/);
});

test('a setup that failed after the marker is not taken for done: the next notice runs it again, and it finishes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taint-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const setUp = path.join(dir, 'set-up');
  const files = { marker: path.join(dir, 'tainted'), envFile: path.join(dir, 'egress.env'), bundle: path.join(dir, 'ca.pem'), mcpConfig: path.join(dir, 'mcp.json'), profiles: [path.join(dir, '.profile')],
    claudeJson: path.join(dir, 'missing', 'claude.json') };
  const env = { ...ENV, SESSION_TOKEN: 'tok', WOODSHED_MCP_SERVERS: JSON.stringify([{ name: 'woodshed-prod', production: true }]) };
  // Claude's config cannot be written: the marker is down, the setup is not.
  await assert.rejects(applyTaint({ proxy: 'http://gw:7693', ca: 'x', token: 'tok', env, repoDir: '/work/r', files }));
  assert.equal(isTainted(files.marker), true);
  assert.equal(isTaintSetUp(setUp), false, 'statusd answers the next notice by running the setup again');
  fs.mkdirSync(path.join(dir, 'missing'));
  await applyTaint({ proxy: 'http://gw:7693', ca: 'x', token: 'tok', env, repoDir: '/work/r', files });
  await markTaintSetUp(setUp);
  assert.equal(isTaintSetUp(setUp), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(files.claudeJson, 'utf8')).projects['/work/r'].disabledMcpServers, []);
});

test('statusd takes a notice as done only once the whole setup was, never from the marker alone', () => {
  const statusd = fs.readFileSync(path.join(import.meta.dirname, 'statusd.mjs'), 'utf8');
  const body = statusd.slice(statusd.indexOf('async function taint('), statusd.indexOf('// The processes a pid started'));
  assert.match(body, /if \(isTaintSetUp\(\)\) return \{ already: true \}/);
  assert.ok(body.indexOf('await markTaintSetUp()') > body.indexOf('await applyTaint('), 'marked after the setup');
  assert.ok(!/isTainted\(\)/.test(body));
});
