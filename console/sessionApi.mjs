// The one console port sessions can reach (the security group admits session
// tasks alone), on the base box's private address:
//
//   POST /github-token   Authorization: Bearer <SESSION_TOKEN>  ->  {"token": "...", "expiresAt": "..."}
//   POST /settings       Authorization: Bearer <SESSION_TOKEN>  ->  {"files": {"api-env": "..."|null, ...},
//                        "database": {"user", "password", "name"}|null, "claudeToken"}   database null only where the
//                        console makes no databases; claudeToken is the owner's own, for claude in their session;
//                        a shared session gets {"database"}, its own, and 503 while they are still being copied, with
//                        {"plan"} too when it runs on the Claude plan of whoever started it
//   *    /anthropic/...  claude's calls to Anthropic, the real credential added here (anthropicProxy.mjs)
//   *    /openai/...     a Codex session's calls to OpenAI on the team key, added here (openaiProxy.mjs)
//   POST /codex-auth     a Codex session's refreshed ~/.codex/auth.json, kept for its owner's next session
//   POST /home           a session's Claude home, a gzipped tar, saved on stop: a private one's for its owner, a
//                        shared one's for its own next run
//   POST /home/restore   that tar back, for the owner's next private session or the shared session's next run;
//                        404 when none is saved
//   POST /progress       {"step": "<one of START_STEPS>"}  ->  204: a start step has finished, for the session page's
//                        checklist. Sent in the background, so nothing in the session waits on it
//   POST /claude-settings  {"version", "changed", "removed"}  ->  {"version", "items"?}: a private session's changes to
//                        its owner's shared Claude settings, and theirs from the owner's other sessions
//                        (claudeSettings.mjs); 404 for a shared session, which has none
//   POST /attachments    the files attached to New session, as a tar, at each start: 204 when there are none
//                        (attachments.mjs)
//   POST /answer         {"text": "<Markdown>"}  ->  {"posted": true|false}: an ask session's answer, posted in its
//                        Slack thread (asks.mjs). 404 for any other session
//
// A session's git credential helper and its `gh` wrapper call /github-token, so a
// session only ever holds a token that expires within hours: an installation
// token, or for a private session whose owner connected GitHub, their own user
// token (githubUser.mjs), so it pushes and opens PRs as them. An ask session's
// installation token reads and writes nothing: it answers questions about the default branch.
// A session's entrypoint calls /settings at start: a private one for its
// owner's settings and databases, a shared one for its own databases. Where
// the console makes no databases, a shared session gets 404 there. Only a
// private session is handed a Claude token, its owner's, which claude uses
// directly so that what needs a claude.ai login (the Artifact tool) works: only
// the owner can open that session. A shared one, which anyone signed in can
// type into, reaches its plan through /anthropic and never holds the token.
// Only a session the console still counts as active gets either.

import { timingSafeEqual } from 'node:crypto';

import { proxyCredential } from './anthropicProxy.mjs';
import { bearerOf } from './openaiProxy.mjs';
import { MAX_ANSWER_CHARS } from './asks.mjs';
import { MAX_SETTINGS_BYTES, parseSyncBody } from './claudeSettings.mjs';
import { privateSessionHomeName, sharedHomeName } from './homes.mjs';
import { ACTIVE_STATUSES, START_STEPS, isAsk } from './sessions.mjs';

// A step name is a word; the body is never more than a few of them.
const MAX_PROGRESS_BYTES = 256;
const MAX_CODEX_AUTH_BYTES = 40_000;
// JSON escapes can grow the text up to six-fold; past this the answer is over MAX_ANSWER_CHARS anyway.
const MAX_ANSWER_BYTES = MAX_ANSWER_CHARS * 6;

