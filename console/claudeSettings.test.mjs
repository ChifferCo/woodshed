import assert from 'node:assert/strict';
import test from 'node:test';

import { createClaudeSettings, savedChoices } from './claudeSettings.mjs';

const b64 = (text) => Buffer.from(text).toString('base64');
const settings = (obj) => ({ '.claude/settings.json': b64(typeof obj === 'string' ? obj : JSON.stringify(obj)) });
const codex = (text) => ({ '.codex/config.toml': b64(text) });

function memoryStore(objects = new Map()) {
  let puts = 0;
  return {
    objects,
    get puts() { return puts; },
    getText: async (key) => objects.get(key) ?? null,
    putText: async (key, text) => { puts++; objects.set(key, text); },
    removeKey: async (key) => { objects.delete(key); },
  };
}

test('peek reads the copy as it is, and bumps or writes nothing', async () => {
  const store = memoryStore(new Map([['octocat/claude-settings.json', JSON.stringify({ version: 4, items: settings({ model: 'opus' }) })]]));
  const s = createClaudeSettings({ store });
  assert.deepEqual(await s.peek('octocat'), { version: 4, items: settings({ model: 'opus' }) });
  assert.equal(store.puts, 0, 'nothing is written');
  const peeked = await s.peek('octocat');
  peeked.items['.claude/settings.json'] = 'changed';
  assert.deepEqual((await s.peek('octocat')).items, settings({ model: 'opus' }), 'what it hands out is a copy');
  assert.deepEqual(await s.sync({ login: 'octocat', sessionId: 'aaaaaaaa', version: 4, changed: {}, removed: [] }), { version: 4 }, 'the version is the one sessions hold');

  assert.deepEqual(await s.peek('nobody'), { version: 0, items: {} }, 'no copy yet: empty');
});

test('peek throws when the saved copy is not JSON, for the caller to say so', async () => {
  const store = memoryStore(new Map([['octocat/claude-settings.json', '{not json']]));
  await assert.rejects(createClaudeSettings({ store }).peek('octocat'));
});

test('savedChoices: Claude Code\'s model and effortLevel from settings.json', () => {
  assert.deepEqual(savedChoices(settings({ model: 'opus', effortLevel: 'high', theme: 'dark' })).claude, { read: true, model: 'opus', effort: 'high' });
  assert.deepEqual(savedChoices(settings({ model: 'claude-opus-5-5[1m]' })).claude, { read: true, model: 'claude-opus-5-5[1m]', effort: null });
  assert.deepEqual(savedChoices(settings({ theme: 'dark' })).claude, { read: true, model: null, effort: null }, 'nothing saved: the agent picks');
  assert.deepEqual(savedChoices({}).claude, { read: true, model: null, effort: null }, 'no settings.json at all');
});

test('savedChoices: a settings.json that does not read, or names something odd, is not known', () => {
  const unread = { read: false, model: null, effort: null };
  assert.deepEqual(savedChoices(settings('{"model": "opus"')).claude, unread, 'bad JSON');
  assert.deepEqual(savedChoices(settings('[]')).claude, unread, 'not an object');
  assert.deepEqual(savedChoices(settings('null')).claude, unread);
  assert.deepEqual(savedChoices(settings({ model: 42 })).claude, unread, 'a model that is not text');
  assert.deepEqual(savedChoices(settings({ model: '<img src=x onerror=alert(1)>' })).claude, unread, 'never drawn as it is');
  assert.deepEqual(savedChoices(settings({ model: 'opus', effortLevel: 'very high' })).claude, unread, 'an effort that is no name');
  assert.deepEqual(savedChoices(null), { claude: unread, codex: unread }, 'the copy itself not read');
});

test('savedChoices: Codex\'s model and model_reasoning_effort from config.toml, its profile\'s first', () => {
  assert.deepEqual(savedChoices(codex('model = "gpt-5.5" # mine\nmodel_reasoning_effort = \'high\'\n[projects."/work/x"]\ntrust_level = "trusted"\n')).codex,
    { read: true, model: 'gpt-5.5', effort: 'high' });
  assert.deepEqual(savedChoices(codex('model = "gpt-5.5"\nprofile = "deep"\n[profiles.deep]\nmodel = "o3"\nmodel_reasoning_effort = "xhigh"\n')).codex,
    { read: true, model: 'o3', effort: 'xhigh' }, 'the profile codex starts on');
  assert.deepEqual(savedChoices(codex('model = "gpt-5.5"\nprofile = "light"\n[profiles.light]\nmodel_reasoning_effort = "low"\n')).codex,
    { read: true, model: 'gpt-5.5', effort: 'low' }, 'a profile with no model keeps the top level\'s');
  assert.deepEqual(savedChoices(codex('[profiles.deep]\nmodel = "o3"\n')).codex, { read: true, model: null, effort: null }, 'a profile not picked counts for nothing');
  assert.deepEqual(savedChoices(codex('approval_policy = "never"\n')).codex, { read: true, model: null, effort: null });
  assert.deepEqual(savedChoices({}).codex, { read: true, model: null, effort: null }, 'no config.toml');
});

test('savedChoices: a config.toml that does not read, or names no plain string, is not known', () => {
  const unread = { read: false, model: null, effort: null };
  assert.deepEqual(savedChoices(codex('model = "gpt-5.5\n')).codex, unread, 'unterminated string');
  assert.deepEqual(savedChoices(codex('[model\n')).codex, unread, 'a broken header');
  assert.deepEqual(savedChoices(codex('model = 5\n')).codex, unread, 'not a string');
  assert.deepEqual(savedChoices(codex('model = ["a", "b"]\n')).codex, unread);
  assert.deepEqual(savedChoices(codex('model = "has space"\n')).codex, unread, 'not a name');
  assert.deepEqual(savedChoices(codex('profile = 3\n')).codex, unread);
  assert.deepEqual(savedChoices(codex('model = "gpt-5.5"\nprofile = "deep"\n[profiles]\ndeep = { model = "o3" }\n')).codex, unread,
    'a profile written inline: its model is not the top level\'s');
  assert.deepEqual(savedChoices(codex('model = "gpt-5.5"\nprofile = "deep"\nprofiles.deep = { model = "o3" }\n')).codex, unread);
  assert.deepEqual(savedChoices(codex('model = "gpt-5.5"\nprofile = "deep"\nprofiles = { deep = { model = "o3" } }\n')).codex, unread);
  assert.deepEqual(savedChoices(codex('model = "gpt-5.5"\n[profiles]\ndeep = { model = "o3" }\n')).codex, { read: true, model: 'gpt-5.5', effort: null },
    'an inline profile not picked counts for nothing');
  assert.deepEqual(savedChoices({ ...settings({ model: 'opus' }), ...codex('model = 5\n') }).claude, { read: true, model: 'opus', effort: null },
    'one agent\'s file does not hide the other\'s');
});
