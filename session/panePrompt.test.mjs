import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Refusal, answerApproval, answerQuestions, matchApproval, matchQuestion, matchReview, planMoves, readApproval, readPrompt,
  readQuestionPicker, readTabs, typeMessage,
} from './panePrompt.mjs';
import { createPicker } from '../shared/__fixtures__/claudePicker.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'shared', '__fixtures__');
const pane = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

const COLOUR = { question: 'Which colour do you prefer?', options: ['Red', 'Green', 'Blue'] };
const SIZE = { question: 'Which size do you want?', options: ['Small', 'Medium', 'Large'] };

test('claude\'s picker is read from a real capture: the question, its options, the highlight and the tabs', () => {
  const screen = readQuestionPicker(pane('pane-ask-two-first.txt'));
  assert.equal(screen.step, 'question');
  assert.equal(screen.question, COLOUR.question);
  assert.deepEqual(screen.options.map((o) => o.label), COLOUR.options, 'not Type something, nor Chat about this, nor the descriptions');
  assert.equal(screen.highlighted, 0);
  assert.deepEqual(screen.tabs, { questions: [{ name: 'Colour', answered: false }, { name: 'Size', answered: false }], submit: true });
  assert.equal(screen.multiSelect, false);

  const single = readQuestionPicker(pane('pane-askquestion.txt'));
  assert.deepEqual(single.options.map((o) => o.label), ['Red', 'Blue']);
  assert.deepEqual(single.tabs, { questions: [{ name: 'Colour', answered: false }], submit: false });
});

test('a picker the person moved in: the highlight on the second row, its pick marked, the tab answered', () => {
  const screen = readQuestionPicker(pane('pane-ask-two-moved.txt'));
  assert.equal(screen.highlighted, 1);
  assert.deepEqual(screen.options[1], { n: 2, label: 'Green', highlighted: true, chosen: true }, 'the ✔ is not part of the label');
  assert.equal(screen.tabs.questions[0].answered, true);
  assert.deepEqual(planMoves(screen, 0), ['Up']);
  assert.deepEqual(planMoves(screen, 2), ['Down']);
  assert.deepEqual(planMoves(screen, 1), []);
  assert.deepEqual(planMoves({ ...screen, highlighted: null }, 0), null, 'with no highlight on an option, no count is safe');
});

test('the review of several answers, a multi-select question and a wrapped label', () => {
  const review = readQuestionPicker(pane('pane-ask-two-review.txt'));
  assert.equal(review.step, 'review');
  assert.deepEqual(review.answers, [{ question: COLOUR.question, answer: 'Green' }, { question: SIZE.question, answer: 'Large' }]);
  assert.deepEqual(review.options.map((o) => o.label), ['Submit answers', 'Cancel']);
  assert.ok(matchReview(review, [{ ...COLOUR, pick: 1 }, { ...SIZE, pick: 2 }]).ok);
  assert.equal(matchReview(review, [{ ...COLOUR, pick: 0 }, { ...SIZE, pick: 2 }]).why, 'other-answers');

  const multi = readQuestionPicker(pane('pane-ask-multiselect.txt'));
  assert.equal(multi.multiSelect, true);
  assert.match(multi.question, /^Which toppings should go on the pizza .* at the office\?$/, 'the │ claude draws before it is not part of it');
  assert.equal(matchQuestion(multi, { question: multi.question, options: ['Cheese', 'Olives', 'Mushrooms'] }).why, 'multi-select');

  const wrapped = readQuestionPicker(pane('pane-ask-wrapped.txt'));
  const deploy = {
    question: 'Which deployment strategy should we use for the console?',
    options: ['Blue-green deployment behind the load balancer with an automatic rollback when health checks fail', 'Rolling update'],
  };
  assert.ok(matchQuestion(wrapped, deploy).ok, 'a label cut where the pane wraps it still matches');
  assert.equal(matchQuestion(wrapped, { ...deploy, options: ['Blue-green', 'Rolling update'] }).why, 'other-options');
});

