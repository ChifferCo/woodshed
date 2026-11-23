// New session on My Woodshed, after the shed's launcher: the project (on a console with more than one), a prompt, an
// optional name and issue, PR or branch,
// claude's model, effort and permission mode, files attached (the paperclip, a paste or a drop), and the repo's
// skills on `/`. The session it starts is private to whoever is signed in and
// runs on their own Claude token or Codex sign-in, or their own Grok Build, Antigravity or OpenCode sign-in
// (shared/agents.cjs), so without one the form says where to save it instead. Built once and kept
// across the page's refreshes, so nothing typed into it is lost.
(function () {
  'use strict';
  const W = window.Woodshed;
  const { h } = W;

  // The values the console accepts (MODELS, EFFORTS and PERMISSION_MODES in sessions.mjs), first the default.
  const MODELS = [['', 'default', 'Claude’s own default'], ['opus', 'opus', 'Most capable'], ['sonnet', 'sonnet', 'Balanced, faster'],
    ['haiku', 'haiku', 'Smallest and quickest'], ['fable', 'fable', 'Newest generation']];
  const EFFORTS = [['', 'default'], ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh'], ['max', 'max']];
  // Every agent a session can run (shared/agents.cjs), in its order: the two the team's key can run, then the three that
  // run on your own sign-in alone.
  const A = window.WoodshedAgents;
  const AGENT_WORDS = {
    claude: 'Claude Code, on your Claude plan', codex: 'OpenAI Codex, on your Codex sign-in or the team key',
    grok: 'Grok Build, on your own xAI sign-in', antigravity: 'Antigravity CLI, on your own Gemini API key', opencode: 'OpenCode, on the providers you signed in to',
  };
  const AGENTS = A.AGENT_IDS.map((id) => [id, A.agent(id).name, AGENT_WORDS[id] ?? A.agent(id).product]);
  // What each permission mode does, in an agent that is not Claude Code or Codex (the entrypoint's mapping onto its flags).
  const OWN_MODE_WORDS = {
    auto: 'Works unattended, without asking', acceptEdits: 'Edits freely, asks before commands', plan: 'Plans only, changes nothing',
    default: 'The agent\u2019s own approval rules',
  };
  const ownModes = (id) => A.agent(id).permissionModes.map((m) => [m, m, OWN_MODE_WORDS[m]]);
  const ownEfforts = (id) => (A.agent(id).efforts ?? ['']).map((e) => [e, e || 'default']);
  // What a session of that agent runs on, for the line under Start.
  const RUNS_ON = { claude: 'Claude plan', codex: 'Codex sign-in or the team key' };
  const runsOn = (id) => RUNS_ON[id] ?? `own ${A.agent(id).product} sign-in`;
  // Codex's models and efforts are OpenAI's catalog's, as the console reads it for you (GET /api/my/codex-models,
  // codexModels.mjs); its permission modes are CODEX_PERMISSION_MODES in sessions.mjs.
  const CODEX_MODES = [['auto', 'auto', 'Works unattended; asks when the model decides to'], ['plan', 'plan', 'Read-only, changes nothing'],
    ['default', 'default', 'Codex\u2019s own approval policy']];
  const MODES = [['auto', 'auto', 'Works unattended; refuses what looks risky'], ['acceptEdits', 'acceptEdits', 'Edits freely, asks before commands'],
    ['plan', 'plan', 'Plans only, changes nothing'], ['default', 'default', 'Asks before every tool']];

  function select(id, options) {
    return h('select', { id, class: 'field' }, options.map(([value, label, title]) => h('option', { value, title }, label)));
  }

  const MAX_ATTACH = 8;
  // How long New session's Work on keeps a project's open pull requests before asking the console again.
  const PULLS_FRESH_MS = 60_000;
  const MAX_ATTACH_MB = 25;
  const MAX_TOTAL_MB = 40;

  function megabytes(bytes) {
    return (bytes / 1024 / 1024).toFixed(1);
  }

  // Each file goes to the console as it is picked (attachments.mjs); Start names the ones still on the list.
  // `extra`: controls that sit after Attach files, before its hint.
  function createAttachments(onChange, ...extra) {
    const chips = h('div', { class: 'attach-chips' });
    const hint = h('span', { class: 'hint' }, 'or paste / drag & drop');
    const input = h('input', { type: 'file', multiple: true, hidden: true });
    const button = h('button', { type: 'button', class: 'btn btn-plain btn-sm', onclick: () => input.click() }, 'Attach files');
    let files = [];
    let flashTimer = null;

    function flash(text) {
      hint.textContent = text;
      hint.classList.add('is-error');
      clearTimeout(flashTimer);
      flashTimer = setTimeout(paint, 4000);
    }

    function paint() {
      hint.classList.remove('is-error');
      const total = files.reduce((n, f) => n + f.bytes, 0);
      hint.textContent = files.length ? `${files.length} file${files.length === 1 ? '' : 's'} · ${megabytes(total)} / ${MAX_TOTAL_MB} MB` : 'or paste / drag & drop';
      chips.replaceChildren(...files.map((f) => h('span', { class: `attach-chip${f.id ? '' : ' is-sending'}` },
        f.thumb ? h('img', { src: f.thumb, alt: '' }) : h('span', { class: 'attach-ext' }, (f.name.split('.').pop() || 'file').slice(0, 4)),
        h('span', { class: 'attach-name', title: f.name }, f.name),
        h('button', { type: 'button', 'aria-label': `Remove ${f.name}`, onclick: () => { files = files.filter((x) => x !== f); paint(); onChange(); } }, '×'))));
    }

    async function add(list) {
      for (const file of list) {
        const total = files.reduce((n, f) => n + f.bytes, 0);
        if (files.length >= MAX_ATTACH) return flash(`max ${MAX_ATTACH} attachments`);
        if (!file.size) { flash(`${file.name} is empty`); continue; }
        if (file.size > MAX_ATTACH_MB * 1024 * 1024) { flash(`${file.name} is over ${MAX_ATTACH_MB} MB`); continue; }
        if (total + file.size > MAX_TOTAL_MB * 1024 * 1024) { flash(`${file.name} would put the total over ${MAX_TOTAL_MB} MB`); continue; }
        const name = file.name || `pasted.${(file.type.split('/')[1] || 'png').replace(/[^a-z0-9]/g, '')}`;
        const entry = { name, bytes: file.size, id: null, thumb: file.type.startsWith('image/') ? URL.createObjectURL(file) : null };
        files.push(entry);
        paint();
        onChange();
        try {
          const res = await fetch(`/api/my/uploads?${new URLSearchParams({ name })}`, {
            method: 'POST', headers: { 'x-woodshed': '1', 'content-type': 'application/octet-stream' }, body: file,
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error || `upload answered ${res.status}`);
          entry.id = body.id;
        } catch (err) {
          files = files.filter((x) => x !== entry);
          flash(`${name}: ${err.message}`);
        }
        paint();
        onChange();
      }
    }

    input.addEventListener('change', () => { add([...input.files]); input.value = ''; });
    return {
      el: h('div', { class: 'attach-row' }, button, ...extra, hint, input),
      chips,
      add,
      ids: () => files.map((f) => f.id).filter(Boolean),
      sending: () => files.some((f) => !f.id),
      clear() { files = []; paint(); },
    };
  }

  // `/` at the start of the prompt or after a space lists the repo's skills and commands (GET /api/skills): the repo of
  // the project picked, when there is a choice. `projectOf` says which; '' is the console's default project.
  function createSkillMenu(prompt, projectOf = () => '') {
    const menu = h('div', { class: 'skill-menu', role: 'listbox', hidden: true });
    const skillsByProject = new Map();
    let matches = [];
    let active = 0;

    function fragment() {
      const before = prompt.value.slice(0, prompt.selectionStart);
      return /(?:^|\s)(\/[a-z0-9:-]*)$/i.exec(before)?.[1] ?? null;
    }

    function insert(skill) {
      const frag = fragment();
      if (frag === null) return;
      const at = prompt.selectionStart - frag.length;
      prompt.value = `${prompt.value.slice(0, at)}/${skill.name} ${prompt.value.slice(prompt.selectionStart)}`;
      const caret = at + skill.name.length + 2;
      prompt.setSelectionRange(caret, caret);
      hide();
    }

    function hide() {
      menu.hidden = true;
      matches = [];
    }

    async function show() {
      const frag = fragment();
      if (frag === null) return hide();
      const list = await load();
      if (fragment() !== frag) return;
      matches = list.filter((s) => `/${s.name}`.startsWith(frag.toLowerCase()));
      if (!matches.length) return hide();
      active = Math.min(active, matches.length - 1);
      menu.replaceChildren(...matches.map((s, i) => h('div', {
        class: 'skill-row', role: 'option', 'aria-selected': String(i === active),
        onmousedown: (e) => { e.preventDefault(); insert(s); },
      }, h('span', { class: 'skill-name' }, `/${s.name}`), h('span', { class: 'skill-desc' }, s.desc))));
      menu.hidden = false;
    }

    // Asked once, as the prompt is first focused, so the list is there by the time `/` is typed.
    function load() {
      const project = projectOf();
      if (!skillsByProject.has(project)) {
        const url = project ? `/api/skills?project=${encodeURIComponent(project)}` : '/api/skills';
        skillsByProject.set(project, W.getJson(url).then((b) => b.skills, () => { skillsByProject.delete(project); return []; }));
      }
      return skillsByProject.get(project);
    }

    prompt.addEventListener('focus', load, { once: true });
    prompt.addEventListener('input', () => { active = 0; show(); });
    prompt.addEventListener('click', show);
    prompt.addEventListener('blur', () => setTimeout(hide, 100));
    prompt.addEventListener('keydown', (e) => {
      if (menu.hidden || !matches.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
        show();
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        insert(matches[active]);
      } else if (e.key === 'Escape') {
        hide();
      } else {
        return;
      }
      e.preventDefault();
    });
    return menu;
  }

  /**
   * Work on as a combobox: type a number, a branch or words to narrow the project's open pull requests (GET /api/pulls),
   * or open ▾ for all of them. Each row says enough to pick from: number, title, draft, author, branch and last update.
   * A picked one goes in as `PR #123`, and the line under the field names it. Anything else typed is sent as typed.
   * @param {HTMLInputElement} input
   * @param {() => string} projectOf  the picked project, empty for the default
   */
  function createPullPicker(input, projectOf) {
    const P = window.WoodshedOpenPulls;
    const listId = 'l-on-list';
    const menu = h('div', { class: 'skill-menu pull-menu', id: listId, role: 'listbox', 'aria-label': 'Open pull requests', hidden: true });
    const toggle = h('button', { type: 'button', class: 'pull-toggle', tabindex: '-1', 'aria-label': 'Show the open pull requests',
      'aria-controls': listId, 'aria-expanded': 'false' }, '▾');
    const chosen = h('p', { class: 'pull-chosen', hidden: true });
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', listId);
    input.setAttribute('aria-expanded', 'false');
    const byProject = new Map();
    let answer = null;
    let matches = [];
    let active = -1;
    let all = false;

    // Read again once a minute old, as the console's own copy is: the page stays open while sessions open pull requests.
    function load() {
      const project = projectOf();
      const kept = byProject.get(project);
      if (!kept || Date.now() - kept.at >= PULLS_FRESH_MS) {
        const url = project ? `/api/pulls?project=${encodeURIComponent(project)}` : '/api/pulls';
        const promise = W.getJson(url).then((b) => b, () => {
          byProject.delete(project);
          return { pulls: [], total: 0, stale: true };
        });
        byProject.set(project, { at: Date.now(), promise });
      }
      return byProject.get(project).promise;
    }

    // The pull request the field names exactly (`PR #123`, `#123`), when it is one of the listed.
    function picked() {
      const number = /^(?:pr\s*)?#\s*(\d+)$/i.exec(input.value.trim())?.[1];
      return number ? answer?.pulls.find((p) => p.number === Number(number)) ?? null : null;
    }

    function showChosen() {
      const p = picked();
      chosen.hidden = !p;
      if (p) chosen.replaceChildren(h('span', { class: 'pull-chosen-title' }, p.title), ` · ${[p.author && `@${p.author}`, p.branch].filter(Boolean).join(' · ')}`);
    }

    function hide() {
      menu.hidden = true;
      all = false;
      matches = [];
      active = -1;
      input.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }

    function pick(p) {
      input.value = P.workOnFor(p);
      hide();
      showChosen();
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function row(p, i) {
      const meta = [p.author && `@${p.author}`, p.branch, p.updatedAt && `updated ${W.ago(p.updatedAt)}`].filter(Boolean).join(' · ');
      return h('div', {
        class: 'pull-row', id: `${listId}-${i}`, role: 'option', 'aria-selected': String(i === active),
        onmousedown: (e) => { e.preventDefault(); pick(p); },
      },
      h('span', { class: 'pull-num' }, `#${p.number}`),
      h('span', { class: 'pull-title', title: p.title }, p.title, p.draft ? h('span', { class: 'pull-draft' }, 'Draft') : null),
      h('span', { class: 'pull-meta', title: meta }, meta));
    }

    function paint() {
      const list = answer?.pulls ?? [];
      // With a pick in the field, ▾ or a click shows the whole list, the pick marked.
      const current = picked();
      matches = all || current ? list : P.matchPulls(list, input.value);
      if (current && active < 0) active = matches.indexOf(current);
      // While typing, the first match is the one Enter picks.
      if (active < 0 && input.value.trim() && matches.length) active = 0;
      if (active >= matches.length) active = matches.length - 1;
      const note = P.pullsNote({ shown: matches.length, listed: list.length, total: answer?.total ?? 0, stale: Boolean(answer?.stale) });
      menu.replaceChildren(...matches.map(row), ...(note ? [h('p', { class: 'pull-note' }, note)] : []));
      menu.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      toggle.setAttribute('aria-expanded', 'true');
      if (active >= 0) {
        input.setAttribute('aria-activedescendant', `${listId}-${active}`);
        menu.querySelector(`#${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
      } else {
        input.removeAttribute('aria-activedescendant');
      }
    }

    async function open({ everything = false } = {}) {
      all = everything;
      if (!answer) menu.replaceChildren(h('p', { class: 'pull-note' }, 'Reading the open pull requests…'));
      menu.hidden = false;
      const project = projectOf();
      const got = await load();
      if (projectOf() !== project || document.activeElement !== input) return;
      answer = got;
      paint();
      showChosen();
    }

    input.addEventListener('focus', () => open());
    input.addEventListener('click', () => { if (menu.hidden) open(); });
    input.addEventListener('input', () => { active = -1; all = false; open(); showChosen(); });
    input.addEventListener('blur', () => setTimeout(hide, 100));
    toggle.addEventListener('mousedown', (e) => e.preventDefault());
    toggle.addEventListener('click', () => {
      if (!menu.hidden && all) return hide();
      input.focus();
      open({ everything: true });
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' && menu.hidden) {
        open({ everything: true });
      } else if (menu.hidden || !matches.length) {
        if (e.key === 'Escape' && !menu.hidden) hide();
        else return;
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
        paint();
      } else if (e.key === 'Enter' && active >= 0 && !e.metaKey && !e.ctrlKey) {
        pick(matches[active]);
      } else if (e.key === 'Escape') {
        hide();
      } else {
        return;
      }
      e.preventDefault();
    });

    return {
      el: h('div', { class: 'pull-pick' }, h('div', { class: 'pull-field' }, input, toggle, menu), chosen),
      // The project changed, or the field was set from outside (a link's ?on=, a start that emptied it).
      refresh() {
        answer = null;
        hide();
        showChosen();
        // Read now only to name a pull request already in the field; otherwise at the field's first focus.
        if (input.value.trim()) load().then((got) => { answer = got; showChosen(); });
      },
    };
  }

  function field(id, label, control, hint) {
    return h('div', { class: 'lfield' },
      h('label', { for: id, class: 'field-label' }, h('span', null, label), hint && h('span', { class: 'hint' }, hint)),
      control);
  }

  /**
   * The Project field: which repo the session works on, among those the person may start on (GET /api/my/projects),
   * with their default marked and Make my default beside any other. With one project it names it as text, with a way
   * to add another (an admin's link to Settings, a line for anyone else). It never hides for a blocked repo:
   * those stay in the list marked `needs setup`, and New session opens on the person's default only while it is not
   * blocked, else on the first that is not (`projectBlockers` in /api/my, databaseGate.mjs).
   * @param {() => void} changed  called when the pick, the projects or their blockers change
   */
  function createProjectPicker(changed) {
    const picker = h('select', { id: 'l-project', class: 'field' });
    const status = h('span', { class: 'sub', role: 'status' });
    const makeDefault = h('button', { type: 'button', class: 'btn btn-plain', title: 'New session opens on this project for you' }, 'Make my default');
    // With one project there is nothing to pick, but the form still says which repo the session works on.
    const only = h('div', { class: 'project-only mono', id: 'l-project-only' });
    const more = h('p', { class: 'project-more' });
    const label = h('label', { for: 'l-project', class: 'field-label' }, h('span', null, 'Project'), h('span', { class: 'hint' }, 'the repo it works on'));
    const el = h('div', { class: 'lfield', hidden: true }, label,
      h('div', { class: 'project-pick' }, picker, makeDefault),
      only,
      more,
      status);
    const pick = el.querySelector('.project-pick');
    let view = null;
    let blockers = {};
    let blockersKey = '{}';
    // A ?project= link picks for this visit only; it waits for the list when the page opens on it. A pick the person
    // made (or a link's) is kept even when that repo is blocked: that is when its fix card shows.
    let asked = null;
    let chosen = false;
    const blockerOf = (name) => blockers[name] ?? null;
    // The project New session opens on: the person's default while it can start, else the first that can.
    function opening(projects) {
      const preferred = projects.find((p) => p.name === view?.defaultProject) ?? projects[0];
      if (!preferred || !blockerOf(preferred.name)) return preferred?.name ?? '';
      return (projects.find((p) => !blockerOf(p.name)) ?? preferred).name;
    }
    function render() {
      const projects = view?.projects ?? [];
      el.hidden = projects.length === 0;
      const one = projects.length === 1;
      pick.hidden = one;
      only.hidden = !one;
      // With one project the select is hidden, so the label points at nothing.
      if (one) label.removeAttribute('for'); else label.setAttribute('for', 'l-project');
      only.textContent = one ? `${projects[0].name} \u00b7 ${projects[0].repo}${blockerOf(projects[0].name) ? ' \u2014 needs setup' : ''}` : '';
      more.hidden = !one;
      more.replaceChildren(...(!one ? [] : W.isAdmin()
        ? ['The only repo on this console. ', h('a', { href: '/console-settings#card-projects' }, 'Add a repo'), ' in Settings to start sessions on another.']
        : ['The only repo on this console. An admin can connect another one in Settings.']));
      const was = picker.value;
      const picked = (chosen && was) || asked || opening(projects);
      picker.replaceChildren(...projects.map((p) => h('option', { value: p.name },
        `${p.name} \u00b7 ${p.repo}${p.name === view.defaultProject ? ' \u2014 your default' : ''}${blockerOf(p.name) ? ' \u2014 needs setup' : ''}`)));
      picker.value = projects.some((p) => p.name === picked) ? picked : opening(projects);
      makeDefault.hidden = !view || picker.value === view.defaultProject || Boolean(blockerOf(picker.value));
      changed();
    }
    picker.addEventListener('change', () => { status.textContent = ''; chosen = true; render(); });
    makeDefault.addEventListener('click', async () => {
      makeDefault.disabled = true;
      try {
        view = await W.postJson('/api/my/projects/default', { project: picker.value });
        status.textContent = '';
      } catch (err) {
        status.textContent = err.message;
      }
      makeDefault.disabled = false;
      render();
    });
    W.getJson('/api/my/projects').then((answer) => { view = answer; render(); }, () => {});
    // An admin's Add a repo link shows once /api/me says who they are.
    window.addEventListener('woodshed:me', () => { if (view) render(); });
    return {
      el,
      /** @returns {string}  the picked project, empty with one project: the server starts on the default */
      value: () => ((view?.projects.length ?? 0) < 2 ? '' : picker.value),
      /** @returns {string}  the picked project's repo, the only one's with one project */
      repo: () => view?.projects.find((p) => p.name === picker.value)?.repo ?? '',
      /** @returns {object|null}  why the picked project cannot start sessions, or null */
      blocker: () => (view ? blockerOf(picker.value) : null),
      /** @returns {object[]}  the other projects' blockers, when every project is blocked */
      othersBlocked: () => {
        const projects = view?.projects ?? [];
        if (projects.length < 2 || projects.some((p) => !blockerOf(p.name))) return [];
        return projects.filter((p) => p.name !== picker.value).map((p) => blockerOf(p.name));
      },
      /** @returns {boolean}  whether another project could be picked */
      hasOthers: () => (view?.projects.length ?? 0) > 1,
      focus: () => picker.focus(),
      /** The blockers from /api/my: drawn again only when they changed, since drawing calls `changed`. */
      setBlockers(next) {
        const key = JSON.stringify(next ?? {});
        if (key === blockersKey) return;
        blockersKey = key;
        blockers = next ?? {};
        if (view) render();
      },
      ask(name) {
        asked = name;
        chosen = false;
        if (view) { picker.value = ''; render(); }
      },
    };
  }

  // Dictate beside Attach files: the browser's speech recognition writes into the prompt after what is typed
  // (dictation.js), and the line under the prompt shows the words still settling. Hidden where the browser has none.
  function createDictation(prompt) {
    let listening = null;
    const heard = h('span', { class: 'dictate-heard' });
    const line = h('p', { class: 'dictate-line', hidden: true, 'aria-live': 'polite' }, 'Listening. Stop when you are done. ', heard);
    const button = h('button', { type: 'button', class: 'btn btn-plain btn-sm', hidden: !W.dictation.available, 'aria-pressed': 'false',
      title: 'Speak the prompt', onclick: () => (listening ? listening.stop() : listen()) }, 'Dictate');
    function draw() {
      button.textContent = listening ? 'Stop' : 'Dictate';
      button.setAttribute('aria-pressed', String(Boolean(listening)));
      line.hidden = !listening;
    }
    function listen() {
      const mine = W.dictation.dictate(prompt, {
        heard: (pending) => { heard.textContent = pending; },
        ended: () => {
          if (listening === mine) listening = null;
          draw();
        },
      });
      listening = mine;
      draw();
      prompt.focus();
    }
    return {
      button,
      line,
      // The page moved away from New session: the mic goes off, and the words it heard stay in the prompt.
      stop() {
        listening?.stop();
      },
      // Start pressed while it listens: the words on screen are the words sent, the ones still settling too.
      finish() {
        if (!listening) return;
        const words = listening.abort();
        listening = null;
        if (words) prompt.value = `${prompt.value.replace(/\s*$/, '')} ${words}`.trimStart();
        draw();
      },
    };
  }

  /** @returns {{el: HTMLElement, update: (me: object) => void}} */
  function createLauncher() {
    const prompt = h('textarea', { id: 'l-prompt', class: 'field', rows: '5', placeholder: 'What should Claude do? Type / for the repo\'s skills.' });
    const workOn = h('input', { id: 'l-on', class: 'field mono', autocomplete: 'off', placeholder: 'Search open PRs, or type PR #123 or a branch' });
    const agent = select('l-agent', AGENTS);
    const model = select('l-model', MODELS);
    // An agent other than Claude Code or Codex takes any model name its own --model does (the registry's modelRe): typed.
    const modelText = h('input', { id: 'l-model-text', class: 'field mono', autocomplete: 'off', spellcheck: 'false', hidden: true });
    const ownAgent = () => !['claude', 'codex'].includes(agent.value);
    const modelValue = () => (ownAgent() ? modelText.value.trim() : model.value);
    const effort = select('l-effort', EFFORTS);
    const effortField = field('l-effort', 'Effort', effort);
    const mode = select('l-mode', MODES);
    // Start says its key (⌘↵, Ctrl+Enter elsewhere), which works from any field of the form; a phone has no keys.
    const K = window.WoodshedKeys;
    const startWords = h('span', null, 'Start');
    const start = h('button', { type: 'submit', class: 'btn btn-open', 'data-keys': 'start' }, startWords,
      h('span', { class: 'btn-keys', 'aria-hidden': 'true' }, K.caps(K.byId.start.mod, K.isMac(window.navigator)).map((k) => h('kbd', null, k))));
    let pulls = null;
    const projects = createProjectPicker(() => {
      pulls?.refresh();
      if (me) update(me);
    });
    pulls = createPullPicker(workOn, () => projects.value());
    const note = h('span', { class: 'sub' });
    const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const dictation = createDictation(prompt);
    const attachments = createAttachments(() => { start.disabled = attachments.sending(); }, dictation.button);
    const promptWrap = h('div', { class: 'prompt-wrap' }, prompt, dictation.line, createSkillMenu(prompt, () => projects.value()));
    promptWrap.addEventListener('dragover', (e) => {
      if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
      e.preventDefault();
      promptWrap.classList.add('is-dragover');
    });
    promptWrap.addEventListener('dragleave', () => promptWrap.classList.remove('is-dragover'));
    promptWrap.addEventListener('drop', (e) => {
      promptWrap.classList.remove('is-dragover');
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      attachments.add([...e.dataTransfer.files]);
    });
    prompt.addEventListener('paste', (e) => {
      if (!e.clipboardData?.files?.length) return;
      e.preventDefault();
      attachments.add([...e.clipboardData.files]);
    });
    // Model, effort and permissions, folded on a phone to one line of what is picked, and open on a desktop as before.
    const picked = h('span', { class: 'loptions-picked' });
    const showPicked = () => {
      const modelWord = ownAgent() ? modelText.value.trim() || 'default' : model.selectedOptions[0]?.textContent ?? '';
      picked.textContent = [modelWord, ...[effort, mode].filter((s) => !s.hidden).map((s) => s.selectedOptions[0]?.textContent ?? '')].join(' · ');
    };
    function fill(select, options) {
      select.replaceChildren(...options.map(([value, label, title]) => h('option', { value, title }, label)));
    }
    // The Codex catalog, asked for the first time Codex is picked and again on each pick after, since OpenAI changes it.
    let codexCatalog = null;
    const codexNote = h('p', { class: 'sub lcatalog-note', hidden: true });
    function codexModelOptions() {
      return [['', 'default', 'Codex\u2019s own default'], ...(codexCatalog?.models ?? []).map((m) => [m.slug, m.slug, m.description || m.name])];
    }
    // The efforts the picked model takes; with Codex's default model, any a listed model takes.
    function codexEffortOptions() {
      const picked = codexCatalog?.models.find((m) => m.slug === model.value);
      const efforts = picked ? picked.efforts : [...new Set((codexCatalog?.models ?? []).flatMap((m) => m.efforts))];
      return [['', picked?.defaultEffort ? `default (${picked.defaultEffort})` : 'default'], ...efforts.map((e) => [e, e])];
    }
    function keepPick(select, options) {
      const was = select.value;
      fill(select, options);
      if (options.some(([value]) => value === was)) select.value = was;
    }
    function showCodexCatalog() {
      keepPick(model, codexModelOptions());
      keepPick(effort, codexEffortOptions());
      codexNote.textContent = codexCatalog?.note ? `Codex models: ${codexCatalog.note}.` : '';
      codexNote.hidden = !codexCatalog?.note;
      showPicked();
    }
    function loadCodexCatalog() {
      W.getJson('/api/my/codex-models').then((answer) => {
        codexCatalog = answer;
        if (agent.value === 'codex') showCodexCatalog();
      }, () => {});
    }
    model.addEventListener('change', () => { if (agent.value === 'codex') keepPick(effort, codexEffortOptions()); });
    function showAgent() {
      const codex = agent.value === 'codex';
      const own = ownAgent();
      const a = A.agent(agent.value);
      model.hidden = own;
      modelText.hidden = !own;
      modelText.placeholder = a.modelHint ? `default (e.g. ${a.modelHint})` : 'default';
      if (!own) fill(model, codex ? codexModelOptions() : MODELS);
      fill(effort, codex ? codexEffortOptions() : own ? ownEfforts(agent.value) : EFFORTS);
      // An agent with no effort on its command line has no menu for it.
      effortField.hidden = own && !a.efforts;
      effort.hidden = effortField.hidden;
      fill(mode, codex ? CODEX_MODES : own ? ownModes(agent.value) : MODES);
      if (codex) loadCodexCatalog();
      codexNote.hidden = !codex || !codexCatalog?.note;
      prompt.placeholder = `What should ${a.name} do? Type / for the repo\u2019s skills.`;
      showPicked();
    }
    // Until the person picks one, the agent follows their sign-ins: Codex for someone with only a Codex sign-in saved.
    let agentPicked = false;
    agent.addEventListener('change', () => {
      agentPicked = true;
      showAgent();
      if (me) update(me);
    });
    for (const s of [model, effort, mode]) s.addEventListener('change', showPicked);
    modelText.addEventListener('input', showPicked);
    showPicked();
    const options = h('details', { class: 'loptions', open: !window.matchMedia('(max-width: 720px)').matches },
      h('summary', null, h('span', { class: 'field-label' }, 'Agent, model, effort and permissions'), picked),
      h('div', { class: 'lgrid4' }, field('l-agent', 'Agent', agent), field('l-model', 'Model', h('div', null, model, modelText)), effortField, field('l-mode', 'Permissions', mode)), codexNote);
    // Where a blocked repo's fix card goes, in place of the rest of the form: the picker above stays.
    const blockedSlot = h('div', { class: 'launch-setup', hidden: true });
    const body = h('div', { class: 'launch-body' },
      field('l-prompt', 'Prompt', promptWrap, 'optional when continuing a PR or branch: opens its review'),
      attachments.el, attachments.chips,
      // No name to give: the console names the session from its prompt, and its page offers a rename once it has.
      field('l-on', 'Continue a PR or branch', pulls.el, 'optional: leave empty to start a new branch'),
      options,
      error,
      h('div', { class: 'launch-actions' }, start, note));
    const form = h('form', { class: 'launch-form' }, projects.el, blockedSlot, body);
    // Until setup is done (a Claude token or a Codex sign-in, and databases ready where the console makes them), New session is the setup
    // card instead of the form: the server refuses a start until then.
    const noToken = h('div', { class: 'launch-setup', hidden: true });
    const tokenHelp = h('p', { class: 'sub' }, 'For Claude, run ', h('code', null, 'claude setup-token'),
      ' on your laptop. For Codex, run ', h('code', null, 'codex login'), ' and copy ', h('code', null, '~/.codex/auth.json'),
      ', or use an OpenAI API key. Save it on My settings: your sessions run on your own plan or sign-in. Grok Build, Antigravity and OpenCode run on your own sign-in too: ',
      ...A.OWN_SIGN_IN_AGENTS.flatMap((id, i) => [i ? ', ' : '', h('a', { href: `/settings#${id}` }, A.agent(id).product)]), '.');
    const el = h('section', { class: 'launch' },
      // On a phone New session is a screen of its own (/?new=1), and this is the way back to the list.
      h('a', { class: 'launch-back', href: '/' }, '‹ My Woodshed'),
      h('div', null, h('h2', { class: 'launch-title' }, 'New session'),
        h('p', { class: 'sub' }, 'Private to you: nobody else can see it or open it, and the console comments nothing on GitHub. The agent still pushes its branch and opens a PR, as every session does.')),
      noToken, form);

    // A pull request from the rail arrives as /?on=PR%20%23123, on a page load or a move to / in place.
    function applyQuery() {
      const asked = new URLSearchParams(window.location.search);
      if (asked.get('on')) workOn.value = asked.get('on');
      if (asked.get('prompt')) prompt.value = asked.get('prompt');
      if (asked.get('project')) projects.ask(asked.get('project'));
      pulls.refresh();
    }
    applyQuery();

    let me = null;
    const full = () => Boolean(me && me.running >= me.limit);
    form.addEventListener('keydown', (e) => {
      // The `/` menu's Enter picks a skill first, and only that.
      if (e.defaultPrevented || e.repeat || e.isComposing || K.match(e) !== 'start') return;
      e.preventDefault();
      if (!start.disabled && !body.hidden) form.requestSubmit();
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (body.hidden) return projects.focus();
      dictation.finish();
      const reviewOnly = !prompt.value.trim() && workOn.value.trim();
      if (!prompt.value.trim() && !reviewOnly) return prompt.focus();
      start.disabled = true;
      error.hidden = true;
      try {
        const session = await W.postJson('/api/my/sessions', {
          prompt: prompt.value, workOn: workOn.value, agent: agent.value, model: modelValue(), effort: effortField.hidden ? '' : effort.value, permissionMode: mode.value,
          ...(projects.value() ? { project: projects.value() } : {}),
          attachments: attachments.ids(),
        });
        // The page stays: the form is emptied for the next one, whose files those were not.
        prompt.value = '';
        workOn.value = '';
        pulls.refresh();
        attachments.clear();
        start.disabled = false;
        (W.navigate ?? ((href) => { window.location.href = href; }))(`/s/${session.id}`);
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        start.disabled = false;
      }
    });

    function update(next) {
      me = next;
      // Only the agents set up to run are offered (`agents` in /api/my): a Claude token, a Codex sign-in or the team's
      // OpenAI key, or the person's own sign-in for the others. A console from before `agents` offers Claude and Codex,
      // and one from before the other agents never lists them, which leaves them out.
      const offered = AGENTS.filter(([value]) => (me?.agents ? me.agents[value] : ['claude', 'codex'].includes(value)));
      const shown = offered.length ? offered : AGENTS.slice(0, 1);
      if (shown.map(([v]) => v).join() !== [...agent.options].map((o) => o.value).join()) {
        const was = agent.value;
        fill(agent, shown);
        if (shown.some(([v]) => v === was)) agent.value = was;
        else agentPicked = false;
        if (agent.value !== was) showAgent();
      }
      agent.disabled = shown.length < 2;
      // With no Claude token, the first agent they can run: Codex for someone with only a Codex sign-in saved.
      const preferred = !me?.claudeToken?.set && me?.codexAuth?.set && shown.some(([v]) => v === 'codex') ? 'codex' : shown[0][0];
      if (me && !agentPicked && agent.value !== preferred) {
        agent.value = preferred;
        showAgent();
      }
      // The server refuses a start until the databases are ready too, so the form waits for the same things the card does.
      const ready = Boolean(me) && W.setupDone(me);
      const after = ready ? W.stepsAfterSetup(me) : [];
      noToken.hidden = ready && !after.length;
      if (!ready && me) noToken.replaceChildren(W.setupCard(me), ...(W.anyAgentSignIn(me) ? [] : [tokenHelp]));
      else if (after.length) noToken.replaceChildren(W.setupCard(me, { compact: true, steps: after }));
      form.hidden = !ready;
      // A repo that cannot start sessions (databaseGate.mjs) keeps the picker, and shows its fix in place of the rest.
      projects.setBlockers(me?.projectBlockers ?? {});
      const blocked = projects.blocker();
      const others = projects.othersBlocked();
      blockedSlot.hidden = !blocked;
      body.hidden = Boolean(blocked);
      blockedSlot.replaceChildren(...(blocked ? [W.blockerCard(blocked, { others: projects.hasOthers() && !others.length })] : []),
        ...(blocked && others.length ? [h('div', null, h('p', { class: 'sub' }, 'Every repo on this console needs setup:'),
          h('ul', { class: 'blocker-others' }, others.map((b) => h('li', null, h('b', { class: 'mono' }, b.repo), ` \u2014 ${b.reason}`))))] : []));
      start.disabled = attachments.sending();
      startWords.textContent = full() ? 'Start when one frees up' : 'Start';
      note.replaceChildren(...(full()
        ? [`${me.running} of ${me.limit} running: this one waits in line and starts by itself when one stops.`,
          ...(W.isAdmin() ? [' Need more at once? ', h('a', { href: '/console-settings' }, 'Raise the limit in Settings'), '.'] : [])]
        : [`Runs on your ${runsOn(agent.value)}, from ${projects.repo() ? `${projects.repo()}\u2019s` : 'the'} default branch unless you name a branch.`]));
    }
    // New session pressed on its own screen: show what is missing, or focus the prompt, so the button always answers.
    function nudge() {
      if (!form.hidden && body.hidden) return projects.focus();
      if (!form.hidden) return prompt.focus();
      const card = noToken.querySelector('.setup-card');
      W.shell?.toast('Finish setup first: New session needs these steps.');
      if (!card) return;
      card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      card.classList.remove('is-nudged');
      void card.offsetWidth;
      card.classList.add('is-nudged');
    }
    return { el, update, applyQuery, nudge, stopDictating: dictation.stop };
  }

  W.createLauncher = createLauncher;
})();
