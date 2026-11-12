// Shared by both pages. Everything is built with DOM calls and textContent:
// titles and messages come from GitHub and from claude, never as HTML.
(function () {
  'use strict';

  const { sameLogin, findLogin, uniqueLogins } = window.WoodshedLogins;
  const { setupSteps, setupDone } = window.WoodshedSetup;
  const invite = window.WoodshedInvite;

  // What the pages say about where sessions run, in the provider's own words: pageShell's meta tag, from
  // providerWords.mjs. A page without it leaves out the steps only a provider can name.
  const PROVIDER_WORDS = readProviderWords();
  // What this installation calls its console (config.consoleName): pageShell's meta tag, read as text.
  const CONSOLE_NAME = document.querySelector?.('meta[name="woodshed-console-name"]')?.content || 'Woodshed';
  /** @returns {string}  the text with its first letter capitalised, for a provider's words at the start of a sentence */
  function capitalised(text) {
    return String(text).replace(/^./, (c) => c.toUpperCase());
  }
  function readProviderWords() {
    const content = document.querySelector?.('meta[name="woodshed-provider"]')?.content;
    if (!content) return {};
    try {
      return JSON.parse(content).words ?? {};
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      console.warn('provider: words not read', { message: err.message });
      return {};
    }
  }

  // A sign-in that lapsed (its cookie expired, or a sign-out in another tab) turns every call into the console's 401,
  // which pages only showed as an error until a reload. Any call answered so takes the page to sign in again, and
  // back here after. The login page answers its own visitors' 401s.
  let sendingToSignIn = false;
  function toSignIn() {
    if (sendingToSignIn || location.pathname === '/login') return;
    sendingToSignIn = true;
    console.log('signIn: the console needs a sign-in again, going to the login page');
    location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
  }
  if (typeof window.fetch === 'function') {
    const browserFetch = window.fetch.bind(window);
    window.fetch = async function (input, init) {
      const res = await browserFetch(input, init);
      if (res.status !== 401) return res;
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
      if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return res;
      const body = await res.clone().json().catch(() => ({}));
      if (body.error === 'sign in first') toSignIn();
      return res;
    };
  }
  // A page the back button restores from the cache kept the flag, and would never go to sign in again.
  window.addEventListener?.('pageshow', function () { sendingToSignIn = false; });
  // A tab left in the background polls rarely, if at all: coming back to it checks the sign-in at once.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible' || location.pathname === '/login') return;
    fetch('/api/me', { cache: 'no-store' }).then((r) => r.json()).then((me) => {
      if (me.signIn && !me.login) toSignIn();
    }).catch(() => {});
  });

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  // Each GitHub handle's display name, from whatever the console last answered. The handle stays the key: only
  // what is shown changes, and a handle with no name shows as @handle.
  const names = {};
  function learnNames(body) {
    if (body?.names && typeof body.names === 'object') Object.assign(names, body.names);
    return body;
  }

  /** @returns {string}  the display name, or @handle */
  function personText(login) {
    // A Slack asker (asks.mjs) whose name Slack would not give.
    if (!names[login] && String(login).startsWith('slack:')) return 'someone in Slack';
    return names[login] || `@${login}`;
  }

  /** @returns {Node}  the display name, with the handle on hover */
  function person(login) {
    return h('span', { class: 'person', title: names[login] ? `@${login}` : null }, personText(login));
  }

  // What the dot and the word say. A running session takes its word from claude's pane. A shared session done with
  // its turn while its pull request waits for the review and the suite is in review; a stopped one that is kept is
  // paused, finished once its pull request is in Slack, or merged (or closed) once that pull request is. A running one that
  // is done with its turn while a background shell waits on a job (a CI poll, a deploy, a test run) is waiting on a job, and
  // counts as busy.
  function displayStatus(s) {
    if (s.status === 'running') {
      if (s.state === 'needs-you') return { key: 'needs-you', word: 'needs you' };
      if (s.state === 'working') return { key: 'working', word: 'working' };
      if (s.state === 'done' && s.slackWaiting) return { key: 'review', word: 'in review' };
      // Done with its turn, but a background shell that waits on a job still runs on a pull request: it needs nobody yet.
      if (s.state === 'done' && s.shells > 0 && s.prUrl) return { key: 'job', word: 'waiting on a job' };
      if (s.state === 'done') return { key: 'done', word: 'done' };
      if (s.state === 'starting') return { key: 'starting', word: 'starting' };
      return { key: 'idle', word: 'claude exited' };
    }
    if (!isLive(s) && s.kept && !s.owner) {
      if (s.prClosedAt) return { key: 'merged', word: s.prMerged ? 'merged' : 'closed' };
      if (s.status === 'failed') return { key: 'failed', word: 'failed' };
      if (s.slackPostedAt) return { key: 'finished', word: 'finished' };
      return { key: 'paused', word: s.stoppedBy ? 'stopped' : 'paused' };
    }
    if (s.status === 'queued' && s.owner) return { key: 'queued', word: 'waiting' };
    if (s.status === 'failed' || (s.owner && s.stopReason === START_TIMEOUT_REASON)) return { key: 'failed', word: 'failed' };
    if (isPaused(s)) return { key: 'paused', word: 'paused' };
    if (s.cleanedAt) return { key: 'stopped', word: 'deleted' };
    return { key: s.status, word: s.status };
  }

  // The console's own stops (sessions.mjs, stopReason): at the idle or lifetime limit a private session is paused,
  // waiting for its owner to resume it; one that never came up has failed. Anything else, a person's stop included,
  // is stopped.
  const PAUSE_REASON_RE = /^(idle|ran) for /;
  const START_TIMEOUT_REASON = 'did not start in time';

  /** @returns {boolean}  a private session the console paused at the idle or lifetime limit */
  function isPaused(s) {
    return Boolean(s.owner) && s.status === 'stopped' && !s.stoppedBy && PAUSE_REASON_RE.test(s.stopReason ?? '');
  }

  // The rail card's line for a stopped private session: since when first, since the card's Resume button leaves
  // little room, then why (`idle 1 h`, `by you`). A failed one's word says enough; its pane says why.
  function privateStopLine(s, me) {
    const why = s.stoppedBy ? `by ${s.stoppedBy === me ? 'you' : personText(s.stoppedBy)}`
      : displayStatus(s).key === 'failed' ? null : s.stopReason?.replace(PAUSE_REASON_RE, '$1 ');
    return [ago(s.stoppedAt), why].filter(Boolean).join(' · ');
  }

  /** @returns {number|null}  where a private session waits in its owner's line, from 1, or null when it is not in it */
  function linePlace(s, sessions) {
    if (!s.owner || s.status !== 'queued' || waitsForRetry(s)) return null;
    const line = sessions.filter((o) => o.owner === s.owner && o.status === 'queued' && !waitsForRetry(o)).sort((a, b) => (a.queuedAt ?? a.createdAt).localeCompare(b.queuedAt ?? b.createdAt));
    return line.indexOf(s) + 1 || null;
  }

  // The provider had no room for it, and its next try is not due yet; once it is, it waits in its owner's line again.
  // The server's copy is waitsForRetry in sessions.mjs: change both.
  function waitsForRetry(s) {
    return s.status === 'queued' && Boolean(s.retryAt) && Date.parse(s.retryAt) > Date.now();
  }

  function ordinal(n) {
    const teen = n % 100 >= 11 && n % 100 <= 13;
    const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10];
    return `${n}${!teen && suffix ? suffix : 'th'}`;
  }

  function lineText(place) {
    return place === 1 ? 'next in line' : `${ordinal(place)} in line`;
  }

  // A session with a Fargate task: what each person's limit counts. The server's copy is SLOT_STATUSES in
  // sessions.mjs: change both.
  function holdsTask(s) {
    return s.status === 'starting' || s.status === 'running' || s.status === 'stopping';
  }

  function isLive(s) {
    return s.status === 'queued' || s.status === 'starting' || s.status === 'running' || s.status === 'stopping';
  }

  /** @returns {boolean}  a stopped shared session that still has its conversation and databases */
  function isResumable(s) {
    return !s.owner && Boolean(s.kept) && !isLive(s);
  }

  // A shared session's group on the rail and the Shared page's tab: working, waiting for input (asked something,
  // done with its turn, or paused when idle), stopped by someone on the console, finished, merged, and ended once
  // nothing of it is kept. A session someone stopped waits on no one, so it leaves Waiting for input, and so does a
  // paused question from Slack: it has answered, and a follow-up comes from the thread.
  const GROUPS = [
    { key: 'working', title: 'Working' },
    { key: 'waiting', title: 'Waiting for input' },
    { key: 'stopped', title: 'Stopped' },
    { key: 'finished', title: 'Finished' },
    { key: 'merged', title: 'Merged' },
    { key: 'ended', title: 'Ended' },
  ];
  const WAITING_KEYS = new Set(['needs-you', 'done', 'idle', 'review', 'paused', 'failed']);

  function group(s) {
    const { key } = displayStatus(s);
    if (isLive(s)) return WAITING_KEYS.has(key) ? 'waiting' : 'working';
    if (!isResumable(s) || s.kind === 'ask') return 'ended';
    if (key === 'merged') return 'merged';
    if (key === 'finished') return 'finished';
    if (s.stoppedBy) return 'stopped';
    return 'waiting';
  }

  /** @returns {boolean}  a shared session someone has, and that someone is `login` */
  function assignedTo(s, login) {
    return !s.owner && sameLogin(s.assignee, login);
  }

  /** @returns {boolean}  a session waiting on its person, live or stopped; on Mine the Needs you zone lists only the stopped ones and Active sorts the live ones first */
  function needsYou(s) {
    if (isLive(s)) return WAITING_KEYS.has(displayStatus(s).key);
    return isPaused(s) || (!s.owner && group(s) === 'waiting');
  }

  /** @returns {boolean}  a shared session nobody has, that still has something to do: Unassigned on Everyone */
  function isUnassigned(s) {
    return !s.owner && s.kind !== 'ask' && !s.assignee && !['ended', 'merged', 'finished'].includes(group(s));
  }

  /** @returns {Array}  who started a session, then → who has it when that is someone else; the Shared page */
  function startedLine(s) {
    const gone = s.assignee && !sameLogin(s.assignee, s.startedBy);
    return [person(s.startedBy), gone && [' → ', person(s.assignee)]];
  }

  /**
   * @param {object} s  the session
   * @param {{ named?: boolean }} [o]  named: the Assigned tag shows who has the session, as on Everyone
   * @returns {HTMLElement|null}  the tag after a card's title: Private, or Assigned on a shared session someone has
   */
  function ownerTag(s, { named = false } = {}) {
    if (s.owner) return h('span', { class: 'otag is-private', title: 'Only you see this session' }, 'Private');
    if (s.assignee && named) return h('span', { class: 'otag is-assigned is-named', title: `Assigned to @${s.assignee}` }, personText(s.assignee));
    if (s.assignee) return h('span', { class: 'otag is-assigned', title: `Assigned to ${personText(s.assignee)}` }, 'Assigned');
    return null;
  }

  /** The setup card: what is left, with Claude or Codex taking you to that sign-in's box on My settings, and Open My settings for databases that did not start. */
  function setupCard(me, { compact = false } = {}) {
    const rows = setupSteps(me).map((step) => h('div', { class: `setup-step${step.done ? ' is-done' : ''}` },
      h('span', { class: 'setup-check', 'aria-hidden': 'true' }, step.done ? '✓' : ''),
      h('span', { class: 'setup-label' }, step.label, h('small', null, step.hint)),
      step.key === 'repo' ? (isAdmin() ? h('a', { class: 'btn btn-primary btn-sm', href: '/console-settings#card-projects' }, 'Add a repo') : null)
        : step.key === 'github' ? h('a', { class: 'btn btn-primary btn-sm', href: '/setup/github' }, 'Set up')
        // Two equal choices, each to its own box on My settings: neither agent is the default.
        : step.key === 'token' && !step.done ? h('span', { class: 'setup-choices' },
          h('a', { class: 'btn btn-plain btn-sm', href: '/settings#claude' }, 'Claude'),
          h('a', { class: 'btn btn-plain btn-sm', href: '/settings#codex' }, 'Codex'))
        : step.todo ? h('a', { class: 'btn btn-plain btn-sm', href: '/settings' }, 'Open My settings') : null));
    return h('section', { class: `setup-card${compact ? ' is-compact' : ''}` },
      h('h3', null, 'Set up your Woodshed'),
      h('p', null, 'New session needs these, and nothing else does.'),
      rows);
  }

  function span(ms) {
    const min = Math.max(1, Math.round(ms / 60000));
    if (min < 60) return `${min} min`;
    const hours = Math.round(min / 60);
    return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
  }

  // Claude still opening, its first prompt queued, is busy too: nothing waits on the person.
  const BUSY_STATES = new Set(['working', 'starting']);

  // A countdown nobody needs all the time: it only shows once the pause is this close.
  const PAUSE_WARN_MS = 15 * 60_000;

  /** @returns {string|null}  `pauses in 9 min`, for a running session claude is not busy in, in its last 15 minutes */
  function pausesIn(s, { idleHours, askIdleHours, myIdleHours }) {
    if (s.kind === 'ask') idleHours = askIdleHours;
    else if (s.owner && myIdleHours) idleHours = myIdleHours;
    if (s.status !== 'running' || BUSY_STATES.has(s.state) || !s.lastActiveAt || !idleHours) return null;
    const left = Date.parse(s.lastActiveAt) + idleHours * 3_600_000 - Date.now();
    return left > PAUSE_WARN_MS ? null : `pauses in ${span(left)}`;
  }

  /** @returns {string|null}  `deleted in 2 days`, for a kept session whose end is set */
  function deletedIn(s) {
    return s.deletesAt && isResumable(s) ? `deleted in ${span(Date.parse(s.deletesAt) - Date.now())}` : null;
  }

  function ago(iso) {
    return iso ? `${span(Date.now() - Date.parse(iso))} ago` : '';
  }

  // The rail card's and the Shared card's line for a stopped shared session: what it is, and since when.
  function keptLine(s) {
    const { key } = displayStatus(s);
    if (key === 'merged') return deletedIn(s) || ago(s.prClosedAt);
    if (key === 'finished') return `in Slack ${ago(s.slackPostedAt)}`;
    if (key === 'failed') return 'did not start again';
    return `${s.stoppedBy ? 'stopped' : 'paused'} ${ago(s.stoppedAt)}`;
  }

  async function sharedAction(s, action, body = {}) {
    return postJson(`/api/sessions/${s.id}/${action}`, body);
  }

  // Resume on a stopped shared session: the same session again, on its branch and databases, with its conversation.
  function resumeSharedButton(s, { small = false, onDone, message = () => '' }) {
    const button = h('button', {
      type: 'button', class: `btn btn-primary${small ? ' btn-sm' : ''}`, title: 'Start it again where it was: its branch, databases and claude\'s conversation',
      onclick: async (e) => {
        e.preventDefault();
        e.stopPropagation();
        button.disabled = true;
        try {
          await sharedAction(s, 'resume', { message: message() });
        } catch (err) {
          window.alert(`Could not resume: ${err.message}`);
        }
        onDone();
      },
    }, 'Resume');
    return button;
  }

  // The questions asked before a stop or a delete, the same from a button and from a card's ⋯ menu.
  function confirmStop(s) {
    if (s.status === 'queued' && s.owner) return window.confirm(`Take "${s.title}" out of the line? Resume puts it back.`);
    return window.confirm(`Stop "${s.title}"? Its work is committed and pushed first.`);
  }
  function confirmDeleteShared(s) {
    return window.confirm(`Delete "${s.title}" now? ${isLive(s) ? 'It is stopped first, its work pushed. ' : ''}Its conversation and databases go, and Resume can no longer pick it up. The branch stays on GitHub.`);
  }

  function deleteSharedButton(s, onDone) {
    const button = h('button', {
      type: 'button', class: 'btn btn-delete',
      onclick: async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!confirmDeleteShared(s)) return;
        button.disabled = true;
        try {
          await sharedAction(s, 'delete');
        } catch (err) {
          window.alert(`Could not delete: ${err.message}`);
        }
        onDone();
      },
    }, 'Delete now');
    return button;
  }

  function statusBadge(s) {
    const st = displayStatus(s);
    return h('span', { class: `status is-${st.key}` }, h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { class: 'word' }, st.word));
  }

  // Whose Claude a shared session runs on, as its last start decided: the team's key, or its starter's own plan.
  // A My Woodshed session always runs on its owner's, so it shows nothing.
  function planChip(s) {
    if (isPrivate(s)) return null;
    if (!s.plan) return h('span', { class: 'plan-chip is-team', title: 'Runs on the team\'s Anthropic key' }, 'Team key');
    return h('span', { class: 'plan-chip', title: `Runs on ${personText(s.plan)}'s own Claude plan (@${s.plan}): they started it with their token switched on` },
      h('span', { class: 'glyph', 'aria-hidden': 'true' }, '◆'), `${personText(s.plan)}'s Claude`);
  }

  function duration(fromIso, toIso) {
    if (!fromIso) return '';
    const ms = (toIso ? Date.parse(toIso) : Date.now()) - Date.parse(fromIso);
    const min = Math.max(0, Math.round(ms / 60000));
    if (min < 60) return `${min}m`;
    return `${Math.floor(min / 60)}h ${min % 60}m`;
  }

  // A session's start, step by step: the machine and the wait for the pull are the console's own steps, from the
  // launcher, and named by the provider, which leaves out one it never reaches. The rest are what its entrypoint
  // reports (START_STEPS in sessions.mjs). A step reported after a later one is done too, as is any step a session
  // started from an older image never reports.
  const PROVIDER_STEPS = PROVIDER_WORDS.startSteps ?? {};
  const START_STEPS = [
    ['machine', ...(PROVIDER_STEPS.machine ?? [])],
    ['pullStarted', ...(PROVIDER_STEPS.pullStarted ?? [])],
    ['container', ...(PROVIDER_STEPS.container ?? [])],
    ['settings', 'Fetching its settings', 'settings'],
    ['home', 'Restoring the Claude home', 'Claude home'],
    ['branch', 'Checking out the branch', 'checkout'],
    ['databases', 'Getting its databases', 'databases'],
    ['env', 'Writing the env files and the prompt', 'env files'],
    ['claude', 'Opening claude', 'opening claude'],
  ].filter(([, label]) => label);

  /** @returns {{steps: {key: string, label: string, short: string, state: 'done'|'now'|'next', seconds: number|null}[], current: object|null}} */
  function startProgress(s, nowMs = Date.now()) {
    const at = s.startSteps || {};
    const last = START_STEPS.reduce((found, [key], i) => (at[key] ? i : found), -1);
    let from = Date.parse(s.startedAt);
    const steps = START_STEPS.map(([key, label, short], i) => {
      const doneAt = at[key] ? Date.parse(at[key]) : null;
      const state = i <= last ? 'done' : i === last + 1 ? 'now' : 'next';
      const end = state === 'now' ? nowMs : doneAt;
      const seconds = end && from ? Math.max(0, Math.round((end - from) / 1000)) : null;
      if (doneAt) from = Math.max(from, doneAt);
      return { key, label, short, state, seconds: state === 'next' ? null : seconds };
    });
    return { steps, current: steps.find((step) => step.state === 'now') ?? null };
  }

  /** @returns {string}  m:ss since the ISO time */
  function clock(fromIso, nowMs = Date.now()) {
    const total = Math.max(0, Math.floor((nowMs - Date.parse(fromIso)) / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  // A private session given no issue or PR works on its branch alone, so it has no reference.
  function ref(s) {
    if (!s.number) return '';
    return s.kind === 'pr' ? `PR #${s.number}` : `#${s.number}`;
  }

  /** @returns {boolean}  a session started from My Woodshed, which only its owner can see */
  function isPrivate(s) {
    return Boolean(s.owner);
  }

  function issueUrl(repo, s) {
    return `https://github.com/${repo}/${s.kind === 'pr' ? 'pull' : 'issues'}/${s.number}`;
  }

  function prNumber(prUrl) {
    return prUrl ? `#${prUrl.split('/').pop()}` : null;
  }

  // The line under a card's title: claude's last message, or what the console knows.
  function lastLine(s) {
    if (s.status === 'failed') return { who: 'console', text: s.error || 'The container did not start.', error: true };
    if (waitsForRetry(s)) return { who: 'console', text: PROVIDER_WORDS.noRoom?.line ?? 'Waiting for room.' };
    if (s.status === 'queued') return { who: 'console', text: s.owner ? 'Waiting in line for one of your slots.' : 'Waiting for a free slot.' };
    if (s.status === 'starting') return { who: 'console', text: 'Starting the container and checking out the branch.' };
    if (s.status === 'stopping') return { who: 'console', text: 'Pushing work in progress, then stopping.' };
    if (s.status === 'stopped' && !s.lastMessage) return { who: 'console', text: `Stopped: ${s.stopReason || 'no reason recorded'}.` };
    if (s.lastMessage) return { who: s.lastMessage.role, text: s.lastMessage.text.replace(/\s+/g, ' ') };
    return null;
  }

  async function fetchSessions() {
    const res = await fetch('/api/sessions', { cache: 'no-store' });
    if (!res.ok) throw new Error(`GET /api/sessions answered ${res.status}`);
    return learnNames(await res.json());
  }

  async function stopSession(id) {
    const res = await fetch(`/api/sessions/${id}/stop`, { method: 'POST', headers: { 'x-woodshed': '1' } });
    if (!res.ok) throw new Error(`stop answered ${res.status}`);
  }

  function stopButton(s, onDone, { label = 'Stop' } = {}) {
    const button = h('button', {
      type: 'button',
      class: 'btn btn-stop',
      onclick: async () => {
        if (!confirmStop(s)) return;
        button.disabled = true;
        try {
          await stopSession(s.id);
        } catch (err) {
          window.alert(`Could not stop the session: ${err.message}`);
        }
        onDone();
      },
    }, label);
    return button;
  }

  /**
   * @returns {string}  the session's app, on its own name: `<id>.<app domain>`, served by this console, so on its
   *   scheme and port (a local console's `http://<id>.localhost:7690/`)
   */
  function appUrl(s, appDomain) {
    return `${location.protocol}//${s.id}.${appDomain}${location.port ? `:${location.port}` : ''}/`;
  }

  // `app` picks one of several to start; without it the session starts the default.
  async function appAction(s, action, { app = null } = {}) {
    const res = await fetch(`/api/sessions/${s.id}/app/${action}`, {
      method: 'POST', headers: { 'x-woodshed': '1', ...(app && { 'content-type': 'application/json' }) }, body: app ? JSON.stringify({ app }) : undefined,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `${action} answered ${res.status}`);
    return body;
  }

  function serversTitle(s) {
    const servers = s.appServers;
    if (!servers) return '';
    const word = (up) => (up ? 'up' : 'down');
    // A statusd from an image before it reported the project's ports gives none: the servers are named alone.
    const port = (n) => (n ? ` :${n}` : '');
    return ` Backend${port(servers.backendPort)} ${word(servers.backend)}, frontend${port(servers.frontendPort)} ${word(servers.frontend)}.`;
  }

  function actionButton(s, { action, label, ariaLabel = null, title, size, onDone, cls = 'btn-plain' }) {
    const button = h('button', {
      type: 'button',
      class: `btn ${cls}${size}`,
      title,
      'aria-label': ariaLabel,
      onclick: async (e) => {
        e.preventDefault();
        e.stopPropagation();
        button.disabled = true;
        try {
          s.app = (await appAction(s, action)).app || s.app;
        } catch (err) {
          window.alert(`Could not ${action} the app: ${err.message}`);
        }
        onDone();
      },
    }, label);
    return button;
  }

  /** @returns {{name: string, label: string}[]|null}  the apps Start app picks from, when the project has more than one */
  function appChoices(s) {
    return Array.isArray(s.apps) && s.apps.length > 1 ? s.apps : null;
  }

  /** @returns {string|null}  the label of the app that runs, or would run, when there are several */
  function runningAppLabel(s) {
    return appChoices(s)?.find((a) => a.name === s.appName)?.label ?? null;
  }

  // What each app's line in the menu says it will do: one runs at a time.
  function appChoiceNote(s, app) {
    const up = s.app === 'running' || s.app === 'api-down' || s.app === 'frontend-down';
    if (app.name === s.appName) return up ? 'Running now: starts it again' : 'Start it in this session';
    return up ? `Stops ${runningAppLabel(s) ?? 'the running app'} first, then starts this one` : 'Start it in this session';
  }

  /** The apps as menu items: each starts that app, after the one running stops. */
  function appChoiceItems(s, onDone) {
    return (appChoices(s) ?? []).map((app) => ({
      group: 'Start app', label: app.label, note: appChoiceNote(s, app),
      run: async () => {
        try {
          s.app = (await appAction(s, 'start', { app: app.name })).app || s.app;
        } catch (err) {
          window.alert(`Could not start ${app.label}: ${err.message}`);
        }
        onDone();
      },
    }));
  }

  // Start app with several apps: a button that opens the page's one menu (session.js's Woodshed.openMenu) with each app's
  // label. A page without that menu starts the default, as one app would.
  function appPickButton(s, { label, ariaLabel = null, title, size, onDone }) {
    const openMenu = window.Woodshed?.openMenu;
    if (!openMenu) return actionButton(s, { action: 'start', label: label.replace(/ ▾$/, ''), ariaLabel, title, size, onDone });
    const key = `${s.id}:apps`;
    return h('button', {
      type: 'button', class: `btn btn-plain btn-app-pick${size}`, title, 'aria-label': ariaLabel, 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-menu-for': key,
      onclick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        openMenu(e.currentTarget, s, { items: appChoiceItems(s, onDone) });
      },
    }, label);
  }

  function setupAppToast(sent) {
    return sent === 'queued' ? 'claude will be asked to set up the app when its turn ends' : 'Asked claude to set up the app';
  }

  /**
   * The app's controls, after the shed's app line: Open app while it runs, Start app otherwise, and Stop app
   * whenever any of it is up or starting. Only a running session has an app. On the rail, the half that is down
   * is in the tooltip and the dot rather than a word, which the card's status line has no room for.
   * @param {object} s  the session
   * @param {{appDomain: string|null, onDone: () => void, small?: boolean}} opts
   * @returns {HTMLElement|null}
   */
  function appButton(s, { appDomain, onDone, small = false }) {
    if (!appDomain || s.status !== 'running') return null;
    const size = small ? ' btn-sm' : '';
    const stop = actionButton(s, {
      action: 'stop', label: small ? '■' : 'Stop app', ariaLabel: small ? 'Stop app' : null, size, onDone, cls: 'btn-plain btn-app-stop',
      title: `Stop the app's backend and frontend.${serversTitle(s)}`,
    });
    const group = (...children) => h('span', { class: 'app-ctl' }, ...children);
    // With several apps, the one that runs is named on the button that picks another.
    const running = runningAppLabel(s);
    const switcher = () => running && window.Woodshed?.openMenu && appPickButton(s, {
      label: `${running} ▾`, ariaLabel: `${running} runs: start another app`, size, onDone,
      title: `${running} is the app running. Pick another to start: ${running} stops first.`,
    });
    if (s.app === 'running' || s.app === 'api-down') {
      const down = s.app === 'api-down';
      const open = h('a', {
        class: `btn btn-open${size}`, href: appUrl(s, appDomain), target: '_blank', rel: 'noopener',
        title: down ? `The page loads, but its API is down, so every call under it fails.${serversTitle(s)}` : `${running ? `${running}: ` : ''}${appUrl(s, appDomain)}`,
      }, h('span', { class: `dot app-dot${down ? ' is-bad' : ''}`, 'aria-hidden': 'true' }), small ? 'App ↗' : 'Open app ↗');
      return group(open, down && !small ? h('span', { class: 'app-tag' }, 'API down') : null, switcher(), stop);
    }
    if (s.app === 'starting' || s.app === 'stopping') {
      const starting = s.app === 'starting';
      const busy = h('button', {
        type: 'button', class: `btn btn-plain${size}`, disabled: true,
        title: starting ? `Starting ${running ?? 'the app'}'s backend and frontend; usually one to three minutes` : 'Stopping the backend and the frontend',
      }, h('span', { class: 'spin', 'aria-hidden': 'true' }), starting ? (small ? 'Starting' : `Starting ${running ?? 'app'}…`) : (small ? 'Stopping' : 'Stopping app…'));
      return group(busy, starting ? stop : null);
    }
    // The project file has no app: Start app would have nothing to run, so this asks claude to write one.
    if (s.app === 'none') {
      if (s.kind === 'ask') return null;
      const setup = h('button', {
        type: 'button', class: `btn btn-plain${size}`,
        title: 'This project\'s .woodshed/project.yaml has no app, so there is nothing to start. Asks claude to work out how the app runs and write it there.',
        onclick: async (e) => {
          e.preventDefault();
          e.stopPropagation();
          setup.disabled = true;
          try {
            const { sent } = await appAction(s, 'setup');
            window.Woodshed.shell?.toast(setupAppToast(sent));
          } catch (err) {
            window.alert(`Could not set up the app: ${err.message}`);
          }
          onDone();
        },
      }, 'Set up app');
      const ctl = group(setup);
      ctl.dataset.idle = 'true';
      return ctl;
    }
    const halfUp = s.app === 'frontend-down';
    const again = s.app === 'failed';
    const startLabel = halfUp || again ? (small ? 'Start again' : 'Start app again') : 'Start app';
    const startTitle = halfUp ? `The backend is up and the frontend is not: Start app starts the frontend.${serversTitle(s)}`
      : again ? 'The last start failed: /tmp/woodshed-app.log in the terminal says why' : 'Start the app in this session';
    const start = appChoices(s)
      ? appPickButton(s, { label: `${startLabel} ▾`, size, onDone, title: `Pick which app to start: ${appChoices(s).map((a) => a.label).join(', ')}.${halfUp || again ? ` ${startTitle}` : ''}` })
      : actionButton(s, { action: 'start', size, onDone, label: startLabel, title: startTitle });
    const ctl = group(start, halfUp && !small ? h('span', { class: 'app-tag' }, 'frontend down') : null, halfUp ? stop : null);
    // Nothing of the app up: the phone's rail hides it, as the shed's does, since starting one is a desk job.
    if (!halfUp) ctl.dataset.idle = 'true';
    return ctl;
  }

  // The shed's PR mark: state, number, and one glyph for what most needs looking at (fail, changes, pending, pass). A
  // pull request in the merge queue says so in words instead of a glyph.
  const PR_STATE_WORD = { open: 'Open', draft: 'Draft', queued: 'In the merge queue', merged: 'Merged', closed: 'Closed without merging' };
  const REVIEW_WORD = { approved: 'approved', changes: 'changes requested', pending: 'awaiting review' };

  function checksWord(checks) {
    if (!checks) return null;
    if (checks.fail) return `${checks.fail} of ${checks.total} checks failing`;
    if (checks.pending) return `${checks.pending} of ${checks.total} checks still running`;
    return `all ${checks.total} checks passing`;
  }

  function prMarkLevel(pr) {
    if (pr.checks?.fail) return 'fail';
    if (pr.review === 'changes') return 'changes';
    if (pr.checks?.pending) return 'pending';
    if (pr.checks || pr.review === 'approved') return 'pass';
    return null;
  }

  /**
   * @param {object} s  the session, with `pr` from the console (prChips.mjs) or only its prUrl
   * @returns {HTMLElement|null}
   */
  function prChip(s, { asLink = false } = {}) {
    const number = prNumber(s.prUrl);
    if (!number) return null;
    const pr = s.pr;
    if (!pr) return h(asLink ? 'a' : 'span', { class: 'prchip', href: asLink ? s.prUrl : null, target: asLink ? '_blank' : null, rel: asLink ? 'noopener' : null }, `PR ${number}`);
    const queued = pr.state === 'queued';
    const level = queued ? null : prMarkLevel(pr);
    const glyph = { fail: '✗', changes: '✗', pending: '', pass: '✓' }[level];
    const stateWord = queued && pr.queuePosition ? `${PR_STATE_WORD.queued}, position ${pr.queuePosition}` : PR_STATE_WORD[pr.state];
    const tip = [`${number} ${pr.title}`, [stateWord, checksWord(pr.checks), REVIEW_WORD[pr.review]].filter(Boolean).join(' · '), s.branch].filter(Boolean).join('\n');
    return h(asLink ? 'a' : 'span', {
      class: `prchip is-${pr.state}`, title: tip, href: asLink ? s.prUrl : null, target: asLink ? '_blank' : null, rel: asLink ? 'noopener' : null,
    }, `PR ${number}`, queued && h('span', { class: 'prchip-word' }, 'queued'),
    level && h('span', { class: `prchip-mark is-${level}`, 'aria-hidden': 'true' }, glyph));
  }

  /**
   * The pull requests a session's card shows, oldest first: each one, but a merged or closed one only while no newer
   * one came after it. The newest always shows, so a session whose last pull request merged keeps its chip. A console
   * from before the list sends only `prUrl` and `pr`.
   * @returns {{url: string, pr: object|null}[]}
   */
  function shownPrs(s) {
    const all = s.prs?.length ? s.prs : s.prUrl ? [{ url: s.prUrl, pr: s.pr ?? null }] : [];
    return all.filter(({ pr }, i) => i === all.length - 1 || !(pr?.state === 'merged' || pr?.state === 'closed'));
  }

  /**
   * A chip for each pull request shownPrs gives, the newest `max` of them; the older ones fold into a `+N` chip whose
   * tooltip names each with its state. Details on a stopped session lists them all.
   * @returns {HTMLElement[]}
   */
  function prChips(s, { max = 2, ...opts } = {}) {
    const shown = shownPrs(s);
    const folded = shown.slice(0, Math.max(0, shown.length - max));
    const chips = shown.slice(folded.length).map(({ url, pr }) => prChip({ prUrl: url, pr, branch: s.branch }, opts));
    if (!folded.length) return chips;
    const tip = folded.map(({ url, pr }) => [prNumber(url), pr?.title, pr && PR_STATE_WORD[pr.state]].filter(Boolean).join(' · ')).join('\n');
    return [h('span', {
      class: 'prchip is-more', title: `${folded.length} more pull request${folded.length === 1 ? '' : 's'}:\n${tip}`,
      'aria-label': `${folded.length} more pull request${folded.length === 1 ? '' : 's'}: ${folded.map(({ url }) => prNumber(url)).join(', ')}`,
    }, `+${folded.length}`), ...chips];
  }

  /**
   * Every pull request the session opened, a merged or closed one its chips no longer show too, oldest first: a link
   * each, with its state and title, one to a line.
   */
  function prLines(s) {
    const all = s.prs?.length ? s.prs : s.prUrl ? [{ url: s.prUrl, pr: s.pr ?? null }] : [];
    return all.map(({ url, pr }, i) => [i ? h('br') : null,
      h('a', { href: url, target: '_blank', rel: 'noopener' }, prNumber(url)),
      pr && ` · ${PR_STATE_WORD[pr.state]}${pr.title ? ` · ${pr.title}` : ''}`]);
  }

  // What the container uses, against what it may: amber past 70% of its memory or 150% CPU, red past 90% or 190%.
  function fmtBytes(bytes) {
    if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
    if (bytes < 10 * 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  }

  /** @returns {{text: string, level: ''|'warn'|'hot', tip: string}|null} */
  function usageOf(s) {
    const u = s.status === 'running' ? s.usage : null;
    if (!u || (u.cpuPercent === null && u.memoryBytes === null)) return null;
    const cores = u.cores || 2;
    const memShare = u.memoryBytes !== null && u.memoryLimitBytes ? u.memoryBytes / u.memoryLimitBytes : 0;
    const cpuShare = u.cpuPercent !== null ? u.cpuPercent / 100 / cores : 0;
    const memLevel = memShare >= 0.9 ? 'hot' : memShare >= 0.7 ? 'warn' : '';
    const cpuLevel = cpuShare >= 0.95 ? 'hot' : cpuShare >= 0.75 ? 'warn' : '';
    const level = memLevel === 'hot' || cpuLevel === 'hot' ? 'hot' : memLevel || cpuLevel;
    const cpu = u.cpuPercent === null ? '—' : `${Math.round(u.cpuPercent)}%${cpuLevel ? ' cpu' : ''}`;
    const mem = u.memoryBytes === null ? '—' : fmtBytes(u.memoryBytes);
    const tip = `The session's container: ${cpu} CPU (100% is one of its ${cores} cores busy), ${mem}${u.memoryLimitBytes ? ` of ${fmtBytes(u.memoryLimitBytes)}` : ''} memory, page cache left out.`;
    // What is over the line comes first.
    const parts = memLevel && !cpuLevel ? [mem, cpu] : [cpu, mem];
    return { text: `${level ? '⚠ ' : ''}${parts.join(' · ')}`, level, tip };
  }

  function usageBadge(s) {
    const u = usageOf(s);
    return u && h('span', { class: `usage${u.level ? ` is-${u.level}` : ''}`, title: u.tip }, u.text);
  }

  // The owner's Claude plan, which all their private sessions draw on, so the newest reading any of them saw stands for
  // each (sessions.mjs keeps a stopped session's last one). Claude Code reports a reading after each answer and leaves
  // a window out on its own, so either can be missing.
  const PLAN_WINDOWS = [
    { key: 'fiveHour', short: '5h', label: 'Five-hour session', ms: 5 * 3600_000 },
    { key: 'sevenDay', short: 'wk', label: 'Week, all models', ms: 7 * 86400_000 },
  ];
  const PLAN_STALE_MS = 30 * 60_000;

  function planLevel(used) {
    if (used === null) return '';
    return used >= 100 ? 'out' : used >= 90 ? 'hot' : used >= 70 ? 'warn' : '';
  }

  /**
   * @returns {{asOf: string|null, stale: boolean, running: number,
   *            windows: {key: string, short: string, label: string, usedPercent: number|null, resetsAt: string|null, pace: number|null, level: string}[]}|null}
   *   `pace` is how much of the window has gone by, from 0 to 1; a window whose reset has passed reads 0% however old the reading
   */
  function planUsageOf(s, sessions) {
    if (!isPrivate(s)) return null;
    const newest = sessions.filter((o) => o.owner === s.owner && o.planUsage).map((o) => o.planUsage)
      .sort((a, b) => (b.asOf ?? '').localeCompare(a.asOf ?? ''))[0];
    if (!newest) return null;
    const now = Date.now();
    const windows = PLAN_WINDOWS.map(({ key, short, label, ms }) => {
      const w = newest[key];
      const reset = w?.resetsAt ? Date.parse(w.resetsAt) : null;
      const rolled = reset !== null && reset <= now;
      const usedPercent = !w ? null : rolled ? 0 : w.usedPercent;
      const pace = reset !== null && !rolled ? Math.min(1, Math.max(0, 1 - (reset - now) / ms)) : null;
      return { key, short, label, usedPercent, resetsAt: rolled ? null : w?.resetsAt ?? null, pace, level: planLevel(usedPercent) };
    });
    return {
      asOf: newest.asOf,
      stale: Boolean(newest.asOf) && now - Date.parse(newest.asOf) > PLAN_STALE_MS,
      running: sessions.filter((o) => o.owner === s.owner && o.status === 'running').length,
      windows,
    };
  }

  /** @returns {string}  `3:40 PM` today, `Sat 9:00 AM` later */
  function resetText(iso) {
    const at = new Date(iso);
    const today = at.toDateString() === new Date().toDateString();
    return at.toLocaleString(undefined, today ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }

  // The pane bar's button face: a short bar and the share used for each window, or when it comes back once one is out.
  function planUsageFace(u) {
    const out = u.windows.find((w) => w.level === 'out');
    const level = out ? 'out' : u.windows.some((w) => w.level === 'hot' || w.level === 'warn') ? 'warn' : '';
    const parts = out
      ? [`✗ out${out.resetsAt ? ` until ${resetText(out.resetsAt)}` : ''}`]
      : u.windows.filter((w) => w.usedPercent !== null).map((w) => h('span', { class: `plan-w${w.level ? ' is-warn' : ''}` },
        h('span', { class: 'plan-mini', 'aria-hidden': 'true' }, h('i', { style: `width:${w.usedPercent}%` })), `${w.short} ${Math.round(w.usedPercent)}%`));
    return {
      level,
      nodes: [h('span', { class: 'plan-lbl' }, 'Plan'), ...(parts.length ? parts : ['—']), u.stale && u.asOf && h('span', { class: 'plan-age' }, ago(u.asOf))],
    };
  }

  // What the plan chip opens: each window with when it resets, how old the reading is, and that it is shared.
  function planUsageDetails(u) {
    const meter = (w) => h('div', { class: `plan-meter${w.level ? ` is-${w.level === 'out' ? 'hot' : w.level}` : ''}` },
      h('div', { class: 'plan-row' }, h('span', null, w.label), h('b', null, w.usedPercent === null ? '—' : `${Math.round(w.usedPercent)}%`)),
      h('div', { class: 'plan-bar', role: 'img', 'aria-label': w.usedPercent === null ? `${w.label}: not reported` : `${w.label}: ${Math.round(w.usedPercent)}% used` },
        h('i', { style: `width:${w.usedPercent ?? 0}%` }),
        w.pace !== null && h('span', { class: 'plan-pace', style: `left:${(w.pace * 100).toFixed(1)}%`, title: 'How much of the window has gone by' })),
      h('div', { class: 'plan-sub' }, w.usedPercent === null ? 'Claude Code has not reported it yet'
        : w.resetsAt ? `Resets ${resetText(w.resetsAt)} · in ${span(Date.parse(w.resetsAt) - Date.now())}` : 'Reset since the reading'));
    const others = u.running - 1;
    return h('div', { class: 'plan-detail' },
      h('div', { class: 'card-menu-group' }, 'Your Claude plan'),
      ...u.windows.map(meter),
      h('p', { class: 'plan-foot' },
        `Read from Claude Code after its last answer${u.asOf ? `, ${ago(u.asOf)}` : ''}. `,
        others > 0 ? `Shared with your ${others} other running private session${others === 1 ? '' : 's'}. ` : '',
        'The tick marks how much of each window has gone by. ',
        h('a', { href: 'https://claude.ai/settings/usage', target: '_blank', rel: 'noopener' }, 'claude.ai usage ↗')));
  }

  // Under the avatar, as most apps keep them, and on the settings pages' list: your own settings, and the console's own,
  // which only an admin sees (the console refuses their calls to anyone else).
  const MY_LINKS = [{ href: '/settings', label: 'My settings' }];
  const CONSOLE_LINKS = [
    { href: '/people', label: 'People' },
    { href: '/secrets', label: 'Secrets & webhooks' },
    { href: '/events', label: 'Webhook events' },
    { href: '/console-settings', label: 'Console settings' },
  ];
  // Behind a hosting proxy the host keeps who is in (and signs people in and out): there is no People page.
  function consoleLinks(me) {
    return me?.hosted ? CONSOLE_LINKS.filter((link) => link.href !== '/people') : CONSOLE_LINKS;
  }

  // The workflows that build the images and apply the infrastructure, in the installation's repo, as its
  // WOODSHED_ACTIONS_WORKFLOWS names them; each has a Run workflow button.
  function workflowLinks(me) {
    if (!me.repo) return [];
    return (me.workflows ?? []).map(({ label, file }) => ({ href: `https://github.com/${me.repo}/actions/workflows/${encodeURIComponent(file)}`, label: `${label} ↗` }));
  }

  function initials(login) {
    const shown = names[login] || login;
    const parts = String(shown).split(/[-_.\s]+/).filter(Boolean);
    return (parts.length > 1 ? parts[0][0] + parts[1][0] : String(shown).slice(0, 2)).toUpperCase();
  }

  // The menu under the avatar: who is signed in, the settings pages, and Sign out. Asked once per page
  // load; the same node goes into every render of the nav, so a refresh never closes it.
  const userSlot = h('div', { class: 'nav-user' });
  function userMenu(me, current) {
    const button = h('button', { type: 'button', class: 'user-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
      h('span', { class: 'avatar', 'aria-hidden': 'true' }, me.login ? initials(me.login) : '··'),
      me.asking > 0 && h('span', { class: 'asking-dot', title: `${me.asking} asking to join` }),
      h('span', { class: 'user-name' }, me.login ? personText(me.login) : 'Not signed in',
        // Under the name, what a program embedding the console says the person is in (server.mjs, menuOf).
        me.menuSubtitle && h('span', { class: 'user-sub' }, me.menuSubtitle)),
      h('span', { class: 'caret', 'aria-hidden': 'true' }, '▾'));
    // Someone asking to join waits on an admin, so the menu says so wherever you are.
    const asking = (link) => link.href === '/people' && me.asking > 0 && h('span', { class: 'menu-count', title: `${me.asking} asking to join` }, me.asking);
    const item = (link) => h('a', { class: 'menu-item', role: 'menuitem', href: link.href, 'aria-current': link.href === current ? 'page' : null }, link.label, asking(link));
    const note = me.hosted ? null : !me.login && me.available ? h('a', { class: 'nav-off', href: `/login?next=${encodeURIComponent(location.pathname)}` }, 'Sign in with GitHub to turn sign-in on')
      : !me.login && me.supported ? h('a', { class: 'nav-off', href: '/secrets', title: 'Set github-app-client-secret on the Secrets tab to turn it on' }, 'GitHub sign-in is off')
        : null;
    const menu = h('div', { class: 'user-menu', role: 'menu', hidden: true },
      h('div', { class: 'menu-head' }, h('b', null, me.login ? personText(me.login) : CONSOLE_NAME), names[me.login] && h('span', { class: 'menu-handle' }, `@${me.login}`), note),
      menuGroups(me),
      me.login && MY_LINKS.map(item),
      h('button', {
        type: 'button', class: 'menu-item', role: 'menuitem', 'data-keys': 'keys',
        onclick: () => { setOpen(false); window.Woodshed.shell?.openKeys(); },
      }, 'Keyboard shortcuts', h('kbd', { class: 'menu-kbd' }, '?')),
      me.admin && [h('div', { class: 'menu-label' }, 'Console'), consoleLinks(me).map(item)],
      workflowLinks(me).length > 0 && [h('div', { class: 'menu-label' }, 'GitHub Actions'), workflowLinks(me).map((link) =>
        h('a', { class: 'menu-item', role: 'menuitem', href: link.href, target: '_blank', rel: 'noopener noreferrer' }, link.label))],
      // Signing out drops what the rail page kept in this tab (session.js), so nobody signing in after sees it.
      me.login && !me.hosted && h('form', {
        method: 'post', action: '/auth/sign-out', class: 'menu-form',
        onsubmit: () => { try { window.sessionStorage.removeItem('woodshed-last'); } catch { /* nothing kept */ } },
      },
        h('button', { type: 'submit', class: 'menu-item', role: 'menuitem' }, 'Sign out')));
    function setOpen(open) {
      menu.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
    }
    button.addEventListener('click', () => setOpen(menu.hidden));
    document.addEventListener('click', (e) => { if (!menu.hidden && !userSlot.contains(e.target)) setOpen(false); });
    userSlot.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || menu.hidden) return;
      setOpen(false);
      button.focus();
    });
    return [button, menu];
  }

  // What a program embedding the console adds to the top of the menu (server.mjs, menuOf): groups of links, where a
  // choice is checked when it is the one in use and is otherwise a link to choose it. designSystem/components/MenuGroups.
  function menuGroups(me) {
    if (!Array.isArray(me.menuGroups) || !me.menuGroups.length) return null;
    const note = (item) => item.note && h('span', { class: 'menu-note' }, item.note);
    const choice = (item) => (item.current
      ? h('div', { class: 'menu-item menu-choice', role: 'menuitemradio', 'aria-checked': 'true', 'aria-current': 'true' },
        h('span', { class: 'menu-check', 'aria-hidden': 'true' }, '✓'), h('span', { class: 'menu-choice-name' }, item.label), note(item))
      : h('a', { class: 'menu-item menu-choice', role: 'menuitemradio', 'aria-checked': 'false', href: item.href },
        h('span', { class: 'menu-check', 'aria-hidden': 'true' }), h('span', { class: 'menu-choice-name' }, item.label), note(item)));
    const link = (item) => h('a', { class: 'menu-item', role: 'menuitem', href: item.href }, item.label, note(item));
    return [
      me.menuGroups.map((group) => [
        group.label && h('div', { class: 'menu-label' }, group.label),
        group.items.map((item) => (typeof item.current === 'boolean' ? choice(item) : link(item))),
      ]),
      h('div', { class: 'menu-rule', role: 'separator' }),
    ];
  }

  /** @returns {string}  what Shared says with no session to list, on the rail and on / alike */
  function sharedEmptyText(picked) {
    return picked.length ? 'Nobody you picked has a shared session.'
      : 'No shared sessions yet. Label an issue woodshed, or comment /woodshed on an issue or PR.';
  }

  // The rail's head, on the pages that have one, carries the same menu in place of the nav bar. It is one node, so a
  // page uses this or nav(), never both: nav() would move the menu out of the rail.
  function userMenuSlot() {
    return userSlot;
  }

  let navCurrent = null;
  let meNow = null;
  // The settings list's Console group, filled once /api/me says you are an admin. One node, like userSlot.
  const consoleSlot = h('div', { class: 'side-console' });
  function fillConsoleSlot() {
    const item = (link) => h('a', { class: 'side-item', href: link.href, 'aria-current': link.href === navCurrent ? 'page' : null },
      h('span', { class: 'side-ico', 'aria-hidden': 'true' }, SETTINGS_ICONS[link.href]), link.label);
    consoleSlot.replaceChildren(...(meNow?.admin ? [h('div', { class: 'side-group' }, 'Console'), ...consoleLinks(meNow).map(item)] : []));
  }
  fetch('/api/me', { cache: 'no-store' }).then((r) => r.json()).then(learnNames).then((me) => {
    meNow = me;
    userSlot.replaceChildren(...userMenu(me, navCurrent));
    fillConsoleSlot();
    // A page drawn before this answer showed the non-admin version of what isAdmin() decides: it draws again.
    window.dispatchEvent(new Event('woodshed:me'));
  }).catch(() => {});

  /** @returns {boolean}  whether the console's own pages are yours to open, once /api/me has answered (`woodshed:me`) */
  function isAdmin() {
    return Boolean(meNow?.admin);
  }

  // The settings pages' left column, in the rail's place: back to the sessions, the avatar menu, and a list of every
  // settings page, as Linear and GitHub keep theirs. Fixed beside the page, which the CSS moves over to make room.
  const SETTINGS_ICONS = { '/settings': '◉', '/people': '☺', '/secrets': '◇', '/events': '≋', '/console-settings': '⚙' };
  function nav(current) {
    navCurrent = current;
    fillConsoleSlot();
    const item = (link) => h('a', { class: 'side-item', href: link.href, 'aria-current': link.href === current ? 'page' : null },
      h('span', { class: 'side-ico', 'aria-hidden': 'true' }, SETTINGS_ICONS[link.href]), link.label);
    return h('aside', { class: 'settings-side', 'aria-label': 'Settings' },
      h('div', { class: 'side-head' }, h('a', { class: 'side-back', href: '/' }, '‹ ', h('b', null, 'Back to sessions')), userSlot),
      h('nav', { class: 'side-list' },
        h('div', { class: 'side-group' }, 'You'), MY_LINKS.map(item),
        consoleSlot,
        h('div', { class: 'side-group' }, 'This browser'),
        h('button', { type: 'button', class: 'side-item', 'data-keys': 'settings', onclick: () => window.Woodshed.shell?.openSettings() },
          h('span', { class: 'side-ico', 'aria-hidden': 'true' }, '◐'), 'Theme and review files', h('kbd', { class: 'side-hint' }, window.Woodshed.shell?.keyText('settings') ?? '⇧⌘,')),
        h('button', { type: 'button', class: 'side-item', 'data-keys': 'keys', onclick: () => window.Woodshed.shell?.openKeys() },
          h('span', { class: 'side-ico', 'aria-hidden': 'true' }, '?'), 'Keyboard shortcuts', h('kbd', { class: 'side-hint' }, '?'))));
  }

  async function getJson(path) {
    const res = await fetch(path, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `GET ${path} answered ${res.status}`);
    return learnNames(body);
  }

  // Writes carry x-woodshed, which a cross-site form cannot send. The error is the console's own sentence.
  async function postJson(path, body) {
    const res = await fetch(path, {
      method: 'POST', headers: { 'x-woodshed': '1', 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
    });
    const answer = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(answer.error || `POST ${path} answered ${res.status}`), answer.link && { link: answer.link });
    return answer;
  }

  function when(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  /**
   * An error's message, then the server's `link` (an https page that fixes it, such as the App's install page) opening
   * in a new tab, as the children of a `form-error`.
   * @param {{message: string, link?: {href: string, text?: string}}} err
   */
  function errorParts(err) {
    const href = /^https:\/\//.test(err.link?.href ?? '') ? err.link.href : null;
    return [err.message, ...(href ? [' ', h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, `${err.link.text || 'Open on GitHub'} ↗`)] : [])];
  }

  /**
   * A change the person must confirm by typing `word`: what it is now, what it becomes, and what that affects.
   * @param {{title: string, before?: string, after?: string, rows?: string[][], effect: string, word: string, goLabel: string,
   *          run: () => Promise<void>}} opts  `run` makes the change; its error stays in the dialog (errorParts). `rows`, for several
   *   changes at once, is [what, now, after] for each, in place of `before` and `after`
   */
  function confirmChange({ title, before, after, rows = null, effect, word, goLabel, run }) {
    const input = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', class: 'field mono' });
    const go = h('button', { type: 'button', class: 'btn btn-open', disabled: true }, goLabel);
    const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const dialog = h('dialog', { class: 'confirm', 'aria-labelledby': 'confirm-title' },
      h('h2', { id: 'confirm-title' }, title),
      rows
        ? h('table', { class: 'confirm-rows' },
          h('thead', null, h('tr', null, h('th', null, 'Setting'), h('th', null, 'Now'), h('th', null, 'After'))),
          h('tbody', null, rows.map(([what, was, next]) => h('tr', null, h('td', null, what), h('td', { class: 'was' }, was), h('td', { class: 'now' }, next)))))
        : h('dl', null, h('dt', null, 'Now'), h('dd', null, before), h('dt', null, 'After'), h('dd', null, after)),
      h('p', { class: 'sub' }, effect),
      h('label', { class: 'field-label' }, h('span', null, 'Type ', h('code', null, word), ' to confirm'), input),
      error,
      h('div', { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => dialog.close() }, 'Cancel'),
        go));
    input.addEventListener('input', () => { go.disabled = input.value !== word; });
    go.addEventListener('click', async () => {
      if (input.value !== word) return;
      go.disabled = true;
      error.hidden = true;
      try {
        await run();
        dialog.close();
      } catch (err) {
        error.replaceChildren(...errorParts(err));
        error.hidden = false;
        go.disabled = false;
      }
    });
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    input.focus();
  }

  // `?by=` holds the logins picked, comma-separated; none is everyone.
  function pickedLogins(search) {
    return (new URLSearchParams(search).get('by') || '').split(',').map((l) => l.trim()).filter(Boolean);
  }

  function byQuery(picked) {
    return picked.length ? `?by=${picked.map(encodeURIComponent).join(',')}` : '';
  }

  /**
   * Who started a session, as a dropdown of checkboxes; none ticked is everyone. Built once and updated in place,
   * so a refresh neither closes it nor takes focus off the box someone just ticked.
   * @param {(picked: string[]) => void} onChange
   * @returns {{el: HTMLElement, update: (opts: {logins: string[], picked: string[], counts?: Record<string, number>}) => void}}
   */
  function peoplePicker(onChange, { allLabel = 'Everyone' } = {}) {
    const summary = h('summary', { class: 'who-sum' });
    const list = h('div', { class: 'who-list', role: 'group', 'aria-label': 'Started by' });
    const el = h('details', { class: 'who-pick' }, summary, list);
    const rows = new Map();
    let rowsShown = '';
    let picked = [];
    document.addEventListener('click', (e) => { if (el.open && !el.contains(e.target)) el.open = false; });
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !el.open) return;
      el.open = false;
      summary.focus();
    });
    function row(login) {
      const box = h('input', { type: 'checkbox', value: login });
      box.addEventListener('change', () => {
        onChange(login === '' ? [] : box.checked ? [...picked, login] : picked.filter((l) => l !== login));
      });
      const n = h('span', { class: 'n' });
      return { label: h('label', { class: 'who-row' }, box, h('span', { class: 'who-name', title: login && names[login] ? `@${login}` : null }, login ? personText(login) : 'Everyone'), n), box, n };
    }
    function update({ logins, picked: next, counts = null }) {
      const spelled = uniqueLogins([...logins, ...next, ...Object.keys(counts ?? {})]);
      const canonical = (l) => findLogin(spelled, l);
      picked = uniqueLogins(next.map(canonical));
      if (counts) {
        const merged = { '': counts[''] };
        for (const [l, n] of Object.entries(counts)) if (l) merged[canonical(l)] = (merged[canonical(l)] || 0) + n;
        counts = merged;
      }
      const all = ['', ...spelled.sort((x, y) => personText(x).localeCompare(personText(y)))];
      // Rebuilt when a name arrives too, so a row never keeps showing @handle.
      const shown = all.map((login) => `${login}=${login ? personText(login) : ''}`).join(',');
      if (shown !== rowsShown) {
        rowsShown = shown;
        rows.clear();
        for (const login of all) rows.set(login, row(login));
        list.replaceChildren(...all.map((login) => rows.get(login).label));
      }
      for (const [login, r] of rows) {
        r.box.checked = login === '' ? picked.length === 0 : picked.includes(login);
        r.n.textContent = counts ? String(login === '' ? counts[''] ?? 0 : counts[login] ?? 0) : '';
      }
      const what = picked.length === 0 ? allLabel : picked.length === 1 ? personText(picked[0]) : `${picked.length} people`;
      summary.replaceChildren(h('span', { class: 'label' }, 'Started by'), h('b', { class: 'who-what' }, what), h('span', { class: 'caret', 'aria-hidden': 'true' }, '▾'));
    }
    return { el, update };
  }

  window.Woodshed = {
    invite, providerWords: PROVIDER_WORDS, consoleName: CONSOLE_NAME, capitalised,
    h, person, personText, displayStatus, isLive, holdsTask, linePlace, lineText, waitsForRetry, isPrivate, statusBadge, planChip, duration, ref, issueUrl, prNumber, lastLine, fetchSessions, stopButton,
    appUrl, appAction, appButton, appChoices, appChoiceItems, runningAppLabel, setupAppToast, serversTitle, nav, isAdmin, consoleLinks: () => consoleLinks(meNow), userMenuSlot, sharedEmptyText, getJson, postJson, when, errorParts, confirmChange, pickedLogins, byQuery, peoplePicker,
    GROUPS, group, setupSteps, setupDone, setupCard, sameLogin, uniqueLogins, startedLine, assignedTo, needsYou, isUnassigned, ownerTag, isResumable, isPaused, PAUSE_REASON_RE, privateStopLine, pausesIn, deletedIn, ago, keptLine, resumeSharedButton, deleteSharedButton, sharedAction, stopSession, confirmStop, confirmDeleteShared,
    startProgress, clock, prChip, prChips, shownPrs, prLines, usageBadge, planUsageOf, planUsageFace, planUsageDetails, fmtBytes,
  };
})();
