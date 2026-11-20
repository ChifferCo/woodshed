// A request to turn on Woodshed's review (and QA) for a repo (reviewSetup.mjs), at /review-setup/<id>: who asked, the
// exact files and settings approving it changes, what the console's GitHub App lacks for any of it, and Approve and
// apply, for an admin of the repo. Once decided, the same steps as a checklist of what was done.
(function () {
  'use strict';
  const W = window.Woodshed;
  const { h } = W;
  const id = location.pathname.split('/').pop();

  let data = null;
  let loadError = null;
  let actionError = null;
  let busy = null;

  const STATUS = {
    pending: ['Waiting for approval', ''], applying: ['Applying', 'is-work'], applied: ['Applied', 'is-ok'],
    refused: ['Refused', ''], failed: ['Failed', 'is-bad'],
  };
  const QA = { none: 'no QA', actions: 'QA in the repo\'s CI', woodshed: 'QA as a Woodshed session' };

  async function load() {
    try {
      data = await W.getJson(`/api/review-setup/${encodeURIComponent(id)}`);
      loadError = null;
    } catch (err) {
      loadError = err.message;
    }
    render();
  }

  async function act(action, body = {}) {
    busy = action;
    actionError = null;
    render();
    try {
      data = await W.postJson(`/api/review-setup/${encodeURIComponent(id)}/${action}`, body);
    } catch (err) {
      actionError = err.message;
      await load();
    }
    busy = null;
    render();
  }

  function who(by) {
    if (by.session) {
      return [h('a', { href: `/s/${encodeURIComponent(by.session)}` }, by.title || `session ${by.session}`),
        by.person ? ` (${by.private ? 'a My Woodshed session of ' : 'a shared session started by '}${W.personText(by.person)})` : ''];
    }
    return [by.login ? `@${by.login}` : 'the console'];
  }

  // Before a decision: what each step would do now. After: what it did.
  function rows() {
    const done = data.steps?.length ? data.steps : null;
    const planned = data.plan?.steps ?? [];
    const list = done ?? planned.map((s) => ({ ...s, state: s.change ? (s.missing.length ? 'blocked' : 'next') : 'kept' }));
    return h('ol', { class: 'start-steps review-setup-steps' }, list.map((step) => {
      const plan = planned.find((p) => p.key === step.key);
      const state = { done: 'is-done', kept: 'is-done', failed: 'is-failed', blocked: 'is-failed', next: 'is-next' }[step.state] ?? 'is-next';
      const mark = { 'is-done': '✓', 'is-failed': '✗' }[state] ?? '';
      // A step left as it is already says so in its words.
      const note = step.state === 'blocked' ? `needs ${plan.missing.join(', ')}` : step.state === 'kept' ? null : step.note;
      return h('li', { class: state },
        h('div', { class: 'review-setup-row' },
          h('span', { class: 'start-mark', 'aria-hidden': 'true' }, mark),
          h('span', { class: 'start-label' }, step.what, note && h('span', { class: 'start-note' }, ` · ${note}`))),
        plan?.text && h('details', { class: 'review-setup-file' },
          h('summary', null, `Show ${plan.path}`),
          h('pre', { class: 'layer-pre' }, plan.text)));
    }));
  }

  function actions() {
    if (data.status !== 'pending') return null;
    return h('div', { class: 'review-setup-actions' },
      h('button', {
        type: 'button', class: 'btn btn-primary', disabled: Boolean(busy) || !data.canApprove.ok,
        onclick: () => act('approve'),
      }, busy === 'approve' && h('span', { class: 'spin', 'aria-hidden': 'true' }), busy === 'approve' ? 'Applying…' : 'Approve and apply'),
      data.canRefuse && h('button', {
        type: 'button', class: 'btn btn-plain', disabled: Boolean(busy), onclick: () => act('refuse'),
      }, busy === 'refuse' ? 'Refusing…' : data.mine ? 'Withdraw' : 'Refuse'));
  }

  function body() {
    const [word, tone] = STATUS[data.status] ?? [data.status, ''];
    const pending = data.status === 'pending';
    return h('div', { class: 'wizard-body review-setup' },
      h('section', { class: 'secret-form' },
        h('h3', null, pending ? 'Approving it changes this ' : data.status === 'refused' ? 'Nothing was changed ' : 'What was done ',
          h('span', { class: `pill ${tone}` }, word)),
        data.plan?.branch && h('p', { class: 'msg-plain' }, `Each file is one commit to ${data.plan.branch}, by the console's GitHub App, pinned to Woodshed `, h('code', null, data.ref), '.'),
        rows(),
        pending && data.plan?.setsKey && h('p', { class: 'msg-plain' }, 'ANTHROPIC_API_KEY is set from the console\'s own Anthropic key, sealed to the repo. Every workflow in ',
          h('code', null, data.repo), ' can read it, so anyone who can push a workflow there can spend it.'),
        data.why && h('p', { class: data.status === 'failed' ? 'form-error' : 'msg-plain', role: data.status === 'failed' ? 'alert' : null }, data.why),
        pending && !data.canApprove.ok && data.canApprove.why && h('p', { class: 'form-error' }, data.canApprove.why),
        actionError && h('p', { class: 'form-error', role: 'alert' }, actionError),
        actions()),
      h('section', null,
        h('h3', null, 'History'),
        h('ul', { class: 'review-setup-history' }, data.history.map((e) => h('li', null,
          h('span', { class: 'review-setup-when' }, W.when(e.at)), ' ', e.what, ' by ', e.by.startsWith('session ') ? e.by : `@${e.by}`,
          e.note && e.what !== 'refused' && e.what !== 'failed' ? ` · ${e.note}` : '')))));
  }

  function render() {
    const app = document.getElementById('app');
    const head = h('header', { class: 'page-head' }, h('div', null,
      h('a', { class: 'side-back', href: '/' }, '‹ Back to sessions'),
      h('h1', { class: 'title' }, data ? `Turn on review for ${data.repo}` : 'Turn on review'),
      data && h('p', { class: 'sub' }, 'Asked by ', ...who(data.by), `, ${W.ago(data.createdAt)}: Woodshed's review with ${QA[data.qa] ?? data.qa}.`,
        data.status === 'pending' ? ` It expires ${new Date(data.expiresAt).toLocaleString()}.` : '')));
    let content;
    if (!data) content = h('p', { class: 'empty' }, loadError ? `Could not load: ${loadError}` : 'Loading…');
    else content = body();
    app.replaceChildren(h('div', { class: 'page review-setup-page' }, head, data && loadError && h('p', { class: 'form-error', role: 'alert' }, loadError), content));
  }

  load();
})();
