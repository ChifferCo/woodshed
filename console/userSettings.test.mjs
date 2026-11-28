import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ownFilesBodyLimit } from '../shared/ownFiles.mjs';
import { checkClaudeToken, checkCodexAuth, createUserSettings, userSecretName } from './userSettings.mjs';
import { createReviewAgents } from './reviewAgents.mjs';
import { openServiceStore } from './store.mjs';
import agents from '../shared/agents.cjs';


function fakeSecrets() {
  const values = new Map();
  return {
    values,
    read: async (name) => values.get(name) ?? null,
    save: async (name, value) => { values.set(name, value); },
    remove: async (name) => { values.delete(name); },
  };
}

test('each person\'s Claude token is kept under their own login, and state.json holds only when', async () => {
  const secrets = fakeSecrets();
  const store = { state: {}, save() {} };
  const settings = createUserSettings({ store, secrets, now: () => Date.parse('2026-10-23T10:00:00Z') });

  await settings.setClaudeToken('Octocat', '  sk-ant-oat01-joel  ');
  assert.deepEqual([...secrets.values], [['users/octocat/claude-token', 'sk-ant-oat01-joel']]);
  assert.deepEqual(store.state.people, { octocat: { claudeTokenAt: '2026-10-23T10:00:00.000Z' } });
  assert.equal(JSON.stringify(store.state).includes('sk-ant'), false, 'never the value');
  const view = settings.view('octocat');
  assert.deepEqual(view.claudeToken, { set: true, savedAt: '2026-10-23T10:00:00.000Z' });
  assert.deepEqual([view.setUp, view.available, view.files['tmux-conf'].custom], [true, true, false]);

  assert.equal(await settings.claudeToken('octocat'), 'sk-ant-oat01-joel');
  assert.equal(await settings.claudeToken('mia-dev'), null, 'someone with nothing saved');
  assert.equal(settings.view('mia-dev').claudeToken.set, false);

  await settings.removeClaudeToken('octocat');
  assert.equal(secrets.values.size, 0);
  assert.equal(await settings.claudeToken('octocat'), null);
});

test('a token must look like one from claude setup-token, and the error never repeats it', () => {
  assert.equal(checkClaudeToken('sk-ant-oat01-abc\n'), 'sk-ant-oat01-abc');
  assert.equal(checkClaudeToken('  sk-ant-oat01-ab\n  cd-ef\r\n gh '), 'sk-ant-oat01-abcd-efgh', 'a copy wrapped across terminal lines');
  for (const bad of ['', '   ', 'ghp_123', 'sk ant-ab', 42]) {
    assert.throws(() => checkClaudeToken(bad), (err) => err.shown && !String(err.message).includes(String(bad).trim() || '\u0000'), String(bad));
  }
  assert.equal(userSecretName('Mia-Dev', 'claude-token'), 'users/mia-dev/claude-token');
});

test('without Secrets Manager nothing can be saved, and the page says so', async () => {
  const settings = createUserSettings({ store: { state: {}, save() {} }, secrets: null });
  assert.equal(settings.view('octocat').available, false);
  await assert.rejects(settings.setClaudeToken('octocat', 'sk-ant-x'), /no secret store/);
  assert.equal(await settings.claudeToken('octocat'), null);
});

test('removing everything deletes the person\'s secrets and their record, and leaves others alone', async () => {
  const secrets = fakeSecrets();
  const store = { state: {}, save() {} };
  const settings = createUserSettings({ store, secrets });
  await settings.setClaudeToken('octocat', 'sk-ant-joel');
  await settings.setAgentAuth('octocat', 'grok', 'xai-joel-key-0123456789abcdef');
  await settings.setClaudeToken('mia-dev', 'sk-ant-mia');
  await settings.removeAll('octocat');
  assert.deepEqual([...secrets.values.keys()], ['users/mia-dev/claude-token']);
  assert.deepEqual(Object.keys(store.state.people), ['mia-dev']);
  assert.equal(settings.view('octocat').setUp, false);
});

test('tmux is the image\'s file plus the person\'s own lines, kept apart by login', async () => {
  const secrets = fakeSecrets();
  const store = { state: {}, save() {} };
  const settings = createUserSettings({ store, secrets, now: () => Date.parse('2026-10-23T10:00:00Z') });

  const tmux = await settings.file('octocat', 'tmux-conf');
  assert.deepEqual([tmux.text, tmux.custom, tmux.label, tmux.editable, tmux.appended], ['', false, '~/.tmux.conf', false, []]);
  assert.match(tmux.sharedText, /set -g mouse on/, 'tmux\'s shared file is the session image\'s own');

  await settings.saveFile('octocat', 'tmux-conf', 'set -g prefix C-a\r\n');
  assert.equal(secrets.values.get('users/octocat/tmux-conf'), 'set -g prefix C-a\n', 'only their own lines are kept');
  assert.equal((await settings.file('octocat', 'tmux-conf')).custom, true);
  assert.equal(settings.view('octocat').files['tmux-conf'].savedAt, '2026-10-23T10:00:00.000Z');
  const none = { 'tmux-conf': null, gitconfig: null, inputrc: null, 'bash-aliases': null };
  assert.deepEqual(await settings.ownFiles('octocat'), { ...none, 'tmux-conf': 'set -g prefix C-a\n' });
  assert.deepEqual(await settings.ownFiles('mia-dev'), none, 'a teammate has none');

  await settings.saveFile('octocat', 'tmux-conf', '  \n');
  assert.equal(secrets.values.has('users/octocat/tmux-conf'), false, 'saving nothing clears their lines');
  await settings.saveFile('octocat', 'tmux-conf', 'set -g prefix C-a');
  await settings.resetFile('octocat', 'tmux-conf');
  assert.equal((await settings.ownFiles('octocat'))['tmux-conf'], null);

  await assert.rejects(settings.saveFile('octocat', 'tmux-conf', 'x'.repeat(70_000)), /64 KB/);
  await assert.rejects(settings.file('octocat', 'secrets'), /no file called/);
  await assert.rejects(settings.saveFile('octocat', 'constructor', 'fixture'), /no file called constructor/);
  await settings.saveFile('octocat', 'tmux-conf', 'set -g mouse off');
  await settings.removeAll('octocat');
  assert.equal(secrets.values.size, 0, 'Remove deletes the files too');
});

