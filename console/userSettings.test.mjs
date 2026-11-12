import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkClaudeToken, checkCodexAuth, createUserSettings, userSecretName } from './userSettings.mjs';

// The default project's env files, as installation.mjs reads them from its project file.
const ENV_FILE_PATHS = async () => ['api/.env', 'web/.env.local'];

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
  await settings.setClaudeToken('mia-dev', 'sk-ant-mia');
  await settings.removeAll('octocat');
  assert.deepEqual([...secrets.values.keys()], ['users/mia-dev/claude-token']);
  assert.deepEqual(Object.keys(store.state.people), ['mia-dev']);
  assert.equal(settings.view('octocat').setUp, false);
});

test('tmux is the image\'s file plus the person\'s own lines, kept apart by login; it is the only file', async () => {
  const secrets = fakeSecrets();
  const store = { state: {}, save() {} };
  const settings = createUserSettings({ store, secrets, now: () => Date.parse('2026-10-23T10:00:00Z') });

  const tmux = await settings.file('octocat', 'tmux-conf');
  assert.match(tmux.sharedText, /set -g mouse on/, 'tmux\'s shared file is the session image\'s own');
  assert.deepEqual([tmux.text, tmux.custom, tmux.editable, tmux.appended, tmux.label], ['', false, false, [], '~/.tmux.conf'], 'and the console cannot change it');

  await settings.saveFile('octocat', 'tmux-conf', 'set -g prefix C-a\r\n');
  assert.equal(secrets.values.get('users/octocat/tmux-conf'), 'set -g prefix C-a\n', 'only their own lines are kept');
  assert.equal(settings.view('octocat').files['tmux-conf'].savedAt, '2026-10-23T10:00:00.000Z');
  assert.deepEqual(await settings.ownFiles('octocat'), { 'tmux-conf': 'set -g prefix C-a\n' });
  assert.deepEqual(await settings.ownFiles('mia-dev'), { 'tmux-conf': null }, 'a teammate has none');
  await settings.resetFile('octocat', 'tmux-conf');
  assert.equal((await settings.ownFiles('octocat'))['tmux-conf'], null);

  await assert.rejects(settings.saveFile('octocat', 'tmux-conf', 'x'.repeat(70_000)), /64 KB/);
  for (const key of ['api-env', 'secrets']) {
    await assert.rejects(settings.file('octocat', key), /no file called/, `${key}: a repo's env files are its Repo settings`);
    await assert.rejects(settings.saveFile('octocat', key, 'X=1'), /no file called/);
  }
  assert.deepEqual(Object.keys(settings.view('octocat').files), ['tmux-conf']);
});

test('own lines an env file\'s secret kept before Repo settings are not read, and go with Remove My Woodshed', async () => {
  const secrets = fakeSecrets();
  secrets.values.set('api-env', 'LOG_LEVEL=info\n');
  secrets.values.set('users/octocat/api-env', 'LOG_LEVEL=debug\n');
  secrets.values.set('users/octocat/web-env', 'OLD=1\n');
  // The records a console from before left: one value saved, one cleared since.
  const store = { state: { people: { octocat: { files: { 'api-env': '2026-10-01T00:00:00.000Z', 'web-env': null, 'tmux-conf': null } } } }, save() {} };
  const settings = createUserSettings({ store, secrets });
  assert.deepEqual(Object.keys(settings.view('octocat').files), ['tmux-conf']);
  assert.deepEqual(await settings.ownFiles('octocat'), { 'tmux-conf': null }, 'a session is handed none of them');
  await settings.removeAll('octocat');
  assert.deepEqual([...secrets.values.keys()].sort(), ['api-env', 'users/octocat/web-env'], 'the saved one goes; the Terraform secret is not theirs');
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
  assert.equal(reads, 2, 'one refresh, its two reads');
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
  assert.equal(reads, 2, 'one refresh in the first minute, its claude-token and codex-auth reads');
  await settings.refresh('mia-dev');
  assert.equal(reads, 4, 'and one more once the minute is up');
});

test('a person\'s own whole files are one secret of theirs, kept by path, and an env file\'s path is refused', async () => {
  const secrets = fakeSecrets();
  const store = { state: {}, save() {} };
  let clock = Date.parse('2026-11-11T10:00:00Z');
  const settings = createUserSettings({ store, secrets, envFilePaths: ENV_FILE_PATHS, now: () => clock });

  assert.deepEqual(await settings.ownWholeFiles('octocat'), {}, 'none yet');
  assert.deepEqual(await settings.saveOwnFile('Octocat', ' app/.env.production ', 'NOTION_TOKEN=a\r\n'), { 'app/.env.production': 'NOTION_TOKEN=a\n' });
  clock += 60_000;
  await settings.saveOwnFile('octocat', '.mcp.local.json', '{}');
  assert.deepEqual(JSON.parse(secrets.values.get('users/octocat/own-files')), { 'app/.env.production': 'NOTION_TOKEN=a\n', '.mcp.local.json': '{}' });
  assert.deepEqual(settings.view('octocat').ownFiles, [
    { path: '.mcp.local.json', savedAt: '2026-11-11T10:01:00.000Z' },
    { path: 'app/.env.production', savedAt: '2026-11-11T10:00:00.000Z' },
  ], 'a save keeps the others\' times');
  assert.equal(JSON.stringify(store.state).includes('NOTION_TOKEN'), false, 'state.json never holds the text');
  assert.deepEqual(await settings.ownWholeFiles('mia-dev'), {}, 'nobody else\'s');

  for (const [file, message] of [['/etc/passwd', /leading/], ['../x', /\.\./], ['.git/config', /git's own/], ['a b', /letters/], ['api/.env', /env files/]]) {
    await assert.rejects(settings.saveOwnFile('octocat', file, 'x'), (err) => err.shown && message.test(err.message), file);
  }
  await assert.rejects(settings.saveOwnFile('octocat', 'big', 'x'.repeat(70_000)), /64 KB/);

  await settings.saveOwnFile('octocat', 'app/.env.production', '  ');
  await settings.saveOwnFile('octocat', '.mcp.local.json', '');
  assert.equal(secrets.values.has('users/octocat/own-files'), false, 'the last one removed takes the secret with it');
  assert.deepEqual(settings.view('octocat').ownFiles, []);

  await settings.saveOwnFile('octocat', 'a/.env', 'X=1');
  await settings.removeAll('octocat');
  assert.equal(secrets.values.size, 0, 'Remove My Woodshed deletes them too');
});
