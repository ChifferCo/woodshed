import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createProjectTokens } from './projectTokens.mjs';
import { loadProjects } from './projects.mjs';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });

function fakeGitHub() {
  const asked = [];
  async function fetchImpl(url, { body }) {
    const { repositories, permissions } = JSON.parse(body);
    asked.push({ installation: url.match(/installations\/(\d+)\//)[1], repositories, permissions: permissions ?? null });
    return { ok: true, json: async () => ({ token: `ghs_${repositories[0]}_${asked.length}`, expires_at: '2026-11-10T13:00:00Z' }) };
  }
  return { asked, fetchImpl };
}

const now = () => Date.parse('2026-11-10T12:00:00Z');

test('without a GitHub App there are no tokens', () => {
  assert.equal(createProjectTokens({ config: { repo: 'acme/app' }, privateKey }), null);
});

test('each project\'s tokens reach its repo alone, from its own installation', async () => {
  const projects = loadProjects({ WOODSHED_CLOUD_PROJECTS: '[{"name":"app","repo":"acme/app","default":true},{"name":"tools","repo":"other/tools","installationId":"42"}]' });
  const github = fakeGitHub();
  const tokens = createProjectTokens({ config: { projects, githubApp: { appId: '1', installationId: '7' } }, privateKey, fetchImpl: github.fetchImpl, now });

  const onTools = tokens.forSession({ project: 'tools', repo: 'other/tools' });
  assert.equal(onTools.project, 'tools');
  assert.equal((await onTools.sessions.token()).token, 'ghs_tools_1');
  assert.deepEqual(github.asked[0], {
    installation: '42', repositories: ['tools'],
    permissions: { contents: 'write', pull_requests: 'write', issues: 'write', metadata: 'read', checks: 'read', actions: 'write', statuses: 'read' },
  });

  const onApp = tokens.forSession({ repo: 'acme/app' });
  assert.equal(onApp.project, 'app', 'a record with no project is on the one with its repo');
  assert.equal(await onApp.asks.token(), await tokens.asks.token(), 'the default project\'s sources are the ones the console already had: one token, minted once');
  assert.deepEqual(github.asked[1], { installation: '7', repositories: ['app'], permissions: { contents: 'read', pull_requests: 'read', issues: 'read', metadata: 'read' } });

  await tokens.console.token();
  assert.deepEqual(github.asked[2], { installation: '7', repositories: ['app'], permissions: null }, 'the console\'s own token, on the default project');
  assert.equal(tokens.forSession({ project: 'tools' }).sessions, onTools.sessions, 'a project\'s sources are made once, so its token is cached');
});
