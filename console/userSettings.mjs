// What each person sets on My settings, kept apart by GitHub login. Values live in Secrets Manager under
// `users/<login>/`, write-only on the page; state.json keeps only when each was saved, so a page load never
// calls AWS. Only a private session of the same login is ever handed one (sessionApi.mjs), and the Claude token not
// even that: the console's Anthropic proxy adds it to the session's calls (anthropicProxy.mjs).
//
//   users/<login>/claude-token   from `claude setup-token`: the person's own Claude plan
//   users/<login>/codex-auth     the person's own Codex sign-in: an OpenAI API key, or the ~/.codex/auth.json of `codex login`.
//                                Handed to their private Codex sessions, which write a refreshed login back (sessionApi.mjs)
//   users/<login>/grok-auth, opencode-auth   the person's own sign-in for Grok Build (an xAI key or ~/.grok/auth.json)
//                                and OpenCode (its auth.json): those agents run on nothing else (shared/agents.cjs).
//                                Handed to their private sessions of that agent alone; their logins rotate, so a session
//                                writes the refreshed one back
//   users/<login>/tmux-conf      ~/.tmux.conf, which their sessions write after the console's shared file, so a change to
//                                that still reaches them. Readable by them, since their sessions hold the same text anyway
//   users/<login>/gitconfig, inputrc, bash-aliases   their own lines for those files, the same way: only what
//                                shared/dotfiles.mjs takes, which never holds a credential, an identity or a path
//   users/<login>/own-files      legacy: their own whole files from before they were per repo, which repoSettings.mjs moves
//                                into the default project's (moveOwnFiles); deleted here with the rest by Remove My Woodshed
//   users/<login>/github         their GitHub user token, from Connect GitHub (githubUser.mjs), as JSON
//   users/<login>/database       the password of their own databases' user (databases.mjs)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import logins from './public/logins.cjs';
import { DOTFILES, dotfileProblem } from '../shared/dotfiles.mjs';
import { SETTINGS, settingProblem } from './consoleSettings.mjs';
import agents from '../shared/agents.cjs';
const { loginKey } = logins;

// Who may review a person's pull requests, as reviewAgents.mjs reads it: a preset's name, or reviewers joined with `+`
// (shared/agents.cjs, reviewersOf), kept as reviewChoiceOf writes it.
const reviewChoice = (choice) => {
  const reviewers = agents.reviewersOf(choice);
  return reviewers ? agents.reviewChoiceOf(reviewers) : null;
};
// What the person's private sessions run their agent in (session/agentPane.mjs): tmux, as every session does, or Herdr's
// terminal runtime, which their own Herdr can attach to. tmux is the default, and the only one for every other session.
export const TERMINALS = Object.freeze(['tmux', 'herdr']);

const CLAUDE_TOKEN = 'claude-token';
const CODEX_AUTH = 'codex-auth';
const GITHUB = 'github';
const OWN_FILES = 'own-files';
const MAX_IDENTITY_CHARS = 200;
const MAX_TOKEN_CHARS = 1000;
const MAX_CODEX_AUTH_CHARS = 20_000;
// Secrets Manager's limit on one value.
const MAX_FILE_BYTES = 65_536;
const HOUR_MS = 3_600_000;
// How often a page load asks the secret store whether a person's Claude token or Codex sign-in is there (refresh): My
// Woodshed polls every few seconds, and on AWS each read is an `aws` CLI call. A start or resume asks every time.
const FRESH_MS = 60_000;
// The console settings a person may override for their own My Woodshed sessions, with the same ranges.
const OWN_LIMIT_KEYS = ['idleHours', 'lifetimeHours'];
const OWN_LIMITS = SETTINGS.filter((setting) => OWN_LIMIT_KEYS.includes(setting.key));
const TMUX_DEFAULT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'session', 'tmux.conf');

const TMUX_FILE = { label: '~/.tmux.conf', shared: TMUX_DEFAULT };

// The files a person may add their own lines to: tmux's, which is the session image's own tmux.conf (the console image
// carries it too), and a few dotfiles the image has none of its own for (shared/dotfiles.mjs). Their own lines for the
// repo's env files are Repo settings (repoSettings.mjs).
const FILES = { 'tmux-conf': TMUX_FILE, ...Object.fromEntries(Object.entries(DOTFILES).map(([key, { label }]) => [key, { label, shared: null }])) };

/**
 * @param {unknown} text
 * @returns {string}  the lines to store, with Windows line endings made Unix ones; empty when there are none
 * @throws {Error}  with a message the page can show
 */
export function checkFile(text) {
  if (typeof text !== 'string') throw Object.assign(new Error('the file must be text'), { shown: true });
  const file = text.replace(/\r\n/g, '\n');
  if (!file.trim()) return '';
  if (Buffer.byteLength(file) > MAX_FILE_BYTES) throw Object.assign(new Error('the file is over the 64 KB a secret can hold'), { shown: true });
  return file;
}

