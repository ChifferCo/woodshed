import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyPane,
  parseTranscriptTail,
  classifyStatus,
  compareSessions,
  STATUS_LABEL,
  STATUS_TIP,
} from './sessionState.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(HERE, '__fixtures__', name), 'utf-8');

// Every pane fixture is a verbatim `tmux capture-pane -p` of a real session on
// the box, kept byte-for-byte so the U+00A0 after the composer chevron and the
// U+2019 in "don’t ask again" are the real characters and not ASCII
// lookalikes. pane-remnant.txt is the one exception: a real *done* capture with
// real marker lines spliced into its body, which is the shape that cannot be
// produced on demand but is the failure the footer anchor exists to prevent.

test('a working pane is read from its footer hint', () => {
  assert.equal(classifyPane(fixture('pane-working.txt')), 'working');
});

test('a finished pane is done', () => {
  assert.equal(classifyPane(fixture('pane-done.txt')), 'done');
});

test('all three blocking dialogs are needs-you', () => {
  // Tool permission, the folder-trust gate at startup, and a question claude
  // asked. All three render through the same select component, so one matcher
  // covers them — but that was verified by capturing each, not assumed.
  assert.equal(classifyPane(fixture('pane-permission.txt')), 'needs-you');
  assert.equal(classifyPane(fixture('pane-folder-trust.txt')), 'needs-you');
  assert.equal(classifyPane(fixture('pane-askquestion.txt')), 'needs-you');
});

test('a pane that is not a claude session classifies as nothing', () => {
  // A bare shell has no composer box and no rule to anchor on. Returning null
  // rather than guessing is what lets the caller fall back to the transcript.
  assert.equal(classifyPane(fixture('pane-shell.txt')), null);
  assert.equal(classifyPane(''), null);
  assert.equal(classifyPane(null), null);
});

test('markers in printed output do not change the state', () => {
  // The whole reason the footer is anchored. This fixture is a DONE session
  // whose body contains "esc to interrupt", "Esc to cancel" and a numbered
  // option list, exactly as a session discussing this feature would.
  const pane = fixture('pane-remnant.txt');
  assert.match(pane, /esc to interrupt/, 'fixture must carry the working marker in its body');
  assert.match(pane, /Esc to cancel/, 'fixture must carry the dialog marker in its body');
  assert.equal(classifyPane(pane), 'done');
});

test('a markdown table in the output is not mistaken for the footer rule', () => {
  // Tables are drawn with the same U+2500 as the composer rule. Treating one as
  // a rule would move the footer boundary into the middle of the output and
  // take the classification with it.
  const pane = fixture('pane-working.txt');
  assert.match(pane, /[┌├└][─┬┼┴]/, 'fixture must contain a rendered table');
  assert.equal(classifyPane(pane), 'working');
});

test('the interrupt hint is matched in full, never as a prefix', () => {
  // The CLI prints seven other "esc to X" hints, and one of them sits in the
  // footer of a BLOCKED session — so a loose match reports the opposite state.
  const withFooter = (hint) => ['── done ──', '──────────', '  ⏵⏵ auto mode on · ' + hint + ' · ← 1 agent'].join('\n');
  for (const hint of ['esc to cancel', 'esc to edit', 'esc to rewind', 'esc to quit', 'esc to keep']) {
    assert.notEqual(classifyPane(withFooter(hint)), 'working', hint + ' must not read as working');
  }
  assert.equal(classifyPane(withFooter('esc to interrupt')), 'working');
});

