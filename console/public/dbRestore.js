// My settings' Restore a dump, inside Your databases (dbRestore.mjs). A Postgres or Mongo dump goes into a copy of
// your database first; the page shows each step as the session start does, what came in, and your database changes
// only on Apply.
(function () {
  'use strict';
  const W = window.Woodshed;
  const { h } = W;
  // pg_dump's custom format without owners, grants or comments. The project file's `dump.extensions` are the ones the
  // database's user may create; the other extensions a source database has would need a superuser here.
  const PG_FLAGS = ['--format=custom', '--no-owner', '--no-privileges', '--no-comments'];
  const NO_DUMP = { skip: [], extensions: [] };
  const PG_SOURCE = '"postgres://USER:PASSWORD@HOST:5432/DATABASE"';
  const BUSY = ['sending', 'restoring', 'applying'];
  const PILL = {
    sending: ['Sending', 'is-work'], restoring: ['Restoring', 'is-work'], applying: ['Applying', 'is-work'],
    ready: ['Ready to check', 'is-ok'], applied: ['Applied', 'is-ok'], failed: ['Failed', 'is-bad'],
  };
  const KIND_NAME = { postgres: 'Postgres', mongo: 'Mongo' };
  // A mongodump archive's first bytes; pg_dump's custom format starts PGDMP, then the archive version.
  const MONGO_MAGIC = [0x6d, 0xe2, 0x99, 0x81];

  /**
   * The commands that make a dump this restores cleanly, one argument a line so a table is easy to drop or add. `dump`
   * is what the project file's databases leave out (`databases[].dump`), names project.mjs has checked.
   * @returns {{key: string, title: string, command: string}[]}
   */
  function dumpCommands({ pgMajor, kinds, dump }) {
    const pg = dump?.postgres ?? NO_DUMP;
    const flags = [...PG_FLAGS, ...pg.extensions.map((e) => `--extension=${e}`)];
    const pgDump = (file) => [
      ...flags.reduce((rows, flag, i) => (i % 2 ? [...rows.slice(0, -1), `${rows.at(-1)} ${flag}`] : [...rows, flag]), [])
        .map((pair) => `  ${pair} \\`), ...pg.skip.map((t) => `  --exclude-table-data='${t}' \\`), `  --file=${file} ${PG_SOURCE}`,
    ].join('\n');
    const commands = [
      { key: 'pg', title: `Postgres, with pg_dump ${pgMajor} (pg_dump --version says)`, command: `pg_dump \\\n${pgDump('woodshed.dump')}` },
      {
        key: 'docker', title: 'Postgres, with Docker, whatever pg_dump you have (a database on your own computer is HOST=host.docker.internal)',
        command: `docker run --rm -v "$PWD:/dump" postgres:${pgMajor} pg_dump \\\n${pgDump('/dump/woodshed.dump')}`,
      },
    ];
    if (kinds.mongo) {
      commands.push({
        key: 'mongo', title: 'Mongo, one database (a local one without a password is mongodb://localhost:27017/DATABASE)',
        command: ['mongodump --uri="mongodb://USER:PASSWORD@HOST:27017/DATABASE?authSource=admin" \\',
          ...(dump?.mongo ?? NO_DUMP).skip.map((c) => `  --excludeCollection=${c} \\`), '  --archive=woodshed-mongo.gz --gzip'].join('\n'),
      });
    }
    return commands;
  }

  /** @returns {Promise<{refused: string, detail: string}|null>}  what the console would refuse, read in the browser */
  async function headerProblem(file, pgMajor) {
    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    if (String.fromCharCode(...head.slice(0, 5)) === 'PGDMP') {
      if (head[5] === 1 && head[6] <= 15) return null;
      return {
        refused: `This dump was made by pg_dump 17 or newer (archive ${head[5]}.${head[6]}). Your databases are Postgres ${pgMajor}, which can't read it. Make it again with Postgres ${pgMajor}'s pg_dump; Docker gives you one whatever version you have.`,
        detail: 'made by pg_dump 17 or newer',
      };
    }
    if (MONGO_MAGIC.every((b, i) => head[i] === b) || (head[0] === 0x1f && head[1] === 0x8b)) return null;
    return { refused: 'This is not a pg_dump custom archive or a mongodump archive. Make it with one of the commands on this page.', detail: 'not a dump' };
  }

  function clock(fromIso) {
    const secs = Math.max(0, Math.round((Date.now() - Date.parse(fromIso)) / 1000));
    return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  }

  function took(secs) {
    if (secs === null || secs === undefined) return '';
    return secs < 60 ? `${secs} s` : `${Math.floor(secs / 60)} min ${String(secs % 60).padStart(2, '0')} s`;
  }

  function copyButton(text) {
    return h('button', {
      type: 'button', class: 'btn btn-plain',
      onclick: async (e) => {
        try {
          await navigator.clipboard.writeText(text);
          e.currentTarget.textContent = 'Copied';
        } catch {
          window.alert('The browser would not copy. Select the text and copy it by hand.');
        }
      },
    }, 'Copy');
  }

  function stepLabels(restore) {
    const copy = h('code', null, restore.copy);
    return {
      send: 'Send the dump',
      check: restore.kind === 'mongo' ? 'Check it is a mongodump archive' : restore.kind === 'postgres' ? `Check it is a pg_dump ${restore.pgMajor} archive` : 'Check it is a dump',
      copy: ['Make the copy, ', copy],
      restore: 'Restore the data',
      count: 'Count what came in',
      close: 'Close your sessions\' connections',
      aside: ['Move your database aside, as ', h('code', null, '__previous')],
      name: 'Give the copy your database\'s name',
      drop: 'Drop the old database',
      backup: ['Back up your Mongo data, as ', h('code', null, '__previous')],
      replace: 'Replace it with the copy',
      cleanup: 'Drop the copy and the backup',
    };
  }

  // A step's right-hand words: what it did or is doing.
  function stepNote(step, restore, sending) {
    if (step.key === 'send' && sending) return `${W.fmtBytes(sending.sent)} of ${W.fmtBytes(sending.total)} · ${Math.floor((100 * sending.sent) / Math.max(1, sending.total))}%`;
    if (step.key === 'restore' && restore.progress && (step.state === 'failed' || step.state === 'now')) {
      const { done, total } = restore.progress;
      const unit = restore.kind === 'mongo' ? 'collections' : 'items';
      // mongorestore names the collections as it reads the archive, so early on, or on an older one, there is no total.
      const counted = total ? `${done.toLocaleString()} of ${total.toLocaleString()} ${unit}` : `${done.toLocaleString()} ${unit}`;
      return step.state === 'failed' ? `stopped after ${counted}` : counted;
    }
    if (step.state === 'failed') return step.detail ?? '';
    if (step.key === 'send' && step.state === 'done') return `${W.fmtBytes(step.detail ?? 0)} · ${took(step.seconds)}`;
    if (step.key === 'check' && step.state === 'done') return restore.kind === 'mongo' ? 'mongodump archive' : `${Number(step.detail ?? 0).toLocaleString()} items`;
    if (step.key === 'close' && step.state === 'done') return `${step.detail ?? 0} closed`;
    return took(step.seconds);
  }

  // The session start's checklist (`.start-steps`), with a failed step marked ✗ and a bar under one that counts.
  function checklist(steps, restore, sending = null) {
    const labels = stepLabels(restore);
    const mark = { done: '✓', now: '', next: '', failed: '✗' };
    return h('ol', { class: 'start-steps restore-steps' }, steps.map((step) => {
      const counting = step.state === 'now' && ((step.key === 'send' && sending) || (step.key === 'restore' && restore.progress?.total));
      const share = step.key === 'send' ? sending && sending.sent / Math.max(1, sending.total) : restore.progress && restore.progress.done / Math.max(1, restore.progress.total);
      const current = step.key === 'restore' && step.state === 'now' && restore.progress?.current;
      return h('li', { class: `is-${step.state}${counting ? ' has-bar' : ''}`, 'aria-current': step.state === 'now' ? 'step' : null },
        h('div', { class: 'restore-step-row' },
          h('span', { class: 'start-mark', 'aria-hidden': 'true' }, mark[step.state]),
          h('span', { class: 'start-label' }, labels[step.key], current && h('span', { class: 'restore-current' }, ' · now on ', h('code', null, current))),
          h('span', { class: 'start-secs' }, stepNote(step, restore, sending))),
        counting && h('div', {
          class: 'restore-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(100 * share)),
        }, h('span', { style: `width: ${Math.min(100, Math.round(100 * share))}%` })));
    }));
  }

  window.WoodshedRestoreParts = { dumpCommands, headerProblem, clock, took, copyButton, checklist, PILL, BUSY, KIND_NAME };
})();