/** @returns {string}  the secret's name under the console's prefix */
export function userSecretName(login, key) {
  return `users/${loginKey(login)}/${key}`;
}

/**
 * @param {unknown} value
 * @returns {string}  the token to store
 * @throws {Error}  with a message the page can show, never containing the value
 */
export function checkClaudeToken(value) {
  if (typeof value !== 'string') throw Object.assign(new Error('the token must be text'), { shown: true });
  // `claude setup-token` wraps the token across the terminal's lines, so a copy of it often holds line breaks and
  // spaces. A token has none of its own.
  const token = value.replace(/\s+/g, '');
  if (!token) throw Object.assign(new Error('paste the token first'), { shown: true });
  if (token.length > MAX_TOKEN_CHARS || !token.startsWith('sk-ant-')) {
    throw Object.assign(new Error('this is not a token from claude setup-token: those start with sk-ant-'), { shown: true });
  }
  return token;
}

/**
 * @param {unknown} value  an OpenAI API key, or the text of ~/.codex/auth.json
 * @returns {string}  what to store: the key alone, or the auth file as one line of JSON
 * @throws {Error}  with a message the page can show, never containing the value
 */
export function checkCodexAuth(value) {
  if (typeof value !== 'string') throw Object.assign(new Error('the sign-in must be text'), { shown: true });
  const text = value.trim();
  if (!text) throw Object.assign(new Error('paste your Codex sign-in first'), { shown: true });
  if (text.length > MAX_CODEX_AUTH_CHARS) throw Object.assign(new Error('that is too long for a Codex sign-in'), { shown: true });
  if (/^sk-[^\s]+$/.test(text)) return text;
  let auth;
  try {
    // zsh ends output with no final newline in a `%`, which a copy of `cat ~/.codex/auth.json` takes along.
    auth = JSON.parse(text.replace(/\}\s*%$/, '}'));
  } catch {
    throw Object.assign(new Error('paste an OpenAI API key (sk-…) or the contents of ~/.codex/auth.json'), { shown: true });
  }
  if (typeof auth !== 'object' || auth === null || Array.isArray(auth) || !(auth.tokens?.refresh_token || auth.OPENAI_API_KEY)) {
    throw Object.assign(new Error('that is not a Codex auth.json: run codex login, then paste ~/.codex/auth.json'), { shown: true });
  }
  return JSON.stringify(auth);
}

/**
 * @param {unknown} values  `{idleHours, lifetimeHours}`; a key left out or null goes back to the console's number
 * @returns {Record<string, number>}  the overrides to keep
 * @throws {Error}  with a message the page can show
 */
export function checkLimits(values) {
  if (typeof values !== 'object' || values === null || Array.isArray(values)) throw Object.assign(new Error('the limits must be an object'), { shown: true });
  const out = {};
  for (const setting of OWN_LIMITS) {
    const value = values[setting.key];
    if (value === undefined || value === null || value === '') continue;
    const problem = settingProblem(setting, value);
    if (problem) throw Object.assign(new Error(problem), { shown: true });
    out[setting.key] = Number(value);
  }
  return out;
}

/**
 * @param {{name: unknown, email: unknown}} identity  what a person's commits say, from My settings
 * @returns {{name: string, email: string}}
 * @throws {Error}  with a message the page can show
 */
export function checkIdentity({ name, email }) {
  const n = String(name ?? '').trim();
  const e = String(email ?? '').trim();
  if (!n || n.length > MAX_IDENTITY_CHARS || /[<>\n]/.test(n)) throw Object.assign(new Error('the name must be one line, without < or >'), { shown: true, status: 400 });
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(e) || e.length > MAX_IDENTITY_CHARS) throw Object.assign(new Error('that is not an email address'), { shown: true, status: 400 });
  return { name: n, email: e };
}

/**
 * @param {{store: {state: object, save: () => void}, secrets: {read: Function, save: Function, remove: Function}|null,
 *          now?: () => number}} deps  `secrets` is null where the console has no Secrets Manager: nothing can be saved
 */
