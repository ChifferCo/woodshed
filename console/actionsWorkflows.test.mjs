import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { actionsWorkflows, loadConfig } from './config.mjs';
import { createHandler } from './server.mjs';

test('the menu\'s workflow links are the installation\'s own, label=file.yml pairs, and none by default', () => {
  assert.deepEqual(actionsWorkflows('Build images=images.yml, Run infrastructure=infra.yaml'), [
    { label: 'Build images', file: 'images.yml' }, { label: 'Run infrastructure', file: 'infra.yaml' },
  ]);
  assert.deepEqual(actionsWorkflows(''), []);
  assert.deepEqual(loadConfig({ GH_TOKEN: 'x', WOODSHED_REPO: 'acme/app' }).actionsWorkflows, [], 'no repo\'s workflow names assumed');
  for (const bad of ['images.yml', '=images.yml', 'Build=images', 'Build=../x.yml', 'Build=a/b.yml']) {
    assert.throws(() => actionsWorkflows(bad), /is not label=file\.yml/, bad);
  }
});

test('/api/me hands the menu the configured workflows, and nothing when there are none', async (t) => {
  async function me(actions) {
    const config = {
      host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'acme/app', label: 'woodshed',
      maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 }, actionsWorkflows: actions,
    };
    const handle = createHandler({ config, fleet: { sessions: () => [] } });
    const server = http.createServer((req, res) => { handle(req, res); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/me`, { headers: { host: '127.0.0.1' } });
    return res.json();
  }
  const set = await me([{ label: 'Build images', file: 'images.yml' }]);
  assert.deepEqual([set.repo, set.workflows], ['acme/app', [{ label: 'Build images', file: 'images.yml' }]]);
  assert.deepEqual((await me([])).workflows, []);
});