test('Remove My Woodshed deletes own lines left from the env file tabs before Repo settings, which only the record names', async () => {
  const secrets = fakeSecrets();
  const store = { state: { people: { octocat: { files: { 'api-env': '2026-10-01T00:00:00.000Z', 'web-env': null } } } }, save() {} };
  await secrets.save('users/octocat/api-env', 'OWN_KEY=1', '');
  await secrets.save('users/mia-dev/api-env', 'HERS=1', '');
  const settings = createUserSettings({ store, secrets });
  await settings.removeAll('octocat');
  assert.equal(secrets.values.has('users/octocat/api-env'), false, 'the old lines go with the record that named them');
  assert.equal(secrets.values.has('users/mia-dev/api-env'), true, 'nobody else\'s');
  assert.equal(store.state.people.octocat, undefined);
});

test('the switch for shared sessions is on by default, needs a token, is in effect only while one is saved, and goes with Remove', async () => {
  const secrets = fakeSecrets();
  const store = { state: {}, save() {} };
  const settings = createUserSettings({ store, secrets });
  assert.throws(() => settings.setOwnTokenForShared('joel', true), /save your Claude token first/);
  assert.equal(settings.usesOwnTokenForShared('joel'), false);

  await settings.setClaudeToken('joel', 'sk-ant-oat01-joel');
  assert.deepEqual([settings.view('joel').ownTokenForShared, settings.usesOwnTokenForShared('Joel')], [true, true], 'on by default');
  settings.setOwnTokenForShared('joel', false);
  assert.deepEqual([settings.view('joel').ownTokenForShared, settings.usesOwnTokenForShared('joel')], [false, false]);

  await settings.removeClaudeToken('joel');
  await settings.setClaudeToken('joel', 'sk-ant-oat01-joel2');
  assert.equal(settings.usesOwnTokenForShared('joel'), false, 'turned off stays off for the next token');
  settings.setOwnTokenForShared('joel', true);
  await settings.removeClaudeToken('joel');
  assert.equal(settings.usesOwnTokenForShared('joel'), false, 'no token, no effect');
  assert.equal(settings.view('joel').ownTokenForShared, true, 'the choice is kept for the next token');
  settings.setOwnTokenForShared('joel', false);
  await settings.removeAll('joel');
  assert.equal(settings.view('joel').ownTokenForShared, true, 'back to the default');
});

test('the switch for reviews on your own Codex sign-in is on by default once one is saved, and in effect only while one is', async () => {
  const settings = createUserSettings({ store: { state: {}, save() {} }, secrets: fakeSecrets() });
  assert.equal(settings.usesOwnCodexForReviews('joel'), false, 'nothing saved, nothing used');
  assert.throws(() => settings.setOwnCodexForReviews('joel', true), /save your Codex sign-in first/);
  await settings.setCodexAuth('joel', 'sk-joel-own-key');
  assert.deepEqual([settings.view('joel').ownCodexForReviews, settings.usesOwnCodexForReviews('Joel')], [true, true], 'on by default');
  settings.setOwnCodexForReviews('joel', false);
  assert.deepEqual([settings.view('joel').ownCodexForReviews, settings.usesOwnCodexForReviews('joel')], [false, false], 'turned off');
  settings.setOwnCodexForReviews('joel', true);
  await settings.removeCodexAuth('joel');
  assert.equal(settings.usesOwnCodexForReviews('joel'), false, 'no sign-in, no effect');
});

