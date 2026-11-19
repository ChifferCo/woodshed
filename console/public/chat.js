// The Chat tab: a running session's conversation as a chat, in place of the agent's terminal. The thread is read from
// the agent's own record of the conversation (claude's transcript, codex's rollout), through the session's statusd
// (GET /api/sessions/<id>/transcript), and drawn as messages: the person's on the right, the agent's replies as text,
// and each run of tool calls between them as one work log that folds open (chatThread.cjs). The composer under it
// types a message into the live agent (POST …/send, as the phone's message box does), with files from the picker or
// dropped or pasted, and Stop sends it Esc (POST …/interrupt). The agent still runs in its terminal, which stays on the
// TUI tab. claude's questions (AskUserQuestion) are answered here: one option picked for each, then Send answers
// (POST …/answer), which the session types into the picker once its pane shows that same question. An approval the
// pane shows (claude's permission dialog, codex's approval; GET …/prompt) is on the Needs you line with Approve and
// Deny, under the same check. Anything else it asks there shows as Needs you, with a button to the TUI tab. The code
// each turn changed shows under its last work log that edited a file, from the edits' diffs the record carries.
// session.js makes the Chat tab the one a running session opens on.
(function () {
  'use strict';
  const W = window.Woodshed;
  const T = window.WoodshedChatThread;
  const { h } = W;
  // How often the thread is read while the agent works or a message waits to show, and otherwise. A read of a record
  // that has not changed is a stat in the session (`since`).
  const FAST_MS = 1500;
  const SLOW_MS = 5000;
  const LIMIT = 300;
  const MAX_FILES = 8;
  const MAX_FILE_MB = 25;
  const SEND_TIMEOUT_MS = 20_000;
  // Within this of the foot, the thread follows what comes in; scrolled further up, it stays where it was put.
  const STICK_PX = 120;
  // The same draft as the phone's message box (messageBox.js): a draft moves with the person between the two.
  const DRAFT_KEY = (id) => `woodshed-draft:${id}`;
  const ICONS = {
    attach: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"/></svg>',
    send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
    stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    mic: W.dictation?.MIC_ICON ?? '',
  };
  const narrow = window.matchMedia('(max-width: 720px)');

  function readDraft(id) {
    try {
      return window.sessionStorage.getItem(DRAFT_KEY(id)) || '';
    } catch {
      return '';
    }
  }
  function keepDraft(id, text) {
    try {
      if (text) window.sessionStorage.setItem(DRAFT_KEY(id), text);
      else window.sessionStorage.removeItem(DRAFT_KEY(id));
    } catch {
      // A private window keeps the draft for this page only.
    }
  }

  function icon(name, attrs) {
    const button = h('button', { type: 'button', ...attrs });
    button.innerHTML = ICONS[name];
    return button;
  }

  // ---- Markdown, from chatThread.cjs's tree, as DOM nodes.

  function inlineNodes(tokens) {
    return tokens.map((t) => {
      if (t.t === 'code') return h('code', null, t.v);
      if (t.t === 'b') return h('strong', null, t.v);
      if (t.t === 'i') return h('em', null, t.v);
      if (t.t === 'a') return h('a', { href: t.href, target: '_blank', rel: 'noopener noreferrer' }, t.v);
      return t.v;
    });
  }

  function codeBlock(block) {
    const copy = h('button', {
      type: 'button', class: 'chat-copy', title: 'Copy the code',
      onclick: () => navigator.clipboard?.writeText(block.text).then(() => W.shell.toast('Copied'), () => W.shell.toast('Not copied: the browser refused')),
    }, 'Copy');
    return h('div', { class: 'chat-code' },
      h('div', { class: 'chat-code-head' }, h('span', null, block.lang || 'text'), copy),
      h('pre', null, h('code', null, block.text)));
  }

  function markdownNodes(text) {
    return T.markdown(text).map((b) => {
      if (b.type === 'p') return h('p', null, inlineNodes(b.inline));
      if (b.type === 'h') return h(`h${Math.min(6, b.level + 2)}`, { class: 'chat-h' }, inlineNodes(b.inline));
      if (b.type === 'code') return codeBlock(b);
      if (b.type === 'ul' || b.type === 'ol') return h(b.type, null, b.items.map((item) => h('li', null, inlineNodes(item))));
      if (b.type === 'quote') return h('blockquote', null, inlineNodes(b.inline));
      if (b.type === 'hr') return h('hr');
      if (b.type === 'table') {
        return h('div', { class: 'chat-table' }, h('table', null,
          h('thead', null, h('tr', null, b.head.map((c) => h('th', null, inlineNodes(c))))),
          h('tbody', null, b.rows.map((row) => h('tr', null, row.map((c) => h('td', null, inlineNodes(c))))))));
      }
      return null;
    });
  }

  function createChat({ openTerminal, openDiff }) {
    let session = null;
    // The last answer for the shown session: { id, agent, entries, partial, writtenAt }.
    let record = null;
    let readError = null;
    let reading = false;
    // A read asked for while one was on its way: it runs once that one answers.
    let again = false;
    let timer = null;
    let ticker = null;
    let wasWorking = false;
    // When the console last said the agent was not working: the record can say a turn runs only if written after it.
    let settledAt = 0;
    // How stale the console's state can be: it reads each session every few seconds.
    const STATE_LAG_MS = 15_000;
    // Per session: messages sent from here that the record does not hold yet, and the files of the message being written.
    const pending = new Map();
    const files = new Map();
    const sending = new Set();
    // The work logs a person opened or closed, by session and key, so a redraw keeps them as they were left.
    const folds = new Map();
    // Per question card (session and key): the option picked for each question, and where its answer stands:
    // {state: 'sending'|'sent'|'refused', error?}.
    const picks = new Map();
    const answers = new Map();
    // What the pane asks while the session needs the person (GET …/prompt): null until it is read for this turn at Needs
    // you, then {id, prompt} (prompt null when the pane shows nothing the page can answer). An approval's answer on its
    // way, and the one answered from here while the console still says Needs you: {id, decision, prompt}.
    let prompt = null;
    let approval = null;
    let answered = null;
    let promptReading = false;
    let recognition = null;

    const thread = h('div', { class: 'chat-col chat-thread', role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation' });
    const scroller = h('div', { class: 'chat-scroll' }, thread);
    const status = h('div', { class: 'chat-status' });
    const chips = h('div', { class: 'chat-chips', hidden: true });
    const field = h('textarea', {
      class: 'chat-field', rows: '1', placeholder: 'Message claude', 'aria-label': 'Message claude', enterkeyhint: 'enter',
      oninput: changed, onchange: changed, oncompositionend: changed, onkeydown: keydown, onpaste: pasted,
    });
    const picker = h('input', { type: 'file', multiple: true, hidden: true, onchange: () => { attach([...picker.files]); picker.value = ''; } });
    const attachButton = icon('attach', { class: 'chat-icon', title: 'Add a file or a picture', 'aria-label': 'Add a file or a picture', onclick: () => picker.click() });
    const micButton = icon('mic', { class: 'chat-icon', title: 'Dictate', 'aria-label': 'Dictate', hidden: !W.dictation?.available, onclick: () => (recognition ? recognition.stop() : listen()) });
    const stopButton = icon('stop', { class: 'chat-stop', title: 'Stop the agent\'s turn (Esc in its terminal)', 'aria-label': 'Stop', onclick: interrupt });
    const sendButton = icon('send', { class: 'chat-send', title: 'Send', 'aria-label': 'Send', onclick: send });
    const agentName = h('span', { class: 'chat-agent' });
    const hint = h('span', { class: 'chat-hint' });
    const composer = h('div', { class: 'chat-composer', ondragover: (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); }, ondrop: dropped },
      chips, field,
      h('div', { class: 'chat-tools' }, agentName, hint, h('span', { class: 'chat-grow' }), attachButton, micButton, stopButton, sendButton), picker);
    const el = h('div', { class: 'pane-view is-chat', role: 'tabpanel', hidden: true },
      scroller, h('div', { class: 'chat-foot' }, h('div', { class: 'chat-col' }, status, composer)));

    const mine = () => files.get(session?.id) ?? [];
    const pendingOf = (id) => pending.get(id) ?? [];
    const agent = () => W.agentOf(session);
    // Working: as the console last read the agent, or as its record says, whichever knew first.
    // The record ends on a question the agent asked and has no answer to yet.
    const asking = () => {
      const last = T.items(ownRecord()?.entries ?? []).pop();
      return last?.kind === 'ask' && !last.answered && !last.declined;
    };
    const ownRecord = () => (record?.id === session?.id ? record : null);
    // A record that ends on claude's open question is a turn waiting on the person, whatever its hooks said last.
    const working = () => !T.endedByStop(ownRecord()) && !asking()
      && (session?.state === 'working' || (session?.state !== 'needs-you' && T.midTurn(ownRecord(), settledAt)));

    function changed() {
      if (!session) return;
      keepDraft(session.id, field.value);
      fit();
      drawComposer();
    }

    function fit() {
      field.style.height = 'auto';
      field.style.height = `${Math.min(field.scrollHeight, 240)}px`;
    }

    // Enter sends and Shift+Enter makes a new line, on a keyboard; a phone's Return is a new line, and its Send sends.
    function keydown(e) {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing || narrow.matches) return;
      e.preventDefault();
      send();
    }

    function pasted(e) {
      const list = [...(e.clipboardData?.files ?? [])];
      if (!list.length) return;
      e.preventDefault();
      attach(list);
    }

    function dropped(e) {
      const list = [...(e.dataTransfer?.files ?? [])];
      if (!list.length) return;
      e.preventDefault();
      attach(list);
    }

    function drawComposer() {
      if (!session) return;
      const id = session.id;
      chips.replaceChildren(...mine().map((f) => h('span', { class: `chat-chip${f.busy ? ' is-busy' : ''}` },
        h('span', { class: 'chat-chip-name' }, f.busy ? `${f.name}…` : f.name),
        h('button', { type: 'button', 'aria-label': `Take off ${f.name}`, onclick: () => { files.set(id, mine().filter((x) => x !== f)); drawComposer(); } }, '×'))));
      chips.hidden = !mine().length;
      const busy = working();
      stopButton.hidden = !busy;
      sendButton.disabled = sending.has(id) || mine().some((f) => f.busy) || !(field.value.trim() || mine().some((f) => f.path));
      micButton.classList.toggle('is-live', Boolean(recognition));
      hint.textContent = narrow.matches ? '' : busy ? `Sent now, ${agent()} reads it after this step` : 'Enter to send · Shift+Enter for a new line';
    }

    async function attach(list) {
      const id = session?.id;
      if (!id) return;
      if (mine().length + list.length > MAX_FILES) return W.shell.toast(`At most ${MAX_FILES} files in one message`);
      const big = list.find((f) => f.size > MAX_FILE_MB * 1024 * 1024);
      if (big) return W.shell.toast(`${big.name || 'That file'} is over ${MAX_FILE_MB} MB`);
      await Promise.all(list.map(async (file) => {
        const entry = { name: file.name || `picture.${(file.type.split('/')[1] || 'png').replace(/[^a-z0-9]/g, '')}`, path: null, busy: true };
        files.set(id, [...(files.get(id) ?? []), entry]);
        drawComposer();
        const res = await fetch(`/api/sessions/${id}/upload?${new URLSearchParams({ name: entry.name, pane: 'none' })}`, {
          method: 'POST', headers: { 'x-woodshed': '1', 'content-type': 'application/octet-stream' }, body: file,
        }).catch(() => null);
        const body = await res?.json().catch(() => ({}));
        if (!res?.ok || !body?.path) {
          W.shell.toast(`${entry.name} not added: ${body?.error || 'the upload failed'}`);
          files.set(id, (files.get(id) ?? []).filter((f) => f !== entry));
        } else Object.assign(entry, { path: body.path, busy: false });
        if (id === session?.id) drawComposer();
      }));
    }

    function listen() {
      const id = session.id;
      const live = W.dictation.dictate(field, {
        heard: () => {},
        changed: () => { keepDraft(id, field.value); fit(); drawComposer(); },
        ended: () => { if (recognition === live) recognition = null; drawComposer(); },
      });
      recognition = live;
      drawComposer();
    }

    async function send() {
      const id = session?.id;
      if (!id || sending.has(id)) return;
      if (recognition) {
        const words = recognition.abort() ?? '';
        recognition = null;
        if (words) field.value = `${field.value.replace(/\s*$/, '')} ${words}`.trimStart();
      }
      const paths = mine().filter((f) => f.path).map((f) => f.path);
      const text = [field.value.trim(), ...paths].filter(Boolean).join('\n');
      if (!text) return;
      sending.add(id);
      const sent = { text, sentAt: Date.now(), state: 'sending' };
      pending.set(id, [...pendingOf(id), sent]);
      field.value = '';
      keepDraft(id, '');
      files.delete(id);
      fit();
      drawComposer();
      drawThread(true);
      try {
        await W.postJson(`/api/sessions/${id}/send`, { text }, { signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
        sent.state = 'sent';
      } catch (err) {
        // Back in the box, to send again.
        pending.set(id, pendingOf(id).filter((p) => p !== sent));
        if (id === session?.id && !field.value) {
          field.value = text;
          keepDraft(id, text);
          fit();
        }
        W.shell.toast(err.name === 'TimeoutError'
          ? `No answer in ${SEND_TIMEOUT_MS / 1000} s: check the TUI tab before sending again`
          : `Not sent: ${err.message}`, { ms: 6000 });
      } finally {
        sending.delete(id);
        if (id === session?.id) {
          drawComposer();
          drawThread(false);
          schedule(0);
        }
      }
    }

    async function interrupt() {
      const id = session?.id;
      if (!id) return;
      stopButton.disabled = true;
      try {
        await W.postJson(`/api/sessions/${id}/interrupt`, {});
        W.shell.toast(`Stopping ${agent()}'s turn`);
      } catch (err) {
        W.shell.toast(`Not stopped: ${err.message}`, { ms: 6000 });
      } finally {
        stopButton.disabled = false;
        schedule(0);
      }
    }

    // ---- The thread.

    function nearFoot() {
      return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < STICK_PX;
    }

    function foldOf(key, fallback) {
      const k = `${session.id}:${key}`;
      return folds.has(k) ? folds.get(k) : fallback;
    }

    function workLog(item, live) {
      const open = foldOf(item.key, live);
      const rows = item.tools.map((tool) => h('li', { class: `chat-tool${tool.error ? ' is-failed' : ''}` },
        h('span', { class: 'chat-tool-name' }, tool.tool),
        h('span', { class: 'chat-tool-text', title: tool.text || null }, tool.text || ''),
        tool.error && h('span', { class: 'chat-tool-failed' }, 'failed')));
      // A click is the person's choice, kept across redraws; the open the page sets while the log is live is not.
      const details = h('details', { class: `chat-work${live ? ' is-live' : ''}`, open: open || null },
        h('summary', { onclick: () => folds.set(`${session.id}:${item.key}`, !details.open) },
          h('span', { class: 'chat-caret', 'aria-hidden': 'true' }, '▸'),
          live && h('span', { class: 'spin', 'aria-hidden': 'true' }),
          h('span', { class: 'chat-work-what' }, T.workSummary(item.tools)),
          item.failed > 0 && h('span', { class: 'chat-work-failed' }, `${item.failed} failed`)),
        h('ul', null, rows));
      return details;
    }

    // What a turn changed (chatThread.cjs turnChanges), under its last work log that edited a file: a line with the
    // files and counts, open while the turn runs and folded once it is over, then a row a file, each folding open to
    // its edits' hunks, drawn in the Diff tab's own classes (rv-file, rv-diff). The record holds what the agent's edit
    // tools changed, never what a command did: a turn that ran one says so, and the Diff tab has the whole branch.
    const STATUS = { add: 'new', delete: 'deleted', rewrite: 'rewritten' };
    function diffLines(hunks) {
      return hunks.flatMap((hunk) => [
        h('span', { class: 'rv-line hunk' }, hunk.head || '@@'),
        ...hunk.lines.map((line) => h('span', { class: `rv-line ${line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : ''}` }, line || ' ')),
      ]);
    }

    function changedFile(f, changes) {
      const key = `${session.id}:diff:${changes.turn}:${f.path}`;
      const slash = f.path.lastIndexOf('/');
      const hunks = f.edits.flatMap((e) => e.hunks);
      const notes = [
        f.edits.some((e) => e.all) && 'Replaced every occurrence in the file.',
        f.edits.some((e) => e.rewrite) && 'Rewrote the whole file: its old lines are not in the record, the Diff tab has them.',
        f.op === 'delete' && !hunks.length && 'Deleted the file.',
        f.cut && 'Cut here to keep the chat light: the Diff tab has the whole change.',
      ].filter(Boolean);
      const details = h('details', { class: 'rv-file chat-diff-file', open: folds.get(key) || null },
        h('summary', { onclick: () => folds.set(key, !details.open) },
          h('span', { class: 'rv-path', title: f.to ? `${f.path} → ${f.to}` : f.path },
            slash >= 0 && h('span', { class: 'rv-dir' }, f.path.slice(0, slash + 1)), h('b', null, f.path.slice(slash + 1)),
            f.to && h('span', { class: 'rv-dir' }, ` → ${f.to}`)),
          STATUS[f.op] && h('span', { class: `rv-status is-${f.op === 'add' ? 'added' : f.op === 'delete' ? 'removed' : 'modified'}` }, STATUS[f.op]),
          h('span', { class: 'rv-counts' }, h('span', { class: 'rv-add' }, `+${f.add}`), ' ', h('span', { class: 'rv-del' }, `−${f.del}`))),
        hunks.length > 0 && h('pre', { class: 'rv-diff' }, diffLines(hunks)),
        notes.map((note) => h('p', { class: 'rv-note-line' }, note)));
      return details;
    }

    function turnDiff(changes, live) {
      const key = `${session.id}:diff:${changes.turn}`;
      const n = changes.files.length;
      const details = h('details', { class: `chat-diff${live ? ' is-live' : ''}`, open: (folds.has(key) ? folds.get(key) : live) || null },
        h('summary', { onclick: () => folds.set(key, !details.open) },
          h('span', { class: 'chat-caret', 'aria-hidden': 'true' }, '▸'),
          live && h('span', { class: 'spin', 'aria-hidden': 'true' }),
          h('span', { class: 'chat-diff-what' }, live ? `Changing ${n} file${n === 1 ? '' : 's'}` : `Changed ${n} file${n === 1 ? '' : 's'}`),
          h('span', { class: 'rv-counts' }, h('span', { class: 'rv-add' }, `+${changes.add}`), ' ', h('span', { class: 'rv-del' }, `−${changes.del}`))),
        h('div', { class: 'chat-diff-files' }, changes.files.map((f) => changedFile(f, changes))),
        h('p', { class: 'chat-diff-foot' },
          changes.commands ? 'Commands may have changed files too: see the ' : 'This turn\'s edits. The whole branch is on the ',
          h('button', { type: 'button', class: 'chat-link', onclick: openDiff }, 'Diff tab'), '.'));
      return details;
    }

    // What the agent asked, with its options. The open one takes the person's picks, one a question, and Send answers
    // has the session type them into the agent's picker; a question that takes several options is the TUI tab's.
    function askCard(item, open) {
      const key = `${session.id}:${item.key}`;
      const sent = answers.get(key);
      const live = open && T.canAnswer(item) && sent?.state !== 'sending' && sent?.state !== 'sent';
      const chosen = picks.get(key) ?? [];
      const said = item.answered ? 'Answered' : item.declined ? 'Not answered'
        : sent?.state === 'sending' ? 'Sending your answers…' : sent?.state === 'sent' ? `Sent, waiting for ${agent()}` : 'Waiting for your answer';
      const pick = (qi, oi) => {
        const next = [...chosen];
        next[qi] = oi;
        picks.set(key, next);
        if (answers.get(key)?.state === 'refused') answers.delete(key);
        drawThread(false);
      };
      const optionList = (q, qi) => {
        if (!live) {
          return q.options.length > 0 && h('ol', null, ...q.options.map((o, oi) => h('li', { class: sent && chosen[qi] === oi ? 'is-picked' : null }, o)));
        }
        return h('div', { class: 'chat-opts', role: 'group', 'aria-label': q.question },
          ...q.options.map((o, oi) => h('button', {
            type: 'button', class: 'chat-opt', 'aria-pressed': chosen[qi] === oi ? 'true' : 'false', onclick: () => pick(qi, oi),
          }, h('span', { class: 'chat-opt-n' }, `${oi + 1}.`), h('span', { class: 'chat-opt-label' }, o),
          chosen[qi] === oi && h('span', { class: 'chat-opt-mark', 'aria-hidden': 'true' }, '✓'))));
      };
      const body = T.answerBody(item, chosen);
      const several = item.questions.length > 1;
      const agentTab = (text) => h('button', { type: 'button', class: 'chat-link', onclick: openTerminal }, text);
      let foot = null;
      if (live) {
        foot = h('div', { class: 'chat-ask-foot' },
          h('button', { type: 'button', class: 'btn btn-sm btn-plain chat-ask-send', disabled: !body, onclick: () => sendAnswers(item, key) }, several ? 'Send answers' : 'Send answer'),
          h('span', { class: 'chat-ask-note' }, body ? `${agent()} gets ${several ? 'them' : 'it'} in its terminal` : several ? 'Pick one for each question' : 'Pick one',
            ' · to type your own, use the ', agentTab('TUI tab')));
      } else if (open && !item.answered && !item.declined && item.questions.some((q) => q.multiSelect)) {
        foot = h('div', { class: 'chat-ask-foot' }, h('span', { class: 'chat-ask-note' }, 'This takes several options: pick them in the ', agentTab('TUI tab')));
      }
      const refused = sent?.state === 'refused' && !item.answered && !item.declined
        && h('p', { class: 'chat-ask-error', role: 'alert' }, `Not answered: ${sent.error}. `, agentTab('Answer in the TUI tab'));
      return h('div', { class: `chat-ask${live ? ' is-open' : ''}` },
        h('div', { class: 'chat-ask-head' }, h('b', null, `${agent()} asks`), h('span', { class: 'chat-ask-state' }, said)),
        ...item.questions.map((q, qi) => h('div', { class: 'chat-ask-q' }, h('p', null, q.question), optionList(q, qi))),
        refused, foot);
    }

    async function sendAnswers(item, key) {
      const id = session?.id;
      const body = T.answerBody(item, picks.get(key) ?? []);
      if (!id || !body) return;
      answers.set(key, { state: 'sending' });
      drawThread(false);
      try {
        await W.postJson(`/api/sessions/${id}/answer`, body, { signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
        answers.set(key, { state: 'sent' });
      } catch (err) {
        answers.set(key, { state: 'refused', error: err.name === 'TimeoutError' ? `no answer in ${SEND_TIMEOUT_MS / 1000} s` : err.message });
      } finally {
        if (id === session?.id) {
          drawThread(false);
          schedule(0);
        }
      }
    }

    async function answerApproval(decision) {
      const id = session?.id;
      const shown = prompt?.id === id ? prompt.prompt : null;
      if (!shown || approval?.busy) return;
      approval = { busy: decision, error: null };
      drawStatus();
      try {
        await W.postJson(`/api/sessions/${id}/answer`, { kind: 'approval', decision, title: shown.title, detail: shown.detail }, { signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
        approval = null;
        answered = { id, decision, prompt: JSON.stringify(shown) };
        prompt = { id, prompt: null };
        W.shell.toast(decision === 'approve' ? `Approved: ${agent()} carries on` : `Denied: ${agent()} was told no`);
      } catch (err) {
        approval = { busy: null, error: err.name === 'TimeoutError' ? `no answer in ${SEND_TIMEOUT_MS / 1000} s` : err.message };
      } finally {
        if (id === session?.id) {
          drawStatus();
          schedule(0);
        }
      }
    }

    function messageNodes() {
      const nodes = [];
      if (readError && !record) return [h('p', { class: 'chat-empty' }, `Could not read the conversation: ${readError}`)];
      if (!record) return [h('p', { class: 'chat-empty' }, h('span', { class: 'spin', 'aria-hidden': 'true' }), 'Reading the conversation…')];
      const waiting = T.stillPending(pendingOf(session.id), record.entries);
      pending.set(session.id, waiting);
      const list = T.items(record.entries);
      if (record.partial) nodes.push(h('p', { class: 'chat-note' }, 'Older messages are left out: this shows the newest of a long conversation.'));
      if (!list.length && !waiting.length) {
        nodes.push(h('div', { class: 'chat-empty' },
          h('b', null, `No messages with ${agent()} yet`),
          h('span', null, 'Write one below. What it does shows here as it works; its terminal is on the TUI tab.')));
      }
      const live = working();
      const lastAsk = list.findLastIndex((item) => item.kind === 'ask');
      const changes = T.turnChanges(list);
      // The turn still running: everything after the person's last message.
      const lastTurn = list.findLastIndex((item) => item.kind === 'user');
      list.forEach((item, i) => {
        if (item.kind === 'user') nodes.push(h('div', { class: 'chat-user' }, h('div', { class: 'chat-bubble' }, item.text)));
        else if (item.kind === 'assistant') nodes.push(h('div', { class: 'chat-said' }, markdownNodes(item.text)));
        else if (item.kind === 'note') nodes.push(h('p', { class: 'chat-note' }, item.text));
        else if (item.kind === 'ask') nodes.push(askCard(item, i === lastAsk && i === list.length - 1));
        else {
          nodes.push(workLog(item, live && i === list.length - 1));
          if (changes.has(item.key)) nodes.push(turnDiff(changes.get(item.key), live && i > lastTurn));
        }
      });
      for (const p of waiting) {
        nodes.push(h('div', { class: 'chat-user is-pending' },
          h('div', { class: 'chat-bubble' }, p.text),
          h('span', { class: 'chat-sent' }, p.state === 'sending' ? 'Sending…' : `Sent, waiting for ${agent()}`)));
      }
      return nodes;
    }

    function drawThread(follow) {
      if (!session) return;
      const stick = follow || nearFoot();
      const top = scroller.scrollTop;
      thread.replaceChildren(...messageNodes());
      if (stick) scroller.scrollTop = scroller.scrollHeight;
      else scroller.scrollTop = top;
      drawStatus();
    }

    // Over the composer: what the agent is doing, as a word. Yellow only when it waits on the person.
    function drawStatus() {
      if (!session) return;
      const state = session.state;
      // Answered from here: the agent has it, and the console's state follows a few seconds later.
      if (state === 'needs-you' && !asking() && answered?.id === session.id) {
        status.className = 'chat-status';
        status.replaceChildren(h('span', null, h('b', null, answered.decision === 'approve' ? 'Approved' : 'Denied'), ` · waiting for ${agent()}`));
        return;
      }
      if (state === 'needs-you' || asking()) {
        status.className = 'chat-status is-needs';
        // Not read yet: the pane is being asked what it shows, which takes one call; the TUI tab's words wait for its answer.
        if (!asking() && prompt?.id !== session.id) {
          status.replaceChildren(h('span', null, h('b', null, 'Needs you'), ` · Reading what ${agent()} asks…`));
          return;
        }
        const shown = !asking() && prompt.prompt?.kind === 'approval' ? prompt.prompt : null;
        if (shown) {
          const { asks, lines } = T.approvalText(shown);
          const busy = approval?.busy;
          status.classList.add('is-approval');
          status.replaceChildren(...[
            h('span', { class: 'chat-needs-text' }, h('b', null, 'Needs you'), ` · ${agent()} asks: ${asks}`),
            lines.length > 0 && h('pre', { class: 'chat-approval' }, lines.join('\n')),
            approval?.error && h('p', { class: 'chat-needs-error', role: 'alert' }, `Not answered: ${approval.error}. Answer in the TUI tab.`),
            h('span', { class: 'chat-needs-actions' },
              h('button', { type: 'button', class: 'btn btn-sm btn-plain', onclick: openTerminal }, 'TUI tab'),
              h('button', { type: 'button', class: 'btn btn-sm btn-plain', disabled: Boolean(busy), title: shown.deny, onclick: () => answerApproval('deny') }, busy === 'deny' ? 'Denying…' : 'Deny'),
              h('button', { type: 'button', class: 'btn btn-sm chat-answer', disabled: Boolean(busy), title: shown.approve, onclick: () => answerApproval('approve') }, busy === 'approve' ? 'Approving…' : 'Approve')),
          ].filter(Boolean));
          return;
        }
        const open = asking() && T.canAnswer(T.items(ownRecord()?.entries ?? []).pop());
        status.replaceChildren(
          h('span', null, h('b', null, 'Needs you'), open ? ` · ${agent()} asks above: pick your answers there`
            : asking() ? ` · ${agent()} asks above; it takes the answer in its terminal` : ` · ${agent()} is asking something it shows in its terminal`),
          h('button', { type: 'button', class: 'btn btn-sm chat-answer', onclick: openTerminal }, open ? 'TUI tab' : 'Answer in the TUI tab'));
        return;
      }
      if (working()) {
        const since = T.turnStart(record?.entries ?? []) ?? pendingOf(session.id)[0]?.sentAt ?? null;
        status.className = 'chat-status is-working';
        status.replaceChildren(h('span', { class: 'spin', 'aria-hidden': 'true' }),
          h('b', null, 'Working'), since ? h('span', { class: 'chat-clock' }, T.elapsed(since)) : null);
        return;
      }
      if (state !== 'done' && state !== 'starting' && state) {
        status.className = 'chat-status';
        status.replaceChildren(h('span', null, h('b', null, `${W.agentTitle(session)} exited`), ' · the TUI tab shows its terminal'));
        return;
      }
      status.className = 'chat-status';
      status.replaceChildren();
    }

    // While the session needs the person and the record holds no question of claude's: what its pane asks, read from
    // the screen, so an approval shows on the Needs you line with its own buttons. Read at once when the state turns
    // Needs you (show), not after the thread's read, and again with each read of the thread while it stays so. Never
    // while the agent works.
    async function readPrompt(id) {
      if (id !== session?.id) return;
      if (session.state !== 'needs-you' || asking()) {
        if (prompt) {
          prompt = null;
          approval = null;
          drawStatus();
        }
        return;
      }
      if (promptReading) return;
      promptReading = true;
      let read = null;
      try {
        read = await W.getJson(`/api/sessions/${id}/prompt`);
      } catch {
        // A console or session from before /prompt, or one that did not answer: the line gets its button to the TUI tab.
      } finally {
        promptReading = false;
      }
      if (id !== session?.id || session.state !== 'needs-you') return;
      const was = prompt?.id === id ? JSON.stringify(prompt.prompt) : undefined;
      let next = read?.prompt ?? null;
      // The prompt just answered, still on the screen as the keys land: it is not asked again.
      if (next && answered?.id === id && JSON.stringify(next) === answered.prompt) next = null;
      else if (next) answered = null;
      prompt = { id, prompt: next };
      if (JSON.stringify(next) !== was) {
        if (!approval?.busy) approval = null;
        drawStatus();
      }
    }

    async function read() {
      if (!session) return;
      if (reading) {
        again = true;
        return;
      }
      const id = session.id;
      reading = true;
      try {
        const since = record?.id === id && record.writtenAt ? `&since=${record.writtenAt}` : '';
        const answer = await W.getJson(`/api/sessions/${id}/transcript?limit=${LIMIT}${since}`);
        if (id !== session?.id) return;
        readError = null;
        if (answer.unchanged && record?.id === id) return;
        record = { id, ...answer };
        drawThread(false);
        // The record can end the turn (an interrupt) before the console's state says so: Stop goes with it.
        drawComposer();
      } catch (err) {
        if (id !== session?.id) return;
        readError = err.message;
        if (!record) drawThread(false);
      } finally {
        await readPrompt(id);
        reading = false;
        if (id === session?.id) schedule(again ? 0 : undefined);
        again = false;
      }
    }

    function schedule(ms) {
      clearTimeout(timer);
      if (!session) return;
      const busy = working() || pendingOf(session.id).length > 0;
      timer = setTimeout(() => (document.hidden ? schedule() : read()), ms ?? (busy ? FAST_MS : SLOW_MS));
    }
    document.addEventListener('visibilitychange', () => { if (!document.hidden && session) schedule(0); });

    /** @param {object|null} s  the running session whose Chat tab shows, or null when it is not shown */
    function show(s) {
      el.hidden = !s;
      if (!s) {
        if (recognition) recognition.abort();
        recognition = null;
        session = null;
        clearTimeout(timer);
        clearInterval(ticker);
        ticker = null;
        return;
      }
      // Each second: the working clock moves, and a turn the record says ended (or began) redraws its work log.
      ticker ??= setInterval(() => {
        if (!session) return;
        const now = working();
        if (now !== wasWorking) {
          wasWorking = now;
          drawThread(false);
          drawComposer();
        } else if (now) drawStatus();
      }, 1000);
      const moved = s.id !== session?.id;
      const was = session?.state;
      session = s;
      if (moved) {
        prompt = null;
        approval = null;
      }
      // A new Needs you: what the pane asks is read now, beside the thread, so an approval's buttons come with it.
      if (s.state === 'needs-you' && (moved || was !== 'needs-you')) {
        prompt = null;
        approval = null;
        answered = null;
        readPrompt(s.id);
      } else if (s.state !== 'needs-you') answered = null;
      if (moved) settledAt = s.state === 'working' ? 0 : Date.now() - STATE_LAG_MS;
      else if (was !== s.state && s.state !== 'working') settledAt = Date.now();
      if (moved) {
        if (recognition) recognition.abort();
        recognition = null;
        record = null;
        readError = null;
        const label = `Message ${agent()}`;
        field.placeholder = label;
        field.setAttribute('aria-label', label);
        agentName.textContent = agent();
        field.value = readDraft(s.id);
        fit();
        drawThread(true);
        drawComposer();
        schedule(0);
        if (!narrow.matches) setTimeout(() => { if (session?.id === s.id && !el.hidden) field.focus({ preventScroll: true }); }, 0);
      } else if (was !== s.state) {
        // The state moved (a turn ended, or started): the live work log and the status line follow, and the thread is
        // read at once, so a reply lands as the turn ends rather than a slow tick later.
        drawThread(false);
        drawComposer();
        schedule(0);
      }
    }

    return { el, show, focus: () => field.focus() };
  }

  W.createChat = createChat;
})();
