import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TAINTED_CLAUDE_FLAGS, applyTaint, egressEnvText, noProxyFor, proxyWithToken, withProdServer } from './taint.mjs';

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

test('woodshed-prod is off for the checkout until it is turned on, the other servers as they were', () => {
  const off = JSON.parse(withProdServer(JSON.stringify({ projects: { '/work/r': { disabledMcpServers: ['slack'] } }, x: 1 }), '/work/r', false));
  assert.deepEqual(off.projects['/work/r'].disabledMcpServers, ['slack', 'woodshed-prod']);
  assert.equal(off.x, 1);
  const on = JSON.parse(withProdServer(JSON.stringify(off), '/work/r', true));
  assert.deepEqual(on.projects['/work/r'].disabledMcpServers, ['slack']);
  assert.deepEqual(JSON.parse(withProdServer(null, '/w', false)).projects['/w'].disabledMcpServers, ['woodshed-prod']);
});

test('applyTaint writes the marker, the egress variables readable by the session alone, a bundle of both authorities, and turns woodshed-prod on', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taint-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = { marker: path.join(dir, 'tainted'), envFile: path.join(dir, 'egress.env'), bundle: path.join(dir, 'ca.pem'), claudeJson: path.join(dir, 'claude.json'), profiles: [path.join(dir, '.profile')] };
  fs.writeFileSync(files.claudeJson, withProdServer(null, '/work/r', false));
  const result = await applyTaint({ proxy: 'http://gw:7693', ca: '-----BEGIN CERTIFICATE-----\nWOODSHED\n-----END CERTIFICATE-----', token: 'tok', env: ENV, repoDir: '/work/r', files });
  assert.equal(result.egress, true);
  assert.equal(result.variables.GIT_SSL_CAINFO, files.bundle);
  assert.equal(result.variables.HTTPS_PROXY, 'http://woodshed:tok@gw:7693');
  assert.match(fs.readFileSync(files.profiles[0], 'utf8'), /\. \/tmp\/woodshed-egress\.env/, 'new shells, the Terminal tab\'s among them, go through it too');
  assert.ok(fs.existsSync(files.marker));
  assert.equal((fs.statSync(files.envFile).mode & 0o777).toString(8), '600', 'it holds the session token');
  assert.match(fs.readFileSync(files.bundle, 'utf8'), /WOODSHED\n-----END CERTIFICATE-----\n$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(files.claudeJson, 'utf8')).projects['/work/r'].disabledMcpServers, []);
  await applyTaint({ proxy: 'http://gw:7693', ca: 'x', token: 'tok', env: ENV, repoDir: '/work/r', files });
  assert.equal(fs.readFileSync(files.profiles[0], 'utf8').split('\n').filter((l) => l.includes('woodshed-egress')).length, 1, 'once');
});

test('the entrypoint and statusd add the same flags to a tainted claude', () => {
  const entrypoint = fs.readFileSync(path.join(import.meta.dirname, 'entrypoint.sh'), 'utf8');
  assert.ok(entrypoint.includes(`TAINTED_CLAUDE_FLAGS='${TAINTED_CLAUDE_FLAGS}'`));
  assert.match(TAINTED_CLAUDE_FLAGS, /--disallowedTools WebSearch,WebFetch/);
});