test('the switches for reviews on your own Grok Build and OpenCode sign-ins work as Codex\'s, each its own', async (t) => {
  t.mock.method(console, 'log', () => {});
  const settings = createUserSettings({ store: { state: {}, save() {} }, secrets: fakeSecrets() });
  assert.equal(settings.usesOwnAgentForReviews('joel', 'grok'), false, 'nothing saved, nothing used');
  assert.throws(() => settings.setOwnAgentForReviews('joel', 'grok', true), /save your Grok Build sign-in first/);
  assert.throws(() => settings.setOwnAgentForReviews('joel', 'codex', true), /no own sign-in for codex/);
  await settings.setAgentAuth('joel', 'grok', 'xai-made-up-joel-0123456789');
  assert.deepEqual(settings.view('joel').ownAgentForReviews, { grok: true, opencode: false }, 'on by default once saved');
  settings.setOwnAgentForReviews('joel', 'grok', false);
  assert.deepEqual([settings.view('joel').ownAgentForReviews.grok, settings.usesOwnAgentForReviews('Joel', 'grok')], [false, false], 'turned off');
  settings.setOwnAgentForReviews('joel', 'grok', true);
  await settings.removeAgentAuth('joel', 'grok');
  assert.equal(settings.usesOwnAgentForReviews('joel', 'grok'), false, 'no sign-in, no effect');
});

test('a Grok Build or OpenCode sign-in already saved keeps the previous review default until reviews is set back to it', (t) => {
  t.mock.method(console, 'log', () => {});
  const store = {
    state: {
      people: {
        joel: { agentAuthAt: { grok: '2026-01-01T00:00:00.000Z' } },
        mia: { claudeTokenAt: '2026-01-01T00:00:00.000Z' },
      },
    },
    save() {},
  };
  const settings = createUserSettings({ store, secrets: fakeSecrets() });
  assert.equal(store.state.reviewDefaultKept, true);
  assert.equal(store.state.people.joel.reviewDefault, 'legacy');
  assert.equal(store.state.people.mia.reviewDefault, undefined, 'no Grok Build or OpenCode sign-in: nothing to keep');
  assert.equal(settings.usesExpandedReviewDefault('joel'), false);
  assert.equal(settings.usesExpandedReviewDefault('mia'), true);
  assert.equal(settings.usesExpandedReviewDefault('new'), true, 'someone with no record gets the wider default');
  assert.equal(settings.view('joel').expandedReviewDefault, false);
  settings.setReviewAgents('joel', 'both');
  assert.equal(settings.usesExpandedReviewDefault('joel'), false, 'a saved choice does not accept the wider default');
  settings.setReviewAgents('joel', null);
  assert.equal(settings.usesExpandedReviewDefault('joel'), true);
  assert.equal(store.state.people.joel.reviewDefault, 'all');
  store.state.people.neo = { agentAuthAt: { opencode: '2026-02-01T00:00:00.000Z' } };
  createUserSettings({ store, secrets: fakeSecrets() });
  assert.equal(store.state.people.neo.reviewDefault, undefined, 'a sign-in saved after the first start joins the wider default');
});

test('a review choice is a preset or reviewers joined with +, saved in the registry\'s order', (t) => {
  t.mock.method(console, 'log', () => {});
  const settings = createUserSettings({ store: { state: {}, save() {} }, secrets: fakeSecrets() });
  settings.setReviewAgents('joel', 'opencode+claude');
  assert.equal(settings.reviewAgents('joel'), 'claude+opencode');
  settings.setReviewAgents('joel', 'codex+claude');
  assert.equal(settings.reviewAgents('joel'), 'both', 'a preset\'s name where one fits');
  assert.throws(() => settings.setReviewAgents('joel', 'grok+mystery'), (err) => err.status === 400 && /reviewers joined with \+/.test(err.message));
  settings.setReviewAgents('joel', null);
  assert.equal(settings.reviewAgents('joel'), null);
});

test('My settings\' files are tmux-conf and three dotfiles: an env file\'s own lines are Repo settings', async () => {
  const settings = createUserSettings({ store: { state: {}, save() {} }, secrets: fakeSecrets() });
  const view = settings.view('mia');
  assert.deepEqual(Object.entries(view.files).map(([key, f]) => [key, f.label]),
    [['tmux-conf', '~/.tmux.conf'], ['gitconfig', '~/.gitconfig'], ['inputrc', '~/.inputrc'], ['bash-aliases', '~/.bash_aliases']]);
  await assert.rejects(settings.file('mia', 'api-env'), /no file called api-env/);
  await assert.rejects(settings.saveFile('mia', 'api-env', 'A=1'), /no file called api-env/);
});

test('a Codex sign-in is an API key or a codex auth.json, kept under the person\'s login', async () => {
  const secrets = fakeSecrets();
  const store = { state: {}, save() {} };
  const settings = createUserSettings({ store, secrets, now: () => Date.parse('2026-11-07T10:00:00Z') });
  const auth = JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: 'rt-1', access_token: 'at-1' } });

  await settings.setCodexAuth('Octocat', ` ${auth}\n`);
  assert.deepEqual([...secrets.values.keys()], ['users/octocat/codex-auth']);
  assert.equal(await settings.codexAuth('octocat'), auth);
  assert.deepEqual(settings.view('octocat').codexAuth, { set: true, savedAt: '2026-11-07T10:00:00.000Z' });
  assert.equal(JSON.stringify(store.state).includes('rt-1'), false, 'never the value');
  assert.equal(await settings.codexAuth('mia-dev'), null);

  await settings.removeCodexAuth('octocat');
  assert.equal(await settings.codexAuth('octocat'), null);
  assert.equal(settings.view('octocat').codexAuth.set, false);
});

