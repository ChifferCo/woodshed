import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compose, readToml, sharedPart, textOf, unitOf, withEntries, withOwnProjects, withTrusted } from './codexConfig.mjs';

const CONFIG = `# mine
model = "gpt-5.5" # the one I like
args = [
  "a", # one
  "b",
]
notes = """two
lines with \\""" inside"""

[projects."/Users/mia/app"]
trust_level = "trusted"

[mcp_servers.github]
command = "npx"
env = { GITHUB_TOKEN = "\${GITHUB_TOKEN}" }

[mcp_servers.github.env]
LOG = 'debug'
`;

test('config.toml is read as statements whose text gives the file back whole, each named by the entry it belongs to', () => {
  const statements = readToml(CONFIG);
  assert.equal(textOf(statements), CONFIG);
  assert.deepEqual(statements.filter((s) => s.kind !== 'blank').map(unitOf), [
    'model', 'args', 'notes', 'projects."/Users/mia/app"', 'projects."/Users/mia/app"',
    'mcp_servers.github', 'mcp_servers.github', 'mcp_servers.github', 'mcp_servers.github', 'mcp_servers.github',
  ]);
  for (const broken of ['a = "no end\n', '[table\n', 'a = [1, 2\n', 'just words\n']) assert.equal(readToml(broken), null, broken);
});

test('each side keeps the folders it trusts: the shared part leaves them out, and a write puts this side\'s back, the same text every round', () => {
  const shared = sharedPart(CONFIG);
  assert.ok(!shared.includes('projects'));
  assert.ok(shared.endsWith('LOG = \'debug\'\n'));
  let local = withTrusted('', '/work/app');
  for (let round = 0; round < 3; round++) {
    local = withOwnProjects(shared, local);
    assert.equal(sharedPart(local), shared, `round ${round}`);
  }
  assert.ok(local.endsWith('[projects."/work/app"]\ntrust_level = "trusted"\n'));
  assert.equal(sharedPart('[projects."/x"]\ntrust_level = "trusted"\n'), '', 'nothing but trusted folders is nothing to sync');
  assert.equal(withTrusted(local, '/work/app'), local, 'trusted once');
});

test('entries put into another file go under their own table, the top\'s before the first header', () => {
  const own = readToml('notify = ["say"]\n[tui]\nnotifications = true\n[mcp_servers.mine]\ncommand = "/Users/mia/bin/mcp"\n')
    .filter((s) => s.kind !== 'header' || s.table[0] === 'mcp_servers');
  assert.equal(compose('model = "o3"\n\n[tui]\nanimations = false\n', own),
    'model = "o3"\nnotify = ["say"]\n\n[tui]\nanimations = false\nnotifications = true\n\n[mcp_servers.mine]\ncommand = "/Users/mia/bin/mcp"\n');
  assert.equal(compose('model = "o3"\n', readToml('[tui]\nx = 1\n').filter((s) => s.kind === 'kv')), 'model = "o3"\n\n[tui]\nx = 1\n', 'a table this file has not gets its header');
  assert.equal(withEntries('[mcp_servers.github]\ncommand = "gh-mcp"\n', readToml('[mcp_servers.github]\ncommand = "npx"\n')), '[mcp_servers.github]\ncommand = "npx"\n',
    'an entry of the same name is replaced whole, never doubled');
});
