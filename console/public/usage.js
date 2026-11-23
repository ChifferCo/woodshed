// The Usage page: the tokens sessions' agents spent, split by what pays for them (a Claude or ChatGPT plan, or an API
// key), and what they cost at the providers' API list prices: for a key what it was charged, for a plan what the same
// tokens would have cost on a key (console/usage.mjs). Everyone sees their own; an admin may switch to Everyone. The
// span and the view live in the URL (?days=7|30|90&everyone=1).
window.Woodshed.settingsPage('/usage', (app, life) => {
  'use strict';
  const W = window.Woodshed;
  const { h } = W;
  const REFRESH_MS = 60_000;
  const SPANS = [7, 30, 90];
  const KINDS = [['input', 'Input'], ['cacheWrite', 'Cache write'], ['cacheRead', 'Cache read'], ['output', 'Output']];
  const PAID = { plan: 'Plan', key: 'API key' };
  const AGENTS = { claude: 'Claude Code', codex: 'Codex' };
  const SESSION_KINDS = { private: 'Private', shared: 'Shared', review: 'Review', qa: 'QA', ask: 'Slack question' };

  let data = null;
  let loadError = null;

  function params() {
    const q = new URLSearchParams(window.location.search);
    const days = Number(q.get('days'));
    return { days: SPANS.includes(days) ? days : 30, everyone: q.get('everyone') === '1' };
  }

  function setParams(next) {
    const { days, everyone } = { ...params(), ...next };
    const q = new URLSearchParams();
    if (days !== 30) q.set('days', String(days));
    if (everyone) q.set('everyone', '1');
    const search = q.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${search ? `?${search}` : ''}`);
    data = null;
    render();
    refresh();
  }

  function money(n) {
    if (!n) return '$0';
    if (n < 0.01) return '<$0.01';
    return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function tokens(n) {
    if (!n) return '0';
    if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
    return String(n);
  }

  const totalOf = (t) => (t.input ?? 0) + (t.cacheWrite5m ?? 0) + (t.cacheWrite1h ?? 0) + (t.cacheRead ?? 0) + (t.output ?? 0);
  const kindOf = (t, kind) => (kind === 'cacheWrite' ? (t.cacheWrite5m ?? 0) + (t.cacheWrite1h ?? 0) : t[kind] ?? 0);
  const num = (text, title = null) => h('td', { class: 'num', title }, text);
  const head = (cols) => h('thead', null, h('tr', null, cols.map(([label, cls]) => h('th', { scope: 'col', class: cls ?? null }, label))));
  const table = (cols, rows, min = 640) => h('div', { class: 'table-box' }, h('table', { class: 'events usage-table', style: `min-width:${min}px` }, head(cols), h('tbody', null, rows)));
  const whoText = (login) => (login ? W.person(login) : h('span', { class: 'meta-cell' }, 'the console'));

  function totalCard(billing) {
    const t = data.totals[billing];
    const plan = billing === 'plan';
    return h('section', { class: 'settings-card usage-total', id: `usage-${billing}` },
      h('h2', { class: 'set-group-label' }, plan ? 'On a plan' : 'On an API key'),
      h('p', { class: 'usage-money' }, money(t.cost)),
      h('p', { class: 'sub' }, plan
        ? 'What the Claude and ChatGPT plans’ tokens would have cost on an API key.'
        : 'What the team key and people’s own keys were charged, at list prices.'),
      h('p', { class: 'foot mono' }, `${tokens(totalOf(t.tokens))} tokens`,
        t.unpriced ? ` · ${tokens(t.unpriced)} on a model with no price` : ''));
  }

  function modelTable() {
    if (!data.byModel.length) return null;
    return h('section', { class: 'usage-section', id: 'usage-models' },
      h('h2', { class: 'set-group-label' }, 'By model'),
      table([['Paid by'], ['Agent'], ['Model'], ...KINDS.map(([, label]) => [label, 'num']), ['At API prices', 'num']],
        data.byModel.map((m) => h('tr', null,
          h('td', null, PAID[m.billing]),
          h('td', null, AGENTS[m.agent] ?? m.agent),
          h('td', { class: 'mono' }, m.model),
          ...KINDS.map(([kind]) => num(tokens(kindOf(m.tokens, kind)))),
          num(m.priced ? money(m.cost) : 'no price', m.priced ? null : 'This model is not in the console’s price list'))), 820));
  }

  function personTable() {
    if (!data.everyone || !data.byPerson.length) return null;
    return h('section', { class: 'usage-section', id: 'usage-people' },
      h('h2', { class: 'set-group-label' }, 'By person'),
      table([['Person'], ['Plan tokens', 'num'], ['Plan at API prices', 'num'], ['Key tokens', 'num'], ['Key at API prices', 'num']],
        data.byPerson.map((p) => h('tr', null,
          h('td', null, whoText(p.person)),
          num(tokens(p.plan.tokens)), num(money(p.plan.cost)), num(tokens(p.key.tokens)), num(money(p.key.cost))))));
  }

  function dayChart() {
    // In dollars; in tokens when nothing in the span has a price, so the days still show.
    const byCost = data.byDay.some((d) => d.plan.cost + d.key.cost > 0);
    const size = (part) => (byCost ? part.cost : part.tokens);
    const top = Math.max(0, ...data.byDay.map((d) => size(d.plan) + size(d.key)));
    if (!top) return null;
    // Newest first, as the other lists; a bar per day against the busiest one, plan then key, each named in words.
    const said = (part) => (byCost ? money(part.cost) : `${tokens(part.tokens)} tokens`);
    return h('section', { class: 'usage-section', id: 'usage-days' },
      h('h2', { class: 'set-group-label' }, byCost ? 'By day, at API prices' : 'By day, in tokens (no price known)'),
      h('div', { class: 'usage-days' }, [...data.byDay].reverse().map((d) => {
        const total = size(d.plan) + size(d.key);
        const label = `${d.day}: ${said(d.plan)} on a plan, ${said(d.key)} on an API key`;
        return h('div', { class: 'usage-day', title: label },
          h('span', { class: 'mono meta-cell' }, d.day.slice(5)),
          h('span', { class: 'usage-bar', role: 'img', 'aria-label': label },
            h('i', { class: 'is-plan', style: `width:${((size(d.plan) / top) * 100).toFixed(2)}%` }),
            h('i', { class: 'is-key', style: `width:${((size(d.key) / top) * 100).toFixed(2)}%` })),
          h('span', { class: 'mono usage-day-cost' }, total ? (byCost ? money(total) : tokens(total)) : '—'));
      })),
      h('p', { class: 'foot usage-legend' }, h('span', null, h('span', { class: 'usage-key is-plan', 'aria-hidden': 'true' }), ' Plan'),
        h('span', null, h('span', { class: 'usage-key is-key', 'aria-hidden': 'true' }), ' API key')));
  }

  function sessionTable() {
    if (!data.bySession.length) return null;
    return h('section', { class: 'usage-section', id: 'usage-sessions' },
      h('h2', { class: 'set-group-label' }, 'Sessions that spent the most'),
      table([['Session'], ...(data.everyone ? [['Person']] : []), ['Kind'], ['Agent'], ['Paid by'], ['Tokens', 'num'], ['At API prices', 'num']],
        data.bySession.map((s) => h('tr', null,
          // A session deleted since keeps its usage, and has no page to open.
          // Someone else's private session, or a shared one you may not open: its numbers, never what it was.
          h('td', null, s.hidden ? h('span', { class: 'meta-cell' }, `A ${s.kind === 'private' ? 'private' : 'shared'} session you cannot open`)
            : s.listed === false ? h('span', null, s.title || s.branch || s.sessionId, h('span', { class: 'detail' }, 'deleted'))
              : h('a', { href: `/s/${s.sessionId}` }, s.title || s.branch || s.sessionId),
            s.repo ? h('span', { class: 'detail' }, s.repo) : null),
          ...(data.everyone ? [h('td', null, whoText(s.person))] : []),
          h('td', { class: 'nowrap' }, SESSION_KINDS[s.kind] ?? s.kind),
          h('td', { class: 'nowrap' }, AGENTS[s.agent] ?? s.agent),
          h('td', { class: 'nowrap' }, PAID[s.billing]),
          num(tokens(s.tokens)), num(money(s.cost))))));
  }

  function controls() {
    const { days, everyone } = params();
    return h('div', { class: 'filters' },
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Span' }, SPANS.map((n) =>
        h('button', { type: 'button', 'aria-pressed': String(n === days), onclick: () => setParams({ days: n }) }, `${n} days`))),
      W.isAdmin?.() && h('div', { class: 'seg', role: 'group', 'aria-label': 'Whose' },
        h('button', { type: 'button', 'aria-pressed': String(!everyone), onclick: () => setParams({ everyone: false }) }, 'Mine'),
        h('button', { type: 'button', 'aria-pressed': String(everyone), onclick: () => setParams({ everyone: true }) }, 'Everyone')));
  }

  function render() {
    const { everyone } = params();
    const pageHead = h('header', { class: 'page-head', id: 'usage' },
      h('div', null,
        h('h1', { class: 'title' }, 'Usage ', h('span', { class: 'pill' }, everyone && W.isAdmin?.() ? 'Everyone' : 'Only you')),
        h('p', { class: 'sub' }, 'The tokens sessions’ agents spent, on a Claude or ChatGPT plan and on API keys, priced at the providers’ API list prices.')));
    if (!data) {
      app.replaceChildren(h('div', { class: 'page' }, life.nav('/usage'), pageHead, controls(),
        h('p', { class: 'empty' }, loadError ? `Could not load usage: ${loadError}` : 'Loading usage…')));
      return;
    }
    const any = data.byModel.length > 0;
    app.replaceChildren(h('div', { class: 'page' },
      life.nav('/usage'),
      pageHead,
      controls(),
      h('div', { class: 'usage-totals' }, totalCard('plan'), totalCard('key')),
      any ? null : h('p', { class: 'empty' }, `No tokens spent ${data.everyone ? 'on this console' : 'in your sessions'} from ${data.from} to ${data.to}.`),
      modelTable(),
      personTable(),
      dayChart(),
      sessionTable(),
      h('p', { class: 'foot' },
        `Counted from each session’s own transcripts, ${data.from} to ${data.to} (UTC). `,
        data.pricesFrom === 'openrouter'
          ? 'Prices are the providers’ standard list prices, read from OpenRouter’s model list just now, '
          : `Prices are the providers’ standard list prices of ${data.pricesAsOf}, built into the console, since OpenRouter’s model list could not be read, `,
        'so a long-context turn priced higher is counted at the standard rate: ',
        'a plan’s figure is what its tokens would have cost on a key, not what the plan costs. ',
        data.unpricedModels.length ? `No price is known for ${data.unpricedModels.join(', ')}. ` : '',
        'A session started from an image before this page counts nothing, and a session’s usage is kept 90 days.')));
  }

  // Only the last read asked draws: one still on its way when the span or the view changed answers for the old one.
  let asked = 0;
  async function refresh() {
    const { days, everyone } = params();
    const mine = ++asked;
    let next = null;
    let error = null;
    try {
      next = await W.getJson(`/api/usage?days=${days}${everyone ? '&everyone=1' : ''}`);
    } catch (err) {
      error = err.message;
    }
    if (mine !== asked) return;
    data = next ?? data;
    loadError = error;
    render();
  }

  render();
  refresh();
  life.on(window, 'woodshed:me', render);
  life.interval(refresh, REFRESH_MS);
});