export function createUserSettings({ store, secrets, now = Date.now }) {
  function people() {
    store.state.people ??= {};
    return store.state.people;
  }

  // Once, the first start after the default grew to every reviewer. A person who already had a Grok Build or OpenCode
  // sign-in keeps the previous default (Claude Code and Codex) until they set reviews back to the default. That switch
  // was already on, and it used to mean "when you pick this agent", so joining the default by itself would send their
  // pull requests to that provider with no new choice. Someone who saves a sign-in after this has no mark, and the
  // wider default includes it. A sign-in written straight into the store, which this mark cannot see until refresh
  // reads it, is kept the same way there.
  function keepPreviousReviewDefault() {
    if (store.state.reviewDefaultKept) return;
    let kept = 0;
    for (const record of Object.values(store.state.people ?? {})) {
      if (!record || typeof record !== 'object' || record.reviewDefault) continue;
      const saved = record.agentAuthAt;
      const had = saved && agents.OWN_SIGN_IN_AGENTS.some((id) => agents.agent(id).reviews && saved[id]);
      if (!had) continue;
      record.reviewDefault = 'legacy';
      kept += 1;
    }
    store.state.reviewDefaultKept = true;
    store.save();
    console.log('userSettings: previous review default kept', { people: kept });
  }
  keepPreviousReviewDefault();

  // Own properties alone: `constructor` is a valid login, and a name every object has.
  function recordFor(login) {
    return Object.hasOwn(people(), loginKey(login)) ? people()[loginKey(login)] : null;
  }

  function touch(login, fields) {
    people()[loginKey(login)] = { ...recordFor(login), ...fields };
    store.save();
  }

  // When each person's store was last asked about their sign-ins (refresh), by login key.
  const askedAt = new Map();

  /**
   * A Claude token or Codex sign-in that is in the secret store counts as saved, whoever put it there: a token written
   * straight into the store as `users/<login>/claude-token`, beside the console, counts as one saved on My settings. The
   * record here, which the pages read without calling the store, follows what is there. A store that fails to answer
   * changes nothing, and is not asked again until the minute is up.
   * @param {string} login
   * @param {{force?: boolean}} [opts]  true asks now, for a start or resume that needs the answer
   */
  async function refresh(login, { force = false } = {}) {
    // An App (`<slug>[bot]`, the author of a pull request a console's App opened) has no sign-ins of its own, and a
    // secret store may refuse the name: Secrets Manager does, `[` and `]` being no characters it takes.
    if (!login || login.endsWith('[bot]') || !secrets || secrets.configured?.() === false) return;
    const key = loginKey(login);
    const record = recordFor(login);
    if (!force && now() - (askedAt.get(key) ?? -Infinity) < FRESH_MS) return;
    askedAt.set(key, now());
    let token;
    let codex;
    let own;
    try {
      [token, codex, ...own] = await Promise.all([
        secrets.read(userSecretName(login, CLAUDE_TOKEN)), secrets.read(userSecretName(login, CODEX_AUTH)),
        ...agents.OWN_SIGN_IN_AGENTS.map((id) => secrets.read(userSecretName(login, agents.agent(id).signIn.secret))),
      ]);
    } catch (err) {
      console.warn('userSettings: stored sign-ins not read', { login, message: String(err?.message ?? err).split('\n')[0] });
      return;
    }
    const at = new Date(now()).toISOString();
    const changes = {};
    if (Boolean(token) !== Boolean(record?.claudeTokenAt)) changes.claudeTokenAt = token ? at : null;
    if (Boolean(codex) !== Boolean(record?.codexAuthAt)) changes.codexAuthAt = codex ? at : null;
    const ownAt = { ...record?.agentAuthAt };
    let ownChanged = false;
    agents.OWN_SIGN_IN_AGENTS.forEach((id, i) => {
      if (Boolean(own[i]) === Boolean(ownAt[id])) return;
      ownChanged = true;
      if (own[i]) ownAt[id] = at;
      else delete ownAt[id];
    });
    if (ownChanged) changes.agentAuthAt = ownAt;
    // The mark above only sees agentAuthAt. A Grok Build or OpenCode sign-in that is in the store and not yet on this
    // record was not saved on My settings: written on the old release before this console looked it up, or straight
    // into the store since. Keep the previous default until they accept the wider one. Each sign-in is checked on its
    // own: saving a different one through My settings writes that one's metadata first, and must not hide this one.
    // An explicit save writes agentAuthAt before it returns, so that sign-in is not discovered here. A first
    // command-line save stores the reviews switch off before the secret, so a stop after the secret lands still
    // discovers it with the switch off. One they accepted (`all`) or who is already kept (`legacy`) stays there.
    // A Claude token or a Codex sign-in never marks it.
    const reviewsSignIn = (id) => agents.agent(id).reviews;
    const discoveredReviewSignIn = agents.OWN_SIGN_IN_AGENTS.some((id) => reviewsSignIn(id) && ownAt[id] && !record?.agentAuthAt?.[id]);
    if (discoveredReviewSignIn && record?.reviewDefault !== 'all' && record?.reviewDefault !== 'legacy') changes.reviewDefault = 'legacy';
    if (!Object.keys(changes).length) return;
    touch(login, changes);
    console.log('userSettings: sign-ins follow the secret store', {
      login, claudeToken: Boolean(token), codexAuth: Boolean(codex), ...Object.fromEntries(agents.OWN_SIGN_IN_AGENTS.map((id, i) => [id, Boolean(own[i])])),
      ...(changes.reviewDefault === 'legacy' ? { reviewDefault: 'legacy' } : {}),
    });
  }

  function requireSecrets() {
    if (!secrets) throw Object.assign(new Error('this console has no secret store, so My settings cannot be saved'), { shown: true });
  }

  /**
   * @returns {{claudeToken: {set: boolean, savedAt: string|null}, codexAuth: {set: boolean, savedAt: string|null}, files: Record<string, {custom: boolean, savedAt: string|null}>,
   *            setUp: boolean, available: boolean}}
   */
  function view(login) {
    const record = recordFor(login);
    const files = Object.fromEntries(Object.keys(FILES).map((key) => {
      const savedAt = record?.files?.[key] ?? null;
      return [key, { custom: Boolean(savedAt), savedAt, label: FILES[key].label }];
    }));
    const github = record?.github;
    return {
      claudeToken: { set: Boolean(record?.claudeTokenAt), savedAt: record?.claudeTokenAt ?? null },
      codexAuth: { set: Boolean(record?.codexAuthAt), savedAt: record?.codexAuthAt ?? null },
      // Each agent that runs on its owner's own sign-in alone (shared/agents.cjs): whether one is saved.
      agentAuth: Object.fromEntries(agents.OWN_SIGN_IN_AGENTS.map((id) => [id, { set: Boolean(record?.agentAuthAt?.[id]), savedAt: record?.agentAuthAt?.[id] ?? null }])),
      ownTokenForShared: record?.ownTokenForShared !== false,
      ownCodexForReviews: record?.ownCodexForReviews !== false,
      // Whether reviews of their pull requests may run Grok Build and OpenCode on their own sign-in (reviewAgents.mjs).
      ownAgentForReviews: Object.fromEntries(agents.OWN_SIGN_IN_AGENTS.filter((id) => agents.agent(id).reviews)
        .map((id) => [id, usesOwnAgentForReviews(login, id)])),
      reviewAgents: reviewChoice(record?.reviewAgents),
      reviewModels: agents.reviewModelsOf(record?.reviewModels),
      // False while a Grok Build or OpenCode sign-in saved before the wider default is still kept out of it.
      expandedReviewDefault: usesExpandedReviewDefault(login),
      terminal: terminal(login),
      limits: { ...record?.limits },
      github: { connected: Boolean(github?.connectedAt), connectedAt: github?.connectedAt ?? null, name: github?.name ?? null, email: github?.email ?? null },
      home: { saved: Boolean(record?.home?.savedAt), savedAt: record?.home?.savedAt ?? null, bytes: record?.home?.bytes ?? 0 },
      files,
      setUp: Boolean(record),
      available: Boolean(secrets) && secrets.configured?.() !== false,
    };
  }

  function requireFile(key) {
    if (!Object.hasOwn(FILES, key)) throw Object.assign(new Error(`no file called ${key}`), { shown: true });
  }

  /** @returns {string}  the image's file: what every session starts from; empty for one the image has none of */
  function sharedFile(key) {
    requireFile(key);
    return FILES[key].shared ? fs.readFileSync(FILES[key].shared, 'utf8') : '';
  }

  /** @returns {Promise<string|null>}  the person's own lines, or null while they have none */
  async function ownFile(login, key) {
    requireFile(key);
    if (!secrets || !recordFor(login)?.files?.[key]) return null;
    return secrets.read(userSecretName(login, key));
  }

  /**
   * @returns {Promise<{key: string, label: string, text: string, custom: boolean, sharedText: string, editable: false,
   *                    appended: string[]}>}
   */
  async function file(login, key) {
    const own = await ownFile(login, key);
    return { key, label: FILES[key].label, text: own ?? '', custom: own !== null, sharedText: sharedFile(key), editable: false, appended: [] };
  }

  async function saveFile(login, key, text) {
    requireSecrets();
    requireFile(key);
    const value = checkFile(text);
    if (!value) return resetFile(login, key);
    const problem = Object.hasOwn(DOTFILES, key) ? dotfileProblem(key, value) : null;
    if (problem) {
      console.log('userSettings: file refused', { login, key, why: problem.split(':')[0] });
      throw Object.assign(new Error(problem), { shown: true });
    }
    await secrets.save(userSecretName(login, key), value, `Woodshed: @${login}'s ${FILES[key].label}, for their My Woodshed sessions only`);
    const record = recordFor(login);
    touch(login, { files: { ...record?.files, [key]: new Date(now()).toISOString() } });
    console.log('userSettings: file saved', { login, key, bytes: Buffer.byteLength(value) });
  }

  async function resetFile(login, key) {
    requireSecrets();
    requireFile(key);
    await secrets.remove(userSecretName(login, key));
    const record = recordFor(login);
    touch(login, { files: { ...record?.files, [key]: null } });
    console.log('userSettings: own lines cleared', { login, key });
  }

  /** @returns {Promise<object|null>}  what githubUser.mjs kept from Connect GitHub, or null when not connected */
  async function githubCredentials(login) {
    if (!secrets || !recordFor(login)?.github?.connectedAt) return null;
    const value = await secrets.read(userSecretName(login, GITHUB));
    return value ? JSON.parse(value) : null;
  }

  /** @param {{name: string, email: string}} [identity]  only on connecting; a refresh keeps what they had */
  async function saveGitHub(login, credentials, identity) {
    requireSecrets();
    await secrets.save(userSecretName(login, GITHUB), JSON.stringify(credentials), `Woodshed: @${login}'s GitHub user token, for their My Woodshed sessions only`);
    const github = recordFor(login)?.github;
    touch(login, { github: { ...github, connectedAt: github?.connectedAt ?? new Date(now()).toISOString(), ...identity } });
  }

  async function forgetGitHub(login) {
    if (secrets) await secrets.remove(userSecretName(login, GITHUB));
    touch(login, { github: null });
  }

  async function setGitIdentity(login, identity) {
    const github = recordFor(login)?.github;
    if (!github?.connectedAt) throw Object.assign(new Error('connect GitHub first: until then your sessions commit as woodshed-bot'), { shown: true });
    touch(login, { github: { ...github, ...checkIdentity(identity) } });
    console.log('userSettings: git identity changed', { login });
  }

  /** @returns {{name: string, email: string}|null}  what a private session's commits say, once GitHub is connected */
  function gitIdentity(login) {
    const github = recordFor(login)?.github;
    return github?.connectedAt && github.name && github.email ? { name: github.name, email: github.email } : null;
  }

  /** The saved Claude home itself is in the provider's home store; this notes when, and how big, for My settings. */
  function noteHome(login, bytes) {
    if (!recordFor(login)) return;
    touch(login, { home: bytes ? { savedAt: new Date(now()).toISOString(), bytes } : null });
  }

  /**
   * Each file's own lines for a private session, by its key (`tmux-conf`); null is none.
   * @param {string} login
   * @returns {Promise<Record<string, string|null>>}
   */
  async function ownFiles(login) {
    const keys = Object.keys(FILES);
    const values = await Promise.all(keys.map((key) => ownFile(login, key)));
    return Object.fromEntries(keys.map((key, i) => [key, values[i]]));
  }

  async function setClaudeToken(login, value) {
    requireSecrets();
    const token = checkClaudeToken(value);
    await secrets.save(userSecretName(login, CLAUDE_TOKEN), token, `Woodshed: @${login}'s Claude token, for their My Woodshed sessions only`);
    touch(login, { claudeTokenAt: new Date(now()).toISOString() });
    console.log('userSettings: Claude token saved', { login });
  }

  async function removeClaudeToken(login) {
    requireSecrets();
    await secrets.remove(userSecretName(login, CLAUDE_TOKEN));
    touch(login, { claudeTokenAt: null });
    console.log('userSettings: Claude token removed', { login });
  }

  async function setCodexAuth(login, value) {
    requireSecrets();
    const auth = checkCodexAuth(value);
    await secrets.save(userSecretName(login, CODEX_AUTH), auth, `Woodshed: @${login}'s Codex sign-in, for their My Woodshed Codex sessions only`);
    touch(login, { codexAuthAt: new Date(now()).toISOString() });
    console.log('userSettings: Codex sign-in saved', { login, apiKey: !auth.startsWith('{') });
  }

  async function removeCodexAuth(login) {
    requireSecrets();
    await secrets.remove(userSecretName(login, CODEX_AUTH));
    touch(login, { codexAuthAt: null });
    console.log('userSettings: Codex sign-in removed', { login });
  }

  /** @returns {Promise<string|null>}  the person's Codex sign-in for their own session; null when none is saved */
  async function codexAuth(login) {
    await refresh(login);
    if (!secrets || !recordFor(login)?.codexAuthAt) return null;
    return secrets.read(userSecretName(login, CODEX_AUTH));
  }

  function ownSignInAgent(id) {
    if (!agents.OWN_SIGN_IN_AGENTS.includes(id)) throw Object.assign(new Error(`no own sign-in for ${id}`), { shown: true });
    return agents.agent(id);
  }

  // One change at a time to each person's sign-in for each agent: My settings' save or remove, and a session's write-back
  // of a refreshed login, which reads the saved one, compares, and writes (sessionApi.mjs, agentAuthReply). Without it a
  // save landing between that read and that write would be written over.
  const agentAuthTurns = new Map();
  /**
   * Runs `fn` with that sign-in to itself: no save or remove of it, nor another turn, runs until it is done.
   * @param {string} login @param {string} id
   * @param {(ops: {read: () => Promise<string|null>, save: (value: string) => Promise<void>}) => Promise<T>} fn
   * @returns {Promise<T>}
   * @template T
   */
  function agentAuthTurn(login, id, fn) {
    const key = `${loginKey(login)}/${id}`;
    const run = (agentAuthTurns.get(key) ?? Promise.resolve()).then(() => fn({ read: () => agentAuth(login, id), save: (value, opts) => saveAgentAuth(login, id, value, opts) }));
    const settled = run.catch(() => {});
    agentAuthTurns.set(key, settled);
    settled.then(() => { if (agentAuthTurns.get(key) === settled) agentAuthTurns.delete(key); });
    return run;
  }

  /**
   * Saves the person's own sign-in for Grok Build or OpenCode (shared/agents.cjs, checkSignIn).
   * `opts.reviews: false` is a first save from the command line. The reviews switch is stored off before the secret
   * is written, and again with the sign-in's metadata. On the service store that write is queued, so it is flushed
   * first: a stop after the secret lands is a discovery, and an author who already accepted the wider default keeps
   * it, so the switch would read as on unless that deny is already stored. A secret write that throws puts this
   * agent's switch back and leaves every other agent's as it is now.
   */
  function setAgentAuth(login, id, value, opts) {
    return agentAuthTurn(login, id, ({ save }) => save(value, opts));
  }

  async function saveAgentAuth(login, id, value, opts) {
    requireSecrets();
    const agent = ownSignInAgent(id);
    const auth = agents.checkSignIn(id, value);
    if (opts?.reviews === false && !agent.reviews) throw Object.assign(new Error(`${agent.product} does not review`), { shown: true });
    const denyFirst = opts?.reviews === false;
    const priorFlags = denyFirst ? recordFor(login)?.ownAgentForReviews : undefined;
    if (denyFirst) {
      touch(login, { ownAgentForReviews: { ...priorFlags, [id]: false } });
      console.log(`userSettings: own ${agent.product} sign-in for reviews`, { login, agent: id, on: false });
      // The file store writes in save. The service store only queues it: flush is awaited before the secret is
      // written, and it rejects when that write failed or the store has closed, so the credential is not saved over
      // a deny that did not land.
      if (typeof store.flush === 'function') {
        try {
          await store.flush();
        } catch {
          throw Object.assign(new Error(`${agent.product}'s reviews switch could not be saved`), { shown: true });
        }
      }
    }
    try {
      await secrets.save(userSecretName(login, agent.signIn.secret), auth, `Woodshed: @${login}'s ${agent.product} sign-in, for their My Woodshed ${agent.product} sessions only`);
    } catch (err) {
      if (denyFirst) {
        const current = { ...recordFor(login)?.ownAgentForReviews };
        if (!priorFlags || !Object.hasOwn(priorFlags, id)) delete current[id];
        else current[id] = priorFlags[id];
        touch(login, { ownAgentForReviews: current });
      }
      throw err;
    }
    const fields = { agentAuthAt: { ...recordFor(login)?.agentAuthAt, [id]: new Date(now()).toISOString() } };
    if (denyFirst) fields.ownAgentForReviews = { ...recordFor(login)?.ownAgentForReviews, [id]: false };
    touch(login, fields);
    console.log(`userSettings: ${agent.product} sign-in saved`, { login, agent: id, apiKey: !auth.startsWith('{') });
  }

  function removeAgentAuth(login, id) {
    return agentAuthTurn(login, id, () => deleteAgentAuth(login, id));
  }

  async function deleteAgentAuth(login, id) {
    requireSecrets();
    const agent = ownSignInAgent(id);
    await secrets.remove(userSecretName(login, agent.signIn.secret));
    const at = { ...recordFor(login)?.agentAuthAt };
    delete at[id];
    touch(login, { agentAuthAt: at });
    console.log(`userSettings: ${agent.product} sign-in removed`, { login, agent: id });
  }

  /** @returns {Promise<string|null>}  the person's own sign-in for that agent, for their own session; null when none is saved */
  async function agentAuth(login, id) {
    const agent = ownSignInAgent(id);
    await refresh(login);
    if (!secrets || !recordFor(login)?.agentAuthAt?.[id]) return null;
    return secrets.read(userSecretName(login, agent.signIn.secret));
  }

  /**
   * The switch under the token: whether the shared sessions this person starts from GitHub run on their own plan.
   * On unless they turned it off: a record from before it defaulted on has no field, so it reads as on too.
   * @throws {Error}  shown on the page, when it is turned on with no token saved
   */
  function setOwnTokenForShared(login, on) {
    if (on && !recordFor(login)?.claudeTokenAt) throw Object.assign(new Error('save your Claude token first'), { shown: true });
    touch(login, { ownTokenForShared: Boolean(on) });
    console.log('userSettings: own token for shared sessions', { login, on: Boolean(on) });
  }

  /** @returns {boolean}  the switch is on and a token is saved: a token removed later turns it off in effect */
  function usesOwnTokenForShared(login) {
    const record = recordFor(login);
    return Boolean(record?.ownTokenForShared !== false && record?.claudeTokenAt);
  }

  /**
   * The switch on the Codex card: whether reviews of this person's pull requests run Codex on their own sign-in, when
   * Console settings' Reviews card has Codex review beside Claude Code. On once a sign-in is saved, unless they turned
   * it off, as the Claude token's switch for shared sessions is. The sign-in never goes into the review session: the console's OpenAI proxy adds it to codex's calls
   * (openaiProxy.mjs), as the Anthropic proxy does a Claude token.
   * @throws {Error}  shown on the page, when it is turned on with no sign-in saved
   */
  function setOwnCodexForReviews(login, on) {
    if (on && !recordFor(login)?.codexAuthAt) throw Object.assign(new Error('save your Codex sign-in first'), { shown: true });
    touch(login, { ownCodexForReviews: Boolean(on) });
    console.log('userSettings: own Codex sign-in for reviews', { login, on: Boolean(on) });
  }

  /** @returns {boolean}  the switch is on and a sign-in is saved */
  function usesOwnCodexForReviews(login) {
    const record = recordFor(login);
    return Boolean(record?.ownCodexForReviews !== false && record?.codexAuthAt);
  }

  /**
   * The switch on the Grok Build and OpenCode cards: whether reviews of this person's pull requests may run that agent on
   * their own sign-in. On once a sign-in is saved on My settings, unless they turned it off, as Codex's is. A first save
   * from the command line sets it off before the secret is stored (setAgentAuth's `reviews: false`), and again with
   * the sign-in's metadata, so that sign-in stays out of reviews until they turn it on, including when a restart
   * discovers the secret before the metadata write; replacing one already saved leaves it as it was. With no reviewer choice
   * saved, the default includes it (reviewAgents.mjs), except a sign-in already saved when that default shipped, or
   * found in the secret store without a save on My settings since (usesExpandedReviewDefault). A saved choice that
   * leaves it out does not, unless none of that choice can run, in which case the same default runs. The sign-in never
   * goes into the review session: the console's proxy adds it to the agent's calls (reviewAgentProxy.mjs).
   * @throws {Error}  shown on the page, when it is turned on with no sign-in saved
   */
  function setOwnAgentForReviews(login, id, on) {
    const agent = ownSignInAgent(id);
    if (!agent.reviews) throw Object.assign(new Error(`${agent.product} does not review`), { shown: true });
    if (on && !recordFor(login)?.agentAuthAt?.[id]) throw Object.assign(new Error(`save your ${agent.product} sign-in first`), { shown: true });
    touch(login, { ownAgentForReviews: { ...recordFor(login)?.ownAgentForReviews, [id]: Boolean(on) } });
    console.log(`userSettings: own ${agent.product} sign-in for reviews`, { login, agent: id, on: Boolean(on) });
  }

  /** @returns {boolean}  the switch is on and a sign-in is saved */
  function usesOwnAgentForReviews(login, id) {
    const record = recordFor(login);
    return Boolean(agents.OWN_SIGN_IN_AGENTS.includes(id) && record?.ownAgentForReviews?.[id] !== false && record?.agentAuthAt?.[id]);
  }

  /**
   * Who reviews this person's pull requests (reviewAgents.mjs): none, claude, codex or both, or any reviewers joined with
   * `+` (claude+grok), or null for every reviewer that can run, which is the default.
   * @throws {Error}  shown on the page, for anything else
   */
  function setReviewAgents(login, choice) {
    const saved = choice === null ? null : reviewChoice(choice);
    if (choice !== null && !saved) {
      throw Object.assign(new Error(`reviews must be one of ${Object.keys(agents.REVIEW_PRESETS).join(', ')}, or reviewers joined with + (${agents.REVIEW_AGENT_IDS.join(', ')}), such as claude+grok`), { shown: true, status: 400 });
    }
    // Null is the default, and setting it is how someone kept on the previous one accepts the wider default. A saved
    // choice does not: picking Claude Code and Codex, or Grok Build alone, leaves the previous default for the day
    // that choice can no longer run.
    const accepted = saved === null && recordFor(login)?.reviewDefault === 'legacy';
    touch(login, { reviewAgents: saved, ...(saved === null ? { reviewDefault: 'all' } : {}) });
    console.log('userSettings: reviews of my pull requests', { login, choice: saved ?? 'every reviewer that can run', ...(accepted ? { accepted: true } : {}) });
  }

  /**
   * The model each reviewer of this person's pull requests runs on (reviewAgents.mjs): `{claude: 'sonnet'}`, a pick for
   * the reviewers named and the reviewer's own default for the rest. Replaces what was saved; `{}` is every default.
   * @throws {Error}  shown on the page, for a reviewer that does not review or a model it does not take
   */
  function setReviewModels(login, models) {
    if (!models || typeof models !== 'object' || Array.isArray(models)) throw Object.assign(new Error('models must be an object of reviewer to model'), { shown: true, status: 400 });
    const picks = {};
    for (const [id, model] of Object.entries(models)) {
      if (model === '' || model === null) continue;
      if (!agents.REVIEW_AGENT_IDS.includes(id)) throw Object.assign(new Error(`${id} is not a reviewer (${agents.REVIEW_AGENT_IDS.join(', ')})`), { shown: true, status: 400 });
      if (!agents.reviewModelOk(id, model)) {
        const takes = id === 'claude' ? `one of ${agents.REVIEW_CLAUDE_MODELS.join(', ')}` : `a model name such as ${agents.agent(id).modelHint || 'gpt-5.5'}`;
        throw Object.assign(new Error(`${agents.agent(id).product}'s review model must be ${takes}`), { shown: true, status: 400 });
      }
      picks[id] = model;
    }
    const saved = agents.reviewModelsOf(picks);
    touch(login, { reviewModels: saved });
    console.log('userSettings: review models', { login, models: agents.reviewModelsText(saved) || 'every default' });
  }

  /** @returns {Record<string, string>}  the person's own picks, none for a reviewer left to its default */
  function reviewModels(login) {
    return agents.reviewModelsOf(recordFor(login)?.reviewModels);
  }

  /** @returns {string|null}  the person's saved choice, or null for the default */
  function reviewAgents(login) {
    return reviewChoice(recordFor(login)?.reviewAgents);
  }

  /**
   * Whether a review with no choice saved runs every reviewer that can, Grok Build and OpenCode included. False only
   * for a sign-in of one of those already saved when that default shipped, or found in the secret store without a save
   * on My settings since, until they set reviews back to the default.
   * @param {string|null} login
   * @returns {boolean}
   */
  function usesExpandedReviewDefault(login) {
    if (!login) return true;
    return recordFor(login)?.reviewDefault !== 'legacy';
  }

  /**
   * What the person's private sessions run their agent in: `tmux` (the default) or `herdr`. Their next session reads it
   * from the /settings answer (sessionApi.mjs); one running keeps what it started with.
   * @throws {Error}  shown on the page, for anything else
   */
  function setTerminal(login, choice) {
    if (!TERMINALS.includes(choice)) throw Object.assign(new Error(`the terminal must be one of ${TERMINALS.join(', ')}`), { shown: true, status: 400 });
    touch(login, { terminal: choice === 'tmux' ? null : choice });
    console.log('userSettings: terminal changed', { login, terminal: choice });
  }

  /** @returns {'tmux'|'herdr'}  the person's choice, tmux when they made none */
  function terminal(login) {
    const saved = recordFor(login)?.terminal;
    return TERMINALS.includes(saved) ? saved : 'tmux';
  }

  /** Replaces the person's own idle and lifetime hours; an empty object goes back to the console's numbers. */
  function setLimits(login, values) {
    const limits = checkLimits(values);
    touch(login, { limits: Object.keys(limits).length ? limits : null });
    console.log('userSettings: own session limits changed', { login, ...limits });
  }

  /** @returns {{idleMs?: number, lifetimeMs?: number}}  what the person set for their own sessions; keys they did not are absent */
  function limitsFor(login) {
    const limits = recordFor(login)?.limits;
    return {
      ...(limits?.idleHours && { idleMs: limits.idleHours * HOUR_MS }),
      ...(limits?.lifetimeHours && { lifetimeMs: limits.lifetimeHours * HOUR_MS }),
    };
  }

  /** @returns {Promise<string|null>}  the person's token: their private session's, or a shared one's they started; null when none is saved */
  async function claudeToken(login) {
    await refresh(login);
    if (!secrets || !recordFor(login)?.claudeTokenAt) return null;
    return secrets.read(userSecretName(login, CLAUDE_TOKEN));
  }

  /** Deletes everything this person saved, the secrets first, so a failure leaves the record to try again from. */
  async function removeAll(login) {
    if (secrets) {
      // Own lines saved on My settings' env file tabs before Repo settings (`users/<login>/<env secret>`) are known only
      // by this record's `files`, which goes below: they go first, or nothing would know of them again.
      const old = Object.keys(recordFor(login)?.files ?? {}).filter((key) => !Object.hasOwn(FILES, key) && /^[a-z0-9-]+$/.test(key));
      for (const key of [CLAUDE_TOKEN, CODEX_AUTH, ...agents.OWN_SIGN_IN_AGENTS.map((id) => agents.agent(id).signIn.secret), GITHUB, OWN_FILES, 'database', ...Object.keys(FILES), ...old]) await secrets.remove(userSecretName(login, key));
    }
    delete people()[loginKey(login)];
    store.save();
    console.log('userSettings: everything removed', { login });
  }

  return {
    view, refresh, askedAbout: (login) => askedAt.has(loginKey(login)), setClaudeToken, removeClaudeToken, claudeToken, setCodexAuth, removeCodexAuth, codexAuth, setAgentAuth, removeAgentAuth, agentAuth, agentAuthTurn, setOwnTokenForShared, usesOwnTokenForShared, setOwnCodexForReviews, usesOwnCodexForReviews, setOwnAgentForReviews, usesOwnAgentForReviews, setReviewAgents, reviewAgents, setReviewModels, reviewModels, usesExpandedReviewDefault, setTerminal, terminal, setLimits, limitsFor, file, saveFile, resetFile, ownFiles,
    githubCredentials, saveGitHub, forgetGitHub, setGitIdentity, gitIdentity, noteHome, removeAll,
  };
}