test('Grok Build and OpenCode sign-ins are each kept under the person\'s login, never in state.json', async (t) => {
  t.mock.method(console, 'log', () => {});
  const secrets = fakeSecrets();
  const store = { state: {}, save() {} };
  const settings = createUserSettings({ store, secrets, now: () => Date.parse('2026-11-23T10:00:00Z') });
  const grok = JSON.stringify({ 'https://auth.x.ai::b1a00492': { key: 'grok-at-1', refresh_token: 'grok-rt-1', auth_mode: 'oidc' } });
  const opencode = JSON.stringify({ anthropic: { type: 'api', key: 'sk-ant-api-1' } });
  await settings.setAgentAuth('Octocat', 'grok', ` ${grok}\n`);
  await settings.setAgentAuth('octocat', 'opencode', opencode);
  assert.deepEqual([...secrets.values.keys()], ['users/octocat/grok-auth', 'users/octocat/opencode-auth']);
  assert.equal(await settings.agentAuth('octocat', 'grok'), grok);
  assert.equal(await settings.agentAuth('octocat', 'opencode'), opencode);
  assert.deepEqual(settings.view('octocat').agentAuth, {
    grok: { set: true, savedAt: '2026-11-23T10:00:00.000Z' },
    opencode: { set: true, savedAt: '2026-11-23T10:00:00.000Z' },
    antigravity: { set: false, savedAt: null },
  });
  assert.equal(/grok-rt|sk-ant/.test(JSON.stringify(store.state)), false, 'never the value');
  assert.equal(await settings.agentAuth('mia-dev', 'grok'), null);
  await settings.removeAgentAuth('octocat', 'grok');
  assert.equal(await settings.agentAuth('octocat', 'grok'), null);
  assert.deepEqual([settings.view('octocat').agentAuth.grok.set, settings.view('octocat').agentAuth.opencode.set], [false, true]);
  await assert.rejects(settings.setAgentAuth('octocat', 'codex', 'sk-x'), /no own sign-in for codex/);
  await assert.rejects(settings.setAgentAuth('octocat', 'grok', 'not a key hunter2'), (err) => err.shown && !err.message.includes('hunter2'));
  await assert.rejects(settings.setAgentAuth('octocat', 'opencode', '{"x":{"type":"magic"}}'), /OpenCode auth.json/);
});

test('a command-line reviews deny is taken back when the secret write throws', async () => {
  const secrets = fakeSecrets();
  const store = { state: { reviewDefaultKept: true, people: { mia: { reviewDefault: 'all', agentAuthAt: { opencode: '2026-11-01T00:00:00.000Z' } } } }, save() {} };
  const settings = createUserSettings({ store, secrets, now: () => Date.parse('2026-11-25T00:00:00Z') });
  // OpenCode's switch is turned off while this upload's secret write is in flight. The failure puts back only Grok's flag.
  secrets.save = async () => {
    settings.setOwnAgentForReviews('mia', 'opencode', false);
    throw new Error('store down');
  };
  await assert.rejects(settings.setAgentAuth('mia', 'grok', 'xai-made-up-mia-0123456789', { reviews: false }), /store down/);
  assert.equal(store.state.people.mia.agentAuthAt?.grok, undefined);
  assert.equal(store.state.people.mia.ownAgentForReviews.grok, undefined, 'the failed upload\'s own flag is taken back');
  assert.equal(store.state.people.mia.ownAgentForReviews.opencode, false, 'the other agent\'s switch stays off');
  secrets.values.set('users/mia/opencode-auth', '{"openai":{"type":"api","key":"sk-openai-made-up"}}');
  const reviews = createReviewAgents({ userSettings: settings, connected: async () => ({ claude: true, codex: true }) });
  assert.deepEqual((await reviews.forReview({ login: 'mia' })).agents, ['claude', 'codex']);
  assert.equal(secrets.values.has('users/mia/grok-auth'), false);
});

test('a command-line sign-in is not saved when the service store rejects the reviews-off write', async (t) => {
  t.mock.method(console, 'error', () => {});
  const store = await openServiceStore({
    load: async () => ({ reviewDefaultKept: true, people: { mia: { reviewDefault: 'all' } } }),
    save: async () => { throw new Error('down'); },
  }, { retryMs: 60_000 });
  t.after(() => store.close());
  const saved = [];
  const secrets = { read: async () => null, save: async (name) => { saved.push(name); }, remove: async () => {} };
  const settings = createUserSettings({ store, secrets, now: () => Date.parse('2026-11-25T00:00:00Z') });
  await assert.rejects(settings.setAgentAuth('mia', 'grok', 'xai-made-up-mia-0123456789', { reviews: false }), /reviews switch could not be saved/);
  assert.deepEqual(saved, [], 'the secret is not written when the deny did not land');
});

test('a command-line sign-in is not saved when the service store has already closed', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const persisted = [];
  const store = await openServiceStore({
    load: async () => ({ reviewDefaultKept: true, people: { mia: { reviewDefault: 'all' } } }),
    save: async (state) => { persisted.push(structuredClone(state)); },
  });
  await store.close();
  const saved = [];
  const secrets = { read: async () => null, save: async (name) => { saved.push(name); }, remove: async () => {} };
  const settings = createUserSettings({ store, secrets, now: () => Date.parse('2026-11-25T00:00:00Z') });
  await assert.rejects(settings.setAgentAuth('mia', 'grok', 'xai-made-up-mia-0123456789', { reviews: false }), /reviews switch could not be saved/);
  assert.deepEqual(saved, [], 'the secret is not written when the store has closed');
  assert.equal(persisted.length, 0, 'a closed store does not take the reviews-off write');
});

