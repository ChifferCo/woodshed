// `woodshed move`'s layout: which terminals were chosen, the spaces, tabs and splits they are in on this computer, and
// the same layout made again on the session's machine.
//
// Herdr keeps each machine's spaces, tabs and splits in its core's `herdr-app` document, read here through hc's API
// (`doc.get`) and never written: what is made is made with the Herdr app's own commands (`herdr-app do space.new`,
// `tab.new`, `pane.split`, `pane.swap`, `pane.close`) when its window is open. With no window, each terminal is started
// with the labels the app adopts terminals by (`herdr.space`, `herdr.tab`), so the spaces and tabs are there when it
// opens, their splits side by side.

import { spawn } from 'node:child_process';

/**
 * Runs a program with arguments (never a shell), with what is piped to it, for hc and herdr-app.
 * @returns {(args: string[], opts?: {input?: string|Buffer, timeoutMs?: number}) => Promise<{code: number|null, stdout: string, stderr: string, missing?: boolean, timedOut?: boolean}>}
 */
export function programRunner({ bin, env = process.env }) {
  return (args, { input = null, timeoutMs = 30_000 } = {}) => new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      resolve({ code: null, stdout: '', stderr: '', missing: true });
      return;
    }
    const out = [];
    const err = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout: '', stderr: String(e.message), missing: e.code === 'ENOENT' || e.code === 'EACCES' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), ...(timedOut ? { timedOut: true } : {}) });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? undefined);
  });
}

function parsed(text) {
  try {
    return JSON.parse(String(text).trim());
  } catch {
    return null;
  }
}

/** A program's own words for its failure: its JSON error, else its last line. */
export function failureOf(out) {
  const answer = parsed(out.stdout) ?? parsed(out.stderr);
  if (answer?.error) return typeof answer.error === 'string' ? answer.error : String(answer.error.message ?? JSON.stringify(answer.error));
  return `${out.stderr}\n${out.stdout}`.trim().split('\n').at(-1) || (out.timedOut ? 'it did not answer in time' : `it exited ${out.code}`);
}

/**
 * Reads a document from hc's core through its API (`hc connect`, one JSON-RPC call): the Herdr app's layout.
 * @returns {Promise<object|null>}  the document's value, or null when it cannot be read
 */
export async function readDoc(hc, name, { on = null } = {}) {
  const lines = [
    { jsonrpc: '2.0', id: 1, method: 'hello', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'doc.get', params: { name, ...(on ? { on } : {}) } },
  ].map((m) => JSON.stringify(m)).join('\n');
  const out = await hc(['connect'], { input: `${lines}\n`, timeoutMs: 10_000 });
  for (const line of String(out.stdout).split('\n')) {
    const message = parsed(line);
    if (message?.id === 2) return message.result?.value ?? null;
  }
  return null;
}

// A node of the app's layout tree as this module keeps it: a terminal, or terminals split right or down.
function treeOf(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'block') {
    const terminal = node.content?.terminal;
    return typeof terminal === 'string' ? { terminal, weight: node.size?.weight ?? null } : null;
  }
  if (!Array.isArray(node.children)) return null;
  const children = node.children.map(treeOf).filter(Boolean);
  return { split: node.type === 'column' ? 'down' : 'right', weight: node.size?.weight ?? null, children };
}

/** @returns {string[]}  a tree's terminals, left to right and top to bottom */
export function leavesOf(tree) {
  if (!tree) return [];
  return tree.terminal ? [tree.terminal] : tree.children.flatMap(leavesOf);
}

/** A tree with only these terminals, a split left with one child said as that child. */
export function prune(tree, keep) {
  if (!tree) return null;
  if (tree.terminal) return keep.has(tree.terminal) ? tree : null;
  const children = tree.children.map((c) => prune(c, keep)).filter(Boolean);
  if (!children.length) return null;
  if (children.length === 1) return { ...children[0], weight: tree.weight };
  return { ...tree, children };
}

/**
 * This computer's spaces and tabs, from the app's document, each tab's tree of terminals. Terminals the document has
 * not placed but whose labels name a space and tab are added to them, side by side.
 * @param {object|null} doc  the `herdr-app` document
 * @param {object[]} terminals  hc's live terminals here
 * @returns {{id: string, name: string, folder: string|null, tabs: {id: string, name: string, tree: object|null}[]}[]}
 */
