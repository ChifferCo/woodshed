// What Restore a dump shows in each state (public/dbRestore.js): one function a state, each returning the elements
// under the section's heading. The states and their mocks are in the PR that added them.
(function () {
  'use strict';

  /**
   * @param {{P: object, h: Function, W: object, button: Function, pickButton: Function, viewerButton: Function,
   *          confirmApply: Function, cancel: Function, post: Function, getSending: () => object|null}} ui
   */
  window.WoodshedRestoreStates = function restoreStates({ P, h, W, button, pickButton, viewerButton, confirmApply, cancel, post, getSending }) {
    const sub = (...children) => h('p', { class: 'sub' }, ...children);
    const discard = (label) => button('btn-quiet', label, () => post('/api/my/databases/restore/discard', {}, label === 'Discard' ? 'Dropping the copy…' : 'Clearing…'));
    const actions = (...buttons) => h('div', { class: 'set-actions' }, ...buttons);

    // `name` is text, or text and elements, such as a database name in code.
    function head(name, startedAt, extra = null) {
      return h('div', { class: 'start-head restore-head' },
        h('p', { class: 'restore-file' }, name, extra && h('span', { class: 'restore-meta' }, ` · ${extra}`)),
        startedAt && h('span', { class: 'start-clock' }, P.clock(startedAt)));
    }

    // Each command in its own box with its own Copy, so copying one never runs the others.
    function commandList(restore, keys = null) {
      return P.dumpCommands(restore).filter((c) => !keys || keys.includes(c.key)).map((c) => h('div', { class: 'restore-cmd' },
        h('p', { class: 'restore-cmd-title' }, c.title),
        h('div', { class: 'value-row' }, h('code', { class: 'value-box' }, c.command), P.copyButton(c.command))));
    }

    // What the project file's `dump` leaves out, in words: nothing said when it leaves out nothing.
    function skippedLine(restore) {
      const rows = restore.dump?.postgres?.skip ?? [];
      const collections = restore.kinds.mongo ? restore.dump?.mongo?.skip ?? [] : [];
      if (!rows.length && !collections.length) return [];
      return [
        'Each command leaves out what a working copy rarely needs: ',
        rows.length && ['the rows of ', h('code', null, rows.join(', ')), ' (each table comes over empty)'],
        rows.length && collections.length && ', and ',
        collections.length && ['in Mongo the collections ', h('code', null, collections.join(', '))],
        '. Take a line out to keep it. ',
      ].flat().filter(Boolean);
    }

    function howTo(restore) {
      return [
        sub(...skippedLine(restore), `Up to ${W.fmtBytes(restore.maxBytes)}.`),
        (restore.dump?.postgres?.skip?.length ?? 0) > 0 && sub('Leave out a table\'s rows only when no other table\'s rows point at it: without them, the restore stops at the other table\'s foreign key.'),
        ...commandList(restore),
      ];
    }

    // The commands under a fold everywhere but before the first restore, so the next dump can always be made.
    function howToFold(restore) {
      return h('details', { class: 'restore-howto' }, h('summary', null, 'How to make a dump'), ...howTo(restore));
    }

    // The project file's migrate command, or the words for one when it names none.
    function migrateStep(migrate, after) {
      if (!migrate) return [`${after ? 'After Apply, migrate it' : 'Next: migrate it'}`];
      return [`${after ? 'After Apply, run' : 'Next: run'} `, h('code', null, migrate)];
    }

    function lackingLine(summary, after, migrate) {
      if (summary.lacking === null || summary.lacking === undefined) {
        return h('p', { class: 'restore-next' }, ...migrateStep(migrate, after), ' in a session before you start the app: the dump may lack your branch\'s migrations.');
      }
      if (summary.lacking === 0) return h('p', { class: 'restore-next' }, 'It has every migration the default branch has.');
      const n = `${summary.lacking} migration${summary.lacking === 1 ? '' : 's'}`;
      return h('p', { class: 'restore-next' }, `The default branch has ${n} this ${after ? 'copy' : 'dump'} lacks. `, ...migrateStep(migrate, after), ' in a session before you start the app.');
    }

    function none(restore) {
      const last = Object.entries(restore.lastApplied ?? {}).sort((a, b) => b[1].at.localeCompare(a[1].at))[0];
      return [
        sub('Your own data in place of the template\'s, for Postgres', restore.kinds.mongo ? ' or Mongo' : '', '. It goes into a copy first, for you to check, and your database changes only when you apply it.'),
        ...howTo(restore),
        actions(pickButton(), last && h('span', { class: 'form-note' }, `Your last restore: ${last[1].fileName}, applied to ${P.KIND_NAME[last[0]]} ${W.when(last[1].at)}.`)),
      ];
    }

    function sending(restore) {
      const s = getSending();
      // The server says a dump is arriving, but not from this page: another tab, or this one before a reload.
      if (!s) {
        return [
          head(restore.fileName, restore.startedAt),
          P.checklist(restore.steps, { ...restore, kind: null }),
          sub('The dump is being sent from another tab or window. Keep that one open until it is sent; this page follows along.'),
        ];
      }
      const steps = restore.steps.map((step) => (step.key === 'send' ? { ...step, state: 'now' } : { ...step, state: 'next', seconds: null }));
      const left = s.sent > 0 ? Math.round(((Date.now() - Date.parse(s.startedAt)) / s.sent) * (s.total - s.sent) / 1000) : null;
      return [
        head(s.name, s.startedAt),
        P.checklist(steps, { ...restore, kind: null }, s),
        sub(`Keep this tab open until the dump is sent${left !== null && left > 5 ? `, about ${P.took(left)} more` : ''}. After that you can close it: the restore carries on, and your database is not touched.`),
        actions(button('btn-quiet', 'Cancel', cancel, false)),
      ];
    }

    function restoring(restore) {
      return [
        head(restore.fileName, restore.startedAt, restore.bytes ? W.fmtBytes(restore.bytes) : null),
        P.checklist(restore.steps, restore),
        sub('You can close this page: the restore carries on in the console. Your database is not touched until you apply the copy.'),
      ];
    }

    function tiles(summary, kind) {
      const tile = (label, value, small = false) => h('div', { class: 'restore-tile' }, h('span', null, label), h('strong', { class: small ? 'is-small' : null }, value));
      const mongo = kind === 'mongo';
      return h('div', { class: 'restore-tiles' },
        tile(mongo ? 'Collections' : 'Tables', summary.tables.toLocaleString()),
        tile(mongo ? 'Documents, about' : 'Rows, about', summary.rows.toLocaleString()),
        summary.newest && tile('Newest migration', summary.newest, true));
    }

    function biggest(summary) {
      const width = Math.max(0, ...summary.top.map((t) => t.name.length));
      return h('code', { class: 'value-box restore-top' }, summary.top.map((t) => `${t.name.padEnd(width)}  ${t.rows.toLocaleString().padStart(12)}`).join('\n') || 'Nothing in it.');
    }

    function ready(restore) {
      const total = restore.steps.reduce((n, s) => n + (s.key === 'send' ? 0 : s.seconds ?? 0), 0);
      return [
        sub(h('strong', null, restore.fileName), ' is restored into ', h('code', null, restore.copy), `, in ${P.took(total)}, at ${W.when(restore.finishedAt)}. Nothing has changed in your ${P.KIND_NAME[restore.kind]} database yet.`),
        tiles(restore.summary, restore.kind),
        biggest(restore.summary),
        restore.kind === 'postgres' && lackingLine(restore.summary, true, restore.migrate),
        restore.apply?.error && h('p', { class: 'form-note is-error' }, `Apply failed: ${restore.apply.error}`),
        actions(viewerButton(restore), button('btn-open', 'Apply to my database…', () => confirmApply(restore)), discard('Discard')),
        h('p', { class: 'form-note' }, 'The copy stays until you apply or discard it. Reset my data drops it too.'),
        howToFold(restore),
      ];
    }

    function applying(restore) {
      return [
        head([`${restore.fileName} into `, h('code', null, restore.live)], restore.apply.startedAt),
        P.checklist(restore.apply.steps, restore),
        sub(restore.kind === 'postgres'
          ? 'Takes a few seconds. Your sessions\' apps connect again by themselves once it is done. If any step fails, your database gets its own name back.'
          : 'Takes about as long as the restore\'s copy. If any step fails, your Mongo data is copied back from the backup.'),
      ];
    }

    function applied(restore) {
      const closed = restore.apply.steps.find((s) => s.key === 'close')?.detail;
      const secs = Math.round((Date.parse(restore.apply.finishedAt) - Date.parse(restore.apply.startedAt)) / 1000);
      return [
        h('div', { class: 'restore-done' },
          h('span', { class: 'start-mark', 'aria-hidden': 'true' }, '✓'),
          h('div', null,
            h('p', { class: 'restore-file' }, `${restore.fileName} is your ${P.KIND_NAME[restore.kind]} database now`),
            sub(`${restore.summary.tables.toLocaleString()} ${restore.kind === 'mongo' ? 'collections' : 'tables'}, about ${restore.summary.rows.toLocaleString()} ${restore.kind === 'mongo' ? 'documents' : 'rows'}. Applied ${W.when(restore.apply.finishedAt)} in ${P.took(secs)}${closed ? `; ${closed} session connection${closed === 1 ? ' was' : 's were'} closed and connect again by themselves` : ''}. The old database is dropped.`))),
        restore.kind === 'postgres' && lackingLine(restore.summary, false, restore.migrate),
        // A new upload replaces this record; what was applied stays in the line under Restore a dump.
        actions(viewerButton(restore), pickButton('Restore another dump…')),
        howToFold(restore),
      ];
    }

    function failed(restore, { sent = true } = {}) {
      const versionProblem = /pg_dump 17 or newer/.test(restore.error ?? '');
      const atCheck = restore.steps.find((s) => s.key === 'check')?.state === 'failed';
      const shownSteps = restore.steps.filter((s) => s.state !== 'next' || !atCheck);
      return [
        head(restore.fileName, null, restore.finishedAt ? `stopped ${W.when(restore.finishedAt)}` : null),
        P.checklist(shownSteps, restore),
        versionProblem
          ? sub(restore.error)
          : h('code', { class: 'value-box is-error' }, restore.error ?? 'No reason given.'),
        ...(versionProblem ? commandList(restore, ['docker']) : []),
        h('p', { class: 'form-note' }, !sent ? 'Nothing was sent.' : atCheck ? 'Nothing was restored, and the upload is deleted.' : 'Your database was not touched, and the half-made copy is dropped. The restore stops at the first error, so a copy is the whole dump or nothing.'),
        actions(pickButton(), discard('Clear')),
        versionProblem ? null : howToFold(restore),
      ];
    }

    // Refused in the browser, before any of it was sent.
    function refused(restore, why) {
      return failed({
        ...restore, fileName: why.fileName, finishedAt: null, error: why.refused,
        steps: [{ key: 'send', state: 'next', seconds: null }, { key: 'check', state: 'failed', detail: why.detail }],
      }, { sent: false });
    }

    return { none, sending, restoring, ready, applying, applied, failed, refused };
  };
})();