test('a command-line reviews deny is durable on the service store before the secret is saved', async () => {
  let release;
  const open = new Promise((resolve) => { release = resolve; });
  let held;
  const persisted = [];
  const store = await openServiceStore({
    load: async () => ({ reviewDefaultKept: true, people: { mia: { reviewDefault: 'all' } } }),
    save: async (state) => {
      persisted.push(structuredClone(state));
      if (persisted.length === 1) {
        held();
        await open;
      }
    },
  });
  const gate = new Promise((resolve) => { held = resolve; });
  const values = new Map();
  let secretsWhenSaved = null;
  const secrets = {
    values,
    read: async (name) => values.get(name) ?? null,
    save: async (name, value) => {
      secretsWhenSaved = persisted.length;
      values.set(name, value);
    },
    remove: async (name) => { values.delete(name); },
  };
  const settings = createUserSettings({ store, secrets, now: () => Date.parse('2026-11-25T00:00:00Z') });
  const pending = settings.setAgentAuth('mia', 'grok', 'xai-made-up-mia-0123456789', { reviews: false });
  try {
    await gate;
    assert.equal(values.size, 0, 'the secret waits until the reviews-off write has finished');
  } finally {
    release();
  }
  await pending;
  assert.equal(secretsWhenSaved, 1, 'the secret is saved once the reviews-off write has been accepted');
  const atSecret = persisted[0];
  assert.equal(atSecret.people.mia.ownAgentForReviews.grok, false);
  assert.equal(atSecret.people.mia.agentAuthAt?.grok, undefined);
  assert.equal(atSecret.people.mia.reviewDefault, 'all');
  const restarted = createUserSettings({ store: { state: structuredClone(atSecret), save() {} }, secrets, now: () => Date.parse('2026-11-25T00:00:00Z') });
  await restarted.refresh('mia', { force: true });
  assert.equal(restarted.usesExpandedReviewDefault('mia'), true);
  assert.equal(restarted.usesOwnAgentForReviews('mia', 'grok'), false);
  const reviews = createReviewAgents({ userSettings: restarted, connected: async () => ({ claude: true, codex: true }) });
  assert.deepEqual((await reviews.forReview({ login: 'mia' })).agents, ['claude', 'codex'], 'a restart after the secret lands does not put Grok Build in the default');
});

test('a Grok Build or OpenCode sign-in found in the store after startup stays on the previous review default', async (t) => {
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args));
  const secrets = fakeSecrets();
  // The one-time mark already ran, on a record that did not know about the sign-in yet: the old release wrote it
  // straight into the store, and this console had not looked it up.
  const store = { state: { reviewDefaultKept: true, people: {} }, save() {} };
  const settings = createUserSettings({ store, secrets, now: () => Date.parse('2026-11-25T00:00:00Z') });
  secrets.values.set('users/joel/grok-auth', 'xai-made-up-joel-0123456789');
  await settings.refresh('joel', { force: true });
  assert.equal(store.state.people.joel.reviewDefault, 'legacy');
  assert.equal(settings.usesExpandedReviewDefault('joel'), false);
  assert.equal(settings.view('joel').expandedReviewDefault, false);
  assert.equal(settings.view('joel').agentAuth.grok.set, true);
  const followed = lines.find((args) => args[0] === 'userSettings: sign-ins follow the secret store');
  assert.equal(followed?.[1]?.reviewDefault, 'legacy');
  assert.equal(JSON.stringify(followed).includes('xai-'), false, 'the log never carries the sign-in');

  await settings.setAgentAuth('mia', 'grok', 'xai-made-up-mia-0123456789');
  await settings.refresh('mia', { force: true });
  assert.equal(store.state.people.mia.reviewDefault, undefined, 'a save on My settings after the mark joins the wider default');
  assert.equal(settings.usesExpandedReviewDefault('mia'), true);

  // A different sign-in written straight into the store afterwards is still uncached. It keeps the previous default
  // until she accepts the wider one, which also takes the sign-in she saved back out until then.
  secrets.values.set('users/mia/opencode-auth', '{"openai":{"type":"api","key":"sk-x"}}');
  await settings.refresh('mia', { force: true });
  assert.equal(store.state.people.mia.reviewDefault, 'legacy');
  assert.equal(settings.usesExpandedReviewDefault('mia'), false);
  assert.equal(settings.view('mia').agentAuth.opencode.set, true);

  // The upgrade order the mark misses: Grok was already in the store, with no metadata, and OpenCode is saved through
  // My settings before the first refresh. That save must not hide the uncached Grok sign-in.
  secrets.values.set('users/ada/grok-auth', 'xai-made-up-ada-0123456789');
  await settings.setAgentAuth('ada', 'opencode', '{"openai":{"type":"api","key":"sk-x"}}');
  assert.equal(store.state.people.ada.reviewDefault, undefined, 'saving one sign-in does not look the other up');
  await settings.refresh('ada', { force: true });
  assert.equal(store.state.people.ada.reviewDefault, 'legacy');
  assert.equal(settings.usesExpandedReviewDefault('ada'), false);
  assert.equal(settings.view('ada').agentAuth.grok.set, true);
  assert.equal(settings.view('ada').agentAuth.opencode.set, true);
  assert.equal(JSON.stringify(lines).includes('xai-made-up-ada'), false, 'the log never carries the sign-in');

  settings.setReviewAgents('joel', null);
  assert.equal(store.state.people.joel.reviewDefault, 'all');
  secrets.values.set('users/joel/opencode-auth', '{"openai":{"type":"api","key":"sk-x"}}');
  await settings.refresh('joel', { force: true });
  assert.equal(store.state.people.joel.reviewDefault, 'all', 'accepting the wider default is not undone by a sign-in found later');
  assert.equal(settings.usesExpandedReviewDefault('joel'), true);

  secrets.values.set('users/neo/claude-token', 'sk-ant-oat01-neo');
  secrets.values.set('users/neo/codex-auth', 'sk-neo');
  await settings.refresh('neo', { force: true });
  assert.equal(store.state.people.neo.reviewDefault, undefined, 'a Claude token or Codex sign-in never keeps the previous default');
  assert.equal(settings.usesExpandedReviewDefault('neo'), true);
});

