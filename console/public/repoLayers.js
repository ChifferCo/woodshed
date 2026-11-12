// The parts of a repo's layered settings that both of its pages draw (designSystem/components/LayeredFile): a repo's
// page on Console settings (repoSettings.js) and the Repo settings card on My settings (myRepoSettings.js). Each layer
// is a row with its word as a tag; the table names keys, never a value.
(function () {
  'use strict';
  const W = window.Woodshed;
  const { h } = W;
  const LAYER_WORDS = { repo: 'Repo', installation: 'Installation', personal: 'Person', session: 'Session' };

  const bytesOf = (text) => new TextEncoder().encode(text).length;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  function savedLine(record) {
    if (!record) return 'None yet.';
    const by = record.by === 'terraform env_files' ? 'copied from Terraform' : record.by ? `by @${record.by}` : '';
    return [`Saved ${W.when(record.savedAt)}`, by, `${record.bytes.toLocaleString()} bytes`, record.keys && plural(record.keys.length, 'key', 'keys')].filter(Boolean).join(' · ');
  }

  function layer(word, title, ...body) {
    return h('div', { class: `layer is-${word}` },
      h('div', { class: 'layer-head' }, h('span', { class: 'layer-tag' }, LAYER_WORDS[word]), h('h3', null, title)),
      body);
  }

  function keyList(keys) {
    return keys.map((k, i) => [i ? ', ' : '', h('code', null, k)]);
  }

  function githubFile(repo, filePath) {
    return `https://github.com/${repo}/blob/HEAD/${filePath}`;
  }

  function defaultsLayer(f, repo) {
    return layer('repo', 'From the repo',
      f.defaults.length ? h('pre', { class: 'layer-pre' }, f.defaults.join('\n')) : h('p', { class: 'layer-text is-none' }, 'No defaults.'),
      h('p', { class: 'sub' }, 'Change it in ', h('a', { href: githubFile(repo, '.woodshed/project.yaml'), target: '_blank', rel: 'noopener' }, '.woodshed/project.yaml ↗'), '.'));
  }

  function sessionLayer(f) {
    const optional = new Set(f.wiring.optional);
    const always = f.wiring.lines.filter((k) => !optional.has(k));
    const parts = [
      always.length && h('p', { class: 'layer-text' }, 'Its lines: ', keyList(always), '.'),
      optional.size > 0 && h('p', { class: 'layer-text' }, 'Only when the session has a value for it: ', keyList([...optional]), '.'),
      f.wiring.env.length > 0 && h('p', { class: 'layer-text' }, 'The project file\'s env, set in every process: ', keyList(f.wiring.env), '.'),
    ].filter(Boolean);
    return layer('session', 'Set by the session', parts.length ? parts : h('p', { class: 'layer-text is-none' }, 'Nothing.'),
      h('p', { class: 'sub' }, 'Woodshed writes these last, with the session\'s databases, ports and URLs, so they win whatever the layers above say.'));
  }

  // What wins a key the session sets itself: its lines, the project file's env, or one of Woodshed's own variables.
  function sessionCell(f, row) {
    if (f.wiring.lines.includes(row.key)) return f.wiring.optional.includes(row.key) ? '✓ if set' : '✓';
    if (f.wiring.env.includes(row.key)) return 'env';
    return row.wins === 'session' ? 'Woodshed' : '';
  }

  function winsWord(f, row, yours) {
    if (row.wins === 'session' && f.wiring.optional.includes(row.key)) return 'Session, if set';
    if (row.wins === 'personal' && yours) return 'Yours';
    return LAYER_WORDS[row.wins];
  }

  /**
   * One row per key any layer sets, and the layer that wins it.
   * @param {object} f  an env file of the view
   * @param {{yours?: boolean}} [opts]  My settings' table, with the person's own layer as Yours
   */
  function keyTable(f, { yours = false } = {}) {
    if (!f.table.length) return h('p', { class: 'sub' }, 'No layer sets a key yet.');
    const mark = (row, word) => (row.setBy.includes(word) ? '✓' : '');
    return h('div', { class: 'table-box' },
      h('table', { class: 'layer-table' },
        h('thead', null, h('tr', null, h('th', null, 'Key'), h('th', null, 'Repo'), h('th', null, 'Installation'), yours && h('th', null, 'Yours'), h('th', null, 'Session'), h('th', null, 'Wins'))),
        h('tbody', null, f.table.map((row) => h('tr', null,
          h('td', { class: 'mono' }, row.key),
          h('td', { class: 'mark' }, mark(row, 'repo')),
          h('td', { class: 'mark' }, mark(row, 'installation')),
          yours && h('td', { class: 'mark' }, mark(row, 'personal')),
          h('td', { class: 'mark' }, sessionCell(f, row)),
          h('td', null, h('span', { class: `layer-tag is-wins is-${row.wins}` }, winsWord(f, row, yours))))))));
  }

  // The repo's own instructions: links to its rules and setup notes on GitHub.
  function repoRules(view) {
    const { rules, setup } = view.projectFile;
    const link = (p) => h('a', { href: githubFile(view.repo, p), target: '_blank', rel: 'noopener' }, `${p} ↗`);
    if (!view.projectFile.read) return h('p', { class: 'layer-text is-none' }, 'Unknown: the project file could not be read.');
    if (!rules && !setup) return h('p', { class: 'layer-text is-none' }, 'None: the project file names no rules or setup notes.');
    return h('p', { class: 'layer-text' }, rules && ['Rules: ', link(rules)], rules && setup && ' · ', setup && ['Setup notes: ', link(setup)]);
  }

  window.WoodshedRepoLayers = {
    INSTRUCTIONS_MAX_BYTES: 16 * 1024,
    NO_CREDENTIALS: 'No production credentials or integration tokens: sessions run unattended, and anything here can end up in a log, a commit or a pull request.',
    LAYER_WORDS, bytesOf, plural, savedLine, layer, keyList, defaultsLayer, sessionLayer, keyTable, repoRules,
  };
})();
