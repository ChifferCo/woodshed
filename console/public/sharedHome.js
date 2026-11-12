// The Shared tab's own page (/), in the pane beside the rail: sessions started from GitHub, open to everyone signed
// in. The rail's People filter picks whose, by assignee; the status filter here lives in the URL (?status=working|waiting|finished|
// merged|all), so a filtered view can be shared. Private sessions live on My Woodshed.
(function () {
  'use strict';
  const W = window.Woodshed;
  const { h } = W;
  // One tab for each of the rail's groups but Ended, which only All shows.
  const STATUS_TABS = [
    ...W.GROUPS.filter((g) => g.key !== 'ended').map((g) => ({ id: g.key, label: g.title })),
    { id: 'all', label: 'All' },
  ];
  // The tabs' old names, so a link from before them still opens on the same sessions.
  const OLD_TABS = { active: 'working', needs: 'waiting' };

  function askedStatus() {
    const status = new URLSearchParams(window.location.search).get('status') || 'working';
    return OLD_TABS[status] || status;
  }

  function matchesStatus(s, status) {
    return status === 'all' || W.group(s) === status;
  }

  /** @param {{onChange: () => void}} opts  `onChange` refreshes the page after a button here changed a session */
  function createSharedHome({ onChange }) {
    let status = askedStatus();
    let last = null;

    function setStatus(next) {
      status = next;
      const url = new URL(window.location.href);
      if (status === 'working') url.searchParams.delete('status');
      else url.searchParams.set('status', status);
      // URLSearchParams would write the commas of ?by= as %2C.
      window.history.replaceState(null, '', `${url.pathname}${url.search.replace(/%2C/g, ',')}`);
      if (last) update(last);
    }

    function card(s, data) {
      const live = W.isLive(s);
      const line = W.lastLine(s);
      const pr = W.prNumber(s.prUrl);
      const kept = W.isResumable(s);
      const starting = s.status === 'starting' && s.startedAt ? W.startProgress(s).current : null;
      const when = starting ? `${starting.short} · ${W.clock(s.startedAt)}`
        : kept ? W.keptLine(s) : W.duration(s.startedAt || s.createdAt, s.stoppedAt);
      const meta = [W.ref(s), s.branch, h('span', null, W.startedLine(s)), when].filter(Boolean);
      const pauses = W.pausesIn(s, data);
      return h('article', { class: `card${live ? '' : ' is-stopped'}` },
        h('div', { class: 'card-head' },
          h('a', { class: 'card-title', href: `/s/${s.id}` }, s.title),
          W.statusBadge(s),
          pauses && h('span', { class: 'timer' }, pauses),
          W.planChip(s)),
        h('div', { class: 'meta' }, meta.map((m) => h('span', null, m))),
        line && h('div', { class: `msg${line.error ? ' is-error' : ''}`, title: line.text }, h('span', { class: 'who' }, line.who), line.text),
        h('div', { class: 'actions' },
          h('a', { class: live ? 'btn btn-open' : 'btn btn-quiet', href: `/s/${s.id}` }, live ? 'Open' : 'Details'),
          W.appButton(s, { appDomain: data.appDomain, onDone: onChange }),
          kept && W.group(s) !== 'merged' && W.resumeSharedButton(s, { onDone: onChange }),
          pr && h('a', { class: 'btn btn-pr', href: s.prUrl, target: '_blank', rel: 'noopener' }, `PR ${pr}`),
          (s.status === 'queued' || s.status === 'starting' || s.status === 'running') && W.stopButton(s, onChange),
          kept && W.group(s) === 'merged' && W.deleteSharedButton(s, onChange)));
    }

    const head = h('div');
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Status' });
    const list = h('div');
    const foot = h('div');
    const el = h('section', { class: 'home' }, head, seg, list, foot);

    /** @param {{data: object, picked: string[]}} args  the page's sessions, and whose (by assignee) the rail's People filter shows */
    function update({ data, picked }) {
      // From the address each time: a move back to /all in place brings its own ?status=.
      status = askedStatus();
      last = { data, picked };
      const shared = data.sessions.filter((s) => !W.isPrivate(s) && (picked.length === 0 || picked.some((l) => W.sameLogin(l, s.assignee))));
      const tabCounts = Object.fromEntries(STATUS_TABS.map((t) => [t.id, shared.filter((s) => matchesStatus(s, t.id)).length]));
      const visible = shared.filter((s) => matchesStatus(s, status));
      head.replaceChildren(h('header', { class: 'page-head' },
        h('div', null,
          h('h1', { class: 'title' }, 'Shared sessions'),
          data.repo
            ? h('p', { class: 'sub' }, `Sessions started from GitHub on ${data.repo}. Add the `, h('code', null, data.label),
              ' label to an issue, or comment ', h('code', null, '/woodshed …'), ' on an issue or PR. Everyone signed in sees these.')
            : h('p', { class: 'sub' }, 'Sessions started from GitHub. The console has no repo yet: an admin adds one on Console settings, then a ',
              h('code', null, data.label), ' label or a ', h('code', null, '/woodshed …'), ' comment on its issues starts one.')),
        h('div', { class: 'stats' },
          h('span', null, 'running ', h('b', null, `${data.running}/${data.maxRunning}`)),
          h('span', null, 'queued ', h('b', null, data.queued)))));
      seg.replaceChildren(...STATUS_TABS.map((t) =>
        h('button', { type: 'button', 'aria-pressed': String(t.id === status), onclick: () => setStatus(t.id) }, t.label, h('span', { class: 'n' }, tabCounts[t.id]))));
      const none = shared.length ? 'No sessions match these filters.' : W.sharedEmptyText(picked);
      list.replaceChildren(visible.length ? h('div', { class: 'cards' }, visible.map((s) => card(s, data))) : h('p', { class: 'empty' }, none));
      foot.replaceChildren(h('p', { class: 'foot' }, `At most ${data.maxRunning} run at once and the rest wait in line. A session waiting for input pauses after ${data.idleHours} ${data.idleHours === 1 ? 'hour' : 'hours'}, and one that works stops at ${data.lifetimeHours} hours. Either way its work is pushed first, and Resume picks it up where it was. A finished session is deleted ${data.afterCloseDays} ${data.afterCloseDays === 1 ? 'day' : 'days'} after its pull request merges or closes. Console settings has these numbers.`));
    }

    return { el, update };
  }

  W.createSharedHome = createSharedHome;
})();
