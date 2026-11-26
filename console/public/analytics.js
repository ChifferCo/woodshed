// The Analytics page (admins): how the team uses Woodshed, for whoever leads it (console/analytics.mjs). The totals
// first, then each person beside the others, then the sessions and pull requests behind the numbers. The window and a
// person picked live in the URL (?days=30&person=ana), so a link shows the same view.
window.Woodshed.settingsPage('/analytics', (app, life) => {
  'use strict';
  const W = window.Woodshed;
  const { h } = W;
  const PULL_FILTERS = [
    { id: 'all', label: 'All' },
    { id: 'woodshed', label: 'Through Woodshed' },
    { id: 'other', label: 'Without' },
    { id: 'risky', label: 'Medium or high risk' },
  ];
  const AGENT_NAMES = { claude: 'Claude', codex: 'Codex', grok: 'Grok Build', opencode: 'OpenCode' };
  const TIER_PILL = { Low: 'is-ok', Medium: 'is-warn', High: 'is-bad' };
  const ROWS_SHOWN = 25;

  let data = null;
  let loadError = null;
  let loading = false;
  const { group } = window.WoodshedSettingsRows.create({ render });

  const params = () => new URLSearchParams(window.location.search);
  const days = () => Number(params().get('days')) || 30;
  const who = () => params().get('person') || null;
  const pullFilter = () => params().get('pulls') || 'all';
  function setParam(key, value, fallback) {
    const p = params();
    if (value === fallback || value === null) p.delete(key);
    else p.set(key, value);
    const q = p.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${q ? `?${q}` : ''}`);
  }

  const n = (v) => Number(v ?? 0).toLocaleString();
  const pct = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
  function hours(v) {
    if (v === null || v === undefined) return '—';
    if (v < 1) return `${Math.max(1, Math.round(v * 60))} min`;
    if (v < 48) return `${v < 10 ? v.toFixed(1) : Math.round(v)} h`;
    return `${(v / 24).toFixed(1)} days`;
  }
  const stamp = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');
  const sameLogin = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
  const tiersText = (t) => {
    const parts = ['High', 'Medium', 'Low'].filter((k) => t[k]).map((k) => `${t[k]} ${k.toLowerCase()}`);
    return parts.length ? parts.join(' · ') : 'none reviewed';
  };
  const reviewedCount = (t) => t.Low + t.Medium + t.High;

  const SVG = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs, ...children) {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs ?? {})) el.setAttribute(k, String(v));
    for (const c of children.flat()) if (c) el.append(c);
    return el;
  }

  function figures(items) {
    return h('div', { class: 'figures' }, items.filter(Boolean).map(({ label, value, sub }) => h('div', { class: 'figure' },
      h('div', { class: 'figure-label' }, label),
      h('div', { class: 'figure-value' }, value),
      sub && h('div', { class: 'figure-sub' }, sub))));
  }

  // Bars over the window, one per day or week: a single series, or Woodshed's on the others' (components/TrendBars).
  // A bar's numbers are in its tooltip and the chart's label, never its colour alone.
  function trendBars({ label, series }) {
    const trend = data.trend;
    const totals = trend.map((b) => series.reduce((sum, s) => sum + b[s.key], 0));
    const max = Math.max(1, ...totals);
    const W_ = 600;
    const H_ = 120;
    const gap = trend.length > 20 ? 2 : 6;
    const width = (W_ - gap * (trend.length - 1)) / trend.length;
    const scale = (v) => (v / max) * (H_ - 4);
    const unit = data.step === 'day' ? 'Day of' : 'From';
    const bars = trend.map((b, i) => {
      let y = H_;
      const x = i * (width + gap);
      const tip = `${unit} ${day(b.start)}: ${series.map((s) => `${b[s.key]} ${s.word}`).join(', ')}`;
      const parts = series.map((s) => {
        const hgt = scale(b[s.key]);
        if (!hgt) return null;
        y -= hgt;
        // A 2px gap of ground between stacked parts.
        return svg('rect', { class: `trend-bar ${s.cls}`, x, y: y + (y + hgt < H_ ? 1 : 0), width, height: Math.max(1, hgt - (y + hgt < H_ ? 2 : 0)), rx: 2 });
      });
      return svg('g', null, svg('title', null, tip), svg('rect', { class: 'trend-hit', x, y: 0, width, height: H_ }), parts);
    });
    const chart = svg('svg', {
      viewBox: `0 0 ${W_} ${H_}`, preserveAspectRatio: 'none', class: 'trend-svg', role: 'img',
      'aria-label': `${label}: ${trend.map((b, i) => `${day(b.start)} ${series.length > 1 ? series.map((s) => `${b[s.key]} ${s.word}`).join(', ') : totals[i]}`).join('; ')}`,
    }, svg('line', { class: 'trend-base', x1: 0, x2: W_, y1: H_ - 0.5, y2: H_ - 0.5 }), bars);
    return h('div', { class: 'trend' },
      h('div', { class: 'trend-head' }, h('span', { class: 'figure-label' }, label),
        series.length > 1 && h('span', { class: 'trend-legend' }, series.map((s) => h('span', null, h('i', { class: `trend-key ${s.cls}`, 'aria-hidden': 'true' }), s.label))),
        h('span', { class: 'trend-max mono' }, `max ${n(Math.max(...totals))}`)),
      chart,
      h('div', { class: 'trend-axis mono' }, h('span', null, day(trend[0]?.start)), h('span', null, 'today')));
  }

  function sessionsGroup() {
    const s = data.sessions;
    const agents = Object.entries(s.agents).sort((a, b) => b[1] - a[1]);
    const agentName = (id) => AGENT_NAMES[id] ?? id;
    return group({ id: 'analytics-totals', label: 'Sessions', note: 'Work sessions started in the window: My Woodshed, and shared ones from a label, a comment or the console.' },
      figures([
        { label: 'Sessions started', value: n(s.work), sub: `${n(s.private)} My Woodshed · ${n(s.shared)} shared` },
        { label: 'People using it', value: s.members ? `${n(s.activeMembers)} / ${n(s.members)}` : n(s.people), sub: s.members ? `members started a session${s.people > s.activeMembers ? `, and ${n(s.people - s.activeMembers)} not on People` : ''}` : 'started a session' },
        { label: 'Reviews run', value: n(s.review), sub: `${n(s.qa)} QA runs · ${n(s.ask)} questions from Slack` },
        { label: 'Most used agent', value: agents.length ? `${agentName(agents[0][0])} ${pct(agents[0][1] / s.work)}` : '—', sub: agents.length > 1 ? agents.slice(1).map(([id, c]) => `${agentName(id)} ${n(c)}`).join(' · ') : 'of sessions' },
      ]),
      trendBars({ label: 'Sessions started', series: [{ key: 'sessions', cls: 'is-woodshed', word: 'sessions', label: 'Sessions' }] }));
  }

  function pullsGroup() {
    const { woodshed: w, other: o, mergedShare } = data.pulls;
    return group({ id: 'analytics-pull-totals', label: 'Pull requests', note: 'Opened in the window, on the console\'s repos. Through Woodshed means a session opened it or worked on its branch.' },
      figures([
        { label: 'Through Woodshed', value: n(w.opened), sub: `${n(w.merged)} merged · ${n(w.open)} open` },
        { label: 'Without Woodshed', value: n(o.opened), sub: `${n(o.merged)} merged · ${n(o.open)} open` },
        { label: 'Merged through Woodshed', value: pct(mergedShare), sub: 'of all merged' },
        { label: 'Opened to merged', value: hours(w.medianMergeHours), sub: `median through Woodshed, ${hours(o.medianMergeHours)} without` },
        { label: 'Merge risk, Woodshed', value: reviewedCount(w.tiers) ? `${pct(w.tiers.High / reviewedCount(w.tiers))} high` : '—', sub: tiersText(w.tiers) },
        { label: 'Merge risk, without', value: reviewedCount(o.tiers) ? `${pct(o.tiers.High / reviewedCount(o.tiers))} high` : '—', sub: tiersText(o.tiers) },
      ]),
      trendBars({
        label: 'Pull requests merged',
        series: [
          { key: 'woodshed', cls: 'is-woodshed', word: 'through Woodshed', label: 'Through Woodshed' },
          { key: 'other', cls: 'is-other', word: 'without', label: 'Without' },
        ],
      }));
  }

  // Each person beside the others: what they started, and how their pull requests went, through Woodshed and not.
  function peopleGroup() {
    const picked = who();
    const rows = data.people.map((p) => {
      const opened = p.woodshed.opened + p.other.opened;
      const risky = p.woodshed.tiers.High + p.other.tiers.High;
      const pickedHere = sameLogin(p.login, picked);
      return h('tr', { class: pickedHere ? 'is-picked' : null },
        h('td', null, h('button', {
          type: 'button', class: 'link-btn', 'aria-pressed': String(pickedHere), title: pickedHere ? 'Show everyone' : 'Show only their sessions and pull requests',
          onclick: () => { setParam('person', pickedHere ? null : p.login, null); render(); },
        }, W.person(p.login))),
        h('td', { class: 'num' }, p.sessions ? n(p.sessions) : h('span', { class: 'quiet' }, 'none')),
        h('td', { class: 'num' }, n(p.activeDays)),
        h('td', { class: 'mono quiet' }, p.lastAt ? day(p.lastAt) : '—'),
        h('td', { class: 'num' }, `${n(p.woodshed.opened)}`, h('span', { class: 'quiet' }, ` / ${n(p.woodshed.merged)}`)),
        h('td', { class: 'num' }, `${n(p.other.opened)}`, h('span', { class: 'quiet' }, ` / ${n(p.other.merged)}`)),
        h('td', { class: 'num' }, opened ? pct(p.share) : '—'),
        h('td', { class: 'num' }, hours(p.woodshed.medianMergeHours), h('span', { class: 'quiet' }, ` / ${hours(p.other.medianMergeHours)}`)),
        h('td', null, risky ? h('span', { class: 'pill is-bad' }, `${risky} high`) : h('span', { class: 'quiet' }, reviewedCount(p.woodshed.tiers) + reviewedCount(p.other.tiers) ? 'none high' : '—')),
        h('td', { class: 'num quiet' }, `+${n(p.woodshed.added + p.other.added)} −${n(p.woodshed.removed + p.other.removed)}`));
    });
    return group({ id: 'analytics-people', label: `By person · ${data.people.length}`, note: 'Pick a name to see only their sessions and pull requests below. Members who started nothing are listed too.' },
      data.people.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'people-table analytics-table' },
        h('thead', null, h('tr', null,
          h('th', { scope: 'col' }, 'Person'),
          h('th', { scope: 'col', class: 'num' }, 'Sessions'),
          h('th', { scope: 'col', class: 'num', title: 'Days they started at least one session' }, 'Days'),
          h('th', { scope: 'col' }, 'Last'),
          h('th', { scope: 'col', class: 'num', title: 'Opened through Woodshed / merged' }, 'Woodshed PRs'),
          h('th', { scope: 'col', class: 'num', title: 'Opened without Woodshed / merged' }, 'Other PRs'),
          h('th', { scope: 'col', class: 'num', title: 'Of the pull requests they opened, how many went through Woodshed' }, 'Share'),
          h('th', { scope: 'col', class: 'num', title: 'Median opened to merged: through Woodshed / without' }, 'To merge'),
          h('th', { scope: 'col' }, 'Merge risk'),
          h('th', { scope: 'col', class: 'num', title: 'A rough size, not a measure of output' }, 'Lines'))),
        h('tbody', null, rows))) : h('p', { class: 'empty' }, 'Nobody has started a session or opened a pull request in this window.'));
  }

  function sessionsList() {
    const picked = who();
    const list = data.sessions.recent.filter((s) => !picked || sameLogin(s.login, picked));
    const rows = list.slice(0, ROWS_SHOWN).map((s) => h('tr', null,
      h('td', { class: 'mono quiet' }, stamp(s.createdAt)),
      h('td', null, s.login ? W.person(s.login) : '—'),
      h('td', null, s.private ? h('span', { class: 'quiet', title: 'A My Woodshed session is its owner\'s: only that it ran is shown' }, 'Private session')
        : s.kept ? h('span', { title: 'Taken off the console\'s list: only its record is kept' }, s.title || s.id)
          : h('a', { href: `/s/${s.id}` }, s.title || s.id)),
      h('td', null, s.project ?? ''),
      h('td', null, AGENT_NAMES[s.agent] ?? s.agent),
      h('td', null, s.prUrls.length ? s.prUrls.map((url, i) => [i ? ' ' : null, h('a', { href: url, target: '_blank', rel: 'noopener' }, `#${url.split('/').pop()} ↗`)]) : h('span', { class: 'quiet' }, 'none'))));
    return group({ id: 'analytics-sessions', label: `Sessions started · ${list.length}`, note: picked ? `${W.personText?.(picked) ?? picked}'s, newest first.` : 'Newest first.' },
      list.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'people-table analytics-table' },
        h('thead', null, h('tr', null, ['When', 'Who', 'Session', 'Project', 'Agent', 'Pull request'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, rows))) : h('p', { class: 'empty' }, 'No sessions in this window.'),
      list.length > ROWS_SHOWN && h('p', { class: 'foot analytics-more' }, `The newest ${ROWS_SHOWN} of ${list.length} shown.`),
      data.sessions.work > data.sessions.recent.length && h('p', { class: 'foot analytics-more' }, `This list and its filter cover the newest ${data.sessions.recent.length} of ${data.sessions.work} sessions; the counts above cover them all.`));
  }

  function pullMatches(p, show) {
    if (show === 'woodshed' || show === 'other') return p.via === show;
    if (show === 'risky') return p.tier === 'Medium' || p.tier === 'High';
    return true;
  }
  const STATE_WORD = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' };

  function pullsList() {
    const picked = who();
    const show = pullFilter();
    const list = data.pulls.recent.filter((p) => (!picked || sameLogin(p.login, picked)) && pullMatches(p, show));
    const rows = list.slice(0, ROWS_SHOWN).map((p) => h('tr', null,
      h('td', { class: 'mono quiet' }, day(p.createdAt)),
      h('td', { class: 'analytics-title' }, h('a', { href: p.url, target: '_blank', rel: 'noopener' }, `#${p.number} ${p.title} ↗`),
        data.projects.length > 1 && h('span', { class: 'quiet' }, ` ${p.project}`)),
      h('td', null, p.login ? W.person(p.login) : '—'),
      h('td', null, p.via === 'woodshed'
        ? (p.sessionLink ? h('a', { href: `/s/${p.sessionLink}` }, 'Woodshed') : 'Woodshed')
        : h('span', { class: 'quiet' }, 'Without')),
      h('td', null, STATE_WORD[p.state] ?? p.state),
      h('td', { class: 'num' }, p.mergeHours === null ? '—' : hours(p.mergeHours)),
      h('td', null, p.tier ? h('span', { class: `pill ${TIER_PILL[p.tier]}` }, p.tier) : h('span', { class: 'quiet' }, 'not reviewed')),
      h('td', { class: 'num quiet' }, `+${n(p.additions)} −${n(p.deletions)}`)));
    return group({ id: 'analytics-pulls', label: `Pull requests · ${list.length}`, note: 'Merge risk is the Woodshed review\'s tier on the pull request.' },
      h('div', { class: 'analytics-bar' },
        h('div', { class: 'seg', role: 'group', 'aria-label': 'Show pull requests' }, PULL_FILTERS.map((f) =>
          h('button', { type: 'button', 'aria-pressed': String(f.id === show), onclick: () => { setParam('pulls', f.id, 'all'); render(); } }, f.label)))),
      list.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'people-table analytics-table' },
        h('thead', null, h('tr', null,
          ['Opened', 'Pull request', 'Who', 'Through', 'State'].map((t) => h('th', { scope: 'col' }, t)),
          h('th', { scope: 'col', class: 'num' }, 'Opened to merged'),
          h('th', { scope: 'col' }, 'Merge risk'),
          h('th', { scope: 'col', class: 'num' }, 'Lines'))),
        h('tbody', null, rows))) : h('p', { class: 'empty' }, 'No pull requests match.'),
      list.length > ROWS_SHOWN && h('p', { class: 'foot analytics-more' }, `The newest ${ROWS_SHOWN} of ${list.length} shown.`),
      data.pulls.woodshed.opened + data.pulls.other.opened > data.pulls.recent.length && h('p', { class: 'foot analytics-more' }, `This list and its filters cover the newest ${data.pulls.recent.length} of ${data.pulls.woodshed.opened + data.pulls.other.opened} pull requests; the counts above cover them all.`));
  }

  function notes() {
    const failed = data.failed.map((f) => f.repo);
    return [
      failed.length > 0 && h('p', { class: 'form-error', role: 'alert' }, `GitHub did not answer for ${failed.join(', ')}: its pull requests are left out. Try again in a minute.`),
      data.truncated && h('p', { class: 'foot' }, 'A repo opened more than 500 pull requests in this window: only the newest 500 are counted.'),
    ];
  }

  function render() {
    const head = h('header', { class: 'page-head', id: 'analytics' },
      h('div', null,
        h('h1', { class: 'title' }, 'Analytics ', W.scopePill('/analytics')),
        h('p', { class: 'sub' }, 'How the team uses Woodshed: who starts sessions, and how their pull requests go.')));
    const windowSeg = h('div', { class: 'filters' },
      h('p', { class: 'foot' }, data ? `From ${day(data.since)} to today${loading ? ' · reading…' : ''}.` : ''),
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Window' }, (data?.windows ?? [7, 30, 90]).map((d) =>
        h('button', { type: 'button', 'aria-pressed': String(d === days()), onclick: () => { setParam('days', d, 30); refresh(); } }, `${d} days`))));
    if (!data) {
      app.replaceChildren(h('div', { class: 'page' }, life.nav('/analytics'), head, windowSeg,
        loadError ? h('p', { class: 'form-error', role: 'alert' }, `Could not load analytics: ${loadError}`) : h('p', { class: 'empty' }, 'Reading sessions and pull requests…')));
      return;
    }
    app.replaceChildren(h('div', { class: 'page analytics-page' },
      life.nav('/analytics'),
      head,
      windowSeg,
      loadError && h('p', { class: 'form-error', role: 'alert' }, `Could not read again: ${loadError}`),
      notes(),
      sessionsGroup(),
      pullsGroup(),
      peopleGroup(),
      sessionsList(),
      pullsList(),
      h('p', { class: 'foot' }, 'Lines changed are a rough size of each pull request, not a measure of anyone\'s work. A pull request opened by a bot is left out unless a session opened it.')));
  }

  // Only the answer for the window picked last is drawn: an older read that lands after it is dropped.
  let asking = 0;
  async function refresh() {
    const mine = ++asking;
    loading = true;
    render();
    try {
      const body = await W.getJson(`/api/analytics?days=${days()}`);
      if (mine !== asking || life.ended) return;
      data = body;
      loadError = null;
    } catch (err) {
      if (mine !== asking || life.ended) return;
      loadError = err.message;
    }
    loading = false;
    render();
  }

  render();
  refresh();
});