test('matching: the question and every option must be the ones on screen', () => {
  const screen = readQuestionPicker(pane('pane-ask-two-first.txt'));
  assert.ok(matchQuestion(screen, COLOUR).ok);
  assert.equal(matchQuestion(screen, SIZE).why, 'other-question');
  assert.equal(matchQuestion(screen, { ...COLOUR, options: ['Red', 'Green'] }).why, 'other-options');
  assert.equal(matchQuestion(screen, { ...COLOUR, options: ['Red', 'Blue', 'Green'] }).why, 'other-options');
  assert.equal(matchQuestion(null, COLOUR).why, 'no-picker');
  assert.equal(readQuestionPicker(pane('pane-ask-answered.txt')), null, 'once answered, no picker');
  for (const name of ['pane-done.txt', 'pane-working.txt', 'pane-shell.txt', 'pane-folder-trust.txt', 'pane-permission-bash.txt']) {
    assert.equal(readQuestionPicker(pane(name)), null, name);
  }
});

test('tabs read from the line claude draws', () => {
  assert.deepEqual(readTabs('←  ☒ Colour  ☐ Size  ✔ Submit  →'), {
    questions: [{ name: 'Colour', answered: true }, { name: 'Size', answered: false }], submit: true,
  });
  assert.deepEqual(readTabs(' ☐ Deploy strategy'), { questions: [{ name: 'Deploy strategy', answered: false }], submit: false });
});

test('an approval: claude\'s permission dialogs, old and new, with what is asked and which rows approve and deny', () => {
  const bash = readApproval(pane('pane-permission-bash.txt'));
  assert.equal(bash.agent, 'claude');
  assert.equal(bash.what, 'Bash command');
  assert.equal(bash.title, 'Do you want to proceed?');
  assert.deepEqual(bash.detail, ['Write current date to now.txt', 'date > now.txt'], 'no tip, no dashed rules');
  assert.equal(bash.options[bash.approve].label, 'Yes');
  assert.equal(bash.options[bash.deny].label, 'No');
  assert.equal(bash.highlighted, 0);

  const write = readApproval(pane('pane-permission-write.txt'));
  assert.equal(write.title, 'Do you want to create notes.txt?');
  assert.equal(write.what, 'Create file');
  assert.equal(write.deny, 2);

  // Captured live from claude 2.1.328 in default mode in an 80-column pane, where the auto mode tip wraps.
  const narrow = readApproval(pane('pane-permission-bash-narrow.txt'));
  assert.equal(narrow.what, 'Bash command');
  assert.deepEqual(narrow.detail, ['Write current date to now.txt', 'date > now.txt'], 'the tip\'s wrapped "below" left out too');
  assert.equal(narrow.options[narrow.approve].label, 'Yes');
  assert.equal(narrow.options[narrow.deny].label, 'No');

  const writeNarrow = readApproval(pane('pane-permission-write-narrow.txt'));
  assert.equal(writeNarrow.what, 'Create file');
  assert.deepEqual(writeNarrow.detail, ['notes2.txt', '1 hello']);
  assert.equal(writeNarrow.options[writeNarrow.approve].label, 'Yes', 'not the wrapped "Yes, and switch to accept edits" row');
  assert.equal(writeNarrow.options[writeNarrow.deny].label, 'No');
  assert.equal(writeNarrow.deny, 2);

  const noOnce = pane('pane-permission-bash.txt').replace('❯ 1. Yes\n', '❯ 1. Yes, and don\'t ask again for date\n');
  assert.notEqual(noOnce, pane('pane-permission-bash.txt'));
  assert.equal(readApproval(noOnce), null, 'with no one-time Yes, Approve has nothing it may pick');

  const old = readApproval(pane('pane-permission.txt'));
  assert.deepEqual(old.detail, ['curl -s https://example.com | head -2', 'Fetch example.com and show first two lines'], 'without "This command requires approval"');

  assert.equal(readApproval(pane('pane-ask-two-first.txt')), null, 'a question picker is no approval');
  assert.equal(readApproval(pane('pane-folder-trust.txt')), null, 'nor is the folder-trust question, which has no Yes and No rows');
  assert.equal(readPrompt(pane('pane-permission-bash.txt')).kind, 'approval');
  assert.equal(readPrompt(pane('pane-ask-two-first.txt')).kind, 'question');
  assert.equal(readPrompt(pane('pane-done.txt')), null);
});

