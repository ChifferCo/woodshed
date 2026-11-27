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
    { id: 'human', label: 'Human reviewed' },
    { id: 'nohuman', label: 'No human review' },
  ];
  const AGENT_NAMES = { claude: 'Claude', codex: 'Codex', grok: 'Grok Build', opencode: 'OpenCode' };
  const TIER_PILL = { Low: 'is-ok', Medium: 'is-warn', High: 'is-bad' };
  const TIER_LEVELS = ['Low', 'Medium', 'High'];
  const STEP = 25;

  let data = null;
  let loadError = null;
  let loading = false;
  let clickedRefresh = false;
  let pollTimer = null;
  // How many rows of each list are shown: Show more adds a page, Show all the rest.
  const shown = { sessions: STEP, pulls: STEP };
  const { group } = window.WoodshedSettingsRows.create({ render });

  const params = () => new URLSearchParams(window.location.search);
  // A window the console does not offer (?days=31) is its 30 days, as /api/analytics answers it.
  const days = () => ([7, 30, 90].includes(Number(params().get('days'))) ? Number(params().get('days')) : 30);
  const who = () => params().get('person') || null;
  const pullFilter = () => params().get('pulls') || 'all';
  const repoPick = () => params().get('repo') || null;
  function setParam(key, value, fallback) {
    const p = params();
    if (value === fallback || value === null) p.delete(key);
    else p.set(key, value);
    const q = p.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${q ? `?${q}` : ''}`);
  }
  function pick(key, value, fallback) {
    setParam(key, value, fallback);
    shown.sessions = STEP;
    shown.pulls = STEP;
    render();
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
  const median = (values) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  const modelName = (m) => AGENT_NAMES[m] ?? m;

  const SVG = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs, ...children) {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs ?? {})) el.setAttribute(k, String(v));
    for (const c of children.flat()) if (c) el.append(c);
    return el;
  }

  // Small line icons (16px, currentColor) that sit beside a label: drawn here, never loaded.
  const ICONS = {
    sessions: 'M3 4.5h10v7H3zM5.5 7.5l1.5 1.2-1.5 1.2M8.5 10h2',
    people: 'M6 7.5a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4zM2.5 13c0-2 1.6-3.5 3.5-3.5s3.5 1.5 3.5 3.5M11 7a1.8 1.8 0 1 0 0-3.6M11.5 9.6c1.4.3 2.5 1.5 2.5 3.4',
    review: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 9.8a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z',
    agent: 'M8 2l1.3 3.2L12.5 6.5 9.3 7.8 8 11 6.7 7.8 3.5 6.5l3.2-1.3zM12.5 10.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z',
    pr: 'M4.5 3.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM4.5 9.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM4.5 6.5v3M11.5 12.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM11.5 9.5V6.5c0-1-.8-2-2-2H8M9.3 3l-1.5 1.5L9.3 6',
    merge: 'M4.5 3.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM4.5 9.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM4.5 6.5v3M11.5 9.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM4.5 6.5c0 2 3 3 7 3',
    clock: 'M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM8 4.8V8l2.2 1.4',
    shield: 'M8 1.8l5 1.8v4c0 3-2.2 5-5 6.2-2.8-1.2-5-3.2-5-6.2v-4zM5.8 8l1.6 1.6L10.4 6.4',
    calendar: 'M3 4.5h10v8.5H3zM3 7.2h10M5.5 2.8v2.4M10.5 2.8v2.4',
    repo: 'M4 2.5h8v11H4zM4 11h8M6.5 5h3',
    human: 'M8 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM3 13.5c0-2.5 2.2-4 5-4s5 1.5 5 4',
    model: 'M5 5h6v6H5zM7 2.5v2.5M9 2.5v2.5M7 11v2.5M9 11v2.5M2.5 7h2.5M2.5 9h2.5M11 7h2.5M11 9h2.5',
    plus: 'M8 3.5v9M3.5 8h9',
    chevron: 'M4 6l4 4 4-4',
  };
  function icon(name, tone) {
    return h('span', { class: `a-ico${tone ? ` is-${tone}` : ''}`, 'aria-hidden': 'true' },
      svg('svg', { viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, svg('path', { d: ICONS[name] })));
  }

  // Each figure has an icon and a tone, so a row reads at a glance. The number and its words carry the meaning.
  function figures(items) {
    return h('div', { class: 'figures' }, items.filter(Boolean).map(({ label, value, sub, icon: ico, tone }) => h('div', { class: `figure${tone ? ` is-${tone}` : ''}` },
      h('div', { class: 'figure-label' }, ico && icon(ico, tone), label),
      h('div', { class: 'figure-value' }, value),
      sub && h('div', { class: 'figure-sub' }, sub))));
  }

  // The window's buckets, as the console cut them (data.trend): the bucket an instant falls in, or -1.
  function bucketIndex(trend, at) {
    const t = Date.parse(at);
    if (!Number.isFinite(t)) return -1;
    let found = -1;
    trend.forEach((b, i) => { if (t >= Date.parse(b.start)) found = i; });
    return found;
  }
  function bucketCounts(trend, items, atOf, keyOf) {
    const out = trend.map((b) => ({ start: b.start, a: 0, b: 0 }));
    for (const item of items) {
      const at = atOf(item);
      if (!at) continue;
      const i = bucketIndex(trend, at);
      if (i >= 0) out[i][keyOf(item)]++;
    }
    return out;
  }
  const dayCounts = (items, atOf, keyOf) => window.WoodshedAnalyticsDays.dayCounts(items, atOf, keyOf, data.since, data.until);

  // Bars over the window: a single series, or two stacked (components/TrendBars). A bar's numbers are in its tooltip and
  // the chart's label, never its colour alone. `buckets`: {start, a, b}; series name which of a and b they are.
  function trendBars({ label, buckets, series, unit = data.step === 'day' ? 'Day of' : 'From', ico }) {
    const trend = buckets;
    const totals = trend.map((b) => series.reduce((sum, s) => sum + b[s.key], 0));
    const max = Math.max(1, ...totals);
    const W_ = 600;
    const H_ = 120;
    const gap = trend.length > 40 ? 1 : trend.length > 20 ? 2 : 6;
    const width = (W_ - gap * (trend.length - 1)) / trend.length;
    const scale = (v) => (v / max) * (H_ - 4);
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
      h('div', { class: 'trend-head' }, h('span', { class: 'figure-label' }, ico && icon(ico), label),
        series.length > 1 && h('span', { class: 'trend-legend' }, series.map((s) => h('span', null, h('i', { class: `trend-key ${s.cls}`, 'aria-hidden': 'true' }), s.label))),
        h('span', { class: 'trend-max mono' }, `max ${n(Math.max(...totals))}`)),
      chart,
      h('div', { class: 'trend-axis mono' }, h('span', null, day(trend[0]?.start)), h('span', null, 'today')));
  }

  // Everything below filters by the person picked (and, for the pull requests, the repo).
  function mySessions() {
    const picked = who();
    return data.sessions.recent.filter((s) => !picked || sameLogin(s.login, picked));
  }
  function myPulls({ byRepo = true } = {}) {
    const picked = who();
    const repo = byRepo ? repoPick() : null;
    return data.pulls.recent.filter((p) => (!picked || sameLogin(p.login, picked)) && (!repo || p.repo === repo));
  }

  function stats(list) {
    const out = { opened: list.length, merged: 0, open: 0, mergeHours: [], tiers: { Low: 0, Medium: 0, High: 0 }, human: 0, humanUnknown: 0, models: 0, modelled: 0, added: 0, removed: 0 };
    for (const p of list) {
      if (p.state === 'merged') { out.merged++; if (p.mergeHours !== null) out.mergeHours.push(p.mergeHours); }
      if (p.state === 'open' || p.state === 'draft') out.open++;
      if (p.tier) out.tiers[p.tier]++;
      if (p.humanReviewers?.length) out.human++;
      else if (p.humanUnknown) out.humanUnknown++;
      out.models += p.models?.length ?? 0;
      if (p.models?.length) out.modelled++;
      out.added += p.additions;
      out.removed += p.deletions;
    }
    out.reviewed = out.tiers.Low + out.tiers.Medium + out.tiers.High;
    return out;
  }

  function sessionsGroup() {
    const s = data.sessions;
    const picked = who();
    const mine = mySessions();
    const counted = picked ? mine.reduce((acc, r) => ({ ...acc, [r.agent]: (acc[r.agent] ?? 0) + 1 }), {}) : s.agents;
    const agents = Object.entries(counted).sort((a, b) => b[1] - a[1]);
    const total = picked ? mine.length : s.work;
    const privateCount = picked ? mine.filter((r) => r.private).length : s.private;
    const buckets = data.step === 'day' ? dayCounts(mine, (r) => r.createdAt, () => 'a') : bucketCounts(data.trend, mine, (r) => r.createdAt, () => 'a');
    return group({ id: 'analytics-totals', label: 'Sessions', note: 'Work sessions started in the window: My Woodshed, and shared ones from a label, a comment or the console.' },
      figures([
        { label: 'Sessions started', icon: 'sessions', tone: 'violet', value: n(total), sub: `${n(privateCount)} My Woodshed · ${n(total - privateCount)} shared` },
        picked ? null : { label: 'People using it', icon: 'people', tone: 'teal', value: s.members ? `${n(s.activeMembers)} / ${n(s.members)}` : n(s.people), sub: s.members ? `members started a session${s.people > s.activeMembers ? `, and ${n(s.people - s.activeMembers)} not on People` : ''}` : 'started a session' },
        picked ? null : { label: 'Reviews run', icon: 'review', tone: 'green', value: n(s.review), sub: `${n(s.qa)} QA runs · ${n(s.ask)} questions from Slack` },
        { label: 'Most used agent', icon: 'agent', tone: 'amber', value: agents.length ? `${AGENT_NAMES[agents[0][0]] ?? agents[0][0]} ${pct(agents[0][1] / total)}` : '—', sub: agents.length > 1 ? agents.slice(1).map(([id, c]) => `${AGENT_NAMES[id] ?? id} ${n(c)}`).join(' · ') : 'of sessions' },
      ]),
      trendBars({ label: 'Sessions started', ico: 'sessions', buckets, series: [{ key: 'a', cls: 'is-violet', word: 'sessions', label: 'Sessions' }] }));
  }

  // A stacked bar of how many pull requests had each merge risk, and the count for each level.
  function riskRow(label, st, ofTotal) {
    const unreviewed = ofTotal - st.reviewed;
    const seg = (cls, v) => v > 0 && h('span', { class: `risk-seg ${cls}`, style: `flex: ${v} 1 0`, title: `${v}` });
    return h('div', { class: 'risk-row' },
      h('div', { class: 'risk-name' }, label, h('span', { class: 'quiet' }, ` · ${n(ofTotal)} pull requests`)),
      ofTotal ? h('div', { class: 'risk-bar', role: 'img', 'aria-label': `${label}: ${n(st.tiers.Low)} low, ${n(st.tiers.Medium)} medium, ${n(st.tiers.High)} high, ${n(unreviewed)} not reviewed` },
        seg('is-low', st.tiers.Low), seg('is-medium', st.tiers.Medium), seg('is-high', st.tiers.High), seg('is-none', unreviewed)) : h('div', { class: 'risk-bar is-empty' }),
      h('div', { class: 'risk-counts' },
        TIER_LEVELS.map((t) => h('span', { class: `pill ${TIER_PILL[t]}` }, `${n(st.tiers[t])} ${t.toLowerCase()}`)),
        h('span', { class: 'pill' }, `${n(unreviewed)} not reviewed`)));
  }

  function pullsGroup() {
    const list = myPulls({ byRepo: false });
    const w = stats(list.filter((p) => p.via === 'woodshed'));
    const o = stats(list.filter((p) => p.via !== 'woodshed'));
    const all = stats(list);
    const mergedShare = all.merged ? w.merged / all.merged : null;
    const openedChart = dayCounts(list, (p) => p.createdAt, (p) => (p.via === 'woodshed' ? 'a' : 'b'));
    const merged = list.filter((p) => p.mergedAt);
    const mergedKey = (p) => (p.via === 'woodshed' ? 'a' : 'b');
    // A short window is by local date, as the opened chart is; a longer one by the weeks the console cut.
    const mergedChart = data.step === 'day' ? dayCounts(merged, (p) => p.mergedAt, mergedKey) : bucketCounts(data.trend, merged, (p) => p.mergedAt, mergedKey);
    const series = [
      { key: 'a', cls: 'is-woodshed', word: 'through Woodshed', label: 'Through Woodshed' },
      { key: 'b', cls: 'is-other', word: 'without', label: 'Without' },
    ];
    return group({ id: 'analytics-pull-totals', label: 'Pull requests', note: 'Opened in the window, on the console\'s repos. Through Woodshed means a session opened it or worked on its branch.' },
      figures([
        { label: 'Opened', icon: 'pr', tone: 'slate', value: n(all.opened), sub: `${n(all.merged)} merged · ${n(all.open)} open` },
        { label: 'Through Woodshed', icon: 'sessions', tone: 'violet', value: n(w.opened), sub: `${n(w.merged)} merged · ${n(w.open)} open` },
        { label: 'Without Woodshed', icon: 'pr', tone: 'teal', value: n(o.opened), sub: `${n(o.merged)} merged · ${n(o.open)} open` },
        { label: 'Merged through Woodshed', icon: 'merge', tone: 'green', value: pct(mergedShare), sub: 'of all merged' },
        { label: 'Opened to merged', icon: 'clock', tone: 'amber', value: hours(median(w.mergeHours)), sub: `median through Woodshed, ${hours(median(o.mergeHours))} without` },
        { label: 'Human reviewed', icon: 'human', tone: 'rose', value: all.opened - all.humanUnknown ? pct(all.human / (all.opened - all.humanUnknown)) : '—', sub: `${n(all.human)} of ${n(all.opened - all.humanUnknown)} had a person review${all.humanUnknown ? ` · ${n(all.humanUnknown)} not known (over 100 reviews)` : ''}` },
        { label: 'Models per pull request', icon: 'model', tone: 'violet', value: all.opened ? (all.models / all.opened).toFixed(1) : '—', sub: `${n(all.modelled)} had at least one model review` },
      ]),
      h('div', { class: 'risk' },
        h('div', { class: 'trend-head' }, h('span', { class: 'figure-label' }, icon('shield'), 'Merge risk, every level'),
          h('span', { class: 'trend-legend' }, [['is-low', 'Low'], ['is-medium', 'Medium'], ['is-high', 'High'], ['is-none', 'Not reviewed']].map(([c, t]) => h('span', null, h('i', { class: `trend-key risk-seg ${c}`, 'aria-hidden': 'true' }), t)))),
        riskRow('Through Woodshed', w, w.opened), riskRow('Without Woodshed', o, o.opened)),
      trendBars({ label: 'Pull requests opened each day', ico: 'calendar', buckets: openedChart, series, unit: 'Day of' }),
      trendBars({ label: 'Pull requests merged', ico: 'merge', buckets: mergedChart, series }));
  }

  // Pull requests for each repo, for everyone or the person picked: a name picks the repo for the list below.
  function reposGroup() {
    const list = myPulls({ byRepo: false });
    const rows = new Map();
    for (const p of list) {
      const r = rows.get(p.repo) ?? { repo: p.repo, opened: 0, woodshed: 0, merged: 0, open: 0, people: new Set() };
      r.opened++;
      if (p.via === 'woodshed') r.woodshed++;
      if (p.state === 'merged') r.merged++;
      if (p.state === 'open' || p.state === 'draft') r.open++;
      if (p.login) r.people.add(p.login);
      rows.set(p.repo, r);
    }
    const sorted = [...rows.values()].sort((a, b) => b.opened - a.opened || a.repo.localeCompare(b.repo));
    const max = Math.max(1, ...sorted.map((r) => r.opened));
    const picked = who();
    const chosen = repoPick();
    const body = sorted.map((r) => {
      const on = chosen === r.repo;
      return h('tr', { class: on ? 'is-picked' : null },
        h('td', null, h('button', { type: 'button', class: 'link-btn', 'aria-pressed': String(on), title: on ? 'Show every repo' : 'Show only this repo\'s pull requests below', onclick: () => pick('repo', on ? null : r.repo, null) }, icon('repo', 'slate'), r.repo)),
        h('td', { class: 'num' }, n(r.opened)),
        h('td', { class: 'bar-cell' }, h('span', { class: 'share-bar', role: 'img', 'aria-label': `${r.woodshed} through Woodshed of ${r.opened}` },
          h('i', { class: 'share-w', style: `width: ${(r.woodshed / max) * 100}%` }), h('i', { class: 'share-o', style: `width: ${((r.opened - r.woodshed) / max) * 100}%` }))),
        h('td', { class: 'num is-violet-ink' }, n(r.woodshed)),
        h('td', { class: 'num' }, n(r.opened - r.woodshed)),
        h('td', { class: 'num is-green-ink' }, n(r.merged)),
        h('td', { class: 'num' }, n(r.open)),
        !picked && h('td', { class: 'num' }, n(r.people.size)));
    });
    return group({ id: 'analytics-repos', label: `By repo · ${sorted.length}`, note: picked ? `${W.personText?.(picked) ?? picked}'s pull requests, and which repos they went to. Pick a repo to filter the list below.` : 'Pull requests opened on each repo. Pick a person to see which repos theirs went to.' },
      sorted.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'people-table analytics-table' },
        h('thead', null, h('tr', null,
          h('th', { scope: 'col' }, 'Repo'), h('th', { scope: 'col', class: 'num' }, 'Pull requests'), h('th', { scope: 'col' }, 'Split'),
          h('th', { scope: 'col', class: 'num' }, 'Woodshed'), h('th', { scope: 'col', class: 'num' }, 'Without'), h('th', { scope: 'col', class: 'num' }, 'Merged'), h('th', { scope: 'col', class: 'num' }, 'Open'),
          !picked && h('th', { scope: 'col', class: 'num', title: 'People who opened one' }, 'People'))),
        h('tbody', null, body))) : h('p', { class: 'empty' }, 'No pull requests in this window.'));
  }

  // Each person beside the others: what they started, and how their pull requests went, through Woodshed and not.
  function peopleGroup() {
    const picked = who();
    const rows = data.people.map((p) => {
      const opened = p.woodshed.opened + p.other.opened;
      const risky = p.woodshed.tiers.High + p.other.tiers.High;
      const reviewed = (t) => t.Low + t.Medium + t.High;
      const pickedHere = sameLogin(p.login, picked);
      return h('tr', { class: pickedHere ? 'is-picked' : null },
        h('td', null, h('button', {
          type: 'button', class: 'link-btn', 'aria-pressed': String(pickedHere), title: pickedHere ? 'Show everyone' : 'Show only their sessions and pull requests',
          onclick: () => pick('person', pickedHere ? null : p.login, null),
        }, icon('human', 'slate'), W.person(p.login))),
        h('td', { class: 'num is-violet-ink' }, p.sessions ? n(p.sessions) : h('span', { class: 'quiet' }, 'none')),
        h('td', { class: 'num' }, n(p.activeDays)),
        h('td', { class: 'mono quiet' }, p.lastAt ? day(p.lastAt) : '—'),
        h('td', { class: 'num' }, `${n(p.woodshed.opened)}`, h('span', { class: 'quiet' }, ` / ${n(p.woodshed.merged)}`)),
        h('td', { class: 'num' }, `${n(p.other.opened)}`, h('span', { class: 'quiet' }, ` / ${n(p.other.merged)}`)),
        h('td', { class: 'num' }, opened ? pct(p.share) : '—'),
        h('td', { class: 'num' }, hours(p.woodshed.medianMergeHours), h('span', { class: 'quiet' }, ` / ${hours(p.other.medianMergeHours)}`)),
        h('td', null, risky ? h('span', { class: 'pill is-bad' }, `${risky} high`) : h('span', { class: 'quiet' }, reviewed(p.woodshed.tiers) + reviewed(p.other.tiers) ? 'none high' : '—')),
        h('td', { class: 'num' }, lines(p.woodshed.added + p.other.added, p.woodshed.removed + p.other.removed)));
    });
    return group({ id: 'analytics-people', label: `By person · ${data.people.length}`, note: 'Pick a name to see only their sessions, pull requests and repos below. Members who started nothing are listed too.' },
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

  // Lines added in green and removed in red: a rough size, never a measure of output.
  function lines(added, removed) {
    return h('span', { class: 'lines' }, h('span', { class: 'lines-add' }, `+${n(added)}`), ' ', h('span', { class: 'lines-del' }, `−${n(removed)}`));
  }

  // Shows the first `count` rows, with Show more (one more page) and Show all under them.
  function more(key, total) {
    // A redraw replaces the button that was pressed, so focus goes to its replacement, or to the status line once all show.
    const redraw = () => { render(); (document.getElementById?.(`analytics-more-${key}`) ?? document.getElementById?.(`analytics-status-${key}`))?.focus?.(); };
    if (total <= shown[key]) return total > STEP ? h('p', { class: 'foot analytics-more', id: `analytics-status-${key}`, tabindex: '-1' }, `All ${n(total)} shown.`) : null;
    return h('div', { class: 'analytics-more-bar' },
      h('span', { class: 'foot' }, `Showing ${n(shown[key])} of ${n(total)}.`),
      h('button', { type: 'button', class: 'analytics-btn', id: `analytics-more-${key}`, onclick: () => { shown[key] += STEP; redraw(); } }, icon('plus'), `Show ${Math.min(STEP, total - shown[key])} more`),
      h('button', { type: 'button', class: 'analytics-btn', onclick: () => { shown[key] = total; redraw(); } }, icon('chevron'), `Show all ${n(total)}`));
  }

  function agentTag(id) {
    return h('span', { class: `agent-tag is-${AGENT_NAMES[id] ? id : 'other'}` }, AGENT_NAMES[id] ?? id);
  }

  function sessionsList() {
    const picked = who();
    const list = mySessions();
    const rows = list.slice(0, shown.sessions).map((s) => h('tr', null,
      h('td', { class: 'mono quiet' }, stamp(s.createdAt)),
      h('td', null, s.login ? W.person(s.login) : '—'),
      h('td', null, s.private ? h('span', { class: 'quiet', title: 'A My Woodshed session is its owner\'s: only that it ran is shown' }, 'Private session')
        : s.kept ? h('span', { title: 'Taken off the console\'s list: only its record is kept' }, s.title || s.id)
          : h('a', { href: `/s/${s.id}` }, s.title || s.id)),
      h('td', null, s.project ?? ''),
      h('td', null, agentTag(s.agent)),
      h('td', null, s.prUrls.length ? s.prUrls.map((url, i) => [i ? ' ' : null, h('a', { href: url, target: '_blank', rel: 'noopener' }, `#${url.split('/').pop()} ↗`)]) : h('span', { class: 'quiet' }, 'none'))));
    return group({ id: 'analytics-sessions', label: `Sessions started · ${list.length}`, note: picked ? `${W.personText?.(picked) ?? picked}'s, newest first.` : 'Newest first.' },
      list.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'people-table analytics-table' },
        h('thead', null, h('tr', null, ['When', 'Who', 'Session', 'Project', 'Agent', 'Pull request'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, rows))) : h('p', { class: 'empty' }, 'No sessions in this window.'),
      more('sessions', list.length));
  }

  function pullMatches(p, show) {
    if (show === 'woodshed' || show === 'other') return p.via === show;
    if (show === 'risky') return p.tier === 'Medium' || p.tier === 'High';
    if (show === 'human') return p.humanReviewers?.length > 0;
    if (show === 'nohuman') return !p.humanReviewers?.length && !p.humanUnknown;
    return true;
  }
  const STATE_PILL = { open: 'is-work', merged: 'is-ok', draft: '', closed: 'is-bad' };
  const STATE_WORD = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' };

  function reviewedBy(p) {
    const people = p.humanReviewers ?? [];
    return people.length
      ? h('span', { class: 'reviewers', title: `Reviewed by ${people.map((l) => `@${l}`).join(', ')}` }, icon('human', 'green'), people.length === 1 ? W.person(people[0]) : `${people.length} people`)
      : p.humanUnknown ? h('span', { class: 'quiet', title: 'More than 100 reviews: a person may be among those not read' }, 'Not known')
        : h('span', { class: 'quiet', title: 'No person reviewed it' }, 'No human');
  }
  function modelsOf(p) {
    const models = p.models ?? [];
    return models.length
      ? h('span', { class: 'pill is-model', title: models.map(modelName).join(', ') }, icon('model'), `${models.length} ${models.length === 1 ? 'model' : 'models'}`)
      : h('span', { class: 'quiet' }, 'none');
  }

  function pullsList() {
    const picked = who();
    const show = pullFilter();
    const repo = repoPick();
    const list = myPulls().filter((p) => pullMatches(p, show));
    const rows = list.slice(0, shown.pulls).map((p) => h('tr', null,
      h('td', { class: 'mono quiet' }, day(p.createdAt)),
      h('td', { class: 'analytics-title' }, h('a', { href: p.url, target: '_blank', rel: 'noopener' }, `#${p.number} ${p.title} ↗`),
        data.projects.length > 1 && h('span', { class: 'quiet' }, ` ${p.repo}`)),
      h('td', null, p.login ? W.person(p.login) : '—'),
      h('td', null, p.via === 'woodshed'
        ? h('span', { class: 'pill is-woodshed' }, p.sessionLink ? h('a', { href: `/s/${p.sessionLink}` }, 'Woodshed') : 'Woodshed')
        : h('span', { class: 'quiet' }, 'Without')),
      h('td', null, h('span', { class: `pill ${STATE_PILL[p.state] ?? ''}` }, STATE_WORD[p.state] ?? p.state)),
      h('td', { class: 'num' }, p.mergeHours === null ? '—' : hours(p.mergeHours)),
      h('td', null, p.tier ? h('span', { class: `pill ${TIER_PILL[p.tier]}` }, p.tier) : h('span', { class: 'quiet' }, 'not reviewed')),
      h('td', null, reviewedBy(p)),
      h('td', null, modelsOf(p)),
      h('td', { class: 'num' }, lines(p.additions, p.deletions))));
    return group({ id: 'analytics-pulls', label: `Pull requests · ${list.length}`, note: 'Merge risk is the Woodshed review\'s tier on the pull request. Human is a person other than the author who reviewed it; models are the Woodshed reviews that ran on it, else the review bots on GitHub.' },
      h('div', { class: 'analytics-bar' },
        h('div', { class: 'seg', role: 'group', 'aria-label': 'Show pull requests' }, PULL_FILTERS.map((f) =>
          h('button', { type: 'button', 'aria-pressed': String(f.id === show), onclick: () => pick('pulls', f.id, 'all') }, f.label))),
        repo && h('button', { type: 'button', class: 'analytics-btn', onclick: () => pick('repo', null, null) }, `Repo: ${repo} ✕`)),
      list.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'people-table analytics-table' },
        h('thead', null, h('tr', null,
          ['Opened', 'Pull request', 'Who', 'Through', 'State'].map((t) => h('th', { scope: 'col' }, t)),
          h('th', { scope: 'col', class: 'num' }, 'Opened to merged'),
          h('th', { scope: 'col' }, 'Merge risk'),
          h('th', { scope: 'col' }, 'Reviewed by'),
          h('th', { scope: 'col' }, 'Models'),
          h('th', { scope: 'col', class: 'num' }, 'Lines'))),
        h('tbody', null, rows))) : h('p', { class: 'empty' }, 'No pull requests match.'),
      more('pulls', list.length));
  }

  function notes() {
    const failed = data.failed.map((f) => f.repo);
    return [
      failed.length > 0 && h('p', { class: 'form-error', role: 'alert' }, `GitHub did not answer for ${failed.join(', ')}: its pull requests are left out. Try again in a minute.`),
      data.truncated && h('p', { class: 'foot' }, 'Some pull requests in this window were not read (GitHub\'s search returns at most 1,000 for a day, and Woodshed reads 2,000 a repo): the counts cover those that were.'),
    ];
  }

  function personPicker() {
    const picked = who();
    const select = h('select', { 'aria-label': 'Person', onchange: (e) => pick('person', e.target.value || null, null) },
      h('option', { value: '' }, 'Everyone'),
      // A person picked who has nothing in this window stays in the menu, so it does not read as Everyone.
      [...data.people.map((p) => p.login), ...(picked && !data.people.some((p) => sameLogin(p.login, picked)) ? [picked] : [])]
        .map((login) => h('option', { value: login, selected: sameLogin(login, picked) }, W.personText?.(login) ?? login)));
    if (picked) select.value = [...data.people.map((p) => p.login), picked].find((l) => sameLogin(l, picked));
    return h('label', { class: 'person-pick' }, icon('human', 'slate'), h('span', null, 'Person'), select);
  }

  // What the pull request data is as of, and a button to read GitHub again, off while a read is running.
  function freshness() {
    // With every repo failed on a first visit there is no time to show, but the button still lets them try again.
    if (!data?.asOf && !data?.failed?.length) return null;
    const running = data.refreshing || clickedRefresh;
    return h('p', { class: 'foot analytics-asof' },
      data.asOf ? `Pull requests as of ${stamp(data.asOf)}` : 'Pull requests not read yet',
      !running && data.refreshFailed ? ' · the last refresh failed, showing the earlier read' : '',
      ' ',
      h('button', { type: 'button', class: 'btn btn-plain', disabled: running, onclick: refreshNow }, running ? 'Refreshing…' : 'Refresh'));
  }

  function render() {
    const head = h('header', { class: 'page-head', id: 'analytics' },
      h('div', null,
        h('h1', { class: 'title' }, 'Analytics ', W.scopePill('/analytics')),
        h('p', { class: 'sub' }, 'How the team uses Woodshed: who starts sessions, and how their pull requests go.')));
    const windowSeg = h('div', { class: 'filters' },
      h('p', { class: 'foot' }, data ? `From ${day(data.since)} to today${loading ? ' · reading…' : ''}.` : ''),
      data && personPicker(),
      freshness(),
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
      reposGroup(),
      peopleGroup(),
      sessionsList(),
      pullsList(),
      h('p', { class: 'foot' }, 'Lines changed are a rough size of each pull request, not a measure of anyone\'s work. A pull request opened by a bot is left out unless a session opened it.')));
  }

  // Only the answer for the window picked last is drawn: an older read that lands after it is dropped, whichever call asked.
  // Every answer kept that says a refresh is running schedules the next ask, so the page follows it to its end whether it
  // was the first load, a window click, the button or an earlier ask.
  let asking = 0;
  async function refresh({ quiet = false } = {}) {
    clearTimeout(pollTimer);
    if (life.ended) return;
    const mine = ++asking;
    if (!quiet) {
      loading = true;
      render();
    }
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
    // Keep asking while a read runs. After a failed ask, only while the button's own read is awaited (a bounded few tries).
    // A failed ask is tried again a few times in a row, whatever it was waiting for, then the page stops asking.
    const again = loadError ? (data?.refreshing || clickedRefresh) && ++retries <= 5 : Boolean(data?.refreshing);
    if (again) pollTimer = setTimeout(() => refresh({ quiet: true }), 3000);
    else {
      clickedRefresh = false;
      // Given up asking: do not leave the button on "Refreshing…" for a read the page can no longer see.
      if (loadError && data) data = { ...data, refreshing: false };
    }
    if (!loadError) retries = 0;
    render();
  }

  // The button: the console reads GitHub again in the background, then the page follows it.
  let retries = 0;
  async function refreshNow() {
    clickedRefresh = true;
    retries = 0;
    render();
    try {
      await W.postJson('/api/analytics/refresh', {});
    } catch (err) {
      clickedRefresh = false;
      loadError = err.message;
      render();
      return;
    }
    await refresh({ quiet: true });
  }

  render();
  refresh();
});