test('an own sign-in written straight into the store counts as set, as a Claude token does', async (t) => {
  t.mock.method(console, 'log', () => {});
  const secrets = fakeSecrets();
  const settings = createUserSettings({ store: { state: {}, save() {} }, secrets, now: () => 1_000_000 });
  secrets.values.set('users/mia-dev/opencode-auth', '{"openai":{"type":"api","key":"sk-x"}}');
  await settings.refresh('mia-dev', { force: true });
  assert.deepEqual(settings.view('mia-dev').agentAuth.opencode.set, true);
  assert.deepEqual(settings.view('mia-dev').agentAuth.grok.set, false);
  secrets.values.delete('users/mia-dev/opencode-auth');
  await settings.refresh('mia-dev', { force: true });
  assert.deepEqual(settings.view('mia-dev').agentAuth.opencode.set, false);
});

test('a Codex sign-in is checked, and the error never repeats it', () => {
  assert.equal(checkCodexAuth(' sk-proj-abc '), 'sk-proj-abc');
  assert.equal(checkCodexAuth('{"OPENAI_API_KEY":"sk-x"}'), '{"OPENAI_API_KEY":"sk-x"}');
  assert.equal(checkCodexAuth('{"OPENAI_API_KEY":"sk-x"}%'), '{"OPENAI_API_KEY":"sk-x"}', 'zsh\'s no-newline mark, copied with the file');
  assert.equal(checkCodexAuth('{\n  "tokens": {"refresh_token": "r"}\n}%\n'), '{"tokens":{"refresh_token":"r"}}');
  for (const bad of ['', 'hunter2 hunter3', '{"nothing":1}', '[1]', 'sk-a b']) {
    assert.throws(() => checkCodexAuth(bad), (err) => err.shown && !err.message.includes('hunter'), bad);
  }
});

test('a person overrides the idle and lifetime hours of their own sessions, within the console settings ranges', () => {
  const store = { state: {}, save() {} };
  const settings = createUserSettings({ store, secrets: null });
  assert.deepEqual(settings.limitsFor('joel'), {});
  settings.setLimits('joel', { idleHours: 2, lifetimeHours: '12' });
  assert.deepEqual(settings.limitsFor('joel'), { idleMs: 2 * 3_600_000, lifetimeMs: 12 * 3_600_000 });
  assert.deepEqual(settings.view('joel').limits, { idleHours: 2, lifetimeHours: 12 });
  assert.deepEqual(settings.limitsFor('mia'), {}, 'nobody else');
  settings.setLimits('joel', { idleHours: '', lifetimeHours: 6 });
  assert.deepEqual(settings.limitsFor('joel'), { lifetimeMs: 6 * 3_600_000 }, 'an empty box is the console\'s number');
  assert.throws(() => settings.setLimits('joel', { idleHours: 30 }), /must be from 0.25 to 24/);
  assert.throws(() => settings.setLimits('joel', { lifetimeHours: 1.5 }), /steps of 1/);
  assert.deepEqual(settings.limitsFor('joel'), { lifetimeMs: 6 * 3_600_000 }, 'a refused save keeps what was');
  settings.setLimits('joel', {});
  assert.deepEqual(settings.limitsFor('joel'), {});
});

