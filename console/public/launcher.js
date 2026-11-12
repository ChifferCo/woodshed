// New session on My Woodshed, after the shed's launcher: the project (on a console with more than one), a prompt, an
// optional name and issue, PR or branch,
// claude's model, effort and permission mode, files attached (the paperclip, a paste or a drop), and the repo's
// skills on `/`. The session it starts is private to whoever is signed in and
// runs on their own Claude token or Codex sign-in, so without either the form says where to save it instead. Built once and kept
// across the page's refreshes, so nothing typed into it is lost.
(function () {
  'use strict';
  const W = window.Woodshed;
  const { h } = W;

  // The values the console accepts (MODELS, EFFORTS and PERMISSION_MODES in sessions.mjs), first the default.
  const MODELS = [['', 'default', 'Claude’s own default'], ['opus', 'opus', 'Most capable'], ['sonnet', 'sonnet', 'Balanced, faster'],
    ['haiku', 'haiku', 'Smallest and quickest'], ['fable', 'fable', 'Newest generation']];
  const EFFORTS = [['', 'default'], ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh'], ['max', 'max']];
  const AGENTS = [['claude', 'Claude', 'Claude Code, on your Claude plan'], ['codex', 'Codex', 'OpenAI Codex, on your Codex sign-in or the team key']];
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

  function field(id, label, control, hint) {
    return h('div', { class: 'lfield' },
      h('label', { for: id, class: 'field-label' }, h('span', null, label), hint && h('span', { class: 'hint' }, hint)),
      control);
  }

  /**
   * The Project field: which repo the session works on, among those the person may start on (GET /api/my/projects),
   * with their default marked and Make my default beside any other. With one project it names it as text; hidden with none.
   * @param {() => void} changed  called when the pick or the projects change
   */
  function createProjectPicker(changed) {
    const picker = h('select', { id: 'l-project', class: 'field' });
    const status = h('span', { class: 'sub', role: 'status' });
    const makeDefault = h('button', { type: 'button', class: 'btn btn-plain', title: 'New session opens on this project for you' }, 'Make my default');
    // With one project there is nothing to pick, but the form still says which repo the session works on.
    const only = h('div', { class: 'project-only mono', id: 'l-project-only' });
    const label = h('label', { for: 'l-project', class: 'field-label' }, h('span', null, 'Project'), h('span', { class: 'hint' }, 'the repo it works on'));
    const el = h('div', { class: 'lfield', hidden: true }, label,
      h('div', { class: 'project-pick' }, picker, makeDefault),
      only,
      status);
    const pick = el.querySelector('.project-pick');
    let view = null;
    // A ?project= link picks for this visit only; it waits for the list when the page opens on it.
    let asked = null;
    function render() {
      const projects = view?.projects ?? [];
      el.hidden = projects.length === 0;
      const one = projects.length === 1;
      pick.hidden = one;
      only.hidden = !one;
      // With one project the select is hidden, so the label points at nothing.
      if (one) label.removeAttribute('for'); else label.setAttribute('for', 'l-project');
      only.textContent = one ? `${projects[0].name} \u00b7 ${projects[0].repo}` : '';
      const picked = picker.value || asked || view?.defaultProject;
      picker.replaceChildren(...projects.map((p) => h('option', { value: p.name },
        `${p.name} \u00b7 ${p.repo}${p.name === view.defaultProject ? ' \u2014 your default' : ''}`)));
      picker.value = projects.some((p) => p.name === picked) ? picked : (view?.defaultProject ?? '');
      makeDefault.hidden = !view || picker.value === view.defaultProject;
      changed();
    }
    picker.addEventListener('change', () => { status.textContent = ''; render(); });
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
    return {
      el,
      /** @returns {string}  the picked project, empty with one project: the server starts on the default */
      value: () => ((view?.projects.length ?? 0) < 2 ? '' : picker.value),
      /** @returns {string}  the picked project's repo, the only one's with one project */
      repo: () => view?.projects.find((p) => p.name === picker.value)?.repo ?? '',
      ask(name) {
        asked = name;
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
    const name = h('input', { id: 'l-name', class: 'field', autocomplete: 'off', placeholder: 'billing-currency' });
    const workOn = h('input', { id: 'l-on', class: 'field mono', autocomplete: 'off', placeholder: '#25812, PR #26030 or a branch' });
    const agent = select('l-agent', AGENTS);
    const model = select('l-model', MODELS);
    const effort = select('l-effort', EFFORTS);
    const mode = select('l-mode', MODES);
    // Start says its key (⌘↵, Ctrl+Enter elsewhere), which works from any field of the form; a phone has no keys.
    const K = window.WoodshedKeys;
    const startWords = h('span', null, 'Start');
    const start = h('button', { type: 'submit', class: 'btn btn-open', 'data-keys': 'start' }, startWords,
      h('span', { class: 'btn-keys', 'aria-hidden': 'true' }, K.caps(K.byId.start.mod, K.isMac(window.navigator)).map((k) => h('kbd', null, k))));
    const projects = createProjectPicker(() => { if (me) update(me); });
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
      picked.textContent = [model, effort, mode].map((s) => s.selectedOptions[0]?.textContent ?? '').join(' · ');
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
      fill(model, codex ? codexModelOptions() : MODELS);
      fill(effort, codex ? codexEffortOptions() : EFFORTS);
      fill(mode, codex ? CODEX_MODES : MODES);
      if (codex) loadCodexCatalog();
      codexNote.hidden = !codex || !codexCatalog?.note;
      prompt.placeholder = `What should ${codex ? 'Codex' : 'Claude'} do? Type / for the repo\u2019s skills.`;
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
    showPicked();
    const options = h('details', { class: 'loptions', open: !window.matchMedia('(max-width: 720px)').matches },
      h('summary', null, h('span', { class: 'field-label' }, 'Agent, model, effort and permissions'), picked),
      h('div', { class: 'lgrid4' }, field('l-agent', 'Agent', agent), field('l-model', 'Model', model), field('l-effort', 'Effort', effort), field('l-mode', 'Permissions', mode)), codexNote);
    const form = h('form', { class: 'launch-form' },
      projects.el,
      field('l-prompt', 'Prompt', promptWrap, 'optional with a PR or branch below: opens its review'),
      attachments.el, attachments.chips,
      h('div', { class: 'lgrid2' },
        field('l-name', 'Name', name, 'optional: Haiku names it from the prompt otherwise'),
        field('l-on', 'Work on', workOn, 'optional')),
      options,
      error,
      h('div', { class: 'launch-actions' }, start, note));
    // Until setup is done (a Claude token or a Codex sign-in, and databases ready where the console makes them), New session is the setup
    // card instead of the form: the server refuses a start until then.
    const noToken = h('div', { class: 'launch-setup', hidden: true });
    const tokenHelp = h('p', { class: 'sub' }, 'For Claude, run ', h('code', null, 'claude setup-token'),
      ' on your laptop. For Codex, run ', h('code', null, 'codex login'), ' and copy ', h('code', null, '~/.codex/auth.json'),
      ', or use an OpenAI API key. Save it on My settings: your sessions run on your own plan or sign-in.');
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
    }
    applyQuery();

    let me = null;
    const full = () => Boolean(me && me.running >= me.limit);
    form.addEventListener('keydown', (e) => {
      // The `/` menu's Enter picks a skill first, and only that.
      if (e.defaultPrevented || e.repeat || e.isComposing || K.match(e) !== 'start') return;
      e.preventDefault();
      if (!start.disabled) form.requestSubmit();
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      dictation.finish();
      const reviewOnly = !prompt.value.trim() && workOn.value.trim();
      if (!prompt.value.trim() && !reviewOnly) return prompt.focus();
      start.disabled = true;
      error.hidden = true;
      try {
        const session = await W.postJson('/api/my/sessions', {
          prompt: prompt.value, name: name.value, workOn: workOn.value, agent: agent.value, model: model.value, effort: effort.value, permissionMode: mode.value,
          ...(projects.value() ? { project: projects.value() } : {}),
          attachments: attachments.ids(),
        });
        // The page stays: the form is emptied for the next one, whose files those were not.
        prompt.value = '';
        name.value = '';
        workOn.value = '';
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
      // Only the agents set up to run are offered (`agents` in /api/my): a Claude token, or a Codex sign-in or the team's
      // OpenAI key. A console from before `agents` offers both.
      const offered = AGENTS.filter(([value]) => !me?.agents || me.agents[value]);
      const shown = offered.length ? offered : AGENTS.slice(0, 1);
      if (shown.map(([v]) => v).join() !== [...agent.options].map((o) => o.value).join()) {
        const was = agent.value;
        fill(agent, shown);
        if (shown.some(([v]) => v === was)) agent.value = was;
        else agentPicked = false;
        if (agent.value !== was) showAgent();
      }
      agent.disabled = shown.length < 2;
      const preferred = me?.codexAuth?.set && !me.claudeToken?.set && shown.some(([v]) => v === 'codex') ? 'codex' : shown[0][0];
      if (me && !agentPicked && agent.value !== preferred) {
        agent.value = preferred;
        showAgent();
      }
      // The server refuses a start until the databases are ready too, so the form waits for the same things the card does.
      const ready = Boolean(me) && W.setupDone(me);
      const refused = me?.databasesRefusal ?? null;
      noToken.hidden = ready && !refused;
      if (refused) {
        noToken.replaceChildren(h('p', { class: 'form-error', role: 'alert' }, `No session can start: ${refused}. Whoever runs this console adds the engine, or the project file drops that database.`));
      } else if (!ready && me) {
        noToken.replaceChildren(W.setupCard(me), ...(me.claudeToken?.set || me.codexAuth?.set ? [] : [tokenHelp]));
      }
      form.hidden = !ready || Boolean(refused);
      start.disabled = attachments.sending();
      startWords.textContent = full() ? 'Start when one frees up' : 'Start';
      note.replaceChildren(...(full()
        ? [`${me.running} of ${me.limit} running: this one waits in line and starts by itself when one stops.`,
          ...(W.isAdmin() ? [' Need more at once? ', h('a', { href: '/console-settings' }, 'Raise the limit in Console settings'), '.'] : [])]
        : [`Runs on your ${agent.value === 'codex' ? 'Codex sign-in or the team key' : 'Claude plan'}, from ${projects.repo() ? `${projects.repo()}\u2019s` : 'the'} default branch unless you name a branch.`]));
    }
    // New session pressed on its own screen: show what is missing, or focus the prompt, so the button always answers.
    function nudge() {
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
