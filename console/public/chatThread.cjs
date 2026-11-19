// The Chat tab's reading of a conversation (chat.js): the entries statusd reads from the agent's own record of it
// (session/sessionTranscript.mjs) made into what the thread shows. A person's messages and the agent's replies stay
// as they are; a run of tool calls between them becomes one work log, summed up in a line ("Ran 3 commands, edited 2
// files"). The agent's text is Markdown, read here into a small tree that chat.js builds with DOM calls, never as
// HTML: a reply can quote anything, a page's markup included. One file for chat.js (a script that sets
// `WoodshedChatThread`) and its test.
(function (root, factory) {
  const thread = factory();
  if (typeof module === 'object' && module.exports) module.exports = thread;
  else root.WoodshedChatThread = thread;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';

  // ---- Markdown, the part agents write: paragraphs, headings, lists, quotes, fenced code, tables and the inline marks.

  const SAFE_LINK = /^(https?:\/\/|mailto:)/i;
  // `code`, **bold**, *em* or _em_, [text](url), and a bare http(s) link, whichever comes first.
  const INLINE = /`([^`\n]+)`|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|(?<![\w*])\*([^*\n]+?)\*(?!\w)|(?<![\w_])_([^_\n]+?)_(?![\w_])|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

  /** @returns {{t: 'text'|'code'|'b'|'i'|'a', v: string, href?: string}[]} */
  function inline(text) {
    const out = [];
    let last = 0;
    for (const m of String(text).matchAll(INLINE)) {
      if (m.index > last) out.push({ t: 'text', v: text.slice(last, m.index) });
      if (m[1] !== undefined) out.push({ t: 'code', v: m[1] });
      else if (m[2] !== undefined || m[3] !== undefined) out.push({ t: 'b', v: m[2] ?? m[3] });
      else if (m[4] !== undefined || m[5] !== undefined) out.push({ t: 'i', v: m[4] ?? m[5] });
      else if (m[6] !== undefined) out.push(SAFE_LINK.test(m[7]) ? { t: 'a', v: m[6], href: m[7] } : { t: 'text', v: m[0] });
      else out.push({ t: 'a', v: m[8], href: m[8] });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ t: 'text', v: text.slice(last) });
    return out;
  }

  const FENCE = /^\s{0,3}(```+|~~~+)\s*([\w+.-]*)/;
  const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  const BULLET = /^(\s*)[-*+]\s+(.*)$/;
  const NUMBERED = /^(\s*)\d{1,3}[.)]\s+(.*)$/;
  const QUOTE = /^\s{0,3}>\s?(.*)$/;
  const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
  const TABLE_ROW = /^\s*\|.*\|\s*$/;
  const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

  // A row's cells, split at each pipe that is not escaped (`\|`, as GFM writes one in a cell) nor inside a code span,
  // which models often leave unescaped (`a | b`).
  function cells(line) {
    const row = line.trim().replace(/^\|/, '').replace(/(^|[^\\])\|$/, '$1');
    const out = [];
    let cell = '';
    let tick = 0;
    for (let i = 0; i < row.length; i++) {
      const ch = row[i];
      if (ch === '\\' && row[i + 1] === '|') {
        cell += '|';
        i++;
      } else if (ch === '`') {
        let n = 1;
        while (row[i + n] === '`') n++;
        if (!tick) tick = n;
        else if (tick === n) tick = 0;
        cell += row.slice(i, i + n);
        i += n - 1;
      } else if (ch === '|' && !tick) {
        out.push(cell);
        cell = '';
      } else cell += ch;
    }
    out.push(cell);
    return out.map((c) => inline(c.trim()));
  }

  /**
   * @returns {object[]}  blocks: {type: 'p'|'h'|'quote', inline, level?}, {type: 'code', lang, text},
   *   {type: 'ul'|'ol', items: inline[]}, {type: 'table', head: inline[], rows: inline[][]}, {type: 'hr'}
   */
  function markdown(text) {
    const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];
    let para = [];
    const endPara = () => {
      if (para.length) blocks.push({ type: 'p', inline: inline(para.join('\n')) });
      para = [];
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = FENCE.exec(line);
      if (fence) {
        endPara();
        const body = [];
        // An unclosed fence runs to the end: a reply cut mid-code still shows as code.
        for (i++; i < lines.length && !lines[i].trimStart().startsWith(fence[1]); i++) body.push(lines[i]);
        blocks.push({ type: 'code', lang: fence[2] || '', text: body.join('\n') });
        continue;
      }
      if (!line.trim()) {
        endPara();
        continue;
      }
      const heading = HEADING.exec(line);
      if (heading) {
        endPara();
        blocks.push({ type: 'h', level: heading[1].length, inline: inline(heading[2]) });
        continue;
      }
      if (RULE.test(line)) {
        endPara();
        blocks.push({ type: 'hr' });
        continue;
      }
      if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[i + 1] ?? '')) {
        endPara();
        const head = cells(line);
        const rows = [];
        for (i += 2; i < lines.length && TABLE_ROW.test(lines[i]); i++) rows.push(cells(lines[i]));
        i--;
        blocks.push({ type: 'table', head, rows });
        continue;
      }
      const list = BULLET.exec(line) ? 'ul' : NUMBERED.exec(line) ? 'ol' : null;
      if (list) {
        endPara();
        const re = list === 'ul' ? BULLET : NUMBERED;
        const items = [];
        for (; i < lines.length; i++) {
          const item = re.exec(lines[i]);
          if (item) items.push(item[2]);
          // A wrapped item's next line, indented under it.
          else if (items.length && /^\s{2,}\S/.test(lines[i])) items[items.length - 1] += `\n${lines[i].trim()}`;
          else break;
        }
        i--;
        blocks.push({ type: list, items: items.map(inline) });
        continue;
      }
      const quote = QUOTE.exec(line);
      if (quote) {
        endPara();
        const body = [];
        for (; i < lines.length && QUOTE.test(lines[i]); i++) body.push(QUOTE.exec(lines[i])[1]);
        i--;
        blocks.push({ type: 'quote', inline: inline(body.join('\n')) });
        continue;
      }
      para.push(line);
    }
    endPara();
    return blocks;
  }

  // ---- The thread.

  // What claude writes in the person's turn when Esc cut the agent's short, and statusd writes for codex's turn_aborted
  // (session/sessionTranscript.mjs).
  const INTERRUPTED = /^\[Request interrupted by user[^\]]*\]$/;

  // Each tool, by what it did, for the work log's line. claude's names and codex's.
  const KINDS = [
    ['command', /^(Bash|BashOutput|KillShell|shell|exec_command|local_shell|unified_exec|write_stdin)$/i],
    ['edit', /^(Edit|MultiEdit|Write|NotebookEdit|apply_patch)$/i],
    ['read', /^(Read|view_image|NotebookRead)$/i],
    ['search', /^(Grep|Glob|LS|ToolSearch)$/i],
    ['web', /^(WebFetch|WebSearch|web_search)$/i],
    ['agent', /^(Task|Agent)$/i],
    ['plan', /^(TodoWrite|update_plan|ExitPlanMode)$/i],
  ];
  const PHRASES = {
    command: (n) => `ran ${n} command${n === 1 ? '' : 's'}`,
    edit: (n) => `edited ${n} file${n === 1 ? '' : 's'}`,
    read: (n) => `read ${n} file${n === 1 ? '' : 's'}`,
    search: (n) => `searched ${n} time${n === 1 ? '' : 's'}`,
    web: (n) => `looked up ${n} page${n === 1 ? '' : 's'}`,
    agent: (n) => `started ${n} agent${n === 1 ? '' : 's'}`,
    plan: (n) => `updated the plan${n === 1 ? '' : ` ${n} times`}`,
    tool: (n) => `used ${n} other tool${n === 1 ? '' : 's'}`,
  };

  /** @returns {string}  'command', 'edit', … or 'tool' */
  function toolKind(name) {
    return KINDS.find(([, re]) => re.test(String(name)))?.[0] ?? 'tool';
  }

  /** @returns {string}  "Ran 3 commands, edited 2 files", in the order each kind first came */
  function workSummary(tools) {
    const counts = new Map();
    for (const tool of tools) {
      const kind = toolKind(tool.tool);
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    const said = [...counts].map(([kind, n]) => PHRASES[kind](n)).join(', ');
    return said ? said[0].toUpperCase() + said.slice(1) : '';
  }

  /**
   * The entries as the thread shows them.
   * @param {{role: string, text: string, tool?: string, error?: boolean, at: string|null}[]} entries
   * @returns {object[]}  {kind: 'user'|'assistant'|'note', text, at} and {kind: 'work', key, tools, failed, at}; a work
   *   log's key is its first entry's place in the list, which stays put as entries come after it
   */
  function items(entries) {
    const out = [];
    entries.forEach((entry, index) => {
      if (entry.role === 'tool' && entry.questions) {
        out.push({ kind: 'ask', key: index, questions: entry.questions, answered: !!entry.answered, declined: !!entry.error, at: entry.at });
      } else if (entry.role === 'tool') {
        const last = out[out.length - 1];
        if (last?.kind === 'work') {
          last.tools.push(entry);
          if (entry.error) last.failed++;
          last.until = entry.at;
        } else out.push({ kind: 'work', key: index, tools: [entry], failed: entry.error ? 1 : 0, at: entry.at, until: entry.at });
      } else if (entry.role === 'user' && INTERRUPTED.test(entry.text.trim())) {
        // codex's interrupt note names the command when the turn ended at its approval, refused.
        out.push({ kind: 'note', text: entry.denied ? `Denied: ${entry.denied}` : 'Interrupted', at: entry.at });
      } else if (entry.role === 'user' || entry.role === 'assistant') {
        out.push({ kind: entry.role, text: entry.text, at: entry.at });
      }
    });
    return out;
  }

  /**
   * The code each turn changed, from its edits' diffs (session/transcriptDiff.mjs). A turn is a message from the person
   * and everything after it up to their next one. Its files are listed once each, in the order it first touched them,
   * with every edit of that file in order and the counts summed; the list shows under the turn's last work log that
   * edited a file, which is where `key` points.
   * @param {object[]} list  items()'s answer
   * @returns {Map<number, {key: number, turn: number, files: object[], add: number, del: number, commands: boolean, cut: boolean}>}
   *   by the work log's key it shows under. turn: the key of the turn's first work log, which stays put as the turn
   *   goes on. files: {path, op: 'edit'|'add'|'delete'|'rewrite', to?, add, del, cut, edits: [{hunks, all?, cut?}]}.
   *   commands: the turn ran commands, which can change files the record does not show
   */
  function turnChanges(list) {
    const out = new Map();
    let turn = null;
    const close = () => {
      if (turn?.files.size) {
        const files = [...turn.files.values()];
        out.set(turn.key, {
          key: turn.key, turn: turn.first, files, commands: turn.commands,
          add: files.reduce((n, f) => n + f.add, 0), del: files.reduce((n, f) => n + f.del, 0), cut: files.some((f) => f.cut),
        });
      }
      turn = null;
    };
    for (const item of list) {
      if (item.kind === 'user') close();
      if (item.kind !== 'work') continue;
      turn ??= { files: new Map(), commands: false, key: null, first: item.key };
      for (const tool of item.tools) {
        if (toolKind(tool.tool) === 'command') turn.commands = true;
        for (const d of Array.isArray(tool.diffs) ? tool.diffs : []) {
          if (!d || typeof d.path !== 'string') continue;
          turn.key = item.key;
          let file = turn.files.get(d.path);
          if (!file) turn.files.set(d.path, file = { path: d.path, op: d.op, add: 0, del: 0, cut: false, edits: [] });
          // A file the turn made stays new however often it is edited after; one it deleted, or wrote whole, says so.
          else if (d.op === 'delete') file.op = 'delete';
          else if (d.op !== 'edit' && file.op !== 'add') file.op = 'rewrite';
          if (d.to) file.to = d.to;
          file.add += Number(d.add) || 0;
          file.del += Number(d.del) || 0;
          if (d.cut) file.cut = true;
          file.edits.push({ hunks: Array.isArray(d.hunks) ? d.hunks : [], ...(d.all && { all: true }), ...(d.cut && { cut: true }), ...(d.op === 'rewrite' && { rewrite: true }) });
        }
      }
    }
    close();
    return out;
  }

  const squash = (text) => String(text).replace(/\s+/g, ' ').trim();
  // How long a sent message is shown as sent before it is let go, when the record never shows it: an agent that
  // exited, or a message it took as a command.
  const PENDING_MS = 10 * 60_000;

  /**
   * The messages sent from the page that the agent's record does not hold yet, to show after the thread. One shows
   * up as a person's entry written no earlier than a little before it was sent, starting with its text (the record
   * can add to it, such as an attached file's path).
   * @param {{text: string, sentAt: number}[]} pending
   * @param {{role: string, text: string, at: string|null}[]} entries
   */
  /** A message as statusd types it (session/statusd.mjs, typeableText): CRLF made newlines, other control characters out. */
  function typeable(text) {
    return String(text ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  }

  // The record's text of a person's message against one sent from the page: the same, whitespace aside. Never a longer
  // one that starts the same, which a message submitted in the TUI tab can be. Only an entry the record cut short (past
  // its 8000 characters, marked …) is matched by its start.
  function sameMessage(recorded, want) {
    const got = squash(typeable(recorded));
    if (got === want) return true;
    return got.endsWith('…') && got.length > 8000 && want.startsWith(got.slice(0, -1));
  }

  function stillPending(pending, entries, now = Date.now()) {
    const used = new Set();
    // The entry that settled a message is no later message's: each after it must be matched by an entry after that one,
    // on this read and the next (its `after` moves on), so one entry never settles two identical messages.
    let settledAt = null;
    const left = [];
    for (const p of pending) {
      // On the bubble itself, which the page keeps and its send() goes on updating: never a copy.
      if (settledAt && (p.after == null || Date.parse(p.after) < Date.parse(settledAt))) p.after = settledAt;
      // One the console holds waits as long as the agent's turn runs: it is let go only once the record holds it.
      if (p.state !== 'held' && p.state !== 'in-box' && now - p.sentAt > PENDING_MS) continue;
      const want = squash(typeable(p.text));
      // After the last message of the person's the record held when this one was sent (`after`, the session's own
      // clock): an earlier prompt that starts the same is never taken for it. A message from before `after` was kept
      // falls back on the page's clock, with room for the two clocks to differ.
      const later = (e) => (p.after !== undefined ? !!e.at && (p.after === null || Date.parse(e.at) > Date.parse(p.after))
        : !e.at || Date.parse(e.at) >= p.sentAt - 30_000);
      const found = entries.findIndex((e, i) => !used.has(i) && e.role === 'user' && later(e) && sameMessage(e.text, want));
      if (found === -1) {
        left.push(p);
        continue;
      }
      used.add(found);
      const at = entries[found].at;
      if (at && (!settledAt || Date.parse(at) > Date.parse(settledAt))) settledAt = at;
    }
    return left;
  }


  /** @returns {string}  "8s", "2m 05s", "1h 03m" */
  function elapsed(fromMs, now = Date.now()) {
    const s = Math.max(0, Math.floor((now - fromMs) / 1000));
    if (s < 60) return `${s}s`;
    const pad = (n) => String(n).padStart(2, '0');
    if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
    return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
  }

  /** @returns {number|null}  when the turn now running began: the newest message the person sent */
  function turnStart(entries) {
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].role === 'user' && entries[i].at) return Date.parse(entries[i].at);
    }
    return null;
  }

  // A turn whose record moved this recently, and ends on what the person said or a tool's call, is still running: the
  // console reads the agent's state every few seconds, the record says it sooner. One left like that for longer is an
  // agent that stopped mid-turn, which the console's state says.
  const MID_TURN_MS = 90_000;

  /**
   * @param {{entries: {role: string, text?: string}[], writtenAt: number|null}|null} record  the last answer
   * @param {number} settledAt  when the console last said the agent was not working: a record no newer than that is
   *   one it already read as over, a turn stopped by Esc among them
   * @returns {boolean}  whether the record says the agent is in the middle of a turn
   */
  function midTurn(record, settledAt = 0, now = Date.now()) {
    const last = record?.entries?.[record.entries.length - 1];
    if (!last || !record.writtenAt || record.writtenAt <= settledAt || now - record.writtenAt > MID_TURN_MS) return false;
    if (last.role === 'user' && INTERRUPTED.test(String(last.text ?? '').trim())) return false;
    return last.role === 'user' || last.role === 'tool';
  }

  /**
   * @returns {boolean}  whether the record ends on claude's note of an Esc: the turn is over, whatever the console's
   *   state still says until its next read of the agent (a few seconds after a Stop)
   */
  function endedByStop(record) {
    const last = record?.entries?.[record.entries.length - 1];
    return !!last && last.role === 'user' && INTERRUPTED.test(String(last.text ?? '').trim());
  }

  // ---- Answering from the page: claude's AskUserQuestion, and an approval the pane shows.

  /**
   * @param {{kind: 'ask', questions: {question: string, options: string[], multiSelect?: boolean}[], answered: boolean,
   *   declined: boolean}} item
   * @returns {boolean}  whether the page can answer it: still open, and one option a question (a multi-select one is
   *   picked in the terminal)
   */
  function canAnswer(item) {
    return !!item && item.kind === 'ask' && !item.answered && !item.declined
      && item.questions.every((q) => !q.multiSelect && q.options.length > 0);
  }

  /**
   * POST /answer's body for the person's picks, once each question has one.
   * @param {{questions: {question: string, options: string[]}[]}} item
   * @param {(number|null|undefined)[]} picks  the option picked for each question, by index
   * @returns {object|null}  null while a question has no pick
   */
  function answerBody(item, picks) {
    if (!item.questions.every((q, i) => Number.isInteger(picks[i]) && picks[i] >= 0 && picks[i] < q.options.length)) return null;
    return { kind: 'question', questions: item.questions.map((q, i) => ({ question: q.question, options: q.options, ...(Array.isArray(q.descriptions) && { descriptions: q.descriptions }), pick: picks[i] })) };
  }

  /**
   * What the Needs you line says of an approval the pane shows (GET /prompt).
   * @param {{what: string|null, title: string, detail: string[]}} prompt
   * @returns {{asks: string, lines: string[]}}  asks: the agent's own question; lines: what it would run or change
   */
  function approvalText(prompt) {
    // The reason goes last, with the lines it wrapped onto: up to the command (`$ `) or the next `Label:` line.
    const detail = prompt.detail ?? [];
    const at = detail.findIndex((l) => /^Reason:/i.test(l));
    let end = at + 1;
    while (at !== -1 && end < detail.length && detail[end].trim() && !/^\$ /.test(detail[end]) && !/^[A-Z][\w ]{0,20}:/.test(detail[end])) end++;
    const reason = at === -1 ? null : detail.slice(at, end).map((l) => l.trim()).join(' ');
    // Every line, as drawn, indentation and blank lines kept: an approval the page answers is one it shows whole
    // (panePrompt.mjs, `complete`). One blank where the reason stood, none at either end.
    const lines = (at === -1 ? detail : [...detail.slice(0, at), ...detail.slice(end)])
      .filter((l, i, all) => l.trim() || (i > 0 && i < all.length - 1 && all[i - 1].trim()));
    return { asks: prompt.what ? `${prompt.what}: ${prompt.title}` : prompt.title, lines: reason ? [...lines, reason] : lines };
  }

  /**
   * One run at a time: a call while one runs is kept, and run once that one ends, whatever it was about. The Chat tab's
   * reads go through it: a read asked for session B while A's is on its way runs when A's ends, rather than being
   * dropped with A's answer, which left B on "Reading the conversation…".
   * @param {() => Promise<void>} run
   * @returns {() => Promise<void>}
   */
  function oneAtATime(run) {
    let busy = false;
    let queued = false;
    return async function request() {
      if (busy) {
        queued = true;
        return;
      }
      busy = true;
      try {
        await run();
      } finally {
        busy = false;
        if (queued) {
          queued = false;
          request();
        }
      }
    };
  }

  /**
   * Why a message cannot go yet, or null: a file still uploading would be left out, and dropped with the draft. Send's
   * button and Enter both ask it, since Enter calls send itself and a disabled button does not stop it.
   * @param {{text: string, files: {name: string, path: string|null, busy?: boolean}[], sending: boolean}} draft
   * @returns {string|null}
   */
  function notReady({ text, files, sending }) {
    if (sending) return 'sending';
    const busy = files.find((f) => f.busy);
    if (busy) return `${busy.name} is still uploading: it goes with the message once it is up`;
    if (!String(text ?? '').trim() && !files.some((f) => f.path)) return 'nothing to send';
    return null;
  }

  /**
   * What a message sent from the page says under it until the agent's record holds it.
   * @param {'sending'|'sent'|'held'} state  held: the console keeps it while the agent is busy, nothing has reached it
   */
  function pendingLabel(state, agent) {
    if (state === 'sending') return 'Sending…';
    if (state === 'in-box') return `In ${agent}'s box, not sent: send or clear it in the TUI tab`;
    if (state === 'held') return `Not sent yet: it goes in when ${agent} is back at its prompt`;
    return `Sent, waiting for ${agent}`;
  }

  /**
   * How long the page waits on a send: longer than the console waits on statusd typing it (console/fleet.mjs,
   * sendTimeoutMs), since statusd types a long claude message a run at a time.
   */
  function sendTimeoutMs(text) {
    const steps = Math.ceil(text.length / 50) + text.split('\n').length;
    return 15_000 + steps * 60;
  }

  /**
   * The page's messages after the console said one sits in the agent's box unsent (`leftInBox`: its length and when):
   * the one of that length sent before then says so; once the box is empty again (no leftInBox) it is let go, since it
   * was sent from the TUI tab (the record shows it) or cleared.
   * @param {{text: string, sentAt: number, state: string}[]} pending
   * @param {{at: string, chars: number}|null} leftInBox
   */
  function inBox(pending, leftInBox) {
    if (!leftInBox) return pending.filter((p) => p.state !== 'in-box');
    const at = Date.parse(leftInBox.at);
    let marked = false;
    return pending.map((p) => {
      if (marked || p.state === 'sending' || p.text.length !== leftInBox.chars || p.sentAt > at) return p;
      marked = true;
      return { ...p, state: 'in-box' };
    });
  }

  /** @returns {string|null}  when the last message of the person's in the record was written, by the session's clock */
  function lastUserAt(entries) {
    for (let i = (entries?.length ?? 0) - 1; i >= 0; i--) {
      if (entries[i].role === 'user' && entries[i].at) return entries[i].at;
    }
    return null;
  }

  /**
   * Held bubbles the console has since sent: it holds `holds` messages now, so the page's held ones past that count, the
   * oldest first, went in. Each becomes a sent one from now on, let go after ten minutes if the record never shows it
   * (a slash command the agent keeps no record of, say), instead of waiting for ever. Changed on the bubbles themselves.
   * @param {{state: string, sentAt: number}[]} pending
   * @param {number|undefined} holds  the session's pendingMessages count, as the console reports it
   * @returns {boolean}  whether any changed
   */
  function deliveredHeld(pending, holds, now = Date.now()) {
    if (!Number.isInteger(holds)) return false;
    const held = pending.filter((p) => p.state === 'held');
    const gone = held.length - holds;
    for (const p of held.slice(0, Math.max(0, gone))) {
      p.state = 'sent';
      p.sentAt = now;
    }
    return gone > 0;
  }

  return { deliveredHeld, typeable, lastUserAt, inBox, sendTimeoutMs, pendingLabel, notReady, oneAtATime, markdown, inline, items, toolKind, workSummary, turnChanges, stillPending, elapsed, turnStart, midTurn, endedByStop, canAnswer, answerBody, approvalText };
});
