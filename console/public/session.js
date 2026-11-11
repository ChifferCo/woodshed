// One session: the rail of every session on the left, and on the right the shed's pane: a bar with Agent, Terminal
// and Review tabs, what the work is on and the session's buttons, over claude's terminal, a plain shell in the repo,
// or the review. A terminal iframe is created once and kept across refreshes and tab switches, so neither drops
// what someone is typing, and the last few sessions' agent terminals stay loaded, hidden, so moving back to one is a
// show and not a load (terminalCache.js). On a phone,
// as in the shed, the rail is the sessions page and this page is the pane alone, with a back link and a key bar.
//
// Shared (/all) and My Woodshed (/) are this page too, the rail's two tabs, each a page of its own: /all shows the
// shared sessions (sharedHome.js) where a session's pane would be, and / the launcher (launcher.js). A session's page opens
// on the tab it belongs to. The rail's head carries the avatar menu, so My settings is a click away on every page.
//
// As in the shed, a card can be pinned to the top of its group, yours alone and kept by
// the console, and renamed for everyone who can see it. The palette, shortcuts and settings are shell.js's.
(function () {
  'use strict';
  const W = window.Woodshed;
  const { h } = W;
  const REFRESH_MS = 5000;
  // While the open session starts, so its checklist and clock move and the terminal opens as soon as claude does.
  const STARTING_REFRESH_MS = 1000;
  // Which page: /, /all or a session's. They are one page, so moving between them changes these, not the document
  // (navigate, below). /?new=1 is New session as a screen of its own on a phone, where / is the list alone.
  let id = null;
  let onMy = false;
  let onShared = false;
  let onNew = false;
  let picked = [];
  let tab = 'agent';
  function readRoute() {
    const { pathname, search } = window.location;
    const params = new URLSearchParams(search);
    id = pathname.startsWith('/s/') ? pathname.split('/').pop() : null;
    onMy = pathname === '/';
    onShared = pathname === '/all';
    onNew = onMy && params.get('new') === '1';
    picked = W.pickedLogins(search);
    // Agent is claude's terminal and the default; ?tab=terminal is the plain shell, ?tab=review the review, ?tab=diff
    // the plain diff and ?tab=applog the app's logs.
    const asked = params.get('tab');
    tab = ['review', 'terminal', 'diff', 'applog'].includes(asked) ? asked : 'agent';
    landOnReview = !asked;
  }
  // Set on each arrival at a page without a tab in its address: a review-only session then opens on its Review.
  let landOnReview = false;
  // The tabs that show a page of their own rather than a terminal: no key bar and no message box.
  const PAGE_TABS = new Set(['review', 'diff', 'applog']);
  readRoute();

  let data = null;
  let me = null;
  let pulls = [];
  let loadError = null;
  const launcher = W.createLauncher();
  const messageBox = W.createMessageBox();
  // Made the first time /all shows, which may be after a move from another of these pages.
  let sharedHome = null;

  // Moving between /, /all and a session's page draws the new one in place: the rail, its scroll and the pane's bar stay,
  // and nothing flashes while a new document loads. The address changes as a link's would, and Back returns.
  const SHELL_PATH_RE = /^\/(all|s\/[0-9a-f]{8})?$/;
  function navigate(href) {
    const url = new URL(href, window.location.href);
    if (url.origin !== window.location.origin || !SHELL_PATH_RE.test(url.pathname)) {
      window.location.href = url.href;
      return;
    }
    if (url.href !== window.location.href) window.history.pushState(null, '', url.pathname + url.search);
    moved();
  }
  function moved() {
    readRoute();
    closeCardMenu();
    if (onMy) launcher.applyQuery();
    render();
    refresh();
  }
  window.addEventListener('popstate', moved);
  // Every link to one of these pages, the rail's, the bar's ‹ and New session's among them. A new tab, a modifier
  // click or a link to anywhere else is the browser's.
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const link = e.target.closest?.('a[href]');
    if (!link || link.target || link.hasAttribute('download')) return;
    const url = new URL(link.href);
    if (url.origin !== window.location.origin || !SHELL_PATH_RE.test(url.pathname)) return;
    e.preventDefault();
    // New session while its screen is already open: say why nothing moves, or put the cursor in the prompt.
    // On a wide screen / shows the same launcher, so that counts as open too.
    if (link.classList.contains('rail-new') && (url.href === window.location.href || (onMy && launcher.el.offsetParent))) return launcher.nudge();
    navigate(url.href);
  });
  W.navigate = navigate;

  // Which tab: My Woodshed's on / and for a private session, Shared otherwise.
  // A session page whose session is not in the list yet (just started, the list not refreshed) keeps the view the
  // rail had, so Mine does not flash to Everyone and back. A shared session assigned to you is on both lists, so it
  // keeps the view it was opened from too.
  let lastRailMine = true;
  // Without sessions from GitHub (People) the console sends no shared session: the rail is Mine alone.
  function sharesShown() {
    return data?.shared !== false;
  }

  function railMine() {
    if (!sharesShown()) return (lastRailMine = true);
    if (onMy) lastRailMine = true;
    else if (onShared || !id) lastRailMine = false;
    else if (currentSession) lastRailMine = W.isPrivate(currentSession) || (lastRailMine && W.assignedTo(currentSession, data?.login));
    return lastRailMine;
  }

  function sessionHref(s) {
    return `/s/${s.id}${W.byQuery(picked)}`;
  }

  // Remove, as the shed has it: a stopped private session off the list, with the Claude home it kept for Resume.
  // @returns {Promise<boolean>}  whether it went
  async function removePrivate(s) {
    const stops = W.isLive(s) ? 'It is stopped first, its work pushed. ' : '';
    if (!window.confirm(`Remove “${s.title}”? ${stops}Its saved conversation goes, so Resume cannot reopen it. The branch stays on GitHub.`)) return false;
    try {
      await W.postJson(`/api/my/sessions/${s.id}/remove`, {});
    } catch (err) {
      window.alert(`Could not remove: ${err.message}`);
      return false;
    }
    // Its own page has nothing left to show.
    if (s.id === id) navigate('/');
    else refresh();
    return true;
  }

  function removeButton(s) {
    const button = h('button', {
      type: 'button', class: 'btn btn-quiet', title: 'Take it off the list. Its branch stays on GitHub',
      onclick: async (e) => {
        e.preventDefault();
        e.stopPropagation();
        button.disabled = true;
        if (!(await removePrivate(s))) button.disabled = false;
      },
    }, 'Remove');
    return button;
  }

  // Resume on a stopped private session: it opens on its page as it starts again. @returns {Promise<boolean>}
  async function resumePrivate(s) {
    try {
      const next = await W.postJson(`/api/my/sessions/${s.id}/resume`, {});
      navigate(`/s/${next.id}`);
      return true;
    } catch (err) {
      window.alert(`Could not resume: ${err.message}`);
      return false;
    }
  }

  async function resumeFromRow(s, row) {
    row.classList.add('is-busy');
    if (!(await resumePrivate(s))) row.classList.remove('is-busy');
  }

  // Resume, as the shed has it: a stopped private session again, on its branch, with claude's conversation.
  function resumeButton(s, small) {
    const button = h('button', {
      type: 'button', class: `btn btn-primary${small ? ' btn-sm' : ''}`, title: 'Start it again on its branch, with claude\'s conversation',
      onclick: async (e) => {
        e.preventDefault();
        e.stopPropagation();
        button.disabled = true;
        if (!(await resumePrivate(s))) button.disabled = false;
      },
    }, 'Resume');
    return button;
  }

  // Pins are the console's, per person; a change shows at once and the next refresh confirms it.
  function prefs() {
    return data?.viewPrefs ?? { pinned: [] };
  }

  function isPinned(s) {
    return prefs().pinned.includes(s.id);
  }

  async function setPref(path, body, apply) {
    if (data?.viewPrefs) apply(data.viewPrefs);
    render();
    try {
      data.viewPrefs = await W.postJson(path, body);
    } catch (err) {
      W.shell.toast(`Not saved: ${err.message}`);
    }
    refresh();
  }

  function setPinned(s, on) {
    return setPref(`/api/sessions/${s.id}/pin`, { on }, (p) => {
      p.pinned = on ? [...p.pinned.filter((x) => x !== s.id), s.id] : p.pinned.filter((x) => x !== s.id);
    });
  }

  // Rename, as the shed has it: a prompt, which works on a phone, rather than an editor the refresh would rebuild.
  async function rename(s) {
    const answer = window.prompt('Name this session:', s.title);
    if (answer === null) return;
    const title = answer.replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!title || title === s.title) return;
    try {
      await W.postJson(`/api/sessions/${s.id}/rename`, { title });
      W.shell.toast(`Renamed to ${title}`);
    } catch (err) {
      W.shell.toast(`Not renamed: ${err.message}`);
    }
    refresh();
  }

  const STAR = 'M5 1.1 L5.99 3.94 L8.99 4 L6.6 5.82 L7.47 8.7 L5 6.98 L2.53 8.7 L3.4 5.82 L1.01 4 L4.01 3.94 Z';
  function starButton(s) {
    const pinned = isPinned(s);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 10 10');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', STAR);
    svg.append(path);
    return h('button', {
      type: 'button', class: 'favstar', 'aria-pressed': String(pinned), 'aria-label': pinned ? 'Unpin this session' : 'Pin this session',
      title: pinned ? 'Pinned to the top of its group. Click to unpin.' : 'Pin to the top of its group. Only you see your pins, on every browser.',
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); setPinned(s, !pinned); },
    }, svg);
  }

  // How someone who can be assigned moves a shared session on from its card: take it, hand it over, or unassign it.
  function assignActions(s) {
    if (!data.assignable || W.isPrivate(s) || s.kind === 'ask') return [];
    const mine = W.sameLogin(s.assignee, data.login);
    return [
      !mine && { label: 'Assign to me', note: s.assignee ? `Take it from ${W.personText(s.assignee)}` : 'Nobody has it: take it', run: () => assignTo(s, data.login) },
      ...data.assignables.filter((l) => !W.sameLogin(l, data.login) && !W.sameLogin(l, s.assignee))
        .map((l) => ({ label: `Hand over to ${W.personText(l)}`, note: `@${l}`, run: () => assignTo(s, l) })),
      s.assignee && { label: 'Unassign', note: 'Nobody has it; anyone who can be assigned can take it', run: () => assignTo(s, null) },
    ].filter(Boolean);
  }

  // A card's ⋯ menu, after the shed's: what can be done to this session, each with what it does. Ending ones last.
  function cardActions(s) {
    const live = W.isLive(s);
    const stoppedPrivate = W.isPrivate(s) && s.status === 'stopped';
    const removable = W.isPrivate(s) && s.status !== 'stopping';
    const deletable = !s.owner && s.status !== 'stopping' && (live || s.kept);
    const gone = !s.owner && !live && !s.kept && s.status !== 'stopping';
    const open = (tabName) => () => { navigate(`/s/${s.id}${tabName ? `?tab=${tabName}` : ''}`); };
    return [
      stoppedPrivate && { label: 'Resume', note: 'Start it again on its branch, with claude\'s conversation', run: () => resumePrivate(s) },
      W.isResumable(s) && W.group(s) !== 'merged' && {
        label: 'Resume', note: 'Start it again where it was: its branch, databases and claude\'s conversation',
        run: async () => { await W.sharedAction(s, 'resume', { message: '' }).catch((err) => window.alert(`Could not resume: ${err.message}`)); refresh(); },
      },
      s.branch && { label: 'Review work', note: 'Read what this session did as a review, against the default branch', run: open('review') },
      s.prUrl && { label: `Open PR ${W.prNumber(s.prUrl)} ↗`, note: 'Its pull request on GitHub, in a new tab', run: () => window.open(s.prUrl, '_blank', 'noopener') },
      ...assignActions(s),
      { label: 'Rename…', note: 'Give it a new name, the one the rail and its page show', run: () => rename(s) },
      { label: isPinned(s) ? 'Unpin' : 'Pin', note: 'Keep it at the top of its group. Only you see your pins', run: () => setPinned(s, !isPinned(s)) },
      live && {
        label: 'Stop session', note: 'Commit and push its work, then stop it. Resume picks it up again', end: true,
        run: async () => {
          if (!W.confirmStop(s)) return;
          await W.stopSession(s.id).catch((err) => window.alert(`Could not stop: ${err.message}`));
          refresh();
        },
      },
      removable && {
        label: 'Remove', note: live ? 'Push its work, stop it and take it off the list, with its saved conversation. The branch stays on GitHub'
          : 'Take it off the list, with its saved conversation. The branch stays on GitHub', end: true, danger: true, run: () => removePrivate(s),
      },
      deletable && {
        label: 'Delete', note: live ? 'Push its work, stop it, and delete its conversation and databases. The branch stays on GitHub'
          : 'Delete its conversation and databases now. The branch stays on GitHub', end: true, danger: true,
        run: async () => {
          if (!W.confirmDeleteShared(s)) return;
          await W.sharedAction(s, 'delete').catch((err) => window.alert(`Could not delete: ${err.message}`));
          refresh();
        },
      },
      gone && {
        label: 'Remove', note: 'Take it off the list, for everyone. Its branch and pull request stay on GitHub', end: true, danger: true,
        run: async () => {
          if (!window.confirm(`Take “${s.title}” off the list for everyone? Its branch and pull request stay on GitHub.`)) return;
          try {
            await W.sharedAction(s, 'remove');
          } catch (err) {
            window.alert(`Could not remove: ${err.message}`);
            return refresh();
          }
          if (s.id === id) navigate('/');
          else refresh();
        },
      },
    ].filter(Boolean);
  }

  // One menu for every card, on the page itself: the rail is rebuilt on each refresh, and the menu stays open through
  // it, following its session by id. A session whose state changed underneath it closes it, since its items would be
  // stale. An action already running for a session is not started again. The top bar's Details and Data open it too,
  // each under its own key, so one closes as the other opens.
  const cardMenu = { el: h('div', { class: 'card-menu', role: 'menu', tabindex: '-1', hidden: true }), id: null, key: null, state: null };
  const acting = new Set();
  document.body.append(cardMenu.el);
  const menuState = (s) => `${s.status}:${s.kept}:${s.prUrl}:${isPinned(s)}:${s.app}:${s.branch}:${s.assignee ?? ''}`;
  // The card's ⋯, or on a phone's session page the top bar's: whichever of the two shows.
  const menuAnchor = () => (cardMenu.key
    ? [...document.querySelectorAll(`[data-menu-for="${cardMenu.key}"]`)].find((b) => b.offsetParent) ?? null : null);
  function closeCardMenu() {
    menuAnchor()?.setAttribute('aria-expanded', 'false');
    cardMenu.el.hidden = true;
    cardMenu.id = null;
    cardMenu.key = null;
  }
  function placeCardMenu(button) {
    const box = button.getBoundingClientRect();
    // Below the button, or above it when there is no room, and inside the window either way.
    const { width, height } = cardMenu.el.getBoundingClientRect();
    const top = box.bottom + 6 + height > window.innerHeight ? Math.max(8, box.top - 6 - height) : box.bottom + 6;
    cardMenu.el.style.top = `${top}px`;
    cardMenu.el.style.left = `${Math.max(8, Math.min(box.right - width, window.innerWidth - width - 8))}px`;
  }
  // `items` in place of the card's own actions, `extra` ahead of them, and `body` above them. An item's `group` is a
  // heading over it, shown when the menu holds more than one.
  function openCardMenu(button, s, { extra = [], items = null, body = null } = {}) {
    const key = button.dataset.menuFor;
    if (cardMenu.key === key) return closeCardMenu();
    closeCardMenu();
    const list = items ?? [...extra, ...cardActions(s)];
    const grouped = new Set(list.map((a) => a.group)).size > 1;
    // A line above the ending actions, between groups, and between the body and the first item.
    const needsSep = (a, i) => (i === 0 ? Boolean(a.end || body) : (a.end && !list[i - 1].end) || a.group !== list[i - 1].group);
    // Which session it is, for the phone's sheet, which covers the row it came from. A desktop's menu sits by its card.
    const head = h('div', { class: 'card-menu-head' }, h('b', null, s.title),
      h('span', null, `${W.displayStatus(s).word} · ${W.isPrivate(s) ? 'only you' : `@${s.startedBy}`}`));
    cardMenu.el.replaceChildren(head, ...[body].flat().filter(Boolean), ...list.map((a, i) => [
      needsSep(a, i) && h('div', { class: 'card-menu-sep', role: 'separator' }),
      grouped && a.group && a.group !== list[i - 1]?.group && h('div', { class: 'card-menu-group' }, a.group),
      h('button', {
        type: 'button', role: 'menuitem', class: `card-menu-item${a.danger ? ' is-danger' : ''}`,
        onclick: async () => {
          closeCardMenu();
          if (acting.has(s.id)) return;
          acting.add(s.id);
          try {
            await a.run();
          } finally {
            acting.delete(s.id);
          }
        },
      }, h('b', null, a.label), h('span', null, a.note)),
    ]).flat().filter(Boolean));
    cardMenu.el.hidden = false;
    placeCardMenu(button);
    cardMenu.id = s.id;
    cardMenu.key = key;
    cardMenu.state = menuState(s);
    button.setAttribute('aria-expanded', 'true');
    // Details with no branch has no item, so the menu itself takes the focus.
    (cardMenu.el.querySelector('button') ?? cardMenu.el).focus();
  }
  // After each refresh: the open menu sits on its session's new ⋯, or closes if that session is gone or changed.
  function syncCardMenu() {
    if (!cardMenu.id) return;
    const s = data.sessions.find((x) => x.id === cardMenu.id);
    const button = menuAnchor();
    if (!s || !button || menuState(s) !== cardMenu.state) return closeCardMenu();
    button.setAttribute('aria-expanded', 'true');
    placeCardMenu(button);
  }
  // Captured, so it runs before the click reaches anything. On a phone the sheet's shade is paint, not an element, and a
  // tap on it would land on the row beneath and open that session: there a tap outside only closes the sheet. On a
  // desktop a click elsewhere closes the menu and still does what it does.
  document.addEventListener('click', (e) => {
    if (cardMenu.el.hidden || cardMenu.el.contains(e.target)) return;
    if (narrow.matches) {
      e.preventDefault();
      e.stopPropagation();
      closeCardMenu();
      return;
    }
    if (!e.target.closest('[data-menu-for]')) closeCardMenu();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !cardMenu.el.hidden) closeCardMenu(); });
  window.addEventListener('resize', closeCardMenu);
  // A scroll that moves the card too, the rail's or the page's, which would leave the menu behind. Not the App log's
  // own scroll to its end every 3 s, which moves nothing the menu is anchored to.
  document.addEventListener('scroll', (e) => {
    if (!cardMenu.el.hidden && (e.target === document || slots.rail?.contains(e.target))) closeCardMenu();
  }, true);

  function menuButton(s) {
    return h('button', {
      type: 'button', class: 'rmenu', 'aria-haspopup': 'menu', 'aria-expanded': String(cardMenu.key === s.id), 'data-session': s.id, 'data-menu-for': s.id,
      'aria-label': `Actions for ${s.title}`, title: 'Actions',
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); openCardMenu(e.currentTarget, s); },
    }, '⋯');
  }

  // Pinned first, then as the console lists them.
  function pinnedFirst(list) {
    return [...list.filter(isPinned), ...list.filter((s) => !isPinned(s))];
  }

  // Private is told apart only where it sits beside an assigned shared session, so a rail of one's own stays quiet.
  function showOwnerTag(s) {
    if (!W.isPrivate(s)) return Boolean(s.assignee);
    return railMine() && data.sessions.some((o) => W.assignedTo(o, data.login));
  }

  // Assign, take it, hand over and unassign are for someone who can be assigned; the console checks, the page only offers them.
  async function assignTo(s, to) {
    try {
      await W.postJson(`/api/sessions/${s.id}/assign`, { to });
      W.shell.toast(to ? (W.sameLogin(to, data.login) ? 'It is yours' : `Handed to ${W.personText(to)}`) : 'Unassigned');
    } catch (err) {
      W.shell.toast(`Not assigned: ${err.message}`);
    }
    refresh();
  }

  function takeButton(s) {
    return h('button', {
      type: 'button', class: 'btn btn-primary btn-sm', title: 'Nobody has this session: take it',
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); e.currentTarget.disabled = true; assignTo(s, data.login); },
    }, 'Take it');
  }

  // The name on a card's line two, only where the card does not already say it: on Mine a shared session someone else
  // started, on Everyone one nobody has. Everyone names whoever has a session in its Assigned tag instead.
  function cardPerson(s) {
    if (W.isPrivate(s)) return null;
    if (railMine()) return W.sameLogin(s.startedBy, data.login) ? null : ['from ', W.person(s.startedBy)];
    return s.assignee ? null : ['from ', W.person(s.startedBy)];
  }

  // After the shed's rail: a card per session, its issue or PR on the right, a status line, and the app's button.
  // The card is not one link, since it holds a button: the title is the link, and a click anywhere else on the card
  // follows it too.
  function railCard(s) {
    const st = W.displayStatus(s);
    const pr = W.prNumber(s.prUrl);
    const live = W.isLive(s);
    const word = h('b', null, st.word.charAt(0).toUpperCase() + st.word.slice(1));
    const pauses = W.pausesIn(s, data);
    const ownPlan = !W.isPrivate(s) && s.plan && [' · ', h('span', { class: 'plan-mark', title: `Runs on ${W.personText(s.plan)}'s own Claude plan (@${s.plan})` }, '◆ own plan')];
    const starting = s.status === 'starting' && s.startedAt ? W.startProgress(s).current : null;
    const place = W.linePlace(s, data.sessions);
    const who = cardPerson(s);
    // Where the installation has more than one project, the card's left edge is its project's colour, and the name
    // is in the card's tooltip and its link's accessible name, so the colour is never all there is.
    const project = projectsShown() && s.project ? projectList().find((p) => p.name === s.project) ?? { name: s.project, color: null } : null;
    const sub = starting ? [word, ` · ${starting.short} · ${W.clock(s.startedAt)}`]
      : place ? [word, ` · ${W.lineText(place)}`]
      : live ? [word, who && [' · ', who], pauses && [' · ', h('span', { class: 'timer' }, pauses)], ownPlan]
      : W.isResumable(s) ? [word, ` · ${W.keptLine(s)}`, who && [' · ', who]]
        : W.isPrivate(s) ? [word, ` · ${W.privateStopLine(s, data.login)}`]
          : [word, who && [' · ', who]];
    const href = sessionHref(s);
    return h('div', {
      class: `rcard is-${st.key}${live ? '' : ' is-stopped'}${project ? ` has-project${project.color ? ` proj-${project.color}` : ''}` : ''}`,
      'aria-current': s.id === id ? 'true' : null,
      title: project ? `Project ${project.name}` : null,
      onclick: (e) => { if (!e.target.closest('a, button')) navigate(href); },
    },
      h('div', { class: 'rtop' },
        live ? h('span', { class: `status is-${st.key}` }, h('span', { class: 'dot', 'aria-hidden': 'true' })) : h('span', { class: `dot ring is-${st.key}`, 'aria-hidden': 'true' }),
        h('a', { class: 'rname', href, title: project ? `${s.title} · project ${project.name}` : s.title, 'aria-label': project ? `${s.title}, project ${project.name}` : null }, s.title),
        showOwnerTag(s) && W.ownerTag(s, { named: !railMine() }),
        h('span', { class: 'rmarks' }, starButton(s), menuButton(s))),
      h('div', { class: 'rsub' },
        h('span', { class: 'rsub-text' }, sub),
        pr ? W.prChip(s, { asLink: true }) : h('span', { class: `rref${s.kind === 'pr' ? ' is-pr' : ''}` }, W.ref(s)),
        W.isUnassigned(s) && data.assignable && takeButton(s),
        !live && W.isPrivate(s) && s.status === 'stopped' && resumeButton(s, true),
        W.isResumable(s) && W.group(s) !== 'merged' && W.resumeSharedButton(s, { small: true, onDone: refresh })));
  }

  // Which zones are folded is this viewer's own choice, kept in their browser when it lets us.
  const ZONES_KEY = 'woodshed-cloud-rail-zones';
  function readZones() {
    try {
      return JSON.parse(window.localStorage.getItem(ZONES_KEY) || '{}');
    } catch {
      return {};
    }
  }
  const folded = { needs: false, unassigned: false, active: false, stopped: true, merged: true, ended: true, ...readZones() };
  function toggleZone(key) {
    folded[key] = !folded[key];
    try {
      window.localStorage.setItem(ZONES_KEY, JSON.stringify(folded));
    } catch {
      // A private window keeps the choice for this page only.
    }
    render();
  }

  // The installation's projects, the default first, each with its colour key. A page kept from before the console sent
  // colours has the names alone.
  function projectList() {
    return (data.projects ?? []).map((p) => (typeof p === 'string' ? { name: p, color: null, default: false } : p));
  }
  function projectsShown() {
    return projectList().length > 1;
  }

  // The project the rail is filtered to, this viewer's own choice, kept in their browser when it lets us. One that
  // names a project the console no longer has is All.
  const PROJECT_KEY = 'woodshed-cloud-rail-project';
  let savedProject = null;
  try {
    savedProject = window.localStorage.getItem(PROJECT_KEY);
  } catch {
    // A private window starts on All.
  }
  function railProject() {
    if (!projectsShown()) return null;
    return window.WoodshedProjectColors.railProject({ saved: savedProject, names: projectList().map((p) => p.name) });
  }
  function pickProject(name) {
    savedProject = name;
    try {
      if (name) window.localStorage.setItem(PROJECT_KEY, name);
      else window.localStorage.removeItem(PROJECT_KEY);
    } catch {
      // A private window keeps the choice for this page only.
    }
    render();
  }

  // All, then a chip per project with its colour and how many of the sessions the rail shows are on it. They are the
  // legend of the cards' edges too. A rail with no sessions has nothing to filter.
  function projectChips(listed) {
    if (!projectsShown() || !listed.length) return null;
    const current = railProject();
    const counts = window.WoodshedProjectColors.countByProject(listed);
    const chip = (name, label, n, color) => h('button', {
      type: 'button', class: `proj-chip${color ? ` proj-${color}` : ''}`, 'aria-pressed': String(current === name), 'data-project': name ?? '',
      title: name ? `Only the sessions on ${name}` : 'Every project\'s sessions',
      onclick: () => pickProject(name),
    }, name && h('span', { class: 'proj-swatch', 'aria-hidden': 'true' }), label, h('span', { class: 'n' }, n));
    return h('div', { class: 'rail-projects', role: 'group', 'aria-label': 'Project' },
      chip(null, 'All', listed.length, null),
      projectList().map((p) => chip(p.name, p.name, counts[p.name] || 0, p.color)));
  }

  // Each zone's dot: the colour of what is in it, and a ring for what has stopped.
  const ZONE_DOTS = {
    active: 'dot zone-dot', working: 'dot zone-dot is-working', waiting: 'dot zone-dot is-waiting', finished: 'dot zone-dot is-finished',
    paused: 'dot ring is-paused', needs: 'dot zone-dot is-waiting', unassigned: 'dot zone-dot is-waiting',
  };

  function zone(key, title, sessions) {
    if (!sessions.length) return null;
    const open = !folded[key];
    return h('section', { class: `zone is-${key}-zone${open ? '' : ' is-folded'}` },
      h('button', { type: 'button', class: 'zone-head', 'aria-expanded': String(open), onclick: () => toggleZone(key) },
        h('span', { class: ZONE_DOTS[key] || 'dot ring', 'aria-hidden': 'true' }),
        h('span', null, title),
        h('span', { class: 'caret', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
        h('span', { class: 'count' }, sessions.length)),
      open && h('div', { class: 'zone-cards' }, pinnedFirst(sessions).map((s) => railCard(s))));
  }

  // One head for both views of the rail: Mine | Everyone, the people filter while Everyone shows, and New session, all
  // in one row. Built once and kept across renders, so the filter stays open through a refresh.
  let railFrame = null;
  function railHead(logins) {
    if (!railFrame) {
      const picker = W.peoplePicker((next) => {
        picked = next;
        const url = new URL(window.location.href);
        if (picked.length) url.searchParams.set('by', picked.join(','));
        else url.searchParams.delete('by');
        // URLSearchParams would write the commas as %2C.
        window.history.replaceState(null, '', `${url.pathname}${url.search.replace(/%2C/g, ',')}`);
        render();
      }, { allLabel: 'People' });
      railFrame = {
        picker,
        mine: h('a', { class: 'rail-seg-link', href: '/' }, 'Mine'),
        everyone: h('a', { class: 'rail-seg-link' }, 'Everyone'),
        slots: h('span', { class: 'rail-slots' }),
      };
      railFrame.add = h('a', { class: 'rail-new', href: '/?new=1', 'data-keys': 'new' }, '+ New session', railFrame.slots);
      railFrame.seg = h('div', { class: 'rail-seg', role: 'group', 'aria-label': 'Whose sessions' }, railFrame.mine, railFrame.everyone);
      railFrame.only = h('b', { class: 'rail-only' }, 'My sessions');
      railFrame.el = h('div', { class: 'rail-head' }, railFrame.seg, railFrame.only, picker.el, railFrame.add);
    }
    railFrame.seg.hidden = !sharesShown();
    railFrame.only.hidden = sharesShown();
    // A switch's own page is marked as the one open only there; on a session's page it is the view the session belongs to.
    railFrame.everyone.setAttribute('href', `/all${W.byQuery(picked)}`);
    railFrame.everyone.setAttribute('aria-current', onShared ? 'page' : !railMine() ? 'true' : 'false');
    railFrame.mine.setAttribute('aria-current', onMy ? 'page' : railMine() ? 'true' : 'false');
    // The people filter belongs to Everyone: each person's shared sessions, as the old Shared page's dropdown showed them.
    railFrame.picker.el.hidden = railMine();
    if (!railMine()) {
      const shared = data.sessions.filter((s) => !W.isPrivate(s));
      const counts = { '': shared.length };
      for (const s of shared) if (s.assignee) counts[s.assignee] = (counts[s.assignee] || 0) + 1;
      railFrame.picker.update({ logins, picked, counts });
    }
    slotsOnButton();
    return railFrame.el;
  }

  // Mine's slots ride on New session. Everyone's row has no room, so the team's count is in the tooltip.
  function slotsOnButton() {
    const mine = railMine();
    const text = mine ? `${runningMine()}/${data.maxPrivate}` : `${data.running}/${data.maxRunning}`;
    const waiting = mine ? waitingMine() : data.queued;
    railFrame.slots.textContent = mine ? text : '';
    railFrame.slots.hidden = !mine;
    railFrame.add.dataset.hint = `New session. ${text} running${waiting ? `, ${waiting} waiting` : ''}.`;
  }

  // The user menu sits at the foot of the rail and opens upward. It is mounted once in layout(), never inside the part
  // each refresh replaces, so the menu keeps its focus through a refresh.
  let railUser = null;
  function railUserFoot() {
    railUser ??= h('div', { class: 'rail-user' }, W.userMenuSlot());
    return railUser;
  }

  // Your session on a pull request's branch in its repo, as the shed finds one: a live one first, then a stopped one.
  // A session or row from before projects is on the default project.
  function sessionOnBranch(branch, project) {
    if (!branch) return null;
    const main = projectList().find((p) => p.default)?.name ?? null;
    const on = (x) => (x ?? main) === (project ?? main);
    const mineOn = data.sessions.filter((s) => W.isPrivate(s) && s.branch === branch && on(s.project));
    return mineOn.find(W.isLive) ?? mineOn.find((s) => s.status === 'stopped') ?? null;
  }

  // The shed's third group: your open pull requests on every repo you may start on, and those waiting on your review.
  // Each opens your session on its branch, resumes a stopped one, or starts a new one. The rail's project filter
  // applies to them as to the sessions.
  function pullsZone(onProject) {
    const main = projectList().find((p) => p.default)?.name ?? null;
    const listed = onProject ? pulls.filter((p) => (p.project ?? main) === onProject) : pulls;
    if (!listed.length) return null;
    const open = !folded.pulls;
    const marked = projectsShown();
    // Two lines: the title and its checks' dot, then the repo and number, the checks and how long since it moved, with
    // what to do with it at the end, as a session card has its Resume.
    const checksOf = (p) => {
      const c = p.checks;
      if (!c) return { key: 'none', text: p.draft ? 'draft · no checks' : 'no checks' };
      if (c.fail) return { key: 'fail', text: `${c.fail} failing` };
      if (c.pending) return { key: 'pending', text: `${c.pass}/${c.total} checks` };
      return { key: 'pass', text: 'all green' };
    };
    const row = (p) => {
      const project = p.project ?? main;
      const found = sessionOnBranch(p.branch, project);
      const live = found && W.isLive(found);
      const checks = checksOf(p);
      const color = marked ? projectList().find((x) => x.name === project)?.color : null;
      const isDefault = !p.project || p.project === main;
      const startHref = `/?new=1&on=${encodeURIComponent(`PR #${p.number}`)}${isDefault ? '' : `&project=${encodeURIComponent(project)}`}`;
      const action = live
        ? h('a', { class: 'btn btn-sm btn-open', href: `/s/${found.id}`, title: `${found.title} is on this branch: open it` },
          h('span', { class: 'dot app-dot', 'aria-hidden': 'true' }), 'Open')
        : found
          ? h('button', {
            type: 'button', class: 'btn btn-sm btn-open', title: `${found.title} is on this branch, stopped: resume it`,
            onclick: (e) => resumeFromRow(found, e.currentTarget.closest('.prow')),
          }, 'Resume')
          : h('a', {
            class: 'btn btn-sm btn-plain', href: startHref,
            title: p.why === 'review' ? 'Waiting on your review: start a session on it' : 'Yours: start a session on it',
          }, 'Start');
      const ref = marked ? `${project} #${p.number}` : `#${p.number}`;
      return h('div', { class: `prow${marked ? ` has-project${color ? ` proj-${color}` : ''}` : ''}`, title: marked ? `${project}: ${p.title}` : p.title },
        h('div', { class: 'prow-top' },
          h('span', { class: 'prow-title' }, p.title),
          h('span', { class: `prow-dot is-${checks.key}`, 'aria-hidden': 'true' })),
        h('div', { class: 'prow-sub' },
          h('span', { class: 'prow-text' },
            marked ? [h('span', { class: 'prow-repo' }, project), ` #${p.number}`] : h('span', { class: 'prow-num' }, `#${p.number}`),
            ' · ', h('span', { class: `prow-checks is-${checks.key}` }, checks.text), p.updatedAt && ` · ${W.ago(p.updatedAt)}`),
          action,
          h('a', {
            class: 'prow-gh', href: W.issueUrl(p.repo ?? data.repo, { kind: 'pr', number: p.number }), target: '_blank', rel: 'noopener',
            'aria-label': `${ref} on GitHub`, title: 'Open it on GitHub',
          }, '↗')));
    };
    // Yours, and everything else a person is asked to look at, so no row the header counts goes unshown.
    const group = (mine, label) => {
      const rows = listed.filter((p) => (p.why === 'yours') === mine);
      return rows.length ? [h('div', { class: 'prow-group' }, `${label} · ${rows.length}`), rows.map(row)] : null;
    };
    return h('section', { class: `zone is-pulls-zone${open ? '' : ' is-folded'}` },
      h('button', { type: 'button', class: 'zone-head', 'aria-expanded': String(open), onclick: () => toggleZone('pulls') },
        h('span', null, 'Pull requests'),
        h('span', { class: 'caret', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
        h('span', { class: 'count' }, listed.length)),
      open && h('div', { class: 'zone-cards' }, group(true, 'Yours'), group(false, 'Review requested')));
  }

  // The phone's Shared status chips, on ?status= as the desktop's filter is, though All is theirs when none is named.
  function railStatus() {
    const asked = new URLSearchParams(window.location.search).get('status');
    return asked && (asked === 'all' || W.GROUPS.some((g) => g.key === asked)) ? asked : 'all';
  }
  function setRailStatus(next) {
    const url = new URL(window.location.href);
    url.searchParams.set('status', next);
    // URLSearchParams would write the commas of ?by= as %2C.
    window.history.replaceState(null, '', `${url.pathname}${url.search.replace(/%2C/g, ',')}`);
    render();
  }
  function statusChips(listed, status) {
    const chip = (key, label, n) => h('button', {
      type: 'button', class: 'rail-chip', 'aria-pressed': String(status === key), onclick: () => setRailStatus(key),
    }, label, n !== null && h('span', { class: 'n' }, n));
    return h('div', { class: 'rail-chips', role: 'group', 'aria-label': 'Status' },
      chip('all', 'All', listed.length),
      W.GROUPS.map((g) => {
        const n = listed.filter((s) => W.group(s) === g.key).length;
        return (n || status === g.key) && chip(g.key, g.title, n);
      }));
  }

  // On Mine, the setup card while anything is missing.
  function setupNotice() {
    return me && railMine() && !W.setupDone(me) ? W.setupCard(me, { compact: true }) : null;
  }

  // Mine is your private sessions and the shared ones assigned to you; Everyone is every shared session, with the ones
  // nobody has first.
  function railListing() {
    if (railMine()) return data.sessions.filter((s) => W.isPrivate(s) || W.assignedTo(s, data.login));
    return data.sessions.filter((s) => !W.isPrivate(s) && (picked.length === 0 || picked.some((l) => W.sameLogin(l, s.assignee))));
  }

  function railBody() {
    const all = railListing();
    const onProject = railProject();
    const listed = onProject ? all.filter((s) => s.project === onProject) : all;
    const emptyText = all.length && onProject ? `No sessions on ${onProject} here. All shows the other projects'.`
      : railMine() ? 'No sessions yet. Start one with New session.' : W.sharedEmptyText(picked);
    const empty = !listed.length && h('p', { class: 'rail-empty' }, emptyText);
    // On a phone the rail is the Shared page, so its status filter is chips above the list; a desktop has the
    // filter in the pane beside it and shows every group.
    const status = !railMine() && narrow.matches ? railStatus() : 'all';
    // Mine: stopped sessions that wait on you (paused at a limit, or stopped mid-wait), then every live session with the
    // ones waiting on you first (their card says so), then the shared ones whose pull request is in Slack, then the rest
    // that stopped.
    // Everyone: what nobody has, then the shed's groups.
    const unassigned = railMine() ? [] : listed.filter(W.isUnassigned);
    const rest = railMine() ? listed : listed.filter((s) => !W.isUnassigned(s));
    const zones = railMine()
      ? [zone('needs', 'Needs you', rest.filter((s) => !W.isLive(s) && W.needsYou(s)).sort((a, b) => Date.parse(b.stoppedAt ?? b.createdAt) - Date.parse(a.stoppedAt ?? a.createdAt))),
        zone('active', 'Active', rest.filter(W.isLive).sort((a, b) => Number(W.needsYou(b)) - Number(W.needsYou(a)))),
        zone('finished', 'Finished', rest.filter((s) => W.group(s) === 'finished')),
        zone('stopped', 'Stopped', rest.filter((s) => !W.isLive(s) && !W.needsYou(s) && W.group(s) !== 'finished'))]
      : [zone('unassigned', 'Unassigned', unassigned),
        ...W.GROUPS.filter((g) => status === 'all' || g.key === status).map((g) => zone(g.key, g.title, rest.filter((s) => W.group(s) === g.key)))];
    return [
      projectChips(all),
      !railMine() && statusChips(listed, status),
      h('div', { class: 'rail-list' },
        setupNotice(),
        empty,
        zones,
        railMine() && pullsZone(onProject)),
    ].filter(Boolean);
  }

  function runningMine() {
    return data.sessions.filter((s) => s.owner === data.login && W.holdsTask(s)).length;
  }

  function waitingMine() {
    return data.sessions.filter((s) => s.owner === data.login && s.status === 'queued' && !W.waitsForRetry(s)).length;
  }

  // ⌘. hides the rail, as the shed's; this browser remembers it.
  const RAIL_KEY = 'woodshed-cloud-rail-hidden';
  let railHidden = false;
  try {
    railHidden = window.localStorage.getItem(RAIL_KEY) === '1';
  } catch {
    // A private window shows it.
  }
  function toggleRail() {
    railHidden = !railHidden;
    remember(RAIL_KEY, railHidden ? '1' : '0');
    render();
  }

  // What the palette lists and does: every session on the page, and each one's actions after Tab.
  function paletteSessions() {
    if (!data) return [];
    const listed = pinnedFirst(data.sessions);
    return listed.map((s) => ({
      id: s.id, title: s.title, branch: s.branch, live: W.isLive(s), href: sessionHref(s),
      meta: W.isPrivate(s) ? 'only you' : W.displayStatus(s).word,
    }));
  }

  function paletteActions(item) {
    const s = data.sessions.find((x) => x.id === item.id);
    if (!s) return [];
    const open = (tabName) => () => { navigate(`/s/${s.id}${tabName ? `?tab=${tabName}` : ''}`); };
    return [
      { group: 'Session', label: 'Open the agent', run: open('') },
      s.status === 'running' && s.hasShell && { group: 'Session', label: 'Open the terminal', run: open('terminal') },
      s.status === 'running' && s.hasShell && W.isPrivate(s) && { group: 'Session', label: 'Sign in for Remote Control', run: () => claudeLogin(s) },
      s.status === 'running' && data.appDomain && W.isPrivate(s) && { group: 'App', label: 'Share the app…', run: () => W.shareApp(s) },
      s.branch && { group: 'Session', label: 'Open the review', run: open('review') },
      { group: 'Session', label: 'Rename it', run: () => rename(s) },
      { group: 'Session', label: isPinned(s) ? 'Unpin it' : 'Pin it', run: () => setPinned(s, !isPinned(s)) },
      s.prUrl && { group: 'Elsewhere', label: 'Open its pull request ↗', run: () => window.open(s.prUrl, '_blank', 'noopener') },
      (s.status === 'running' || s.status === 'starting' || s.status === 'queued') && {
        group: 'Danger', label: 'Stop it', danger: true,
        run: async () => {
          if (!W.confirmStop(s)) return;
          try {
            await W.postJson(`/api/sessions/${s.id}/stop`, {});
          } catch (err) {
            W.shell.toast(`Not stopped: ${err.message}`);
          }
          refresh();
        },
      },
    ].filter(Boolean);
  }

  W.shell.register({
    sessions: paletteSessions, actions: paletteActions, toggleRail, railShown: () => !railHidden,
  });

  // What a phone's top bar puts in its ⋯ ahead of the card's: the app, the databases, and the key bar's switch.
  function paneActions(s) {
    if (s.status !== 'running') return [];
    const app = (action) => async () => {
      await W.appAction(s, action).catch((err) => window.alert(`Could not ${action} the app: ${err.message}`));
      refresh();
    };
    const up = s.app === 'running' || s.app === 'api-down';
    const busy = s.app === 'starting' || s.app === 'stopping';
    return [
      s.hasShell && W.isPrivate(s) && {
        group: 'Claude', label: 'Sign in for Remote Control', note: 'Asks claude for /woodshed:remote-control: open the link it shows and paste the code in the chat', run: () => claudeLogin(s),
      },
      data.appDomain && up && { group: 'App', label: 'Open app ↗', note: 'The app in this session, in a new tab', run: () => window.open(W.appUrl(s, data.appDomain), '_blank', 'noopener') },
      data.appDomain && !up && !busy && {
        group: 'App', label: s.app === 'failed' || s.app === 'frontend-down' ? 'Start app again' : 'Start app',
        note: 'Start the app in this session: one to three minutes', run: app('start'),
      },
      data.appDomain && (up || s.app === 'starting' || s.app === 'frontend-down') && { group: 'App', label: 'Stop app', note: 'Stop the app\'s backend and frontend', run: app('stop') },
      data.appDomain && W.isPrivate(s) && { group: 'App', label: 'Share the app…', note: 'Let members, or anyone with a link, open the app', run: () => W.shareApp(s) },
      data.appDomain && s.editor && { group: 'Code', label: 'Editor ↗', note: 'Its checkout in VS Code, in a new tab', run: () => openEditor(s) },
      ...dataActions(s),
      !PAGE_TABS.has(tab) && {
        label: keyBarShown ? 'Hide the key bar' : 'Show the key bar', note: 'esc, the arrows, tab and ^C above the terminal', run: toggleKeyBar,
      },
    ].filter(Boolean);
  }

  // Remote Control needs a login of its own, which woodshed-login makes. claude's /woodshed:remote-control runs it in the
  // conversation; a session from an older image gets it typed at the Terminal tab. The answer says which tab to open.
  async function claudeLogin(s) {
    try {
      const res = await fetch(`/api/sessions/${s.id}/claude-login`, { method: 'POST', headers: { 'x-woodshed': '1' } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `sign in answered ${res.status}`);
      navigate(body.where === 'agent' ? `/s/${s.id}` : `/s/${s.id}?tab=terminal`);
    } catch (err) {
      window.alert(`Could not start the sign-in: ${err.message}`);
    }
  }

  // VS Code on the checkout, on the session's app name, never the console's (console/editorProxy.mjs).
  function editorUrl(s) {
    return `${W.appUrl(s, data.appDomain)}__woodshed/code/`;
  }

  function openEditor(s) {
    window.open(editorUrl(s), '_blank', 'noopener');
  }

  // The session's databases and Redis, each in its viewer: a shared session's own, a private session's owner's. Only
  // the viewers of the databases the installation hosts (data.viewers, each engine's), and Redis only when the project
  // uses it (statusd's `redis`).
  function dataActions(s) {
    if (s.status !== 'running') return [];
    const whose = W.isPrivate(s) ? 'Your own' : 'This session\'s own';
    const open = (path) => () => window.open(`/${path}/${s.id}/`, '_blank', 'noopener');
    return [
      ...(data.viewers ?? []).map((v) => ({ group: 'Data', label: `${v.name} ↗`, note: `${whose} ${v.name} database, in ${v.program}`, run: open(v.route) })),
      s.redis !== false && { group: 'Data', label: 'Redis ↗', note: `${whose} Redis, in redis-commander`, run: open('redis') },
    ].filter(Boolean);
  }

  // What the bar used to spell out beside the name: the branch, who started it and how, how long, whose Claude, and
  // who can see it.
  function sessionDetails(s) {
    const trigger = s.trigger === 'label' ? `with the ${data.label} label` : s.trigger === 'comment' ? 'with a /woodshed comment'
      : s.trigger === 'my-woodshed' ? 'from My Woodshed' : s.trigger === 'slack' ? 'with a question in Slack'
        : s.trigger === 'qa' ? 'with the QA label, to test the pull request' : 'from the console';
    const claude = W.isPrivate(s) ? 'Your own Claude plan' : s.plan ? `${W.personText(s.plan)}'s own Claude plan` : 'The team\'s Anthropic key';
    const row = (term, value) => value && [h('dt', null, term), h('dd', null, value)];
    return h('dl', { class: 'card-menu-dl' },
      row('Branch', s.branch),
      row('Started by', `${W.personText(s.startedBy)}, ${trigger}`),
      row(W.isLive(s) ? 'Running for' : 'Ran for', s.startedAt && W.duration(s.startedAt, s.stoppedAt)),
      row('Runs on', claude),
      !W.isPrivate(s) && s.kind !== 'ask' && row('Assigned to', assignedLine(s)),
      row('Visible to', W.isPrivate(s) ? 'Only you' : 'Everyone on the console'));
  }

  // Who has a shared session and how they got it: by the label, a /woodshed comment, taking it, or a hand over.
  function assignedLine(s) {
    if (!s.assignee) return 'Nobody';
    const how = { label: 'by the label', comment: 'by a /woodshed comment', console: 'from the console', 'take it': 'took it', 'hand over': `handed over by ${W.personText(s.assignedBy)}` }[s.assignedHow];
    return [W.personText(s.assignee), how, s.assignedAt && W.ago(s.assignedAt)].filter(Boolean).join(', ');
  }

  function copyBranch(s) {
    return {
      label: 'Copy branch name', note: 'To check it out somewhere else',
      run: async () => {
        try {
          await navigator.clipboard.writeText(s.branch);
          W.shell.toast('Branch name copied');
        } catch (err) {
          W.shell.toast(`Not copied: ${err.message}`);
        }
      },
    };
  }

  // Invite an engineer: a link that opens New session on this session's PR, or on its branch once GitHub has it. Whether
  // GitHub has the branch is read from the review call, at most every 15 seconds while it has not.
  const inviteChecks = new Map();
  const INVITE_RECHECK_MS = 15_000;
  function inviteCheck(s) {
    const key = `${s.id}:${s.branch}`;
    const known = inviteChecks.get(key);
    if (known?.loading || known?.pushed || (known && Date.now() - known.at < INVITE_RECHECK_MS)) return known;
    const entry = { pushed: known?.pushed ?? null, at: Date.now(), loading: true };
    inviteChecks.set(key, entry);
    W.getJson(`/api/sessions/${s.id}/review`)
      .then((r) => ({ pushed: r.base !== s.branch }))
      .catch((err) => ({ pushed: /^GitHub has no /.test(err.message) ? false : null }))
      .then((result) => {
        const changed = result.pushed !== entry.pushed;
        inviteChecks.set(key, { ...result, at: Date.now(), loading: false });
        if (changed && currentSession?.id === s.id) slots.head?.replaceChildren(paneBar(s));
      });
    return entry;
  }

  function inviteButton(s) {
    const target = W.invite.inviteTarget(s, W.isPrivate(s) && !s.prUrl && s.branch ? inviteCheck(s) : { pushed: null });
    const ready = target.state === 'pr' || target.state === 'branch';
    return h('button', {
      type: 'button', class: `pbtn${ready ? '' : ' is-off'}`, 'aria-disabled': String(!ready),
      title: ready ? `Copies a link that opens New session on ${target.on}, as the engineer's own private session on their own Claude. Yours stays private: the link holds nothing of it`
        : target.state === 'checking' ? 'Checking whether GitHub has the branch…' : 'GitHub has no pull request or branch for this session yet: it pushes when it commits and when it stops',
      onclick: async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!ready) return W.shell.toast(target.state === 'checking' ? 'Still checking whether GitHub has the branch' : 'Nothing to link yet: push the branch first');
        try {
          await navigator.clipboard.writeText(W.invite.inviteUrl(window.location.origin, target.on, document.querySelector('meta[name="woodshed-link-query"]')?.content || null));
          W.shell.toast(`Link copied: opens New session on ${target.on}`);
        } catch (err) {
          W.shell.toast(`Not copied: ${err.message}`);
        }
      },
    }, W.invite.inviteLabel(target));
  }

  // A bar button that opens the page's one menu under its own key.
  function barMenuButton(s, { key, label, title, open, className = '' }) {
    const menuKey = `${s.id}:${key}`;
    return h('button', {
      type: 'button', class: `pbtn${className ? ` ${className}` : ''}`, 'aria-haspopup': 'menu', 'aria-expanded': String(cardMenu.key === menuKey), 'data-menu-for': menuKey, title,
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); openCardMenu(e.currentTarget, s, open()); },
    }, label);
  }

  // The owner's plan, beside the container's CPU and memory; the detail opens under it.
  function planButton(s, plan) {
    const face = W.planUsageFace(plan);
    return barMenuButton(s, {
      key: 'plan', label: face.nodes, className: `pplan${face.level ? ` is-${face.level}` : ''}`,
      title: 'How much of your Claude plan is used, and when it resets',
      open: () => ({ body: W.planUsageDetails(W.planUsageOf(s, data.sessions) ?? plan), items: [] }),
    });
  }

  // After the shed's pane bar: the tabs, the name and how it is doing, what it is on, then the session's buttons. The
  // rest is under Details, and the app's button shows only when the rail card holding it does not.
  function paneBar(s) {
    const pr = W.prNumber(s.prUrl);
    const tabButton = (key, label, disabledWhy) => h('button', {
      type: 'button',
      class: 'ptab',
      role: 'tab',
      'aria-selected': String(tab === key),
      disabled: Boolean(disabledWhy),
      title: disabledWhy || null,
      onclick: () => setTab(key),
    }, label);
    const typing = s.status === 'running' && !PAGE_TABS.has(tab);
    // A question from Slack reads the default branch: it has no branch, app or databases of its own.
    const tools = s.status === 'running' && s.kind !== 'ask';
    const plan = s.status === 'running' ? W.planUsageOf(s, data.sessions) : null;
    return h('div', { class: 'pane-bar' },
      h('a', { class: 'pback', href: railMine() ? '/' : `/all${W.byQuery(picked)}`, 'aria-label': 'Back to sessions' }, '‹'),
      // A phone's two rows: the name over one line of its state, its PR and its usage, with ⋯ for the rest.
      h('div', { class: 'pphone' },
        h('b', { class: 'pphone-title', title: s.title }, s.title),
        h('span', { class: 'pphone-meta' }, W.statusBadge(s), pr && W.prChip(s, { asLink: true }), W.usageBadge(s))),
      h('button', {
        type: 'button', class: 'pmore', 'aria-haspopup': 'menu', 'aria-expanded': String(cardMenu.key === `${s.id}:phone`), 'data-menu-for': `${s.id}:phone`,
        'aria-label': `Actions for ${s.title}`, title: 'Actions',
        onclick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          openCardMenu(e.currentTarget, s, { body: [h('div', { class: 'card-menu-group' }, 'Details'), sessionDetails(s), plan && W.planUsageDetails(plan)], extra: paneActions(s) });
        },
      }, '⋯'),
      typing && h('button', {
        type: 'button', class: 'pkeys', title: 'Show or hide the key bar', 'aria-pressed': String(keyBarShown), onclick: toggleKeyBar,
      }, '⌨'),
      h('div', { class: 'ptabs', role: 'tablist', 'aria-label': 'View' },
        tabButton('agent', 'Agent'),
        tabButton('terminal', 'Terminal', s.status !== 'running' ? 'The shell is there while the session runs'
          : s.hasShell ? null : 'This session started from an image without the Terminal tab: a new session has it'),
        tabButton('review', 'Review', s.branch ? null : s.kind === 'ask' ? 'A question from Slack changes no code' : 'This session has no branch yet, so there is nothing to review'),
        tabButton('diff', 'Diff', s.kind === 'ask' ? 'A question from Slack changes no code'
          : s.status === 'running' ? null : 'The diff is read from the session while it runs: Review shows what it pushed'),
        tabButton('applog', 'App log', tools ? null : s.kind === 'ask' ? 'A question from Slack runs no app' : 'The app\'s logs are there while the session runs')),
      h('button', { type: 'button', class: 'ptitle', title: `${s.title}\nClick to rename it`, 'aria-label': `Rename ${s.title}`, onclick: () => rename(s) },
        h('span', { class: 'ptitle-text' }, s.title), h('span', { class: 'prename', 'aria-hidden': 'true' }, '✎')),
      W.statusBadge(s),
      s.number && h('a', { class: 'pref', href: W.issueUrl(data.repo, s), target: '_blank', rel: 'noopener', title: s.kind === 'pr' ? 'Open the pull request' : 'Open the issue' }, W.ref(s)),
      pr && s.kind !== 'pr' && W.prChip(s, { asLink: true }),
      barMenuButton(s, {
        key: 'details', label: 'Details ▾', title: 'Its branch, who started it, how long it has run, whose Claude it runs on and who can see it',
        open: () => ({ body: sessionDetails(s), items: s.branch ? [copyBranch(s)] : [] }),
      }),
      h('div', { class: 'pright' },
        W.isPrivate(s) && s.kind !== 'ask' && s.branch && inviteButton(s),
        plan && planButton(s, plan),
        W.usageBadge(s),
        s.kind !== 'ask' && W.appButton(s, { appDomain: data.appDomain, onDone: refresh, small: true }),
        tools && data.appDomain && s.editor && h('a', { class: 'pbtn', href: editorUrl(s), target: '_blank', rel: 'noopener', title: 'Open its checkout in VS Code, in a new tab' }, 'Editor ↗'),
        tools && dataActions(s).length > 0 && barMenuButton(s, {
          key: 'data', label: 'Data ▾', title: 'Open its databases or Redis in a viewer', open: () => ({ items: dataActions(s) }),
        }),
        (s.status === 'queued' || s.status === 'starting' || s.status === 'running') && W.stopButton(s, refresh, { label: 'Stop session' }),
        W.isResumable(s) && W.resumeSharedButton(s, { small: true, onDone: refresh })));
  }

  // The phone's key bar, after the shed's: what an on-screen keyboard lacks and claude's TUI needs. Keys go to the
  // terminal frame's xterm as input, which reaches the session without focusing the terminal, so the phone's
  // keyboard stays down. The shed sends them through tmux instead; here the frame is same-origin, so it needs no
  // route. Phone only: the CSS hides the bar and its switch on a wider screen.
  const KEYS = [
    ['esc', '\x1b'], ['↑', null, 'A'], ['↓', null, 'B'],
    ['tab', '\t'], ['⇧tab', '\x1b[Z'], ['⏎', '\r'], ['^C', '\x03'],
  ];
  const TERM_SCALE_KEY = 'woodshed-cloud-term-scale';
  const KEY_BAR_KEY = 'woodshed-cloud-key-bar';
  const TERM_SCALE_MIN = 0.5;
  const TERM_SCALE_MAX = 1;
  let termScale = 0.7;
  let keyBarShown = true;
  try {
    const saved = parseFloat(window.localStorage.getItem(TERM_SCALE_KEY));
    if (saved >= TERM_SCALE_MIN && saved <= TERM_SCALE_MAX) termScale = saved;
    keyBarShown = window.localStorage.getItem(KEY_BAR_KEY) !== 'off';
  } catch {
    // A private window keeps the defaults.
  }

  function remember(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // As above.
    }
  }

  function sendKey(seq, arrow) {
    const frame = (tab === 'terminal' ? shellPool : agentPool).frameOf(currentSession);
    const term = frame?.contentWindow?.term;
    if (!term) return;
    // An arrow is ESC O A once the program has asked for application cursor keys, as claude's TUI does.
    const data = arrow ? `\x1b${term.modes?.applicationCursorKeysMode ? 'O' : '['}${arrow}` : seq;
    term.input(data, true);
  }

  function zoom(delta) {
    termScale = Math.min(TERM_SCALE_MAX, Math.max(TERM_SCALE_MIN, Math.round((termScale + delta) * 10) / 10));
    remember(TERM_SCALE_KEY, String(termScale));
    applyTermScale();
    renderKeyBar(currentSession);
  }

  function applyTermScale() {
    slots.body.style.setProperty('--term-scale', String(termScale));
    slots.plain.style.setProperty('--term-scale', String(termScale));
  }

  function toggleKeyBar() {
    keyBarShown = !keyBarShown;
    remember(KEY_BAR_KEY, keyBarShown ? 'on' : 'off');
    render();
  }

  function renderKeyBar(s) {
    const show = Boolean(s) && s.status === 'running' && !PAGE_TABS.has(tab) && keyBarShown;
    slots.keys.hidden = !show;
    if (!show) return slots.keys.replaceChildren();
    const key = (label, onclick, title, disabled) => h('button', { type: 'button', title, disabled, onclick }, label);
    slots.keys.replaceChildren(
      ...KEYS.map(([label, seq, arrow]) => key(label, () => sendKey(seq, arrow))),
      key('A−', () => zoom(-0.1), 'Smaller type, more columns', termScale <= TERM_SCALE_MIN),
      key('A+', () => zoom(0.1), 'Larger type, fewer columns', termScale >= TERM_SCALE_MAX));
  }

  // The shell's keys, and the shed's terminal (terminal.js): copy out, links, pictures, files and swipe.
  function bindTerminal(frame, sessionId, pane) {
    W.shell.bindFrame(frame);
    W.terminal.bind(frame, { session: sessionId, pane });
  }

  // The terminals kept loaded, by session and start, so a Resume (same id, new container) gets a fresh one. One pool
  // for the Agent tab and one for the Terminal tab's shell: a session's first open pays the load, every later one is
  // free. A frame is only ever mounted visible,
  // never hidden to warm it: with no box to measure, xterm makes ttyd attach tmux at 80x24 and tmux shrinks the
  // window for every other client of the session.
  const MAX_TERMINALS = 8;

  /**
   * @param {{pane: 'agent'|'terminal', root: () => HTMLElement, path: string, label: string, keyOf: (s: object) => string|null}} args
   *   `path` is the ttyd route (`term` or `shell`); `keyOf` is null for a session with nothing to show in this pane
   */
  function createTerminalPool({ pane, root, path, label, keyOf }) {
    const cache = W.createTerminalCache({ max: MAX_TERMINALS });
    const frames = new Map();
    let shown = null;

    function drop(keys) {
      for (const key of keys) {
        frames.get(key)?.remove();
        frames.delete(key);
        if (shown === key) shown = null;
      }
    }

    function mount(s, key) {
      const frame = h('iframe', { class: 'term', src: `/${path}/${s.id}/`, title: `${label} for ${s.title}`, onload: (e) => bindTerminal(e.target, s.id, pane) });
      frames.set(key, frame);
      root().append(frame);
    }

    // A frame parked before ttyd sized itself stays at 80x24, and showing it fires no resize, so one is sent once the
    // pane has laid out. Focus goes to it as in the shed, but not on a phone, where focus raises the keyboard.
    function refit(s, focus) {
      const frame = frames.get(keyOf(s));
      if (!frame) return;
      requestAnimationFrame(() => {
        frame.contentWindow?.dispatchEvent(new Event('resize'));
        if (focus && !narrow.matches) frame.contentWindow?.term?.focus();
      });
    }

    return {
      frameOf: (s) => frames.get(keyOf(s)),
      refit,
      // Does nothing while the same terminal is already the one shown, so a refresh does not refit or refocus it.
      show(s) {
        const key = keyOf(s);
        if (shown === key) return;
        const wasKept = frames.has(key);
        drop(cache.touch(key));
        if (!frames.has(key)) mount(s, key);
        for (const [k, frame] of frames) frame.hidden = k !== key;
        shown = key;
        if (wasKept) refit(s, true);
      },
      hide() {
        for (const frame of frames.values()) frame.hidden = true;
        shown = null;
      },
      retain(sessions) {
        drop(cache.retain(new Set(sessions.map(keyOf).filter(Boolean))));
      },
    };
  }

  function termKey(s) {
    return s?.status === 'running' ? `${s.id}:${s.startedAt}` : null;
  }

  function shellKey(s) {
    return s?.hasShell ? termKey(s) : null;
  }

  const agentPool = createTerminalPool({ pane: 'agent', root: () => slots.body, path: 'term', label: 'Terminal', keyOf: termKey });
  const shellPool = createTerminalPool({ pane: 'terminal', root: () => slots.plain, path: 'shell', label: 'Shell', keyOf: shellKey });

  function showBody(s, tabPage) {
    if (termKey(s)) agentPool.show(s);
    else agentPool.hide();
    slots.view.replaceChildren(termKey(s) ? '' : s ? terminalBody(s) : tabPage ? '' : h('p', { class: 'empty' }, 'No session you can open with that id.'));
  }

  // A private session at its owner's limit: it has no task yet, and starts by itself when one of theirs stops.
  function lineBody(s) {
    const place = W.linePlace(s, data.sessions);
    return h('div', { class: 'ended' },
      h('h2', null, 'Waiting for a free slot'),
      h('p', null, `${W.lineText(place).replace(/^./, (c) => c.toUpperCase())}. You have ${runningMine()} of ${data.maxPrivate} sessions running. This one starts by itself when one of them stops or is paused.`),
      h('div', { class: 'row' }, W.stopButton(s, refresh, { label: 'Take it out of the line' })),
      W.isAdmin() && h('p', { class: 'hint' }, 'Need more at once? ', h('a', { href: '/console-settings' }, 'Raise the limit in Console settings'), '.'));
  }

  function terminalBody(s) {
    if (s.status === 'starting' && s.startedAt) return startingBody(s);
    if (W.linePlace(s, data.sessions)) return lineBody(s);
    const waiting = {
      queued: W.waitsForRetry(s) ? [W.providerWords.noRoom?.title ?? 'Waiting for room', W.providerWords.noRoom?.detail ?? '']
        : ['Waiting for a free slot', `All ${data.maxRunning} slots are in use. This session starts as soon as one frees up.`],
      stopping: ['Stopping', 'Committing and pushing work in progress, then removing the container.'],
    }[s.status];
    if (waiting) return h('div', { class: 'ended' }, h('h2', null, waiting[0]), h('p', null, waiting[1]));
    if (W.isResumable(s)) return keptBody(s);
    const paused = W.isPaused(s);
    const facts = [
      ['Status', s.status === 'failed' ? `Failed: ${s.error || 'unknown error'}`
        : `${paused ? 'Paused' : 'Stopped'} ${W.ago(s.stoppedAt)}: ${s.stopReason || 'no reason recorded'}`],
      ['Branch', s.branch || 'none'],
      ['Head', s.head || 'unknown'],
      ['Pull request', s.prUrl || 'none'],
      ['Ran', W.duration(s.startedAt, s.stoppedAt) || 'never started'],
      s.status === 'failed' && s.startSteps && ['Stopped at', W.startProgress(s).current?.label ?? 'after claude opened'],
      ['Last message', s.lastMessage ? `${s.lastMessage.role}: ${s.lastMessage.text}` : 'none'],
    ].filter(Boolean);
    return h('div', { class: 'ended' },
      h('h2', null, stoppedHeading(s, paused)),
      W.isPrivate(s)
        ? [h('p', null, 'Work in progress is committed and pushed to the branch before a stop, and your Claude home saved. Resume starts it again on the same branch, with claude\'s conversation.'),
          h('div', { class: 'row' }, s.status === 'stopped' && resumeButton(s, false), removeButton(s))]
        : s.kind === 'ask' ? h('p', null, 'Its conversation is deleted. Mention the bot in a Slack thread to ask again.')
          : h('p', null, 'Work in progress is committed and pushed to the branch before a stop. Comment ', h('code', null, '/woodshed …'), ` on ${W.ref(s)} to start a new session on the same branch.`),
      h('dl', null, facts.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])));
  }

  // A pause says which limit it hit, from the console's reason: `idle for 1 h` or `ran for 8 h`.
  function stoppedHeading(s, paused) {
    if (paused) {
      const span = s.stopReason.replace(W.PAUSE_REASON_RE, '');
      return s.stopReason.startsWith('idle') ? `Paused after ${span} waiting for you` : `Paused after running for ${span}`;
    }
    if (W.displayStatus(s).key === 'failed') return s.status === 'failed' ? 'This session failed' : 'This session did not start in time';
    return 'This session has stopped';
  }

  // The start as a checklist: each step's seconds once done, the current one counting, the rest to come.
  function startingBody(s) {
    const { steps } = W.startProgress(s);
    const mark = { done: '✓', now: '', next: '' };
    return h('div', { class: 'ended starting' },
      h('div', { class: 'start-head' }, h('h2', null, 'Starting'), h('span', { class: 'start-clock' }, W.clock(s.startedAt))),
      h('p', null, 'The terminal appears here when claude is open.'),
      h('ol', { class: 'start-steps' }, steps.map((step) => h('li', { class: `is-${step.state}`, 'aria-current': step.state === 'now' ? 'step' : null },
        h('span', { class: 'start-mark', 'aria-hidden': 'true' }, mark[step.state]),
        h('span', { class: 'start-label' }, step.label),
        h('span', { class: 'start-secs' }, step.seconds === null ? '' : `${step.seconds} s`)))));
  }

  // A stopped shared session that keeps its conversation and databases: why it stopped, what is kept, and Resume.
  function keptBody(s) {
    const st = W.displayStatus(s);
    const pr = W.prNumber(s.prUrl);
    const what = {
      paused: [s.stoppedBy ? `Stopped by ${W.personText(s.stoppedBy)}` : `Paused: ${s.stopReason || 'stopped'}`, s.kind === 'ask'
        ? 'The container is stopped. Resume, or a mention of the bot in its Slack thread, picks the conversation up where it was.'
        : 'Its work is pushed and the container is stopped. Resume picks the conversation up where it was, on the same branch and databases.'],
      failed: ['It did not start again', `${s.error || 'The container did not start.'} Resume tries again, with the same conversation and databases.`],
      finished: ['Finished: its pull request is in Slack', `The review approved ${pr ? `PR ${pr}` : 'it'} and the agent Playwright suite passed, so it was posted to Slack and the session stopped.`],
      merged: [s.prMerged ? 'Merged' : 'Closed without merging', `${pr ? `PR ${pr}` : 'Its pull request'} ${s.prMerged ? 'merged' : 'closed'} ${W.ago(s.prClosedAt)}. Its conversation and databases are ${W.deletedIn(s) || 'deleted soon'}. The branch stays on GitHub.`],
    }[st.key] || ['Stopped', ''];
    const box = h('textarea', { id: `resume-${s.id}`, placeholder: 'What to tell claude when it opens (optional)', maxlength: '4000' });
    const facts = [
      ['Last message', s.lastMessage ? `${s.lastMessage.role}: ${s.lastMessage.text}` : 'none'],
      ['Pull request', s.prUrl || 'none yet'],
      ['Branch', s.branch || 'none'],
      ['Stopped', `${W.ago(s.stoppedAt)}${s.stopReason ? `: ${s.stopReason}` : ''}`],
      ['Kept until', s.prClosedAt ? (W.deletedIn(s) || 'deleted soon') : s.prUrl ? 'its pull request merges or closes, and 3 days after'
        : (W.deletedIn(s) || 'deleted 7 days after it stopped, since it has no pull request')],
    ];
    return h('div', { class: 'ended' },
      h('h2', null, what[0]),
      h('p', null, what[1]),
      h('div', { class: 'kept' }, (s.kind === 'ask' ? ['conversation'] : ['conversation', 'branch', 'databases']).map((k) => h('span', null, k))),
      h('div', { class: 'resume-box' },
        h('label', { class: 'label', for: box.id }, 'Resume with a message'),
        box,
        h('div', { class: 'row' },
          W.resumeSharedButton(s, { onDone: refresh, message: () => box.value }),
          s.kind === 'ask' ? h('span', { class: 'hint' }, 'Or mention the bot again in its Slack thread.')
            : h('span', { class: 'hint' }, 'Or comment ', h('code', null, '/woodshed …'), ` on ${W.ref(s)}${pr ? ` or PR ${pr}` : ''}.`),
          st.key === 'merged' && W.deleteSharedButton(s, refresh))),
      h('dl', null, facts.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])));
  }

  // The Review tab: what the branch changes against the default branch, as GitHub has it. Read when the tab is
  // opened, and again when the session's head moves.
  const review = { key: null, data: null, error: null, loading: false, open: new Set(), anchor: 'file' };

  async function loadReview(s, force) {
    const key = `${s.branch}@${s.head || ''}`;
    if (!force && (review.loading || review.key === key)) return;
    review.key = key;
    review.loading = true;
    renderReview(s);
    try {
      review.data = await W.getJson(`/api/sessions/${s.id}/review`);
      review.error = null;
    } catch (err) {
      review.error = err.message;
    }
    review.loading = false;
    renderReview(s);
  }

  // Five squares split between added and removed lines, as GitHub draws them.
  function statBlocks(additions, deletions) {
    const total = additions + deletions;
    const green = total ? Math.round((additions / total) * 5) : 0;
    const red = total ? Math.min(5 - green, Math.round((deletions / total) * 5) || (deletions ? 1 : 0)) : 0;
    return h('span', { class: 'rv-blocks', 'aria-hidden': 'true' },
      Array.from({ length: 5 }, (_, i) => h('span', { class: i < green ? 'add' : i < green + red ? 'del' : '' })));
  }

  function counts(f) {
    return [h('span', { class: 'rv-add' }, `+${f.additions}`), ' ', h('span', { class: 'rv-del' }, `−${f.deletions}`)];
  }

  function patchLines(patch) {
    return patch.split('\n').map((line) => {
      const kind = line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : '';
      return h('span', { class: `rv-line ${kind}` }, line || ' ');
    });
  }

  // A file of a branch's changes, collapsed until opened. `state.open` keeps which ones are open across redraws.
  function fileCard(f, i, state, words) {
    const slash = f.path.lastIndexOf('/');
    const details = h('details', { class: 'rv-file', id: `${state.anchor}-${i}`, open: state.open.has(f.path) },
      h('summary', null,
        h('span', { class: 'rv-path', title: f.path }, slash >= 0 && h('span', { class: 'rv-dir' }, f.path.slice(0, slash + 1)), h('b', null, f.path.slice(slash + 1))),
        f.status !== 'modified' && h('span', { class: `rv-status is-${f.status}` }, f.status),
        h('span', { class: 'rv-counts' }, counts(f))),
      f.previousPath && h('p', { class: 'rv-note-line' }, `Renamed from ${f.previousPath}`),
      f.patch ? h('pre', { class: 'rv-diff' }, patchLines(f.patch)) : !f.truncated && h('p', { class: 'rv-note-line' }, words.noPatch),
      f.truncated && h('p', { class: 'rv-note-line' }, words.cut));
    details.addEventListener('toggle', () => {
      if (details.open) state.open.add(f.path);
      else state.open.delete(f.path);
    });
    return details;
  }

  // What a branch changes, file by file, in the shape of console/review.mjs's shapeReview: the Review tab of a stopped
  // session, from GitHub, and the Diff tab of a running one, from its checkout (session/sessionDiff.mjs). `words` is
  // what differs between the two.
  function changesBody(s, state, words) {
    const r = state.data;
    const title = h('h2', { class: 'rv-title' }, h('span', { class: 'rv-kicker' }, words.kicker), s.title);
    const readAgain = h('button', { type: 'button', class: 'btn btn-plain btn-sm', disabled: state.loading, onclick: words.reload }, state.loading ? 'Reading…' : 'Read again');
    if (!r) {
      const note = h('p', { class: 'sub', role: 'status' }, state.error || words.reading);
      return h('div', { class: 'review' }, title, note, state.error && h('div', null, readAgain));
    }
    const commits = `${r.aheadBy} commit${r.aheadBy === 1 ? '' : 's'} ahead of ${r.base}${r.behindBy ? `, ${r.behindBy} behind` : ''}`;
    return h('div', { class: 'review' },
      h('div', { class: 'rv-head' },
        title,
        h('div', { class: 'rv-chips' },
          r.branch && [h('code', { class: 'rv-chip' }, r.branch), h('span', { class: 'rv-arrow', 'aria-hidden': 'true' }, '→')], h('code', { class: 'rv-chip is-base' }, r.base),
          r.head && h('code', { class: 'rv-sha' }, r.head),
          h('span', { class: 'rv-counts' }, counts(r)), statBlocks(r.additions, r.deletions))),
      h('div', { class: 'rv-banner' },
        h('span', null, words.banner(commits)),
        h('span', { class: 'rv-banner-actions' }, readAgain, words.actions)),
      state.error && h('p', { class: 'rv-error', role: 'alert' }, state.error),
      words.notes,
      h('div', { class: 'rv-section' }, h('span', null, 'Files changed'), h('span', { class: 'count' }, r.files.length)),
      r.files.length
        ? h('div', { class: 'rv-grid' },
          h('nav', { class: 'rv-tree', 'aria-label': 'Files changed' }, r.files.map((f, i) => h('a', {
            href: `#${state.anchor}-${i}`,
            title: f.path,
            onclick: () => { state.open.add(f.path); document.getElementById(`${state.anchor}-${i}`).open = true; },
          }, h('span', { class: 'rv-tree-name' }, f.path.split('/').pop()), h('span', { class: 'rv-counts' }, counts(f))))),
          h('div', { class: 'rv-files' }, r.files.map((f, i) => fileCard(f, i, state, words))))
        : h('p', { class: 'empty' }, words.empty(r.base)));
  }

  function reviewBody(s) {
    const r = review.data;
    return changesBody(s, review, {
      kicker: 'Review: ',
      reading: 'Reading the branch from GitHub…',
      reload: () => loadReview(s, true),
      banner: (commits) => ['What the session has pushed: ', h('b', null, commits), '. Work still uncommitted in its terminal shows here once it pushes.'],
      actions: r?.url && h('a', { class: 'btn btn-pr btn-sm', href: r.url, target: '_blank', rel: 'noopener' }, 'On GitHub ↗'),
      noPatch: 'GitHub shows no diff for this file: it is binary, too large, or only renamed.',
      cut: 'The diff is cut at 400 lines. The rest is on GitHub.',
      empty: (base) => `The branch has no changes against ${base} yet.`,
    });
  }

  function renderReview(s) {
    if (slots.review && slots.reviewMode?.startsWith('github:')) slots.review.replaceChildren(reviewBody(s));
  }

  // The App log tab, after the shed's app terminal: the end of the start's, the backend's and the frontend's logs,
  // read from statusd every few seconds while the tab is open. Read-only: the servers are stopped from Stop app.
  const APPLOG_MS = 3000;
  const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
  const appLog = { which: 'frontend', logs: null, error: null, timer: null, session: null };
  async function readAppLog() {
    const s = appLog.session;
    if (!s) return;
    let logs = null;
    let error = null;
    try {
      logs = (await W.getJson(`/api/sessions/${s.id}/applog`)).logs;
    } catch (err) {
      error = err.message;
    }
    // A read that was out when the pane moved to another session is that session's no longer.
    if (appLog.session?.id !== s.id) return;
    if (error) appLog.error = error;
    else Object.assign(appLog, { logs, error: null });
    renderAppLog();
  }

  function watchAppLog(s) {
    const open = Boolean(s) && tab === 'applog' && s.status === 'running';
    if (!open) {
      clearInterval(appLog.timer);
      appLog.timer = null;
      appLog.session = null;
      return;
    }
    if (appLog.session?.id === s.id && appLog.timer) return;
    if (appLog.session?.id !== s.id) Object.assign(appLog, { logs: null, error: null });
    appLog.session = s;
    clearInterval(appLog.timer);
    appLog.timer = setInterval(readAppLog, APPLOG_MS);
    readAppLog();
  }

  function renderAppLog() {
    if (!slots.applog) return;
    const pick = (name, label) => h('button', {
      type: 'button', class: 'btn btn-plain btn-sm', 'aria-pressed': String(appLog.which === name), onclick: () => { appLog.which = name; renderAppLog(); },
    }, label);
    const log = appLog.logs?.find((l) => l.name === appLog.which);
    const text = log?.text ? log.text.replace(ANSI_RE, '') : appLog.logs ? 'Nothing logged yet. Start app writes here.' : 'Reading…';
    // The same <pre> across reads, its text changed in place, so someone reading up the log or selecting in it stays
    // where they are; at the bottom, it follows the log.
    // Moved out and back in, an element loses its scroll, so the frame is built once and only the bar is redrawn.
    if (!appLog.pre) {
      appLog.pre = h('pre', { class: 'applog-text' });
      appLog.bar = h('div', { class: 'applog-bar' });
      slots.applog.replaceChildren(h('div', { class: 'applog' }, appLog.bar, appLog.pre));
    }
    const { pre } = appLog;
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
    const switched = appLog.shown !== appLog.which;
    if (pre.textContent !== text) pre.textContent = text;
    appLog.shown = appLog.which;
    appLog.bar.replaceChildren(pick('frontend', 'Frontend'), pick('backend', 'Backend'), pick('start', 'Start app'),
      h('span', { class: 'sub' }, appLog.error || (log ? `the last ${Math.min(48, Math.ceil(log.bytes / 1024))} KB, every 3 s` : '')));
    if (atBottom || switched) pre.scrollTop = pre.scrollHeight;
  }

  // The Diff tab: the running session's checkout against the default branch, uncommitted work included, drawn as the stopped
  // Review tab draws what was pushed (changesBody). Read each time the tab opens and on Read again, never on a timer:
  // each read fetches the default branch and walks the tree. The Review tab is the one with the analysis and GitHub.
  const plainDiff = { data: null, error: null, loading: false, at: null, session: null, openFor: null, open: new Set(), anchor: 'diff-file', reads: 0 };
  async function readDiff(s) {
    if (plainDiff.session !== s.id) Object.assign(plainDiff, { data: null, at: null, open: new Set() });
    Object.assign(plainDiff, { session: s.id, loading: true, error: null });
    const read = ++plainDiff.reads;
    renderDiff(s);
    let answer = null;
    let error = null;
    try {
      answer = await W.getJson(`/api/sessions/${s.id}/diff`);
    } catch (err) {
      error = err.message;
    }
    // Only the latest read lands: one still out when the pane moved away and back is older than the checkout shown.
    if (read !== plainDiff.reads) return;
    Object.assign(plainDiff, { loading: false, error });
    if (answer) Object.assign(plainDiff, { data: answer, at: new Date() });
    renderDiff(s);
  }

  function watchDiff(s) {
    const open = Boolean(s) && tab === 'diff' && s.status === 'running';
    if (!open) {
      plainDiff.openFor = null;
      return;
    }
    if (plainDiff.openFor === s.id) return;
    plainDiff.openFor = s.id;
    readDiff(s);
  }

  function renderDiff(s) {
    if (!slots.diff) return;
    const d = plainDiff.data;
    slots.diff.replaceChildren(changesBody(s, plainDiff, {
      kicker: 'Diff: ',
      reading: 'Reading the checkout…',
      reload: () => readDiff(s),
      banner: (commits) => ['The checkout as it is now: ', h('b', null, commits), d?.uncommitted ? ', and work not committed yet' : '',
        plainDiff.at ? `. Read at ${plainDiff.at.toLocaleTimeString()}.` : '.'],
      notes: d && !d.baseFetched && h('p', { class: 'rv-note-line' }, `${d.base} could not be fetched, so this is against the ${d.base} the checkout already had.`),
      noPatch: 'No diff shown for this file: it is binary, or only renamed or a mode change.',
      cut: `This file's diff is too large to show here: git diff origin/${d?.base} -- <file> in the Terminal tab shows it.`,
      empty: (base) => `No changes against ${base} yet.`,
    }));
  }

  function setTab(next) {
    if (tab === next) return;
    tab = next;
    landOnReview = false;
    const url = new URL(window.location.href);
    if (currentSession) (tab === 'terminal' ? shellPool : agentPool).refit(currentSession, false);
    if (tab === 'agent') url.searchParams.delete('tab');
    else url.searchParams.set('tab', tab);
    window.history.replaceState(null, '', url);
    render();
  }

  // Moving an iframe in the DOM reloads it, so the page is laid out once and only the rail and the bar are swapped on
  // each refresh. The terminal stays mounted, hidden, while Review shows, and its body is rebuilt
  // only when what it shows changes, e.g. starting to running.
  const slots = {};
  function layout() {
    if (slots.shell) return;
    slots.railBody = h('div', { style: 'display: contents' });
    slots.rail = h('nav', { class: 'rail', 'aria-label': 'Sessions' }, slots.railBody, railUserFoot());
    slots.head = h('div');
    slots.keys = h('div', { class: 'keybar', role: 'toolbar', 'aria-label': 'Keys for the terminal', hidden: true });
    slots.view = h('div', { style: 'display: contents' });
    slots.body = h('div', { class: 'pane-view is-terminal', role: 'tabpanel' }, slots.view);
    slots.plain = h('div', { class: 'pane-view is-terminal', role: 'tabpanel', hidden: true });
    slots.review = h('div', { class: 'pane-view is-review', role: 'tabpanel' });
    slots.applog = h('div', { class: 'pane-view is-applog', role: 'tabpanel', hidden: true });
    slots.diff = h('div', { class: 'pane-view is-diff', role: 'tabpanel', hidden: true });
    slots.launch = launcher.el;
    slots.home = h('div', { style: 'display: contents' });
    slots.shell = h('div', { class: 'shell' }, slots.rail,
      h('main', { class: 'pane' }, slots.head, slots.keys, slots.body, messageBox.el, slots.plain, slots.review, slots.diff, slots.applog, slots.launch, slots.home));
    document.getElementById('app').replaceChildren(slots.shell);
    applyTermScale();
    fitToKeyboard();
  }

  // iOS lays its keyboard over the page without shrinking the layout viewport, so the prompt the keyboard was
  // raised for sits under it. The visual viewport does shrink: while it is short, the shell takes its height and
  // the terminal refits to the rows that show. A pinch zoom shrinks it too, at a scale above 1, and is left alone.
  const narrow = window.matchMedia('(max-width: 720px)');
  function fitToKeyboard() {
    const visual = window.visualViewport;
    if (!slots.shell) return;
    if (!visual || !narrow.matches) {
      slots.shell.style.height = '';
      return;
    }
    const short = visual.scale <= 1 && visual.height < window.innerHeight - 60;
    slots.shell.style.height = short ? `${visual.height}px` : '';
    if (short) window.scrollTo(0, 0);
  }
  window.visualViewport?.addEventListener('resize', fitToKeyboard);
  // A window widened past a phone's shows the Shared page's pane, so it is filled at once.
  narrow.addEventListener('change', () => { if (onShared) render(); });

  // The session's own id first: moving to another session in place must rebuild its terminal.
  function bodyKey(s) {
    if (!s) return 'missing';
    if (s.status === 'starting') return `${s.id}:starting:${Date.now()}`;
    return s.status === 'running' ? `${termKey(s)}` : `${s.id}:${s.status}:${s.stopReason}:${s.head}:${s.prUrl}:${s.kept}:${s.slackPostedAt}:${s.prClosedAt}`;
  }

  let currentSession = null;
  function render() {
    if (!data) {
      document.getElementById('app').replaceChildren(h('p', { class: 'empty' }, loadError ? `Could not load sessions: ${loadError}` : 'Loading…'));
      return;
    }
    // Everyone has nothing to show without shared sessions, so its address opens Mine.
    if (onShared && !sharesShown()) {
      window.history.replaceState(null, '', '/');
      readRoute();
    }
    layout();
    const s = id ? data.sessions.find((x) => x.id === id) : null;
    currentSession = s || null;
    const logins = W.uniqueLogins(data.sessions.filter((x) => !W.isPrivate(x)).map((x) => x.assignee)).sort();
    const top = railHead(logins);
    if (slots.rail.firstChild !== top) {
      if (slots.rail.firstChild !== slots.railBody) slots.rail.firstChild.remove();
      slots.rail.prepend(top);
    }
    // The rail's list is drawn again on every refresh: a project chip that had the focus gets it back, so the keyboard
    // stays where it was.
    const focusedChip = document.activeElement?.closest?.('.rail-projects') ? document.activeElement.dataset.project ?? null : null;
    slots.railBody.replaceChildren(...railBody());
    if (focusedChip !== null) slots.railBody.querySelector(`.rail-projects [data-project="${CSS.escape(focusedChip)}"]`)?.focus();
    syncCardMenu();
    // A tab's own page puts what it is in the pane: Shared's sessions on /all, New session on /.
    const tabPage = onMy || onShared;
    slots.shell.classList.toggle('is-launcher', tabPage);
    slots.shell.classList.toggle('is-new', onNew);
    slots.shell.classList.toggle('is-railless', railHidden);
    slots.launch.hidden = !onMy;
    if (onMy) launcher.update(me);
    if (onShared && !sharedHome) {
      sharedHome = W.createSharedHome({ onChange: () => refresh() });
      slots.home.append(sharedHome.el);
    }
    if (sharedHome) sharedHome.el.hidden = !onShared;
    // On a phone the rail is the Shared page and the pane is hidden, so its cards are not built.
    if (onShared && !narrow.matches) sharedHome.update({ data, picked });
    const key = bodyKey(s);
    if (slots.bodyKey !== key) {
      slots.bodyKey = key;
      // Someone else's private session gets the same words as an id that never existed.
      showBody(s, tabPage);
    }
    agentPool.retain(data.sessions);
    shellPool.retain(data.sessions);
    // The shell's terminal, made the first time its tab opens and dropped once the session stops.
    const hasShell = Boolean(shellKey(s));
    if (!hasShell) shellPool.hide();
    else if (tab === 'terminal') shellPool.show(s);
    if (!s) {
      slots.plain.hidden = true;
      slots.body.hidden = tabPage;
      slots.head.replaceChildren();
      renderKeyBar(null);
      messageBox.show(null);
      slots.review.hidden = true;
      slots.applog.hidden = true;
      slots.diff.hidden = true;
      watchAppLog(null);
      watchDiff(null);
      return;
    }
    openReviewWhenRunning(s);
    if (tab === 'review' && !s.branch) tab = 'agent';
    if (tab === 'terminal' && !hasShell) tab = 'agent';
    if ((tab === 'applog' || tab === 'diff') && (s.status !== 'running' || s.kind === 'ask')) tab = 'agent';
    slots.head.replaceChildren(paneBar(s));
    renderKeyBar(s);
    // A phone's message box, for claude on the Agent tab; the Terminal tab's shell takes the keyboard straight in.
    messageBox.show(narrow.matches && s.status === 'running' && tab === 'agent' ? s : null);
    slots.body.hidden = tab !== 'agent';
    slots.plain.hidden = tab !== 'terminal';
    slots.review.hidden = tab !== 'review';
    slots.applog.hidden = tab !== 'applog';
    slots.diff.hidden = tab !== 'diff';
    watchAppLog(s);
    watchDiff(s);
    // A running session's review is the shed's own page, served by its statusd and framed here; a stopped session's is
    // what it pushed.
    if (tab === 'review') {
      const mode = s.status === 'running' ? `shed:${s.id}` : `github:${s.id}`;
      if (slots.reviewMode !== mode) {
        slots.reviewMode = mode;
        slots.review.replaceChildren();
      }
      if (s.status === 'running') {
        // Made once: a refresh would drop the chat, the open asks and the scroll.
        if (!slots.review.firstChild) slots.review.append(h('iframe', { class: 'review-frame', src: `/review?session=claude-${s.id}&embed=1`, title: `Review of ${s.title}` }));
      } else {
        if (!slots.review.firstChild) renderReview(s);
        loadReview(s, false);
      }
    }
  }

  // A session started with a PR or branch and no prompt lands on the Review each time it is opened, once the machine is
  // up (until then it stays on its starting page), because the Review is what it was started for. A tab asked for in the
  // address is left alone, and so is a tab picked afterwards: this runs once per arrival.
  function openReviewWhenRunning(s) {
    if (!s.reviewOnly || !landOnReview || s.status !== 'running') return;
    landOnReview = false;
    tab = 'review';
    window.history.replaceState(null, '', `/s/${s.id}?tab=review`);
  }

  // What the last answers were, in this tab, so a page load draws the rail at once and refreshes it after, rather than
  // showing Loading… first. Only this tab's, gone when it closes, and never anything the page did not already show.
  // Kept with whose it was, the login the page was served to, and drawn only for that same person: a tab someone else
  // signs into after a sign-out never shows the last one's private sessions. Sign out also clears it (common.js).
  const LAST_KEY = 'woodshed-cloud-last';
  const signedInAs = document.querySelector('meta[name="woodshed-login"]')?.content ?? null;
  // Until the first answer confirms it, the kept list is a guess: a first refresh that fails drops it.
  let fromLast = false;
  function readLast() {
    try {
      const last = JSON.parse(window.sessionStorage.getItem(LAST_KEY) || 'null');
      if (!last?.data?.sessions || last.login !== signedInAs) return;
      ({ data, me, pulls } = { data: last.data, me: last.me ?? null, pulls: last.pulls ?? [] });
      fromLast = true;
    } catch {
      // A private window, or storage turned off: the page waits for its first answer.
    }
  }
  function keepLast() {
    try {
      window.sessionStorage.setItem(LAST_KEY, JSON.stringify({ login: signedInAs, data, me, pulls }));
    } catch {
      // Full or refused: the next load just waits for its first answer.
    }
  }

  async function refresh() {
    try {
      // My Woodshed's own answer is asked for on /, and once anywhere else, so moving to / has it already.
      // Asked again on every refresh while the setup card shows, so its databases row moves on whichever page is open.
      const askMe = onMy || !me || (railMine() && !W.setupDone(me));
      [data, me] = await Promise.all([W.fetchSessions(), askMe ? W.getJson('/api/my') : Promise.resolve(me)]);
      // The rail's pull requests are best effort: GitHub being slow must not hold the page.
      if (railMine()) W.getJson('/api/my/pulls').then((answer) => { pulls = answer.pulls; keepLast(); render(); }, () => {});
      loadError = null;
      fromLast = false;
      keepLast();
    } catch (err) {
      loadError = err.message;
      if (fromLast) {
        ({ data, me, pulls } = { data: null, me: null, pulls: [] });
        fromLast = false;
      }
    }
    render();
  }

  // One loop for the page's life, whichever of its pages shows; a move refreshes at once besides.
  let loopTimer = null;
  async function loop() {
    clearTimeout(loopTimer);
    await refresh();
    const waiting = currentSession?.status === 'starting' || currentSession?.status === 'queued';
    loopTimer = setTimeout(loop, waiting ? STARTING_REFRESH_MS : REFRESH_MS);
  }
  readLast();
  if (data) render();
  loop();
  window.addEventListener('woodshed:me', render);
})();