test('codex\'s approval, as codex 0.167 words it, with the shortcut after each option left out of the label', () => {
  const screen = [
    'stand-in codex', '',
    'Would you like to run the following command?', '',
    '  Reason: run the migrations before the tests', '',
    '  $ npm run migrate', '',
    '› 1. Yes, just this once (y)',
    '  2. Yes, and don\'t ask again for this command in this session (a)',
    '  3. No, and tell Codex what to do differently (esc)', '',
    '  Press enter to confirm or esc to cancel',
  ].join('\n');
  const approval = readApproval(screen);
  assert.equal(approval.agent, 'codex');
  assert.equal(approval.what, null);
  assert.deepEqual(approval.detail, ['Reason: run the migrations before the tests', '$ npm run migrate']);
  assert.deepEqual([approval.options[approval.approve].label, approval.options[approval.deny].label], ['Yes, just this once', 'No, and tell Codex what to do differently']);
  assert.ok(matchApproval(approval, { key: approval.key }).ok);
  assert.equal(matchApproval(approval, { key: readApproval(screen.replace('npm run migrate', 'rm -rf /')).key }).why, 'other-approval');
  // One space more inside the command is another command: the key is the screen's text as it is, not squashed.
  const spaced = readApproval(screen.replace('npm run migrate', 'npm run  migrate'));
  assert.notEqual(spaced.key, approval.key);
  assert.equal(matchApproval(spaced, { key: approval.key }).why, 'other-approval');
});

// The in-memory stand-in picker as a pane: capture draws it, keys press it, and each key is kept.
function paneOf(spec, { after } = {}) {
  const picker = createPicker(spec);
  const pressed = [];
  return {
    picker,
    pressed,
    io: {
      capture: async () => picker.render(),
      keys: async (...keys) => {
        for (const k of keys) {
          pressed.push(k);
          picker.press(k);
          after?.(k, picker);
        }
      },
      sleep: async () => {},
      waitMs: 50,
    },
  };
}

const TWO = { questions: [{ ...COLOUR, header: 'Colour' }, { ...SIZE, header: 'Size' }] };

test('answering two questions: each pick, then Submit answers on the review, checking the screen at each step', async () => {
  const { io, picker, pressed } = paneOf(TWO);
  const done = await answerQuestions(io, [{ ...COLOUR, pick: 1 }, { ...SIZE, pick: 2 }]);
  assert.deepEqual(picker.state.done, { answers: ['Green', 'Large'] });
  assert.deepEqual(pressed, ['Down', 'Enter', 'Down', 'Down', 'Enter', 'Enter']);
  assert.equal(done.moves, 3);
});

test('a highlight left on another row is counted from, not from the first', async () => {
  const { io, picker, pressed } = paneOf(TWO);
  picker.press('Down');
  picker.press('Down');
  await answerQuestions(io, [{ ...COLOUR, pick: 0 }, { ...SIZE, pick: 0 }]);
  assert.deepEqual(picker.state.done, { answers: ['Red', 'Small'] });
  assert.deepEqual(pressed, ['Up', 'Up', 'Enter', 'Enter', 'Enter']);
});

test('one question: its pick is the answer, with no review', async () => {
  const { io, picker, pressed } = paneOf({ questions: [{ ...COLOUR, header: 'Colour' }] });
  await answerQuestions(io, [{ ...COLOUR, pick: 2 }]);
  assert.deepEqual(picker.state.done, { answers: ['Blue'] });
  assert.deepEqual(pressed, ['Down', 'Down', 'Enter']);
});

