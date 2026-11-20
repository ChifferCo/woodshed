// A stand-in for claude's AskUserQuestion picker and permission dialog, for the tests of session/panePrompt.mjs and
// statusd's POST /answer: it draws what the real one draws (copied from the captures beside it, pane-ask-*.txt and
// pane-permission-bash.txt, Claude Code 2.1.328) and takes the keys the real one takes: ↑/↓ move the highlight,
// Enter picks, a digit picks its row, Tab/←/→ move between questions, Esc cancels.
// In memory (`createPicker`), or in a tmux pane: `node claudePicker.mjs <spec.json> <answers file>`, which writes what
// was picked to the answers file as JSON once the picker closes.

import fs from 'node:fs';

const RULE = '─'.repeat(80);

/**
 * @param {{questions?: {question: string, header: string, options: string[]}[], approval?: {title: string, command: string}}} spec
 */
export function createPicker(spec) {
  const state = {
    tab: 0,
    at: 0,
    picks: (spec.questions ?? []).map(() => null),
    done: null,
  };
  const questions = spec.questions ?? [];
  const several = questions.length > 1;
  const rows = () => (state.done ? [] : spec.approval ? ['Yes', 'Yes, and always allow access to this folder', 'No']
    : state.tab === questions.length ? ['Submit answers', 'Cancel']
      : [...questions[state.tab].options, 'Type something.', 'Chat about this']);

  function render() {
    const out = ['', '❯ Earlier, the person asked something.', '', RULE];
    if (state.done) {
      out.length = 0;
      out.push(state.done.cancelled ? '● Declined to answer' : '● Answered', '', RULE, '❯ ', RULE);
      return out.join('\n');
    }
    if (spec.approval) {
      out.push(' Bash command', ' Tip: auto mode handles these prompts for you', ` ${spec.approval.what ?? 'Run it'}`, '╌'.repeat(80), ` ${spec.approval.command}`, '╌'.repeat(80), ` ${spec.approval.title}`);
      rows().forEach((r, i) => out.push(` ${i === state.at ? '❯' : ' '} ${i + 1}. ${r}`));
      out.push('', ' Esc to cancel · Tab to amend');
      return out.join('\n');
    }
    const tabs = questions.map((q, i) => `${state.picks[i] === null ? '☐' : '☒'} ${q.header}`).join('  ');
    out.push(several ? `←  ${tabs}  ✔ Submit  →` : ` ${tabs}`, '');
    if (state.tab === questions.length) {
      out.push('Review your answers', '');
      questions.forEach((q, i) => out.push(` ● ${q.question}`, `   → ${q.options[state.picks[i]]}`));
      out.push('');
      rows().forEach((r, i) => out.push(`${i === state.at ? '❯' : ' '} ${i + 1}. ${r}`));
      return out.join('\n');
    }
    const q = questions[state.tab];
    out.push(q.question, '');
    const list = rows();
    list.forEach((r, i) => {
      if (i === list.length - 1) out.push(RULE);
      const mark = state.picks[state.tab] === i ? ' ✔' : '';
      out.push(`${i === state.at ? '❯' : ' '} ${i + 1}. ${r}${mark}`);
      if (i < q.options.length) out.push(`     ${r} is one of the options`);
    });
    out.push('', 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel');
    return out.join('\n');
  }

  function pick(i) {
    if (spec.approval) {
      state.done = { approval: rows()[i] };
      return;
    }
    if (state.tab === questions.length) {
      state.done = i === 0 ? { answers: state.picks.map((p, k) => questions[k].options[p]) } : { cancelled: true };
      return;
    }
    if (i >= questions[state.tab].options.length) return;
    state.picks[state.tab] = i;
    if (!several) {
      state.done = { answers: [questions[0].options[i]] };
      return;
    }
    state.tab++;
    state.at = state.tab < questions.length && state.picks[state.tab] !== null ? state.picks[state.tab] : 0;
  }

  /** @param {string} key  Up, Down, Left, Right, Tab, Enter, Escape or a digit */
  function press(key) {
    if (state.done) return;
    const n = rows().length;
    if (key === 'Up') state.at = Math.max(0, state.at - 1);
    else if (key === 'Down') state.at = Math.min(n - 1, state.at + 1);
    else if (key === 'Enter') pick(state.at);
    else if (/^[1-9]$/.test(key) && Number(key) <= n) pick(Number(key) - 1);
    else if (key === 'Escape') state.done = { cancelled: true };
    else if ((key === 'Right' || key === 'Tab') && several && state.tab < questions.length) {
      state.tab++;
      state.at = 0;
    } else if (key === 'Left' && several && state.tab > 0) {
      state.tab--;
      state.at = state.picks[state.tab] ?? 0;
    }
  }

  return { render, press, state };
}

const KEYS = { '\x1b[A': 'Up', '\x1b[B': 'Down', '\x1b[C': 'Right', '\x1b[D': 'Left', '\x1bOA': 'Up', '\x1bOB': 'Down', '\x1bOC': 'Right', '\x1bOD': 'Left', '\r': 'Enter', '\t': 'Tab', '\x1b': 'Escape' };

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const [specFile, answersFile] = process.argv.slice(2);
  const picker = createPicker(JSON.parse(fs.readFileSync(specFile, 'utf8')));
  const draw = () => process.stdout.write(`\x1b[2J\x1b[H${picker.render().replace(/\n/g, '\r\n')}`);
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    for (const seq of chunk.match(/\x1b\[[A-D]|\x1bO[A-D]|[\s\S]/g) ?? []) {
      picker.press(KEYS[seq] ?? seq);
      if (picker.state.done) fs.writeFileSync(answersFile, JSON.stringify(picker.state.done));
    }
    draw();
  });
  draw();
}