test('a matcher written with an ASCII apostrophe would miss the real option label', () => {
  // Pinned because it fails silently. The label uses U+2019, so matching on the
  // prose is a trap; this is why the classifier keys on structure instead.
  const pane = fixture('pane-permission.txt');
  assert.match(pane, /don’t ask again/, 'the real label uses U+2019');
  assert.doesNotMatch(pane, /don't ask again/, 'an ASCII apostrophe must not match');
  assert.equal(classifyPane(pane), 'needs-you');
});

test('a matcher written with an ASCII space after the chevron would miss the composer', () => {
  // Same class of trap. The composer line is chevron + U+00A0.
  const pane = fixture('pane-done.txt');
  assert.match(pane, /❯ /, 'the real composer line uses U+00A0');
  assert.doesNotMatch(pane, /^❯ $/m, 'an ASCII space must not match');
  assert.equal(classifyPane(pane), 'done');
});

test('the message preview is exactly what the card drew before', () => {
  // A golden assertion, not a shape check. This function was lifted out of
  // lastMessageFor in server.mjs, which had no tests at all, so the only thing
  // standing between a refactor and a silently different preview is the whole
  // value being pinned — role mapping, text, and timestamp together. A
  // "typeof text === 'string'" check would have passed with the roles inverted.
  assert.deepEqual(parseTranscriptTail(fixture('transcript-endturn.jsonl')).message, {
    role: 'claude',
    text: 'Noted — you prefer red.',
    at: '2026-08-27T11:42:50.449Z',
  });
});

test('a long message is cut at exactly 600 characters plus an ellipsis', () => {
  // The other half of the old behaviour, and the half a fixture cannot reach:
  // none of the captured transcripts happens to hold a 600+ character message.
  const long = 'x'.repeat(700);
  const rec = JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: long }] },
    timestamp: '2026-08-27T00:00:00.000Z',
  });
  const { message } = parseTranscriptTail('fragment\n' + rec);
  assert.equal(message.text.length, 601);
  assert.equal(message.text, 'x'.repeat(600) + '…');
  assert.equal(message.at, '2026-08-27T00:00:00.000Z');
});

test('a message with no timestamp reports null rather than undefined', () => {
  // `at: rec.timestamp || null` in the original. undefined would serialise out
  // of the /sessions payload entirely and the card's tooltip would read
  // "Invalid Date".
  const rec = JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }] },
  });
  assert.equal(parseTranscriptTail('fragment\n' + rec).message.at, null);
});

test('a tail with nothing readable still returns a storable value', () => {
  // What makes the caching in readTranscriptTail work. It stores
  // { mtimeMs, value } and reuses it whenever the mtime matches, so `value`
  // being an object rather than a bare null is what stops a session with no
  // readable message from re-reading 64 KB of transcript on every poll. The
  // old lastMessageFor cached a null the same way; this pins the contract that
  // replaced it.
  for (const input of ['', 'fragment only', 'fragment\nnot json\n{oops', null, undefined]) {
    const value = parseTranscriptTail(input);
    assert.equal(typeof value, 'object', 'always an object');
    assert.notEqual(value, null, 'never a bare null, which the cache cannot tell from a miss');
    assert.deepEqual(value, { message: null, turn: null });
  }
});

test('the first line of a tail is discarded as a fragment', () => {
  // The caller slices at a byte offset, so line one is half a record. Parsing
  // it would either throw or, worse, half-succeed.
  const tail = fixture('transcript-endturn.jsonl');
  assert.doesNotThrow(() => parseTranscriptTail(tail));
  const firstLine = tail.split('\n')[0];
  assert.throws(() => JSON.parse(firstLine), 'the fixture really does start mid-record');
});

test('the turn is read from records the message walk skips', () => {
  // A tool-only assistant record carries no text, so the preview steps over it
  // — but it is exactly the evidence that claude is mid-turn.
  assert.equal(parseTranscriptTail(fixture('transcript-endturn.jsonl')).turn, 'end_turn');
  assert.equal(parseTranscriptTail(fixture('transcript-tooluse.jsonl')).turn, 'tool_use');
  assert.equal(parseTranscriptTail(fixture('transcript-userlast.jsonl')).turn, 'user');
});