// The card's section, drawn for each state from what /api/my says and, while a dump is sent, from the upload itself.
(function () {
  'use strict';
  const W = window.Woodshed;
  const { h } = W;
  const P = window.WoodshedRestoreParts;

  /**
   * @param {{getMe: () => object, setMe: (me: object) => void, render: () => void}} page  mySettings.js's state
   * @returns {{section: () => HTMLElement|null, busy: () => boolean}}
   */
  function createRestore({ getMe, setMe, render }) {
    const note = h('p', { class: 'form-note', role: 'status' });
    const picker = h('input', { type: 'file', accept: '.dump,.backup,.pgdump,.archive,.gz,application/octet-stream,application/gzip', hidden: true });
    let sending = null;
    let refused = null;
    let working = false;
    let refresh = null;
    let tick = null;

    function say(text, isError = false) {
      note.textContent = text;
      note.classList.toggle('is-error', isError);
    }

    // While something runs the clock moves every second, and the page asks how it goes every 3. Each render calls
    // this, so a timer already set is left to run rather than set again.
    function watch(status) {
      if (!P.BUSY.includes(status) && !sending) {
        clearTimeout(refresh);
        clearInterval(tick);
        refresh = null;
        tick = null;
        return;
      }
      tick ??= setInterval(render, 1_000);
      if (sending || refresh) return;
      refresh = setTimeout(() => W.getJson('/api/my').then((answer) => {
        refresh = null;
        setMe(answer);
        render();
      }, () => {
        refresh = null;
        render();
      }), 3_000);
    }

    // XMLHttpRequest, not fetch, for the upload's progress and Cancel: a dump can take minutes to send.
    async function send(file) {
      const restore = getMe().restore;
      refused = null;
      say('');
      if (file.size > restore.maxBytes) return say(`${file.name} is over ${W.fmtBytes(restore.maxBytes)}.`, true);
      const problem = await P.headerProblem(file, restore.pgMajor);
      if (problem) {
        refused = { fileName: file.name, ...problem };
        return render();
      }
      const xhr = new XMLHttpRequest();
      // This upload's own state: a refused second upload's events must not touch the first's.
      const mine = { name: file.name, sent: 0, total: file.size, startedAt: new Date().toISOString(), xhr };
      sending = mine;
      render();
      xhr.open('POST', `/api/my/databases/restore?${new URLSearchParams({ name: file.name })}`);
      xhr.setRequestHeader('x-woodshed', '1');
      xhr.setRequestHeader('content-type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => { mine.sent = e.loaded; };
      xhr.onloadend = () => {
        let answer = {};
        try { answer = JSON.parse(xhr.responseText); } catch { /* the status says enough */ }
        const { cancelled } = mine;
        if (sending === mine) sending = null;
        if (xhr.status >= 200 && xhr.status < 300) setMe(answer);
        else if (cancelled) clearCancelled();
        else say(answer.error || 'The upload did not reach the console: try again.', true);
        render();
      };
      xhr.send(file);
    }
    picker.addEventListener('change', () => {
      const [file] = picker.files;
      picker.value = '';
      if (file) send(file);
    });

    // A cancel is no failure to show: once the console has noticed the upload stopped, its record goes.
    function clearCancelled(tries = 3) {
      setTimeout(() => W.postJson('/api/my/databases/restore/discard', {}).then((me) => {
        setMe(me);
        say('Cancelled. Nothing was restored.');
        render();
      }, () => (tries > 1 ? clearCancelled(tries - 1) : W.getJson('/api/my').then((me) => { setMe(me); render(); }, () => {}))), 700);
    }

    function cancel() {
      if (!sending) return;
      sending.cancelled = true;
      sending.xhr.abort();
    }

    async function post(path, body, doing) {
      refused = null;
      working = true;
      say(doing);
      render();
      try {
        setMe(await W.postJson(path, body));
        say('');
      } catch (err) {
        say(err.message, true);
        W.getJson('/api/my').then((me) => { setMe(me); render(); }, () => {});
      }
      working = false;
      render();
    }

    const button = (cls, label, onclick, disabled = working) => h('button', { type: 'button', class: `btn ${cls}`, disabled, onclick }, label);
    const pickButton = (label = 'Restore a dump…') => button('btn-open', label, () => picker.click());
    const viewerButton = (restore) => button('btn-plain', 'Open in the database viewer ↗', () => (restore.kind === 'mongo'
      ? openMongo(restore.status === 'applied' ? 'mongo' : 'mongo-copy')
      : openInViewer(restore.status === 'applied' ? 'your-database' : 'restored-copy')));

    // A running private session's own, the viewers run inside it.
    async function runningSession() {
      const { sessions = [] } = await W.getJson('/api/sessions');
      const mine = sessions.find((s) => W.isPrivate(s) && W.sameLogin(s.owner, getMe().login) && s.status === 'running');
      if (!mine) throw new Error('Start one of your sessions first: the database viewer runs inside it.');
      return mine;
    }

    // Mongo's viewer is locked to one database, so a private session runs a second one on the copy (/mongo-copy/).
    async function openMongo(app) {
      const tab = window.open('about:blank', '_blank');
      try {
        const mine = await runningSession();
        const res = await fetch(`/${app}/${mine.id}/`, { method: 'HEAD' });
        if (!res.ok) throw new Error(res.status === 404 ? 'Your running session started before its viewer could open the copy: start a new session.' : `The viewer did not answer: ${res.status}`);
        tab.location.href = `/${app}/${mine.id}/`;
      } catch (err) {
        tab?.close();
        say(err.message, true);
      }
    }

    // A running private session's pgweb has bookmarks for your database and the copy (session/entrypoint.sh): this
    // points it at one, then opens it. The tab opens first, since a browser blocks one opened after an await.
    async function openInViewer(bookmark) {
      const tab = window.open('about:blank', '_blank');
      try {
        const mine = await runningSession();
        const res = await fetch(`/pg/${mine.id}/api/connect`, {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `bookmark_id=${bookmark}`,
        });
        const answer = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(answer.error === 'Session is locked'
            ? 'Your running session started before its viewer could open the copy: start a new session.'
            : `The viewer did not open it: ${answer.error || res.status}`);
        }
        tab.location.href = `/pg/${mine.id}/`;
        say(`Opened in the viewer. Its Connect button switches between your-database and restored-copy.`);
      } catch (err) {
        tab?.close();
        say(err.message, true);
      }
    }

    function confirmApply(restore) {
      const kindName = P.KIND_NAME[restore.kind];
      W.confirmChange({
        title: `Apply the restored copy to your ${kindName} database?`,
        before: `${restore.live}, with whatever your sessions put in it`,
        after: `What ${restore.fileName} held, from ${restore.copy}`,
        effect: restore.kind === 'postgres'
          ? `Your private sessions' connections to Postgres are closed, and their apps connect again by themselves. Mongo is not touched. ${restore.migrate ? `Run ${restore.migrate} in a session afterwards` : 'Migrate it in a session afterwards'}: the dump may lack your branch's migrations.`
          : 'Your Mongo data is backed up first and put back if anything fails. Postgres is not touched.',
        word: 'apply',
        goLabel: 'Apply to my database',
        run: () => post('/api/my/databases/restore/apply', { confirm: 'apply' }, 'Applying…'),
      });
    }

    const states = window.WoodshedRestoreStates({ P, h, W, button, pickButton, viewerButton, confirmApply, cancel, post, getSending: () => sending });

    function section() {
      const me = getMe();
      const restore = me.restore;
      watch(restore?.status);
      if (!restore?.available || me.databases?.status !== 'ready') return null;
      const status = sending ? 'sending' : refused ? 'failed' : restore.status;
      const [pillText, pillClass] = P.PILL[status] ?? [null, null];
      const body = sending ? states.sending(restore)
        : refused ? states.refused(restore, refused)
          : (states[restore.status] ?? states.none)(restore);
      return h('div', { class: 'restore' },
        h('div', { class: 'set-head' }, h('h3', null, 'Restore a dump'), pillText && h('span', { class: `pill ${pillClass}` }, pillText)),
        ...body,
        note,
        picker);
    }

    return { section, busy: () => Boolean(sending) || P.BUSY.includes(getMe().restore?.status) };
  }

  window.WoodshedRestore = { createRestore, dumpCommands: P.dumpCommands };
})();