export function localLayout(doc, terminals) {
  const spaces = [];
  for (const space of Array.isArray(doc?.spaces) ? doc.spaces : []) {
    if (!space || typeof space.id !== 'string') continue;
    spaces.push({
      id: space.id, name: typeof space.name === 'string' ? space.name : '', folder: typeof space.folder === 'string' ? space.folder : null,
      tabs: (Array.isArray(space.tabs) ? space.tabs : []).filter((t) => t && typeof t.id === 'string')
        .map((t) => ({ id: t.id, name: typeof t.name === 'string' ? t.name : '', tree: treeOf(t.root) })),
    });
  }
  const placed = new Set(spaces.flatMap((s) => s.tabs.flatMap((t) => leavesOf(t.tree))));
  for (const terminal of terminals) {
    const spaceId = terminal.labels?.['herdr.space'];
    const tabId = terminal.labels?.['herdr.tab'];
    if (placed.has(terminal.address) || !spaceId || !tabId) continue;
    let space = spaces.find((s) => s.id === spaceId);
    if (!space) spaces.push(space = { id: spaceId, name: '', folder: null, tabs: [] });
    let tab = space.tabs.find((t) => t.id === tabId);
    if (!tab) space.tabs.push(tab = { id: tabId, name: '', tree: null });
    const leaf = { terminal: terminal.address, weight: null };
    tab.tree = !tab.tree ? leaf : tab.tree.split === 'right' ? { ...tab.tree, children: [...tab.tree.children, leaf] } : { split: 'right', weight: null, children: [tab.tree, leaf] };
    placed.add(terminal.address);
  }
  return spaces;
}

/**
 * The terminals a move takes, and the spaces and tabs it makes them in: `--space` and `--tab` by id or name, and
 * `--terminal` by address or name. A chosen terminal in no space gets a space and tab of its own.
 * @returns {{spaces: {name: string, from: string|null, tabs: {name: string, from: string|null, tree: object}[]}[]}|{error: string}}
 */
export function choose(layout, terminals, { space = null, tab = null, terminal = [] }) {
  const byAddress = new Map(terminals.map((t) => [t.address, t]));
  const named = (want, list) => {
    const exact = list.filter((x) => x.id === want || x.id.endsWith(`/${want}`));
    return exact.length ? exact : list.filter((x) => x.name === want);
  };
  let keep;
  if (space) {
    const found = named(space, layout);
    if (found.length !== 1) return { error: found.length ? `more than one space is called ${space}: name it by id (herdr-app ls)` : `no space ${space} on this computer (herdr-app ls lists them)` };
    keep = new Set(found[0].tabs.flatMap((t) => leavesOf(t.tree)));
  } else if (tab) {
    const tabs = layout.flatMap((s) => s.tabs);
    const found = named(tab, tabs);
    if (found.length !== 1) return { error: found.length ? `more than one tab is called ${tab}: name it by id (herdr-app ls)` : `no tab ${tab} on this computer (herdr-app ls lists them)` };
    keep = new Set(leavesOf(found[0].tree));
  } else {
    keep = new Set();
    for (const want of terminal) {
      const t = byAddress.get(want) ?? terminals.find((x) => x.name === want);
      if (!t) return { error: `no live terminal ${want} on this computer (hc ls lists them)` };
      keep.add(t.address);
    }
  }
  keep = new Set([...keep].filter((address) => byAddress.has(address)));
  if (!keep.size) return { error: 'nothing to move: no live terminal there' };
  const spaces = [];
  const placed = new Set();
  for (const s of layout) {
    const tabs = s.tabs.map((t) => ({ name: t.name, from: t.id, tree: prune(t.tree, keep) })).filter((t) => t.tree);
    tabs.forEach((t) => leavesOf(t.tree).forEach((a) => placed.add(a)));
    if (tabs.length) spaces.push({ name: s.name, from: s.id, tabs });
  }
  const loose = [...keep].filter((a) => !placed.has(a));
  if (loose.length) spaces.push({ name: '', from: null, tabs: loose.map((a) => ({ name: byAddress.get(a).name ?? '', from: null, tree: { terminal: a, weight: null } })) });
  return { spaces };
}

/**
 * Each terminal's place, as the move bundle says it: its space and tab by name, the split that made it (right or
 * down of the terminal before it) and its share of that split.
 * @returns {Map<string, {space: string, tab: string, split: 'right'|'down'|null, ratio: number|null}>}
 */
