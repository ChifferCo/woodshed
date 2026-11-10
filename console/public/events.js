// The Webhook events page: what the console did with each message the webhooks
// queue brought, newest first. The filter lives in the URL (?show=acted|problems).
(function () {
  'use strict';
  const W = window.Woodshed;
  const { h } = W;
  const REFRESH_MS = 5000;
  const FILTERS = [
    { id: 'all', label: 'All' },
    { id: 'acted', label: 'Acted on' },
    { id: 'problems', label: 'Ignored or failed' },
  ];
  const ACTED = new Set(['started', 'sent', 'resumed', 'refreshed']);

  let data = null;
  let loadError = null;

  function filter() {
    return new URLSearchParams(window.location.search).get('show') || 'all';
  }

  function setFilter(id) {
    window.history.replaceState(null, '', id === 'all' ? window.location.pathname : `?show=${id}`);
    render();
  }

  function matches(e, show) {
    if (show === 'acted') return ACTED.has(e.outcome);
    if (show === 'problems') return !ACTED.has(e.outcome);
    return true;
  }

  function result(e) {
    const session = e.sessionId && h('a', { href: `/s/${e.sessionId}` }, e.sessionId);
    if (e.outcome === 'started') return ['Started session ', session];
    if (e.outcome === 'sent') return ['Sent to session ', session];
    if (e.outcome === 'resumed') return ['Resumed session ', session];
    if (e.outcome === 'refreshed') return `Read again: ${e.reason || 'the pull request'}`;
    if (e.outcome === 'duplicate') return `Skipped: ${e.reason || 'already handled'}`;
    if (e.outcome === 'failed') return `Failed: ${e.reason || 'no reason recorded'}`;
    return `Ignored: ${e.reason || 'nothing to do'}`;
  }

  function tone(e) {
    if (ACTED.has(e.outcome)) return 'is-done';
    if (e.outcome === 'failed') return 'is-failed';
    return 'is-idle';
  }

  function row(e) {
    const target = e.number ? h('a', { class: 'nowrap', href: W.issueUrl(data.repo, e), target: '_blank', rel: 'noopener' }, W.ref(e)) : '';
    return h('tr', null,
      h('td', { class: 'mono meta-cell' }, W.when(e.receivedAt || e.handledAt)),
      h('td', { class: 'mono' }, e.type || 'unknown'),
      h('td', null, target, e.detail ? h('span', { class: 'detail' }, e.detail) : null),
      h('td', null, e.login ? W.person(e.login) : ''),
      h('td', { class: 'result' }, h('span', { class: `status ${tone(e)}` }, h('span', { class: 'dot', 'aria-hidden': 'true' })), ' ', result(e)),
      h('td', { class: 'mono meta-cell', title: e.deliveryId || '' }, (e.deliveryId || '').slice(0, 8)));
  }

  function render() {
    const app = document.getElementById('app');
    const head = h('header', { class: 'page-head' },
      h('div', null,
        h('h1', { class: 'title' }, 'Webhook events'),
        h('p', { class: 'sub' }, 'Every delivery the console took off the queue, and what it did with it.')));
    if (!data) {
      app.replaceChildren(h('div', { class: 'page' }, W.nav('/events'), head,
        h('p', { class: 'empty' }, loadError ? `Could not load events: ${loadError}` : 'Loading events…')));
      return;
    }
    const show = filter();
    const visible = data.events.filter((e) => matches(e, show));
    const table = visible.length
      ? h('div', { class: 'table-box' }, h('table', { class: 'events' },
        h('thead', null, h('tr', null, ['Received', 'Event', 'On', 'From', 'Result', 'Delivery'].map((c) => h('th', { scope: 'col' }, c)))),
        h('tbody', null, visible.map(row))))
      : h('p', { class: 'empty' }, data.events.length ? 'No events match this filter.' : 'No webhook events yet.');
    app.replaceChildren(h('div', { class: 'page' },
      W.nav('/events'),
      head,
      h('div', { class: 'filters' },
        h('p', { class: 'foot' }, data.queue ? 'Newest first. The last 7 days are kept.' : 'This console does not read a webhooks queue, so it only polls GitHub.'),
        h('div', { class: 'seg', role: 'group', 'aria-label': 'Show' }, FILTERS.map((f) =>
          h('button', { type: 'button', 'aria-pressed': String(f.id === show), onclick: () => setFilter(f.id) }, f.label)))),
      table,
      h('p', { class: 'foot' }, `A delivery with a bad signature is turned away by ${W.providerWords.webhookReceiver ?? 'the webhook receiver'} and never reaches this list. `,
        'The GitHub App’s Recent Deliveries page shows those as 401.')));
  }

  async function refresh() {
    try {
      data = await W.getJson('/api/webhook-events');
      loadError = null;
    } catch (err) {
      loadError = err.message;
    }
    render();
  }

  refresh();
  setInterval(refresh, REFRESH_MS);
})();
