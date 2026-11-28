import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const agents = require('./agents.cjs');

test('every agent is listed, Claude Code first, and only the new two need an own sign-in', () => {
  assert.deepEqual(agents.AGENT_IDS, ['claude', 'codex', 'grok', 'opencode']);
  assert.deepEqual(agents.OWN_SIGN_IN_AGENTS, ['grok', 'opencode']);
  assert.deepEqual(agents.REVIEW_AGENT_IDS, ['claude', 'codex', 'grok', 'opencode']);
  for (const id of agents.AGENT_IDS) {
    const a = agents.agent(id);
    assert.equal(a.id, id);
    assert.ok(a.processNames.includes(a.command), `${id}: its command is one of its process names`);
    // Every agent reviews: the two on no team credential only on the author's own sign-in, which the console's proxy adds
    // (console/reviewAgentProxy.mjs), never handed to the review.
    assert.equal(a.reviews, true);
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

test('each agent places every mode it offers on one scale, and a started session never gets a looser one', () => {
  for (const id of agents.AGENT_IDS) {
    const a = agents.agent(id);
    assert.deepEqual(Object.keys(a.modeRanks).sort(), [...a.permissionModes].sort(), `${id}: a rank for each mode it offers, and none other`);
    assert.ok(Object.values(a.modeRanks).every((r) => Object.values(agents.RANKS).includes(r)));
    assert.equal(a.modeRanks.plan, agents.RANKS.readOnly, `${id}: a read-only mode, so a started session always has one`);
    assert.equal(a.modeRanks.auto, agents.RANKS.everything);
  }
  // OpenCode's modes mean Claude Code's, held by configureOpencode's permission rules.
  assert.deepEqual(agents.agent('opencode').modeRanks, agents.agent('claude').modeRanks);
  assert.deepEqual(agents.agent('opencode').permissionModes, ['auto', 'acceptEdits', 'plan', 'default']);
  // Codex's own policy edits and runs commands unasked: looser than acceptEdits.
  assert.ok(agents.agent('codex').modeRanks.default > agents.agent('claude').modeRanks.acceptEdits);
  for (const from of agents.AGENT_IDS) {
    for (const mode of [...agents.agent(from).permissionModes, 'bypassPermissions', '']) {
      for (const to of agents.AGENT_IDS) {
        const got = agents.modeForStartedSession(from, mode, to);
        assert.ok(agents.agent(to).permissionModes.includes(got), `${from} ${mode} -> ${to}: ${got}`);
        const limit = agents.agent(from).modeRanks[mode] ?? agents.RANKS.readOnly;
        assert.ok(agents.agent(to).modeRanks[got] <= limit, `${from} ${mode} -> ${to} ${got} is no looser`);
        // The loosest that is no looser.
        assert.ok(Object.values(agents.agent(to).modeRanks).every((r) => r > limit || r <= agents.agent(to).modeRanks[got]));
      }
    }
  }
  assert.equal(agents.modeForStartedSession('claude', 'default', 'codex'), 'plan');
  assert.equal(agents.modeForStartedSession('codex', 'default', 'opencode'), 'acceptEdits');
  assert.equal(agents.modeForStartedSession('opencode', 'toString', 'claude'), 'plan', 'a name off the object is no mode');
});

test('review models: Claude Code takes its named models, the others a model name, and nothing else is kept', () => {
  assert.equal(agents.reviewModelOk('claude', 'sonnet'), true);
  assert.equal(agents.reviewModelOk('claude', 'gpt-5'), false);
  assert.equal(agents.reviewModelOk('codex', 'gpt-5.5'), true);
  assert.equal(agents.reviewModelOk('opencode', 'openai/gpt-5'), true);
  assert.equal(agents.reviewModelOk('codex', 'gpt 5; rm -rf'), false, 'never a space or a shell character');
  assert.equal(agents.reviewModelOk('opencode', `anthropic/sk-ant-api03-${'a'.repeat(40)}`), false, 'a key in the model position of provider/model');
  assert.equal(agents.reviewModelOk('opencode', `openai/ghp_${'a'.repeat(36)}`), false);
  assert.equal(agents.reviewModelOk('opencode', 'openai/gpt-5'), true);
  assert.equal(agents.reviewModelOk('codex', ''), false, 'empty is no pick');
  assert.equal(agents.reviewModelOk('nobody', 'x'), false);
  assert.deepEqual(agents.reviewModelsOf({ codex: 'gpt-5.5', claude: 'opus', grok: 'bad model', other: 'x', __proto__: { opencode: 'a/b' } }), { claude: 'opus', codex: 'gpt-5.5' }, 'in the registry\'s order, the misshapen and unknown left out');
  assert.deepEqual(agents.reviewModelsOf(['claude']), {});
  assert.equal(agents.reviewModelsText({ codex: 'gpt-5.5', claude: 'sonnet' }), 'claude=sonnet codex=gpt-5.5');
  assert.deepEqual(agents.parseReviewModels('claude=sonnet, codex=gpt-5.5'), { claude: 'sonnet', codex: 'gpt-5.5' });
  assert.equal(agents.parseReviewModels('claude=sonnet,claude=opus'), null);
  assert.equal(agents.parseReviewModels('claude'), null);
  assert.deepEqual(agents.REVIEW_DEFAULT_MODELS, { claude: 'opus' });
});
