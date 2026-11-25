import { test } from 'node:test';
import assert from 'node:assert/strict';

import paste from './public/terminalPaste.cjs';

// A terminal frame's document as terminalPaste.bind sees it: listeners by event, a window with xterm, the clipboard and
// File, and events that record what was done to them.
function frame({ clipboard = undefined, connected = true } = {}) {
  const typed = [];
  const term = {
    options: { disableStdin: !connected },
    paste: (text) => typed.push({ paste: text }),
    input: (data) => typed.push({ input: data }),
    focus() {},
  };
  const listeners = {};
  const doc = {
    defaultView: { term, File: globalThis.File, navigator: { clipboard } },
    addEventListener: (type, fn) => (listeners[type] ??= []).push(fn),
  };
  const fire = (type, fields) => {
    const e = { ...fields, prevented: false, stopped: false, stoppedNow: false };
    e.preventDefault = () => { e.prevented = true; };
    e.stopPropagation = () => { e.stopped = true; };
    e.stopImmediatePropagation = () => { e.stoppedNow = true; };
    for (const fn of listeners[type] ?? []) fn(e);
    return e;
  };
  return { doc, term, typed, fire };
}

// statusd's answers, through the console: tmux types the path itself; Herdr says it did not.
function uploads(answers) {
  const asked = [];
  const upload = async (file, name) => {
    asked.push(name);
    const answer = answers[asked.length - 1];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { upload, asked };
}
const saved = (path, typed) => ({ ok: true, body: { path, bytes: 3, ...(typed === undefined ? {} : { typed }) } });
const png = (name = '') => new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test('a picture pasted on an agent in Herdr has its path typed through the terminal, with no Enter', async () => {
  const { doc, typed, fire } = frame();
  const { upload, asked } = uploads([saved('/tmp/uploads/1-pasted.png', false)]);
  const toasts = [];
  paste.bind(doc, { pane: 'agent', mac: false, upload, toast: (t) => toasts.push(t) });
  const e = fire('paste', { clipboardData: { files: [png()] } });
  await settle();
  assert.ok(e.prevented, 'the browser does not paste it too');
  assert.deepEqual(asked, ['pasted.png']);
  assert.deepEqual(typed, [{ paste: '/tmp/uploads/1-pasted.png ' }]);
  assert.ok(!typed.some((t) => /[\r\n]/.test(t.paste ?? t.input)), 'no Enter');
  assert.equal(toasts.at(-1), '1 path typed at the prompt: add your question and press enter');
});

test('a path statusd typed in tmux, or a statusd from before `typed`, is not typed again', async () => {
  for (const answer of [saved('/tmp/uploads/1-a.png', true), saved('/tmp/uploads/1-a.png', undefined)]) {
    const { doc, typed, fire } = frame();
    paste.bind(doc, { pane: 'agent', mac: false, upload: uploads([answer]).upload, toast() {} });
    fire('drop', { dataTransfer: { files: [png('a.png')] } });
    await settle();
    assert.deepEqual(typed, []);
  }
});

test('files saved before a later one failed still go in, and the toast says both', async () => {
  const { doc, typed, fire } = frame();
  const { upload } = uploads([saved('/tmp/uploads/1-a.png', false), { ok: false, body: { error: 'the file is empty' } }]);
  const toasts = [];
  paste.bind(doc, { pane: 'agent', mac: false, upload, toast: (t) => toasts.push(t) });
  fire('drop', { dataTransfer: { files: [png('a.png'), png('b.png')] } });
  await settle();
  assert.deepEqual(typed, [{ paste: '/tmp/uploads/1-a.png ' }]);
  assert.equal(toasts.at(-1), 'Not attached: the file is empty. 1 path typed at the prompt before it');
});

test('a terminal whose connection is down is not said to have the path: the toast names it', async () => {
  const { doc, typed, fire } = frame({ connected: false });
  const toasts = [];
  paste.bind(doc, { pane: 'agent', mac: false, upload: uploads([saved('/tmp/uploads/1-a.png', false)]).upload, toast: (t) => toasts.push(t) });
  fire('paste', { clipboardData: { files: [png('a.png')] } });
  await settle();
  assert.deepEqual(typed, []);
  assert.equal(toasts.at(-1), 'Saved in the session as /tmp/uploads/1-a.png: type its path at the prompt');
});

test('too many or too big files are refused before any upload', async () => {
  const { doc, fire } = frame();
  const { upload, asked } = uploads([]);
  const toasts = [];
  paste.bind(doc, { pane: 'agent', mac: false, upload, toast: (t) => toasts.push(t) });
  fire('drop', { dataTransfer: { files: Array.from({ length: 9 }, () => png('x.png')) } });
  fire('drop', { dataTransfer: { files: [{ name: 'huge.bin', size: 26 * 1024 * 1024, type: '' }] } });
  await settle();
  assert.deepEqual(asked, []);
  assert.deepEqual(toasts, ['At most 8 files at a time', 'huge.bin is over 25 MB']);
});

const ctrlV = (fields = {}) => ({ key: 'v', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, ...fields });

test('off a Mac, Ctrl+V in an agent\'s pane is kept from xterm and left to the browser\'s own paste', () => {
  const { doc, typed, fire } = frame();
  paste.bind(doc, { pane: 'agent', mac: false, upload: uploads([]).upload, toast() {} });
  const e = fire('keydown', ctrlV());
  assert.ok(e.stoppedNow, 'xterm never sees it, so it sends no ^V');
  assert.ok(!e.prevented, 'the browser pastes, and the paste listener or xterm takes it');
  assert.deepEqual(typed, []);
});

test('the Terminal tab\'s shell keeps Ctrl+V as ^V, and other keys are left alone', () => {
  const { doc, fire } = frame();
  paste.bind(doc, { pane: 'terminal', mac: true, upload: uploads([]).upload, toast() {} });
  const e = fire('keydown', ctrlV());
  assert.ok(!e.stoppedNow && !e.prevented);
  const agent = frame();
  paste.bind(agent.doc, { pane: 'agent', mac: true, upload: uploads([]).upload, toast() {} });
  for (const other of [ctrlV({ shiftKey: true }), ctrlV({ metaKey: true, ctrlKey: false }), ctrlV({ key: 'c' })]) {
    const k = agent.fire('keydown', other);
    assert.ok(!k.stoppedNow && !k.prevented, JSON.stringify(other));
  }
});

// The async clipboard as a browser gives it: items with types, each read as a Blob.
const item = (type, data) => ({ types: [type], getType: async () => new Blob([data], { type }) });

test('on a Mac, Ctrl+V reads the clipboard: a picture is attached, and its path typed through the terminal', async () => {
  const clipboard = { read: async () => [item('image/png', new Uint8Array([1, 2, 3]))] };
  const { doc, typed, fire } = frame({ clipboard });
  const { upload, asked } = uploads([saved('/tmp/uploads/1-pasted.png', false)]);
  paste.bind(doc, { pane: 'agent-2', mac: true, upload, toast() {} });
  const e = fire('keydown', ctrlV());
  assert.ok(e.stoppedNow && e.prevented);
  await settle();
  assert.deepEqual(asked, ['pasted.png']);
  assert.deepEqual(typed, [{ paste: '/tmp/uploads/1-pasted.png ' }]);
});

test('on a Mac, Ctrl+V of text pastes it, and a clipboard it may not read sends the agent ^V', async () => {
  const text = frame({ clipboard: { read: async () => [item('text/plain', 'hello there')] } });
  paste.bind(text.doc, { pane: 'agent', mac: true, upload: uploads([]).upload, toast() {} });
  text.fire('keydown', ctrlV());
  await settle();
  assert.deepEqual(text.typed, [{ paste: 'hello there' }]);

  const denied = frame({ clipboard: { read: async () => { throw new DOMException('denied', 'NotAllowedError'); } } });
  paste.bind(denied.doc, { pane: 'agent', mac: true, upload: uploads([]).upload, toast() {} });
  denied.fire('keydown', ctrlV());
  await settle();
  assert.deepEqual(denied.typed, [{ input: '\x16' }]);

  const old = frame({ clipboard: { readText: async () => 'only text here' } });
  paste.bind(old.doc, { pane: 'agent', mac: true, upload: uploads([]).upload, toast() {} });
  old.fire('keydown', ctrlV());
  await settle();
  assert.deepEqual(old.typed, [{ paste: 'only text here' }]);
});

test('on a Mac, a held Ctrl+V pastes once: its repeats read nothing and send no ^V', async () => {
  let reads = 0;
  const { doc, typed, fire } = frame({ clipboard: { read: async () => { reads++; return [item('text/plain', 'once')]; } } });
  paste.bind(doc, { pane: 'agent', mac: true, upload: uploads([]).upload, toast() {} });
  fire('keydown', ctrlV());
  const held = fire('keydown', ctrlV({ repeat: true }));
  fire('keydown', ctrlV({ repeat: true }));
  await settle();
  assert.ok(held.stoppedNow && held.prevented);
  assert.equal(reads, 1);
  assert.deepEqual(typed, [{ paste: 'once' }]);
});