test('a Claude token or Codex sign-in written straight into the store counts as set, and one taken out of it does not', async (t) => {
  t.mock.method(console, 'log', () => {});
  const values = new Map();
  const secrets = { read: async (name) => values.get(name) ?? null, save: async (name, v) => { values.set(name, v); }, remove: async (name) => { values.delete(name); } };
  const store = { state: {}, save() {} };
  let clock = 1_000_000;
  const settings = createUserSettings({ store, secrets, now: () => clock });
  await settings.refresh('mia-dev');
  assert.equal(settings.view('mia-dev').setUp, false, 'nobody is set up by a look that found nothing');
  values.set('users/mia-dev/claude-token', 'sk-ant-host-wrote-it');
  values.set('users/mia-dev/codex-auth', 'sk-codex');
  clock += 2_500;
  await settings.refresh('mia-dev');
  assert.equal(settings.view('mia-dev').claudeToken.set, false, 'a page load inside the minute does not ask again');
  await settings.refresh('mia-dev', { force: true });
  assert.deepEqual([settings.view('mia-dev').claudeToken.set, settings.view('mia-dev').codexAuth.set], [true, true]);
  assert.equal(await settings.claudeToken('mia-dev'), 'sk-ant-host-wrote-it');
  assert.equal(settings.usesOwnTokenForShared('mia-dev'), true);
  values.delete('users/mia-dev/claude-token');
  clock += 10_000;
  await settings.refresh('mia-dev');
  assert.equal(settings.view('mia-dev').claudeToken.set, true, 'a set token is asked about once a minute');
  clock += 60_000;
  assert.equal(await settings.claudeToken('mia-dev'), null);
  assert.equal(settings.view('mia-dev').claudeToken.set, false);
});

test('a store that fails to answer changes nothing about what is set, and is not asked again inside the minute', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const store = { state: { people: { 'mia-dev': { claudeTokenAt: '2026-11-01T00:00:00.000Z' } } }, save() {} };
  let reads = 0;
  const settings = createUserSettings({ store, secrets: { read: async () => { reads += 1; throw new Error('throttled'); } } });
  await settings.refresh('mia-dev');
  assert.equal(settings.view('mia-dev').claudeToken.set, true);
  await settings.refresh('mia-dev');
  assert.equal(reads, 2 + agents.OWN_SIGN_IN_AGENTS.length, 'one refresh, a read for each sign-in: Claude, Codex and each own-sign-in agent');
});

test('with no token saved, page loads inside the minute ask the store once', async () => {
  let reads = 0;
  let clock = 1_000_000;
  const settings = createUserSettings({ store: { state: {}, save() {} }, secrets: { read: async () => { reads += 1; return null; } }, now: () => clock });
  assert.equal(settings.askedAbout('mia-dev'), false);
  for (let i = 0; i < 12; i += 1) {
    await settings.refresh('mia-dev');
    clock += 5_000;
  }
  const perRefresh = 2 + agents.OWN_SIGN_IN_AGENTS.length;
  assert.equal(reads, perRefresh, 'one refresh in the first minute, one read for each agent\'s sign-in');
  await settings.refresh('mia-dev');
  assert.equal(reads, 2 * perRefresh, 'and one more once the minute is up');
});

test('the own-files request body limit follows the store\'s limit, and never drops below 160 KB', () => {
  assert.equal(ownFilesBodyLimit(undefined), 160 * 1024);
  assert.equal(ownFilesBodyLimit(65_536), 160 * 1024);
  assert.equal(ownFilesBodyLimit(1_048_576), 2_621_440);
  assert.equal(ownFilesBodyLimit(1e12), 16 * 1024 * 1024);
});

// A pull request a console's App opened has the App as its author (`<slug>[bot]`), and review asks for its plan. An App
// has no sign-ins of its own, and `[bot]` is no name a secret store takes: Secrets Manager refused it with an error.
test('an App\'s login has no stored sign-ins, and its store is never asked', async () => {
  const asked = [];
  const secrets = { ...fakeSecrets(), read: async (name) => { asked.push(name); if (/\[|\]/.test(name)) throw new Error('ValidationException: Invalid name'); return null; } };
  const settings = createUserSettings({ store: { state: {}, save() {} }, secrets });
  assert.equal(await settings.claudeToken('acme-woodshed[bot]'), null);
  assert.equal(await settings.codexAuth('acme-woodshed[bot]'), null);
  assert.deepEqual(asked, [], 'no read for a bot');
  await settings.claudeToken('octocat');
  assert.ok(asked.includes(userSecretName('octocat', 'claude-token')), 'a person\'s is still read');
});

