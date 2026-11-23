import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const agents = require('./agents.cjs');

test('every agent is listed, Claude Code first, and only the new two need an own sign-in', () => {
  assert.deepEqual(agents.AGENT_IDS, ['claude', 'codex', 'grok', 'opencode']);
  assert.deepEqual(agents.OWN_SIGN_IN_AGENTS, ['grok', 'opencode']);
  for (const id of agents.AGENT_IDS) {
    const a = agents.agent(id);
    assert.equal(a.id, id);
    assert.ok(a.processNames.includes(a.command), `${id}: its command is one of its process names`);
    // Only the agents the console has a proxy for may run where no one's sign-in may go: reviews and shared sessions.
    assert.equal(a.reviews, a.teamCredential);
    assert.equal(Boolean(a.signIn), !a.teamCredential);
    assert.ok(a.permissionModes.includes('auto'));
  }
  assert.ok(agents.PROCESS_NAMES.includes('grok') && agents.PROCESS_NAMES.includes('opencode'));
  // tmux names a pane's command after the process, which Linux cuts at 15 characters.
  assert.ok(agents.PROCESS_NAMES.every((n) => n.length <= 15));
});

test('a session with no agent, or one unknown, runs Claude Code', () => {
  assert.equal(agents.agentOfSession({}), 'claude');
  assert.equal(agents.agentOfSession({ options: { agent: 'opencode' } }), 'opencode');
  assert.equal(agents.agentOfSession({ options: { agent: 'toString' } }), 'claude');
  assert.equal(agents.agent('constructor').id, 'claude');
});

test('model names: each agent\'s own shape, never a space or a quote', () => {
  assert.ok(agents.modelShapeOk('grok', 'grok-build'));
  assert.ok(agents.modelShapeOk('grok', ''));
  assert.ok(!agents.modelShapeOk('grok', 'grok build'));
  assert.ok(agents.modelShapeOk('opencode', 'anthropic/claude-sonnet-4-5'));
  assert.ok(!agents.modelShapeOk('opencode', 'claude-sonnet-4-5'));
  assert.ok(!agents.modelShapeOk('opencode', 'a/b"; rm -rf /'));
  // Claude Code's are a fixed list, checked by the console.
  assert.ok(!agents.modelShapeOk('claude', 'opus'));
});

test('own sign-ins: a key or a login file each agent writes, checked before it is kept', () => {
  assert.equal(agents.checkSignIn('grok', '  xai-abcdefghijklmnop  '), 'xai-abcdefghijklmnop');
  const grokLogin = { 'https://auth.x.ai::b1a00492': { key: 'tok', auth_mode: 'oidc', refresh_token: 'r' } };
  assert.equal(agents.checkSignIn('grok', `${JSON.stringify(grokLogin, null, 2)}%`), JSON.stringify(grokLogin));
  assert.throws(() => agents.checkSignIn('grok', '{"x": {"auth_mode": "oidc"}}'), /not a Grok Build auth.json/);
  assert.throws(() => agents.checkSignIn('grok', 'sk-nope'), /xAI API key/);

  const oc = { anthropic: { type: 'api', key: 'sk-ant-x' }, openai: { type: 'oauth', refresh: 'r', access: 'a', expires: 1 } };
  assert.equal(agents.checkSignIn('opencode', JSON.stringify(oc)), JSON.stringify(oc));
  assert.throws(() => agents.checkSignIn('opencode', '{"anthropic": {"key": "x"}}'), /not an OpenCode auth.json/);
  assert.throws(() => agents.checkSignIn('opencode', '{}'), /holds no OpenCode sign-in/);

  for (const bad of [undefined, 42, '', '   ']) assert.throws(() => agents.checkSignIn('opencode', bad), (err) => err.shown === true);
  assert.throws(() => agents.checkSignIn('grok', `xai-${'a'.repeat(30_000)}`), /too long/);
  assert.throws(() => agents.checkSignIn('codex', 'sk-x'), /no own sign-in/);
});

test('a sign-in\'s digest is the same whatever its spacing, and differs for another sign-in', () => {
  const login = { s: { key: 'k', refresh_token: 'r' } };
  assert.equal(agents.signInDigest(JSON.stringify(login)), agents.signInDigest(`\n${JSON.stringify(login, null, 2)}  `));
  assert.notEqual(agents.signInDigest(JSON.stringify(login)), agents.signInDigest(JSON.stringify({ s: { key: 'k', refresh_token: 'r2' } })));
  assert.equal(agents.signInDigest('xai-abc\n'), agents.signInDigest('xai-abc'));
  assert.match(agents.signInDigest('{not json'), /^[0-9a-f]{64}$/);
});
