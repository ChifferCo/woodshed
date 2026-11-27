import { test } from 'node:test';
import assert from 'node:assert/strict';

import { announcesState, createStateAnnouncer } from './stateAnnounce.mjs';

// The hook's state file as a test holds it, and the console's answers to each call.
function setup({ answer = () => ({ ok: true, status: 204 }) } = {}) {
  const file = { mtimeMs: null, text: '' };
  const calls = [];
  const lines = [];
  const announcer = createStateAnnouncer({
    stateFile: '/tmp/state.json', consoleUrl: 'http://console.test:7691', token: 'tok',
    stat: async () => { if (file.mtimeMs === null) throw new Error('ENOENT'); return { mtimeMs: file.mtimeMs }; },
    readFile: async () => file.text,
    fetch: async (url, opts) => {
      calls.push({ url, method: opts.method, authorization: opts.headers.authorization, body: opts.body });
      const a = answer();
      if (a instanceof Error) throw a;
      return { ...a, body: null };
    },
    log: { log: (...a) => lines.push(['log', ...a]), warn: (...a) => lines.push(['warn', ...a]) },
  });
  const write = (state, at) => { file.mtimeMs = at; file.text = JSON.stringify({ state, event: 'x', at }); };
  return { announcer, calls, lines, write, file };
}

test('a new state in the hook\'s file is told to the console, with the token and nothing else', async () => {
  const { announcer, calls, write } = setup();
  assert.equal(await announcer.check(), 'none', 'no hook has fired yet');
  write('working', 1);
  assert.equal(await announcer.check(), 'told');
  assert.deepEqual(calls, [{ url: 'http://console.test:7691/state-changed', method: 'POST', authorization: 'Bearer tok', body: undefined }]);
  assert.equal(await announcer.check(), 'unchanged', 'the file not written since: not even read');
  write('working', 2);
  assert.equal(await announcer.check(), 'unchanged', 'another tool call, still working: nothing to tell');
  write('done', 3);
  assert.equal(await announcer.check(), 'told');
  write('needs-you', 4);
  assert.equal(await announcer.check(), 'told');
  assert.equal(calls.length, 3);
});

test('a file caught mid-write is read again at the next look', async () => {
  const { announcer, calls, file, write } = setup();
  file.mtimeMs = 1;
  file.text = '{"state": "wor';
  assert.equal(await announcer.check(), 'unchanged');
  write('working', 1);
  assert.equal(await announcer.check(), 'told', 'same time, read again since the first read failed');
  assert.equal(calls.length, 1);
});

test('a console that refuses or does not answer is not asked again for that change, and said so once', async () => {
  let answer = () => ({ ok: false, status: 404 });
  const { announcer, calls, lines, write } = setup({ answer: () => answer() });
  write('working', 1);
  assert.equal(await announcer.check(), 'failed');
  assert.equal(await announcer.check(), 'unchanged', 'the console still reads it at its tick');
  write('done', 2);
  assert.equal(await announcer.check(), 'failed');
  assert.deepEqual(lines.filter((l) => l[0] === 'warn').map((l) => l[2].message), ['the console answered 404'], 'once per reason');
  answer = () => new Error('fetch failed');
  write('working', 3);
  assert.equal(await announcer.check(), 'failed');
  answer = () => ({ ok: true, status: 204 });
  write('done', 4);
  assert.equal(await announcer.check(), 'told');
  assert.equal(calls.length, 4);
  assert.deepEqual(lines.map((l) => l[0]), ['warn', 'warn', 'log']);
});

test('only claude and Grok Build sessions announce, never a QA run, and only with the console\'s address and a token', () => {
  const session = { consoleUrl: 'http://console.test:7691', token: 'tok', agent: 'claude', qa: false };
  assert.equal(announcesState(session), true);
  assert.equal(announcesState({ ...session, agent: 'grok' }), true);
  for (const agent of ['codex', 'opencode']) assert.equal(announcesState({ ...session, agent }), false, `${agent} has no hooks`);
  assert.equal(announcesState({ ...session, qa: true }), false, 'a QA run\'s state is its script\'s');
  assert.equal(announcesState({ ...session, consoleUrl: '' }), false, 'no console to tell');
  assert.equal(announcesState({ ...session, token: '' }), false, 'nothing to sign the call with');
});