test('metadata records written after the last message are ignored', () => {
  // attachment / mode / bridge-session records land after the final message, so
  // an unfiltered walk would read metadata as conversation.
  const tail = fixture('transcript-endturn.jsonl');
  const lastLine = tail.trimEnd().split('\n').pop();
  const lastRec = JSON.parse(lastLine);
  assert.ok(!['assistant', 'user'].includes(lastRec.type), 'fixture ends on a metadata record');
  assert.equal(parseTranscriptTail(tail).turn, 'end_turn');
});

test('a whole-file read keeps its first line', () => {
  // A transcript smaller than the tail window is read from byte zero, so line
  // one is a complete record. A young session has exactly one — the prompt just
  // sent — and dropping it reads as "done" when claude is about to reply.
  const only = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: 'go' },
    timestamp: '2026-08-27T00:00:00.000Z',
  });
  assert.equal(parseTranscriptTail(only, { partial: false }).turn, 'user');
  assert.equal(parseTranscriptTail(only).turn, null, 'a real tail still drops the fragment');
});

test('an empty or unparseable tail yields nothing rather than throwing', () => {
  assert.deepEqual(parseTranscriptTail(''), { message: null, turn: null });
  assert.deepEqual(parseTranscriptTail('fragment\nnot json at all\n{oops'), { message: null, turn: null });
  assert.deepEqual(parseTranscriptTail(null), { message: null, turn: null });
});

test('the pane outranks the transcript', () => {
  // The measured case: while a dialog blocks, the transcript's last record is
  // the user's prompt, which on its own reads as "working".
  assert.equal(
    classifyStatus({ pane: 'needs-you', turn: 'user', hasTranscript: true }),
    'needs-you',
  );
  assert.equal(
    classifyStatus({ pane: 'working', turn: 'end_turn', hasTranscript: true }),
    'working',
  );
});

test('a blocking dialog beats a session that has never been spoken to', () => {
  // The folder-trust gate blocks before any transcript exists. Calling that
  // "idle" would hide a session that cannot start until someone answers.
  assert.equal(
    classifyStatus({ pane: 'needs-you', turn: null, hasTranscript: false }),
    'needs-you',
  );
});

test('a pane at rest is idle only when nothing was ever said', () => {
  assert.equal(classifyStatus({ pane: 'done', turn: 'end_turn', hasTranscript: true }), 'done');
  assert.equal(classifyStatus({ pane: 'done', turn: null, hasTranscript: false }), 'idle');
});

test('an unreadable pane falls back to the transcript', () => {
  assert.equal(classifyStatus({ pane: null, turn: 'end_turn', hasTranscript: true }), 'done');
  assert.equal(classifyStatus({ pane: null, turn: 'tool_use', hasTranscript: true }), 'working');
  assert.equal(classifyStatus({ pane: null, turn: 'user', hasTranscript: true }), 'working');
  assert.equal(classifyStatus({ pane: null, turn: null, hasTranscript: false }), 'idle');
});

// A session as the sort sees it. `at` is minutes past a fixed epoch, so the
// timestamps read as launch order at a glance.
const S = (name, at, extra = {}) => ({
  name,
  createdAt: new Date(Date.UTC(2026, 7, 28, 9, at)).toISOString(),
  ...extra,
});

test('the list is newest first below the pin', () => {
  const list = [S('claude-bbbbbbbb', 10), S('claude-dddddddd', 40), S('claude-aaaaaaaa', 1)];
  list.sort(compareSessions);
  assert.deepEqual(
    list.map((s) => s.name),
    ['claude-dddddddd', 'claude-bbbbbbbb', 'claude-aaaaaaaa'],
  );
});

test('a pin beats launch time, and an absent pin is not a pin', () => {
  // The absence matters as much as the pin. /sessions is not the comparator's
  // only caller shape — it is handed objects that predate the field, and a
  // `favorite` that is simply missing has to read as unpinned rather than
  // sorting as something. So only the oldest row carries the key at all.
  const list = [S('claude-bbbbbbbb', 10), S('claude-dddddddd', 40),
                S('claude-aaaaaaaa', 1, { favorite: true })];
  list.sort(compareSessions);
  assert.deepEqual(
    list.map((s) => s.name),
    ['claude-aaaaaaaa', 'claude-dddddddd', 'claude-bbbbbbbb'],
    'the pinned oldest leads; the two unpinned rows stay newest-first',
  );
});