test('nothing is typed when the pane shows another question, other options, or no picker', async () => {
  const { io, pressed } = paneOf(TWO);
  await assert.rejects(answerQuestions(io, [{ ...SIZE, pick: 0 }, { ...COLOUR, pick: 0 }]), (err) => err instanceof Refusal && err.why === 'other-question');
  await assert.rejects(answerQuestions(io, [{ ...COLOUR, options: ['Red', 'Blue'], pick: 0 }, { ...SIZE, pick: 0 }]), { why: 'other-options' });
  await assert.rejects(answerQuestions(io, [{ ...COLOUR, pick: 0 }]), { why: 'other-question' }, 'the picker asks two, the page answers one');
  assert.deepEqual(pressed, []);

  const answered = { capture: async () => pane('pane-ask-answered.txt'), keys: async () => assert.fail('typed'), sleep: async () => {}, waitMs: 10 };
  await assert.rejects(answerQuestions(answered, [{ ...COLOUR, pick: 0 }]), (err) => err.why === 'no-picker' && /shows no question now/.test(err.message));
});

test('a picker that changes under the answer stops it, and says how far it got', async () => {
  // Someone in the TUI tab answers the second question first: the screen after the first pick is the review.
  const { io, pressed } = paneOf(TWO, {
    after: (k, picker) => {
      if (k === 'Enter' && picker.state.tab === 1) {
        picker.state.picks[1] = 0;
        picker.state.tab = 2;
        picker.state.at = 0;
      }
    },
  });
  await assert.rejects(answerQuestions(io, [{ ...COLOUR, pick: 0 }, { ...SIZE, pick: 1 }]), (err) => err.why === 'other-question' && err.typed === 1 && /1 answered in the terminal/.test(err.message));
  assert.deepEqual(pressed, ['Enter'], 'no key after the screen stopped matching');

  // A highlight that does not land where the moves should put it.
  const stuck = paneOf(TWO, { after: (k, picker) => { if (k === 'Down') picker.state.at = 0; } });
  await assert.rejects(answerQuestions(stuck.io, [{ ...COLOUR, pick: 2 }, { ...SIZE, pick: 0 }]), { why: 'not-moved' });
  assert.deepEqual(stuck.pressed, ['Down', 'Down'], 'no Enter on a row it did not mean');
});

test('approving and denying claude\'s permission dialog, and refusing a different one', async () => {
  const spec = { approval: { title: 'Do you want to proceed?', what: 'Write current date to now.txt', command: 'date > now.txt' } };
  const shown = readApproval(createPicker(spec).render());
  const approve = paneOf(spec);
  assert.deepEqual(await answerApproval(approve.io, { decision: 'approve', key: shown.key }), { moves: 0, agent: 'claude' });
  assert.deepEqual(approve.picker.state.done, { approval: 'Yes' });
  assert.deepEqual(approve.pressed, ['Enter']);

  const deny = paneOf(spec);
  await answerApproval(deny.io, { decision: 'deny', key: shown.key });
  assert.deepEqual(deny.picker.state.done, { approval: 'No' });
  assert.deepEqual(deny.pressed, ['Down', 'Down', 'Enter']);

  const other = paneOf({ approval: { ...spec.approval, command: 'rm -rf build' } });
  await assert.rejects(answerApproval(other.io, { decision: 'approve', key: shown.key }), { why: 'other-approval' });
  assert.deepEqual(other.pressed, [], 'a stale approval sends no key, Enter least of all');
});

test('an approval too long for the page to show in full is answered in the TUI tab alone, and a clipped part counts', async () => {
  const codex = (command) => [
    'Would you like to run the following command?', '',
    ...Array.from({ length: 7 }, (_, i) => `  Reason line ${i + 1}`),
    `  $ ${command}`, '',
    '› 1. Yes, proceed (y)',
    '  3. No, and tell Codex what to do differently (esc)', '',
    '  Press enter to confirm or esc to cancel',
  ].join('\n');
  const long = readApproval(codex('npm test'));
  assert.equal(long.complete, false, 'more lines than the page shows');
  assert.equal(long.detail.length, 6, 'the command, the 8th line, is not among them');
  assert.equal(matchApproval(long, { key: long.key }).why, 'incomplete');
  // The part the page never showed still tells two approvals apart.
  assert.notEqual(readApproval(codex('rm -rf /')).key, long.key);
  const wide = readApproval(codex(`echo ${'x'.repeat(400)}`).replace(/ {2}Reason line [2-7]\n/g, ''));
  assert.equal(wide.complete, false, 'a line longer than the page keeps');
});