export function placesOf(spaces) {
  const out = new Map();
  for (const s of spaces) {
    for (const t of s.tabs) {
      const walk = (node, split) => {
        if (node.terminal) {
          out.set(node.terminal, { space: s.name, tab: t.name, split, ratio: typeof node.weight === 'number' ? Math.round(node.weight * 100) / 100 : null });
          return;
        }
        node.children.forEach((c, i) => walk(c, i === 0 ? split : node.split));
      };
      walk(t.tree, null);
    }
  }
  return out;
}

/**
 * Runs `herdr-app do <command>` with its arguments as one JSON object.
 * @returns {Promise<object>}  what it answered; throws with its error
 */
export async function appDo(app, command, args) {
  const out = await app(['do', command, JSON.stringify(args)], { timeoutMs: 60_000 });
  const answer = parsed(out.stdout);
  if (out.code !== 0 || !answer || answer.error) throw Object.assign(new Error(`herdr-app ${command}: ${failureOf(out)}`), { app: true });
  return answer;
}

/** @returns {Promise<object|null>}  the open window's spaces (herdr-app ls), or null with no window */
export async function appSpaces(app) {
  const out = await app(['ls'], { timeoutMs: 10_000 });
  if (out.code !== 0 || out.missing) return null;
  return parsed(out.stdout);
}

// A space on a machine just added to hc: the window learns of the machine a moment later, and says it has none until it
// does (measured: a few seconds after `hc machine add`).
async function newSpace(app, args, { sleep, tries = 40 }) {
  for (let i = 0; ; i++) {
    try {
      return await appDo(app, 'space.new', args);
    } catch (err) {
      if (i >= tries || !/has no machine called/.test(err.message)) throw err;
      await sleep(500);
    }
  }
}

// A terminal on a machine by its address there (`woodshed-x/t1`), from its address or name: the window lists addresses.
async function addressOf(hc, machine, terminal) {
  const out = await hc(['get', '--json', `${machine}/${terminal}`]);
  const t = parsed(out.stdout);
  if (out.code !== 0 || typeof t?.address !== 'string') throw Object.assign(new Error(`hc get ${machine}/${terminal}: ${failureOf(out)}`), { app: true });
  return t.address.startsWith(`${machine}/`) ? t.address : `${machine}/${t.address}`;
}

// The pane the window shows a terminal in, waited for: a terminal the app adopts by its labels gets one once its machine
// answers.
async function paneOf(app, terminal, { sleep, tries = 40 } = {}) {
  for (let i = 0; i < tries; i++) {
    const ls = await appSpaces(app);
    for (const s of ls?.spaces ?? []) {
      for (const t of s.tabs ?? []) {
        for (const x of t.terminals ?? []) if (x.terminal === terminal && x.pane) return { pane: x.pane, space: s.id, tab: t.id };
      }
    }
    await sleep(250);
  }
  return null;
}

/**
 * The chosen layout made on a machine through the open Herdr window. Each terminal is started by `start(address)`,
 * which says what it runs there: `{argv, folder}`, or `{adopt: <terminal>}` for one already running there (the
 * session's own agent), which takes the place a stand-in shell held.
 * `onSpace` hears of each space as it is made, so a failure part way can close it.
 * @returns {Promise<{spaces: {id: string, name: string}[], terminals: Map<string, string>}>}  the spaces made, and
 *          each moved terminal's address there
 */