function reply(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sameToken(given, expected) {
  if (typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * @param {string|undefined} header  the request's Authorization header
 * @param {object[]} sessions
 * @returns {object|null}  the active session whose token the header carries
 */
export function sessionForAuthorization(header, sessions) {
  return sessionForToken(/^Bearer (\S+)$/.exec(String(header ?? ''))?.[1], sessions);
}

function sessionForToken(given, sessions) {
  if (!given) return null;
  return sessions.find((s) => ACTIVE_STATUSES.has(s.status) && sameToken(given, s.token)) ?? null;
}

/**
 * @param {{fleet: {sessions: () => object[]}, tokens: {token: () => Promise<{token: string, expiresAt: number}>},
 *          userSettings?: {claudeToken: (login: string) => Promise<string|null>,
 *                          ownFiles: (login: string) => Promise<Record<string, string|null>>,
 *                          gitIdentity: (login: string) => {name: string, email: string}|null}|null,
 *          anthropic?: ReturnType<typeof import('./anthropicProxy.mjs').createAnthropicProxy>|null,
 *          githubUser?: {tokenFor: (login: string) => Promise<{token: string, expiresAt: number}|null>}|null,
 *          askTokens?: {token: () => Promise<{token: string, expiresAt: number}>}|null,
 *          tokensFor?: ((session: object) => {project: string, default: boolean, sessions: object, asks: object})|null,
 *          asks?: {answer: (session: object, text: string) => Promise<boolean>}|null}} opts
 *   `askTokens` mints an ask session's read-only token; `asks` posts its answers
 *   `tokensFor` gives the token sources of the project a session runs on, in place of `tokens` and `askTokens`
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createSessionApi({
  fleet, tokens, userSettings = null, githubUser = null, homes = null, databases = null, claudeSettings = null, anthropic = null, openai = null,
  attachments = null, askTokens = null, asks = null, tokensFor = null,
}) {
  return async function handle(req, res) {
    const pathname = new URL(req.url, 'http://console').pathname;
    if (anthropic?.isProxyPath(pathname)) {
      const credential = proxyCredential(req.headers);
      return anthropic.handle(req, res, sessionForToken(credential?.token, fleet.sessions()), credential?.via ?? null);
    }
    if (openai?.isProxyPath(pathname)) return openai.handle(req, res, sessionForToken(bearerOf(req.headers), fleet.sessions()));
    const routes = ['/codex-auth', '/github-token', '/settings', '/home', '/home/restore', '/progress', '/claude-settings', '/attachments', '/answer'];
    if (req.method !== 'POST' || !routes.includes(pathname)) return reply(res, 404, { error: 'not found' });
    const session = sessionForAuthorization(req.headers.authorization, fleet.sessions());
    if (!session) {
      console.warn('sessionApi: request refused, no active session has that token', { pathname, from: req.socket.remoteAddress });
      return reply(res, 401, { error: 'unauthorized' });
    }
    if (pathname === '/settings') return settingsReply(res, session, userSettings, databases);
    if (pathname === '/codex-auth') return codexAuthReply(req, res, session, userSettings);
    if (pathname === '/progress') return progressReply(req, res, session, fleet);
    if (pathname === '/answer') return answerReply(req, res, session, asks);
    if (pathname === '/attachments') {
      if (!attachments || !(await attachments.has(session.id))) {
        res.writeHead(204).end();
        return;
      }
      return attachments.send(session.id, res);
    }
    if (pathname === '/claude-settings') return claudeSettingsReply(req, res, session, { claudeSettings, userSettings });
    if (pathname.startsWith('/home')) {
      const periodic = new URL(req.url, 'http://console').searchParams.get('why') === 'periodic';
      return homeReply(req, res, session, { homes, userSettings, restore: pathname === '/home/restore', periodic });
    }
    const own = tokensFor?.(session);
    // The owner's own token reaches every repo the App is on that they can write to, not only the session's project's.
    // So only a session on the default project gets it as it is; one on another project gets it scoped by GitHub to
    // that project's repo alone, and when GitHub makes none, that project's App token, which reaches its repo alone.
    const ownerToken = session.owner && githubUser && (!own || own.default);
    if (session.owner && githubUser && !ownerToken && !isAsk(session) && githubUser.scopedTokenFor) {
      let scopedToken;
      try {
        scopedToken = await githubUser.scopedTokenFor(session.owner, { repo: own.repo, permissions: own.permissions });
      } catch (err) {
        if (!err.shown) throw err;
        return reply(res, 409, { error: err.message });
      }
      if (scopedToken) {
        console.log('sessionApi: owner\'s github token handed out, scoped to the project', { sessionId: session.id, owner: session.owner, project: own.project, token: 'owner-scoped' });
        return reply(res, 200, { token: scopedToken.token, expiresAt: new Date(scopedToken.expiresAt).toISOString() });
      }
      console.log('sessionApi: no scoped owner token for the session\'s project, the App\'s instead', { sessionId: session.id, project: own.project, token: 'installation' });
    }
    if (ownerToken) {
      let user;
      try {
        user = await githubUser.tokenFor(session.owner);
      } catch (err) {
        if (!err.shown) throw err;
        return reply(res, 409, { error: err.message });
      }
      if (user) {
        console.log('sessionApi: owner\'s github token handed out', { sessionId: session.id, owner: session.owner, token: 'owner' });
        return reply(res, 200, { token: user.token, expiresAt: new Date(user.expiresAt).toISOString() });
      }
    }
    if (!tokens && !own) {
      console.warn('sessionApi: no GitHub token, this console has no GitHub App', { sessionId: session.id });
      return reply(res, 404, { error: 'this console has no GitHub App, so it mints no GitHub tokens' });
    }
    const source = isAsk(session) ? (own?.asks ?? askTokens) : (own?.sessions ?? tokens);
    if (!source) {
      console.warn('sessionApi: no read-only token for an ask session', { sessionId: session.id });
      return reply(res, 404, { error: 'this console mints no read-only tokens' });
    }
    const { token, expiresAt } = await source.token();
    console.log('sessionApi: github token handed out', { sessionId: session.id, readOnly: isAsk(session), token: 'installation', ...(own ? { project: own.project } : {}) });
    return reply(res, 200, { token, expiresAt: new Date(expiresAt).toISOString() });
  };
}

// A shared session's own databases, which the console starts copying as the session starts: 503 until they are made.
// With them, whose plan it runs on, when the fleet decided at launch that it runs on its starter's.
async function sharedSettingsReply(res, session, databases, userSettings) {
  if (!databases?.available) {
    console.warn('sessionApi: settings refused, a shared session has no owner', { sessionId: session.id });
    return reply(res, 404, { error: 'a shared session has no personal settings' });
  }
  const { status, database, error } = await databases.sessionDatabase(session.id);
  if (status === 'working') return reply(res, 503, { error: 'its databases are still being copied' });
  if (!database) {
    console.warn('sessionApi: the session\'s databases are not there', { sessionId: session.id, status, error });
    return reply(res, 409, { error: `the session's databases could not be made: ${error ?? 'the console has no record of them'}` });
  }
  const onPlan = Boolean(await starterToken(session, userSettings));
  console.log('sessionApi: settings handed out', { sessionId: session.id, owner: null, database: database.name, plan: onPlan ? session.plan : null });
  return reply(res, 200, onPlan ? { database, plan: session.plan } : { database });
}

// The plan is always the starter's: the fleet sets it from startedBy, and statusd can change neither.
async function starterToken(session, userSettings) {
  if (!session.plan || session.plan !== session.startedBy || !userSettings) return null;
  // Switched off since the launch: the next start would have used the team key, so this one does too.
  if (!userSettings.usesOwnTokenForShared(session.plan)) {
    console.log('sessionApi: the starter switched their own token off, the session uses the team key', { sessionId: session.id, plan: session.plan });
    return null;
  }
  // Secrets Manager failing here costs only the plan: the session starts on the team key rather than not at all.
  const token = await userSettings.claudeToken(session.plan).catch((err) => {
    console.warn('sessionApi: the starter\'s Claude token could not be read', { sessionId: session.id, plan: session.plan, message: err?.message });
    return null;
  });
  if (!token) console.warn('sessionApi: the starter\'s Claude token is gone, the session uses the team key', { sessionId: session.id, plan: session.plan });
  return token;
}

// The owner's settings and no one else's: the session is found by its own token, and its owner was fixed when
// the console created it.
async function settingsReply(res, session, userSettings, databases) {
  if (!session.owner) return sharedSettingsReply(res, session, databases, userSettings);
  const codex = session.options?.agent === 'codex';
  const claudeToken = userSettings ? await userSettings.claudeToken(session.owner) : null;
  if (!claudeToken && !codex) {
    console.warn('sessionApi: no Claude token for the owner', { sessionId: session.id, owner: session.owner });
    return reply(res, 409, { error: `@${session.owner} has no Claude token saved on My settings` });
  }
  // The private task definition holds no database password, so a private session has its owner's or none.
  const database = databases?.available ? await databases.credentials(session.owner) : null;
  if (databases?.available && !database) {
    console.warn('sessionApi: the owner\'s databases are not ready', { sessionId: session.id, owner: session.owner });
    return reply(res, 409, { error: `@${session.owner}'s own databases are not ready: see My settings` });
  }
  // null for a file is the console's default, which the task definition already gives every session.
  const files = await userSettings.ownFiles(session.owner);
  console.log('sessionApi: settings handed out', {
    sessionId: session.id, owner: session.owner, ownFiles: Object.keys(files).filter((k) => files[k] !== null), database: database?.name ?? null,
  });
  // A Codex session runs on its owner's own sign-in when they saved one, and otherwise on the team's key through /openai.
  const codexAuth = codex ? await userSettings.codexAuth(session.owner) : null;
  if (codex) console.log('sessionApi: Codex sign-in decided', { sessionId: session.id, owner: session.owner, own: Boolean(codexAuth) });
  return reply(res, 200, { files, git: userSettings.gitIdentity(session.owner), database, claudeToken, ...(codex ? { codexAuth } : {}) });
}

// Whether the login a session sends back was refreshed before the saved one: a refresh token rotates, so the older is dead.
function isOlderLogin({ incoming, current }) {
  try {
    const at = (text) => Date.parse(JSON.parse(text).last_refresh ?? '');
    const [a, b] = [at(incoming), at(current)];
    return Number.isFinite(a) && Number.isFinite(b) && a < b;
  } catch {
    return false;
  }
}

// A private Codex session's refreshed login: ChatGPT's refresh token rotates, so the copy saved on My settings would
// stop working once a session used it. Only the owner's own sign-in is ever replaced, and only by their own session.
async function codexAuthReply(req, res, session, userSettings) {
  if (!userSettings || !session.owner || session.options?.agent !== 'codex') {
    req.resume();
    return reply(res, 404, { error: 'only a private Codex session keeps a sign-in' });
  }
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > MAX_CODEX_AUTH_BYTES) return reply(res, 413, { error: 'too large' });
  }
  const current = await userSettings.codexAuth(session.owner);
  if (!current) {
    console.log('sessionApi: Codex sign-in not kept, the owner has none saved', { sessionId: session.id, owner: session.owner });
    return reply(res, 409, { error: 'the owner saved no Codex sign-in' });
  }
  if (isOlderLogin({ incoming: text, current })) {
    console.log('sessionApi: Codex sign-in not kept, the saved one is newer', { sessionId: session.id, owner: session.owner });
    return reply(res, 409, { error: 'the saved Codex sign-in is newer' });
  }
  try {
    await userSettings.setCodexAuth(session.owner, text);
  } catch (err) {
    if (!err.shown) throw err;
    console.warn('sessionApi: Codex sign-in refused', { sessionId: session.id, owner: session.owner, message: err.message });
    return reply(res, 400, { error: err.message });
  }
  console.log('sessionApi: Codex sign-in kept', { sessionId: session.id, owner: session.owner });
  return reply(res, 200, { ok: true });
}

// A start step the session reports, kept for its page's checklist.
async function progressReply(req, res, session, fleet) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > MAX_PROGRESS_BYTES) return reply(res, 413, { error: 'too large' });
  }
  let step;
  try {
    step = JSON.parse(text).step;
  } catch {
    return reply(res, 400, { error: 'not JSON' });
  }
  if (!START_STEPS.includes(step)) return reply(res, 400, { error: 'unknown step' });
  fleet.startStep(session, step);
  res.writeHead(204);
  return res.end();
}

// An ask session's answer, posted in its Slack thread.
async function answerReply(req, res, session, asks) {
  if (!asks || !isAsk(session)) {
    req.resume();
    return reply(res, 404, { error: 'only a question from Slack has a thread to answer in' });
  }
  // Whole characters per chunk: a long answer's accents would otherwise break where a chunk ends.
  req.setEncoding('utf8');
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > MAX_ANSWER_BYTES) return reply(res, 413, { error: 'too large' });
  }
  let answer;
  try {
    answer = JSON.parse(text).text;
  } catch {
    return reply(res, 400, { error: 'not JSON' });
  }
  if (typeof answer !== 'string' || answer.length > MAX_ANSWER_CHARS) {
    return reply(res, 400, { error: `give {"text": "..."}, at most ${MAX_ANSWER_CHARS} characters` });
  }
  try {
    return reply(res, 200, { posted: await asks.answer(session, answer) });
  } catch (err) {
    if (!err.shown) throw err;
    return reply(res, 400, { error: err.message });
  }
}

// A private session's turn at its owner's shared Claude settings.
async function claudeSettingsReply(req, res, session, { claudeSettings, userSettings }) {
  if (!claudeSettings || !session.owner) {
    req.resume();
    return reply(res, 404, { error: 'no shared Claude settings for this session' });
  }
  if (!userSettings?.view(session.owner).setUp) {
    req.resume();
    return reply(res, 409, { error: 'My Woodshed was removed, so nothing is kept' });
  }
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > MAX_SETTINGS_BYTES * 2) return reply(res, 413, { error: 'too large' });
  }
  let body;
  try {
    body = parseSyncBody(JSON.parse(text));
  } catch {
    body = null;
  }
  if (!body) return reply(res, 400, { error: 'expected {"version", "changed", "removed"}' });
  try {
    return reply(res, 200, await claudeSettings.sync({ login: session.owner, sessionId: session.id, ...body }));
  } catch (err) {
    if (!err.shown) throw err;
    console.warn('sessionApi: shared Claude settings refused', { sessionId: session.id, owner: session.owner, message: err.message });
    return reply(res, 413, { error: err.message });
  }
}

// A Claude home, in and out: a session's own, and for a private session its owner's too. A private session starts
// from its owner's latest home, and a resumed one from its own, so its conversation is the one it left; one saved
// before sessions kept their own falls back to the owner's.
async function homeReply(req, res, session, { homes, userSettings, restore, periodic = false }) {
  if (!homes) {
    req.resume();
    return reply(res, 404, { error: 'this console keeps no Claude homes' });
  }
  const own = session.owner ? privateSessionHomeName(session.owner, session.id) : sharedHomeName(session.id);
  if (restore) {
    const fromOwn = !session.owner || Boolean(session.resumeClaude);
    const saved = (fromOwn ? await homes.get(own) : null) ?? (session.owner ? await homes.get(session.owner) : null);
    if (!saved) return reply(res, 404, { error: 'nothing saved yet' });
    console.log('sessionApi: Claude home handed out', { sessionId: session.id, owner: session.owner ?? null, bytes: saved.bytes, own: fromOwn });
    res.writeHead(200, { 'content-type': 'application/gzip', 'cache-control': 'no-store' });
    return saved.stream.pipe(res);
  }
  // Remove My Woodshed takes the record first; a session it is stopping must not save a home for nobody.
  if (session.owner && !userSettings?.view(session.owner).setUp) {
    req.resume();
    console.log('sessionApi: Claude home not kept, the owner removed My Woodshed', { sessionId: session.id, owner: session.owner });
    return reply(res, 409, { error: 'My Woodshed was removed, so nothing is kept' });
  }
  try {
    const bytes = await homes.put(own, req);
    // The owner's, which their next new session starts from, only at stop. A periodic save is for this session's own
    // Resume after a crash; copying it would swap the owner's between their running sessions every few minutes, or put
    // a session's empty home over theirs when its restore failed.
    if (session.owner && !periodic) {
      await homes.copy(own, session.owner).catch((err) => console.warn('sessionApi: owner\'s Claude home not updated', {
        sessionId: session.id, owner: session.owner, message: String(err?.message ?? err).split('\n')[0],
      }));
      userSettings?.noteHome(session.owner, bytes);
    }
    console.log('sessionApi: Claude home saved', { sessionId: session.id, owner: session.owner ?? null, bytes, periodic });
    return reply(res, 200, { bytes });
  } catch (err) {
    if (!err.shown) throw err;
    req.resume();
    return reply(res, 413, { error: err.message });
  }
}