test("real codex 0.167's approval reads with its own options, and the page keeps its wrapped reason whole", async () => {
  const fs = await import('node:fs');
  const chat = (await import('../console/public/chatThread.cjs')).default;
  // Captured from codex 0.167 in plan mode's read-only sandbox, asked to write a file.
  const screen = readApproval(fs.readFileSync(new URL('../shared/__fixtures__/pane-codex-approval.txt', import.meta.url), 'utf8'));
  assert.equal(screen.agent, 'codex');
  assert.equal(screen.title, 'Would you like to run the following command?');
  assert.deepEqual(screen.options.map((o) => o.label.slice(0, 20)), ['Yes, proceed', "Yes, and don't ask a", 'No, and tell Codex w']);
  assert.equal(screen.approve, 0, 'just this once, never the "don\'t ask again" row');
  assert.equal(screen.deny, 2);
  assert.equal(screen.highlighted, 0);
  assert.deepEqual(chat.approvalText(screen).lines, [
    'Environment: local',
    '$ echo hi > hello-from-chat.txt',
    'Reason: May I run the requested command outside the sandbox to create hello-from-chat.txt?',
  ]);
});

test('a message gets no Enter when a prompt is on screen, before its text or as it went in', async () => {
  const approval = createPicker({ approval: { title: 'Do you want to proceed?', what: 'Write the date', command: 'date > now.txt' } }).render();
  const clear = '╭───╮\n│ > │\n╰───╯\n  ? for shortcuts';
  const io = (screens) => {
    const done = [];
    return { done, capture: async () => screens.shift() ?? clear, type: async (t) => { done.push(`type ${t}`); }, enter: async () => { done.push('Enter'); } };
  };
  const plain = io([clear, clear]);
  assert.deepEqual(await typeMessage(plain, 'hi'), { sent: true });
  assert.deepEqual(plain.done, ['type hi', 'Enter']);
  const open = io([approval]);
  assert.deepEqual(await typeMessage(open, 'hi'), { sent: false, kind: 'approval', typed: false });
  assert.deepEqual(open.done, [], 'nothing typed into it');
  // The approval came up between the first read and the Enter: the text is in, the Enter is not.
  const race = io([clear, approval]);
  assert.deepEqual(await typeMessage(race, 'hi'), { sent: false, kind: 'approval', typed: true });
  assert.deepEqual(race.done, ['type hi'], 'no Enter, which would have approved it');
  const unread = { capture: async () => { throw new Error('no server running'); }, type: async () => assert.fail('typed'), enter: async () => assert.fail('entered') };
  await assert.rejects(typeMessage(unread, 'hi'), /no server running/);
});

test('the page shows every line of an approval it lets the person answer', async () => {
  const chat = (await import('../console/public/chatThread.cjs')).default;
  const screen = [
    'Would you like to run the following command?', '',
    ...['  Environment: local', '  Cwd: /tmp/fx/repo', '  Network: off', '  Sandbox: none', '  Timeout: 60s', '  $ rm -rf build'],
    '',
    '› 1. Yes, proceed (y)',
    '  3. No, and tell Codex what to do differently (esc)', '',
    '  Press enter to confirm or esc to cancel',
  ].join('\n');
  const approval = readApproval(screen);
  assert.equal(approval.complete, true, 'six lines: the most the page shows');
  const { lines } = chat.approvalText(approval);
  assert.equal(lines.length, 6);
  assert.ok(lines.includes('$ rm -rf build'), 'the command, its sixth line, is shown: Approve answers nothing the page hid');
});