test('a dotfile\'s own lines are kept as tmux\'s are, and refused with the line and why when they hold what a session must not get', async () => {
  const secrets = fakeSecrets();
  const settings = createUserSettings({ store: { state: {}, save() {} }, secrets });
  const git = await settings.file('mia', 'gitconfig');
  assert.deepEqual([git.label, git.sharedText, git.custom], ['~/.gitconfig', '', false], 'the image has none of its own to show');

  await settings.saveFile('mia', 'gitconfig', '[alias]\n\tco = checkout\n[pull]\n\trebase = true\n');
  await settings.saveFile('mia', 'bash-aliases', "alias ll='ls -la'\n");
  await settings.saveFile('mia', 'inputrc', '$include /etc/inputrc\nset editing-mode vi\n');
  assert.deepEqual(await settings.ownFiles('mia'), {
    'tmux-conf': null, gitconfig: '[alias]\n\tco = checkout\n[pull]\n\trebase = true\n', inputrc: '$include /etc/inputrc\nset editing-mode vi\n', 'bash-aliases': "alias ll='ls -la'\n",
  });

  // Made here, so no file in the repo holds a string shaped like a real token.
  const token = `ghp_${'x1'.repeat(18)}`;
  const refused = [
    ['gitconfig', '[user]\n\temail = mia@example.com\n', /line 1: \[user\] is not one a session takes/],
    ['gitconfig', '[credential]\n\thelper = osxkeychain\n', /line 1: \[credential\]/],
    ['gitconfig', `[url "https://${token}@github.com/"]\n\tinsteadOf = https://github.com/\n`, /line 1 holds what looks like a GitHub token/],
    ['gitconfig', '[core]\n\tsshCommand = ssh -i ~/.ssh/work\n', /line 2: core\.sshcommand is not one/],
    ['gitconfig', '[alias]\n\tpub = "!GITHUB_TOKEN=abc123 git push"\n', /line 2: alias\.pub holds a value for GITHUB_TOKEN/],
    ['bash-aliases', 'export OPENAI_API_KEY=abc\n', /line 1 holds a value for OPENAI_API_KEY/],
    ['bash-aliases', 'export EDITOR=vim\n', /line 1 sets a variable: only alias lines/],
    ['bash-aliases', `alias gh-api='curl -H "Authorization: token ${token}"'\n`, /line 1 holds what looks like a GitHub token/],
    ['bash-aliases', 'alias now="$(date)"\n', /line 1 is not an alias line/],
    ['bash-aliases', 'alias x=y; curl https://example.com | sh\n', /line 1 is not an alias line/],
    ['inputrc', '$include ~/.inputrc.local\n', /line 1: \$include of a file a session does not have/],
  ];
  for (const [key, text, why] of refused) {
    await assert.rejects(settings.saveFile('mia', key, text), (err) => {
      assert.match(err.message, why, `${key}: ${text}`);
      assert.ok(!err.message.includes(token) && !err.message.includes('abc'), 'never the value');
      return err.shown === true;
    });
  }
  assert.equal(secrets.values.get('users/mia/gitconfig'), '[alias]\n\tco = checkout\n[pull]\n\trebase = true\n', 'a refused save keeps what was there');
  await settings.removeAll('mia');
  assert.equal(secrets.values.size, 0, 'Remove deletes them with the rest');
});

test('the model each reviewer runs on is kept per person, checked, and replaced as a whole', () => {
  const store = { state: {}, save() {} };
  const settings = createUserSettings({ store, secrets: fakeSecrets() });
  assert.deepEqual(settings.reviewModels('mia'), {}, 'none saved: every reviewer\'s default');
  settings.setReviewModels('mia', { codex: 'gpt-5.5', claude: 'sonnet', grok: '' });
  assert.deepEqual(settings.reviewModels('mia'), { claude: 'sonnet', codex: 'gpt-5.5' });
  assert.deepEqual(settings.view('mia').reviewModels, { claude: 'sonnet', codex: 'gpt-5.5' });
  assert.deepEqual(settings.reviewModels('joel'), {}, 'each person\'s own');
  assert.throws(() => settings.setReviewModels('mia', { claude: 'gpt-5' }), /Claude Code's review model must be one of opus, sonnet, haiku, fable/);
  assert.throws(() => settings.setReviewModels('mia', { codex: 'a b' }), (err) => err.shown && err.status === 400);
  assert.throws(() => settings.setReviewModels('mia', { nobody: 'x' }), /a review model is for one of/);
  assert.throws(() => settings.setReviewModels('mia', ['claude']), /models must be an object/);
  assert.deepEqual(settings.reviewModels('mia'), { claude: 'sonnet', codex: 'gpt-5.5' }, 'a refused save changes nothing');
  settings.setReviewModels('mia', {});
  assert.deepEqual(settings.reviewModels('mia'), {}, 'an empty object is every default again');
  settings.setReviewAgents('mia', 'codex');
  settings.setReviewModels('mia', { claude: 'haiku' });
  assert.equal(settings.reviewAgents('mia'), 'codex', 'picking models leaves who reviews alone');
});

test('a credential pasted into a review model box is refused and never logged', (t) => {
  const lines = [];
  t.mock.method(console, 'log', (...a) => lines.push(JSON.stringify(a)));
  const settings = createUserSettings({ store: { state: {}, save() {} }, secrets: fakeSecrets() });
  const pat = `ghp_${'a'.repeat(36)}`;
  assert.throws(() => settings.setReviewModels('mia', { codex: pat }), (err) => err.shown && !err.message.includes('ghp_'));
  assert.throws(() => settings.setReviewModels('mia', { codex: 'sk-ant-made-up-0123456789' }), /model must be/);
  assert.throws(() => settings.setReviewModels('mia', { opencode: `openai/glpat-${'a1'.repeat(10)}` }), /model must be/);
  assert.throws(() => settings.setReviewModels('mia', { grok: `AIza${'aB1'.repeat(11)}` }), /model must be/);
  settings.setReviewModels('mia', { codex: 'gpt-5.5' });
  assert.ok(lines.some((l) => l.includes('review models') && l.includes('"reviewers":["codex"]')));
  assert.ok(!lines.join('').includes('gpt-5.5') && !lines.join('').includes(pat), 'the log names reviewers, never a model');
});
