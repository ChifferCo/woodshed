import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compose, readToml, sharedPart, textOf, unitOf, withEntries, withOwnEntries, withTrusted } from './codexConfig.mjs';

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
    local = withOwnEntries(shared, local);
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

test('an entry holding a credential stays on the side it was set on, as its trusted folders do; a variable\'s name is no credential', async () => {
  const { credentialOf, configCredential } = await import('./codexConfig.mjs');
  const kv = (text) => readToml(text).find((s) => s.kind === 'kv');
  for (const [text, why] of [
    ['[mcp_servers.x.env]\nAPI_KEY = "ABCD1234EFGH5678"\n', 'sets mcp_servers.x.env.API_KEY'],
    ['[mcp_servers.x]\nenv = { LINEAR_API_KEY = "LINAPIKEY1234" }\n', 'sets mcp_servers.x.env.LINEAR_API_KEY'],
    ['[mcp_servers.x]\nhttp_headers = { Authorization = "Bearer abc" }\n', 'sets mcp_servers.x.http_headers.Authorization'],
    ['[mcp_servers.x]\nbearer_token = "abc"\n', 'sets mcp_servers.x.bearer_token'],
    ['[mcp_servers.x]\nurl = "https://mia:pw@example.com/mcp"\n', 'mcp_servers.x.url\'s URL carries a sign-in'],
    ['[shell_environment_policy.set]\nGITHUB_TOKEN = "TOKENVALUE"\n', 'sets shell_environment_policy.set.GITHUB_TOKEN'],
    ['[mcp_servers]\nx = { url = "https://example.com/mcp", http_headers = { Authorization = "Bearer abc" } }\n', 'sets mcp_servers.x.Authorization'],
    ['[mcp_servers]\nx = { command = "npx", env = { API_KEY = "abc" } }\n', 'sets mcp_servers.x.API_KEY'],
  ]) assert.equal(credentialOf(kv(text)), why, text);
  for (const text of [
    '[model_providers.x]\nenv_key = "OPENAI_API_KEY"\n',
    '[mcp_servers.x]\nbearer_token_env_var = "GITHUB_TOKEN"\n',
    '[mcp_servers.x]\nenv_http_headers = { Authorization = "MY_TOKEN" }\n',
    '[mcp_servers.x]\nenv = { GITHUB_TOKEN = "${GITHUB_TOKEN}" }\n',
    'preferred_auth_method = "chatgpt"\n',
    'mcp_oauth_credentials_store = "file"\n',
  ]) assert.equal(credentialOf(kv(text)), null, text);

  const session = 'model = "o3"\n\n[mcp_servers.linear]\ncommand = "npx"\n\n[mcp_servers.linear.env]\nLINEAR_API_KEY = "LINAPIKEY1234"\n\n[projects."/work/app"]\ntrust_level = "trusted"\n';
  const shared = sharedPart(session);
  assert.equal(shared, 'model = "o3"\n', 'the server with its key is not sent');
  assert.equal(configCredential(shared), null);
  assert.match(configCredential(session), /LINEAR_API_KEY/);
  const back = withOwnEntries('model = "gpt-5.5"\n', session);
  assert.equal(sharedPart(back), 'model = "gpt-5.5"\n');
  assert.ok(back.includes('LINEAR_API_KEY = "LINAPIKEY1234"') && back.includes('[projects."/work/app"]'), 'and stays here when the shared copy is written');
});

test('a # inside a quoted value is no comment, and a key\'s shape in a comment or a table\'s name is caught too', async () => {
  const { credentialOf, configCredential } = await import('./codexConfig.mjs');
  // Made here, so no file in the repo holds a string shaped like a real token.
  const token = `ghp_${'x1'.repeat(18)}`;
  const [pair] = readToml('[mcp_servers.x.env]\nAPI_KEY = "abc#def" # a note\n').filter((s) => s.kind === 'kv');
  assert.equal(pair.value, '"abc#def"');
  assert.equal(credentialOf(pair), 'sets mcp_servers.x.env.API_KEY');
  const commented = `model = "o3"\n# ${token}\n[mcp_servers."${token}"]\ncommand = "npx"\n`;
  assert.match(configCredential(commented), /GitHub token/);
  assert.equal(sharedPart(commented), 'model = "o3"\n', 'neither the comment nor the table goes');
  assert.equal(configCredential('model = "o3\n'), 'is not TOML the console reads');
});
