import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { PAGES, ENTRIES, search } = createRequire(import.meta.url)('./public/settingsIndex.cjs');
const titles = (q, opts) => search(q, opts).map((e) => e.title);

test('nothing typed lists every section, My settings first', () => {
  const all = search('');
  assert.equal(all.length, ENTRIES.length);
  assert.equal(all[0].page, '/settings');
});

test('the words people reach for find the section, in the right place', () => {
  assert.ok(titles('repo').includes('My repo settings'));
  assert.ok(titles('repo').includes('Repos the console runs sessions on'));
  assert.equal(search('token')[0].id, 'claude');
  assert.ok(titles('openai').includes('Codex sign-in'));
  assert.equal(search('timeout')[0].page, '/settings');
  assert.ok(titles('timeout').includes('Session limits for everyone'));
  assert.equal(search('ostgr')[0].id, 'my-databases', 'part of a word still matches');
  assert.equal(search('tmux')[0].id, 'my-tmux');
  assert.equal(search('slack channel')[0].id, 'card-slack');
  assert.equal(search('webhook')[0].page, '/secrets');
  assert.equal(search('invite')[0].id, 'invite-card');
});

test('every typed word has to match, and nonsense finds nothing', () => {
  assert.deepEqual(search('zzzzq'), []);
  assert.deepEqual(search('token zzzzq'), []);
  assert.ok(search('claude token').length <= search('token').length);
  assert.equal(search('  CLAUDE   Token ')[0].id, 'claude');
});

test('a page the person cannot open is left out', () => {
  const mine = search('', { allowed: (page) => !PAGES[page].admin });
  assert.ok(mine.length > 0 && mine.every((e) => e.page === '/settings'));
  assert.deepEqual(search('webhook', { allowed: (page) => page === '/settings' }), []);
});

test('each section has a card with its id in its page, so the link lands on it', () => {
  const source = { '/settings': ['mySettings.js', 'myRepoSettings.js'], '/console-settings': ['consoleSettings.js'], '/secrets': ['secrets.js'], '/people': ['people.js'], '/events': ['events.js'] };
  for (const e of ENTRIES) {
    assert.ok(PAGES[e.page], `${e.id}: unknown page ${e.page}`);
    const text = source[e.page].map((f) => readFileSync(new URL(`./public/${f}`, import.meta.url), 'utf8')).join('\n');
    // A card drawn from a list carries `card-${card.id}` (or `group-…`): the list must have that id.
    const drawn = e.id.match(/^(card|group)-(.+)$/);
    const literal = text.includes(`id: '${e.id}'`) || Boolean(drawn && text.includes(`id: \`${drawn[1]}-\${`) && text.includes(`id: '${drawn[2]}'`));
    assert.ok(literal, `${e.page} draws no element with id ${e.id}`);
  }
});