export async function buildWithApp({ app, hc, machine, spaces, start, sleep, onSpace = () => {} }) {
  const made = { spaces: [], terminals: new Map() };
  const adopts = [];
  const qualified = (t) => (String(t).includes('/') ? String(t) : `${machine}/${t}`);
  // The first terminal of a tab or a split: what it runs, or a stand-in shell where a running terminal will go.
  const opening = (address) => {
    const how = start(address);
    if (how.adopt) return { folder: how.folder, argv: null, adopt: how.adopt };
    return { folder: how.folder, argv: how.argv, adopt: null };
  };
  const note = (address, terminal, how, pane, where) => {
    if (how.adopt) adopts.push({ address, adopt: how.adopt, standIn: pane, ...where });
    else made.terminals.set(address, qualified(terminal));
  };
  const grow = async (node, pane, where) => {
    if (node.terminal) return;
    const panes = [pane];
    for (let i = 1; i < node.children.length; i++) {
      const first = leavesOf(node.children[i])[0];
      const how = opening(first);
      const split = await appDo(app, 'pane.split', { direction: node.split, pane: panes[i - 1], ...(how.argv ? { argv: how.argv } : {}) });
      note(first, split.terminal, how, split.pane, where);
      panes.push(split.pane);
    }
    for (let i = 0; i < node.children.length; i++) await grow(node.children[i], panes[i], where);
  };
  for (const space of spaces) {
    let spaceId = null;
    for (const tab of space.tabs) {
      const first = leavesOf(tab.tree)[0];
      const how = opening(first);
      const args = { ...(how.folder ? { folder: how.folder } : {}), ...(how.argv ? { argv: how.argv } : {}), focus: false };
      const answer = spaceId
        ? await appDo(app, 'tab.new', { ...args, space: spaceId, ...(tab.name ? { name: tab.name } : {}) })
        : await newSpace(app, { ...args, machine, ...(space.name ? { name: space.name } : {}), ...(tab.name ? { tab: tab.name } : {}) }, { sleep });
      if (!spaceId) {
        spaceId = answer.space;
        made.spaces.push({ id: spaceId, name: space.name });
        onSpace({ id: spaceId, name: space.name });
      }
      const at = await paneOf(app, qualified(answer.terminal), { sleep });
      if (!at) throw Object.assign(new Error(`herdr-app: the new tab's terminal ${answer.terminal} never showed in the window`), { app: true });
      note(first, answer.terminal, how, at.pane, { space: spaceId, tab: answer.tab });
      await grow(tab.tree, at.pane, { space: spaceId, tab: answer.tab });
    }
  }
  // A terminal already running there takes its stand-in's place: the app adopts it into the tab by its labels (written
  // with the machine's own ids), it is swapped where the stand-in is, and the stand-in closed.
  for (const a of adopts) {
    const local = (id) => String(id).slice(String(id).startsWith(`${machine}/`) ? machine.length + 1 : 0);
    const terminal = await addressOf(hc, machine, a.adopt);
    const labelled = await hc(['label', '--json', terminal, `herdr.space=${local(a.space)}`, `herdr.tab=${local(a.tab)}`]);
    if (labelled.code !== 0) throw Object.assign(new Error(`hc label ${terminal}: ${failureOf(labelled)}`), { app: true });
    const at = await paneOf(app, terminal, { sleep });
    if (!at) throw Object.assign(new Error(`herdr-app: ${terminal} never showed in its tab`), { app: true });
    await appDo(app, 'pane.swap', { pane: at.pane, target: a.standIn });
    await appDo(app, 'pane.close', { pane: a.standIn });
    made.terminals.set(a.address, terminal);
  }
  return made;
}

/**
 * The chosen layout started on a machine with no Herdr window: each terminal with the labels the app adopts it by, in
 * new spaces and tabs named by this move, side by side in each tab.
 * @returns {Promise<{spaces: {id: string, name: string}[], terminals: Map<string, string>}>}
 */
export async function buildWithLabels({ hc, machine, spaces, start, tag, onTerminal = () => {} }) {
  const made = { spaces: [], terminals: new Map() };
  for (const [s, space] of spaces.entries()) {
    const spaceId = `${tag}-s${s + 1}`;
    made.spaces.push({ id: `${machine}/${spaceId}`, name: space.name });
    for (const [t, tab] of space.tabs.entries()) {
      const labels = ['--label', `herdr.space=${spaceId}`, '--label', `herdr.tab=${spaceId}-t${t + 1}`];
      for (const address of leavesOf(tab.tree)) {
        const how = start(address);
        if (how.adopt) {
          const terminal = await addressOf(hc, machine, how.adopt);
          const out = await hc(['label', '--json', terminal, `herdr.space=${spaceId}`, `herdr.tab=${spaceId}-t${t + 1}`]);
          if (out.code !== 0) throw Object.assign(new Error(`hc label ${terminal}: ${failureOf(out)}`), { app: true });
          made.terminals.set(address, terminal);
          continue;
        }
        const out = await hc(['run', '--json', '--bg', '--on', machine, '--keep', '--no-parent', ...(how.folder ? ['--cwd', how.folder] : []), ...labels, '--', ...how.argv]);
        const answer = parsed(out.stdout);
        if (out.code !== 0 || typeof answer?.address !== 'string') throw Object.assign(new Error(`hc run on ${machine}: ${failureOf(out)}`), { app: true });
        made.terminals.set(address, answer.address.includes('/') ? answer.address : `${machine}/${answer.address}`);
        onTerminal(made.terminals.get(address));
      }
    }
  }
  return made;
}