test('nothing a session does moves it', () => {
  // The whole point of the change. The old sort ranked by state, so a session
  // finishing a tool call re-sorted the rail out from under whoever was reading
  // it. The same four rows must come out in the same order whatever they are
  // doing, and whatever their clocks say.
  const states = ['needs-you', 'working', 'done', 'idle'];
  const orders = states.map((status) => {
    const list = [
      S('claude-aaaaaaaa', 1, { status: 'done', windowActivity: 9000 }),
      S('claude-bbbbbbbb', 10, { status, windowActivity: 1 }),
      S('claude-cccccccc', 20, { status: 'working', windowActivity: 5000 }),
    ];
    return list.sort(compareSessions).map((s) => s.name);
  });
  for (const order of orders) {
    assert.deepEqual(
      order,
      ['claude-cccccccc', 'claude-bbbbbbbb', 'claude-aaaaaaaa'],
      'launch order, whatever the middle row is doing',
    );
  }
});

test('the order is total, so a poll cannot shuffle equal rows', () => {
  // tmux reports session_created in whole seconds, so two sessions launched
  // together really do share a timestamp. Without the name tiebreak they can
  // swap on successive polls, which the page's repaint guard reads as a change
  // and redraws.
  const mk = () => [S('claude-bbbbbbbb', 5), S('claude-aaaaaaaa', 5)];
  const forward = mk().sort(compareSessions).map((s) => s.name);
  const reversed = mk().reverse().sort(compareSessions).map((s) => s.name);
  assert.deepEqual(forward, reversed);
  assert.deepEqual(forward, ['claude-aaaaaaaa', 'claude-bbbbbbbb']);
});

test('the order stays total once pins are in it', () => {
  // Same flicker guard, one key up. Two pinned sessions launched in the same
  // second are exactly the case the name tiebreak exists for — if the pin were
  // the last word instead of the first, two pinned rows could swap between
  // polls and the repaint guard would redraw the rail on every one.
  const mk = () => [
    S('claude-cccccccc', 5, { favorite: true }),
    S('claude-aaaaaaaa', 5, { favorite: true }),
    S('claude-bbbbbbbb', 40),
  ];
  const forward = mk().sort(compareSessions).map((s) => s.name);
  const reversed = mk().reverse().sort(compareSessions).map((s) => s.name);
  assert.deepEqual(forward, reversed);
  assert.deepEqual(forward, ['claude-aaaaaaaa', 'claude-cccccccc', 'claude-bbbbbbbb']);
});

test('a session without a creation time sorts last rather than throwing', () => {
  const list = [
    { name: 'claude-nostamp' },
    S('claude-aaaaaaaa', 1),
    { name: 'claude-nulled', createdAt: null },
  ];
  list.sort(compareSessions);
  assert.deepEqual(
    list.map((s) => s.name),
    ['claude-aaaaaaaa', 'claude-nostamp', 'claude-nulled'],
  );
});

test('every state has a label and a tooltip', () => {
  // The tooltip is the rail dot's only affordance — the dot is aria-hidden and
  // carries no text of its own — so a state missing one renders a bare dot with
  // nothing to explain it.
  for (const status of ['needs-you', 'working', 'done', 'idle']) {
    assert.equal(typeof STATUS_LABEL[status], 'string', status + ' has a label');
    assert.ok(STATUS_LABEL[status].length, status + ' label is not empty');
    assert.equal(typeof STATUS_TIP[status], 'string', status + ' has a tooltip');
    assert.ok(STATUS_TIP[status].length, status + ' tooltip is not empty');
  }
  // And nothing extra: a key in one map and not the other is a dot that renders
  // with a word but no explanation, or the reverse.
  assert.deepEqual(Object.keys(STATUS_LABEL).sort(), Object.keys(STATUS_TIP).sort());
});
