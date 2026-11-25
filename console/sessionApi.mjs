// The one console port sessions can reach (the security group admits session
// tasks alone), on the base box's private address:
//
//   POST /github-token   Authorization: Bearer <SESSION_TOKEN>  ->  {"token": "...", "expiresAt": "..."}
//   POST /repo-settings  Authorization: Bearer <SESSION_TOKEN>  ->  {"project", "envFiles": {"<key>": {"installation":
//                        "<text>"|null, "personal": "<text>"|null}}, "instructions": {"installation", "personal"},
//                        "personalFor": "<login>"|null}: the session's own project's repo settings (repoSettings.mjs),
//                        the owner's own in a private session alone; 404 for an ask session, 503 while the store does
//                        not answer
//   POST /settings       Authorization: Bearer <SESSION_TOKEN>  ->  {"files": {"tmux-conf": "..."|null},
//                        "ownFiles": {"<path>": "<text>"} (the owner's whole files for the session's repo, written
//                        where git ignores them),
//                        "database": {"user", "password", "name"}|null, "claudeToken", "terminal": "tmux"|"herdr"}
//                        terminal: what the owner picked on My settings for their agent; database null only where the
//                        console makes no databases; claudeToken is the owner's own, for claude in their session;
//                        a shared session gets {"database"}, its own, and 503 while they are still being copied, with
//                        {"plan"} too when it runs on the Claude plan of whoever started it. A private session of
//                        Grok Build or OpenCode gets no claudeToken but "agentAuth", its owner's own sign-in
//                        for that agent, and 409 with none saved
//   *    /anthropic/...  claude's calls to Anthropic, the real credential added here (anthropicProxy.mjs)
//   *    /openai/...     a Codex session's calls to OpenAI on the team key, added here (openaiProxy.mjs)
//   *    /grok/..., /opencode/...   a review's Grok Build and OpenCode calls, on its author's own sign-in, added here
//                         (reviewAgentProxy.mjs)
//   POST /codex-auth     a Codex session's refreshed ~/.codex/auth.json, kept for its owner's next session
//   POST /agent-auth     a private Grok Build or OpenCode session's refreshed login (shared/agents.cjs, `rotates`), kept
//                        as its owner's own sign-in for their next session
//   POST /home           a session's Claude home, a gzipped tar, saved on stop: a private one's for its owner, a
//                        shared one's for its own next run
//   POST /conversation   {"agent", "entries", "partial", "writtenAt"}  ->  204: the session's conversation as its Chat
//                        draws it (shared/savedConversation.mjs), kept beside its home for its Chat while it is
//                        stopped or paused. 409 for a session that has seen production data, 413 past
//                        MAX_CONVERSATION_BYTES, 400 for any other shape, 404 where the console keeps no homes
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
//   POST /issues         {"repo", "title", "body", "labels"?}  ->  {"number", "url", "labels", "labelsIgnored"}: an ask
//                        session asks the console to open a GitHub issue with its App for whoever last mentioned the bot
//                        (asks.mjs openIssue). 404 for any other session, 403 with why when refused
//   POST /qa-report      {"verdict", "report", "sha", "costUsd"}  ->  204: a QA session's result (session/qa.sh), written
//                        into the pull request's QA comment, after which the console stops the session
//                        (qaSessions.mjs). 404 for any other session, 409 for a second report
//   POST /qa-video       a WebM body  ->  {"n"}: one of a QA session's browser recordings, sent before its report,
//                        kept by the console for the QA comment to link (fleet.qaVideo, qaRecordings.mjs). 404 for any
//                        other session, 409 once the report is in, past MAX_QA_VIDEOS or while another of its videos
//                        is on its way, 413 past MAX_QA_VIDEO_BYTES, 400 for anything but WebM, 502 when the store
//                        refused it
//   POST /qa-poster      a PNG body  ->  {"saved": true}: a still from the first video, which the comment shows
//                        (fleet.qaPoster). The same refusals, past MAX_QA_POSTER_BYTES and for anything but PNG
//   *    /mcp/<name>[/...] a session's calls to one of the console's MCP servers (mcpServers.mjs), relayed with what
//                        the server takes, which the session never holds (mcpRelay.mjs); /prod-mcp is the environment's
//                        woodshed-prod. A production server's first call taints the session: it is locked down before
//                        the call goes on, or refused (503) and left untainted when the lockdown fails
//   POST /egress         ->  {"proxy", "ca"}: a tainted session's way out, the console's egress proxy (egressProxy.mjs),
//                        and the certificate authority it shows for GitHub. 404 for a session that is not tainted
//   *    /sessions[/<id>] a person's own session starting sessions of theirs, and following them, with its start token
//                        rather than SESSION_TOKEN (sessionStarts.mjs)
//
// A tainted session's Claude home is its own alone: /home keeps it for its Resume and never copies it to its owner's,
// /home/restore hands back only its own, and /claude-settings refuses it (409), so nothing it saw reaches its owner's
// other sessions. Its home goes when the session is removed (fleet.mjs).
//
// A session's git credential helper and its `gh` wrapper call /github-token, so a
// session only ever holds a token that expires within hours: an installation
// token, or for a private session whose owner connected GitHub, their own user
// token (githubUser.mjs), so it pushes and opens PRs as them. An ask session's
// installation token reads and writes nothing: it answers questions about the default branch. Nor does a QA
// session's: it tests a pull request, and the console posts what it found.
// A session's entrypoint calls /settings at start: a private one for its
// owner's settings and databases, a shared one for its own databases. Where
// the console makes no databases, a shared session gets 404 there. Only a
// private session is handed a Claude token, its owner's, which claude uses
// directly so that what needs a claude.ai login (the Artifact tool) works: only
// the owner can open that session. A shared one, which anyone signed in can
// type into, reaches its plan through /anthropic and never holds the token.
// Only a session the console still counts as active gets either.

import { timingSafeEqual } from 'node:crypto';

import { isAnthropicPath, proxyCredential } from './anthropicProxy.mjs';
import { isMcpPath } from './mcpRelay.mjs';
import { bearerOf, isOpenAiPath } from './openaiProxy.mjs';
import { isReviewAgentPath, reviewAgentTokenOf } from './reviewAgentProxy.mjs';
import { MAX_ANSWER_CHARS, MAX_ISSUE_BODY_CHARS } from './asks.mjs';
import { MAX_SETTINGS_BYTES, parseSyncBody } from './claudeSettings.mjs';
import { conversationKey, sessionHomeName } from './homes.mjs';
import { MAX_QA_VIDEOS, MAX_QA_VIDEO_BYTES, MAX_REPORT_CHARS, isWebm, parseQaReport } from './qaSessions.mjs';
import { MAX_QA_POSTER_BYTES, isPng } from './qaRecordings.mjs';
import { ACTIVE_STATUSES, START_STEPS, isAsk, isQa, isReview, runsCodex } from './sessions.mjs';
import { parseReviewReport } from './reviewSessions.mjs';
import { MAX_CONVERSATION_BYTES, parseSavedConversation } from '../shared/savedConversation.mjs';
import agents from '../shared/agents.cjs';

// A step name is a word; the body is never more than a few of them.
const MAX_PROGRESS_BYTES = 256;
const MAX_CODEX_AUTH_BYTES = 40_000;
// JSON escapes can grow the text up to six-fold; past this the answer is over MAX_ANSWER_CHARS anyway.
const MAX_ANSWER_BYTES = MAX_ANSWER_CHARS * 6;
const MAX_ISSUE_BYTES = MAX_ISSUE_BODY_CHARS * 6 + 10_000;
// The report, cut to MAX_REPORT_CHARS by the console, plus the verdict: the same six-fold for escapes.
const MAX_QA_REPORT_BYTES = MAX_REPORT_CHARS * 6 + 10_000;
// The QA sessions with a video or poster on its way: one at a time each, taken before the body is read, so videos sent at once
// can neither pass MAX_QA_VIDEOS together nor fill the console's memory (a QA session runs the pull request's code,
// which holds its token).
const qaVideosSending = new Set();

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
 * The session token a request to the session API carries, wherever its route takes it: claude's calls to Anthropic
 * as an API key or a bearer, Codex's to OpenAI and every other route as a bearer: a caller that serves
 * the session API for an installation can tell by it whether a request is that installation's (ownsSessionToken).
 * @param {import('node:http').IncomingMessage} req
 * @returns {string|null}
 */
export function sessionTokenOf(req) {
  const pathname = new URL(req.url || '/', 'http://console').pathname;
  if (isAnthropicPath(pathname)) return proxyCredential(req.headers)?.token ?? null;
  // The MCP relay takes the session token as a bearer, as every other route does.
  if (isMcpPath(pathname)) return /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? null;
  if (isOpenAiPath(pathname)) return bearerOf(req.headers);
  if (isReviewAgentPath(pathname)) return reviewAgentTokenOf(req.headers);
  return /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? null;
}

/**
 * @param {string|undefined} header  the request's Authorization header
 * @param {object[]} sessions
 * @returns {object|null}  the active session whose token the header carries
 */
export function sessionForAuthorization(header, sessions) {
  return sessionForToken(/^Bearer (\S+)$/.exec(String(header ?? ''))?.[1], sessions);
}

export function sessionForToken(given, sessions) {
  if (!given) return null;
  return sessions.find((s) => ACTIVE_STATUSES.has(s.status) && sameToken(given, s.token)) ?? null;
}

/**
 * @param {{fleet: {sessions: () => object[]}, tokens: {token: () => Promise<{token: string, expiresAt: number}>},
 *          userSettings?: {claudeToken: (login: string) => Promise<string|null>,
 *                          ownFiles: (login: string, opts?: {repo?: string}) => Promise<Record<string, string|null>>,
 *                          gitIdentity: (login: string) => {name: string, email: string}|null}|null,
 *          anthropic?: ReturnType<typeof import('./anthropicProxy.mjs').createAnthropicProxy>|null,
 *          githubUser?: {tokenFor: (login: string) => Promise<{token: string, expiresAt: number}|null>}|null,
 *          askTokens?: {token: () => Promise<{token: string, expiresAt: number}>}|null,
 *          tokensFor?: ((session: object) => {project: string, default: boolean, sessions: object, asks: object})|null,
 *          asks?: {answer: (session: object, text: string) => Promise<boolean>}|null,
 *          githubAccess?: ((project: string) => Promise<'full'|'repo'|null>)|null,
 *          repoSettings?: {forSession: (session: object) => Promise<object|null>,
 *                          filesForSession: (session: object) => Promise<Record<string, string>>}|null,
 *          mcpRelay?: ReturnType<typeof import('./mcpRelay.mjs').createMcpRelay>|null,
 *          egress?: {sessionUrl: string|null, caPem: () => Promise<string>}|null}} opts
 *   `mcpRelay` relays sessions' calls to the console's MCP servers, and `egress` is the proxy a tainted session leaves through
  *   `githubAccess` reads a project's `githubAccess` (null when its file could not be read)
 *   `ownerTokenRepos`, for a console whose GitHub App is installed beyond its own repos (a host's, installation.mjs's
 *   `githubConnect`), gives the console's repos (owner/name): the person's own token would reach all the App's, so a
 *   private session's is always scoped by GitHub. To these repos, those of its project repo's owner, when its project
 *   file says `full`; to its project's repo alone when it says `repo` or cannot be read
 *   `askTokens` mints an ask session's read-only token; `asks` posts its answers
 *   `tokensFor` gives the token sources of the project a session runs on, in place of `tokens` and `askTokens`
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createSessionApi({
  fleet, tokens, userSettings = null, githubUser = null, homes = null, databases = null, claudeSettings = null, anthropic = null, openai = null,
  reviewAgentProxy = null, attachments = null, askTokens = null, asks = null, tokensFor = null, githubAccess = null, repoSettings = null, sessionStarts = null,
  ownerTokenRepos = null, mcpRelay = null, egress = null,
}) {
  // The access last logged for each session: a session asks for a token on every git and gh call, so the decision is
  // logged when it is first made and when it changes, not each time. Ended sessions are dropped once it grows.
  const loggedAccess = new Map();
  function logAccess(session, own, access) {
    if (loggedAccess.get(session.id) === access) return;
    if (loggedAccess.size >= 500) {
      const live = new Set(fleet.sessions().map((s) => s.id));
      for (const id of loggedAccess.keys()) if (!live.has(id)) loggedAccess.delete(id);
    }
    loggedAccess.set(session.id, access);
    console.log('sessionApi: github access for a private session', { sessionId: session.id, project: own?.project ?? null, access });
  }

  // `full` or `repo`, from the session's project file; behind a host, `repos` for its `full`. One that cannot be read
  // errs toward less: `full` on the default project, as before the setting, and `repo` on any other, whose repo may be
  // public; behind a host `repo` on every project, as there was no time before the setting there.
  async function accessFor(session, own) {
    const fallback = !ownerTokenRepos && (!own || own.default) ? 'full' : 'repo';
    let access = fallback;
    if (githubAccess && own) {
      const read = await githubAccess(own.project).catch(() => null);
      access = read ?? fallback;
      if (!read) console.warn('sessionApi: project file not read, githubAccess from the project', { sessionId: session.id, project: own.project, access });
    }
    if (ownerTokenRepos && access === 'full') access = 'repos';
    logAccess(session, own, access);
    return access;
  }

  return async function handle(req, res) {
    const pathname = new URL(req.url, 'http://console').pathname;
    if (anthropic?.isProxyPath(pathname)) {
      const credential = proxyCredential(req.headers);
      return anthropic.handle(req, res, sessionForToken(credential?.token, fleet.sessions()), credential?.via ?? null);
    }
    if (openai?.isProxyPath(pathname)) return openai.handle(req, res, sessionForToken(bearerOf(req.headers), fleet.sessions()));
    if (reviewAgentProxy?.isProxyPath(pathname)) return reviewAgentProxy.handle(req, res, sessionForToken(reviewAgentTokenOf(req.headers), fleet.sessions()));
    if (isMcpPath(pathname)) {
      if (!mcpRelay) {
        req.resume();
        return reply(res, 404, { error: 'this console relays no MCP servers' });
      }
      return mcpRelay.handle(req, res, sessionForAuthorization(req.headers.authorization, fleet.sessions()));
    }
    // Its own token, not the session token (sessionStarts.mjs).
    if (sessionStarts?.isPath(pathname)) return sessionStarts.handle(req, res);
    const routes = ['/codex-auth', '/agent-auth', '/github-token', '/settings', '/repo-settings', '/home', '/home/restore', '/conversation', '/progress', '/claude-settings', '/attachments', '/answer', '/issues', '/qa-report', '/qa-video', '/qa-poster', '/review-report', '/egress'];
    if (req.method !== 'POST' || !routes.includes(pathname)) return reply(res, 404, { error: 'not found' });
    const session = sessionForAuthorization(req.headers.authorization, fleet.sessions());
    if (!session) {
      console.warn('sessionApi: request refused, no active session has that token', { pathname, from: req.socket.remoteAddress });
      return reply(res, 401, { error: 'unauthorized' });
    }
    if (pathname === '/settings') return settingsReply(res, session, userSettings, databases, repoSettings, { planOnly: req.headers[PLAN_ONLY_HEADER] === '1' });
    if (pathname === '/repo-settings') return repoSettingsReply(req, res, session, repoSettings);
    if (pathname === '/codex-auth') return codexAuthReply(req, res, session, userSettings, fleet);
    if (pathname === '/agent-auth') return agentAuthReply(req, res, session, userSettings);
    if (pathname === '/progress') return progressReply(req, res, session, fleet);
    if (pathname === '/answer') return answerReply(req, res, session, asks);
    if (pathname === '/issues') return issueReply(req, res, session, asks);
    if (pathname === '/qa-report') return qaReportReply(req, res, session, fleet);
    if (pathname === '/qa-video') return qaRecordingReply(req, res, session, fleet, VIDEO);
    if (pathname === '/qa-poster') return qaRecordingReply(req, res, session, fleet, POSTER);
    if (pathname === '/review-report') return reviewReportReply(req, res, session, fleet);
    if (pathname === '/egress') return egressReply(req, res, session, egress);
    if (pathname === '/attachments') {
      if (!attachments || !(await attachments.has(session.id))) {
        res.writeHead(204).end();
        return;
      }
      return attachments.send(session.id, res);
    }
    if (pathname === '/conversation') return conversationReply(req, res, session, { homes, userSettings, fleet });
    if (pathname === '/claude-settings') return claudeSettingsReply(req, res, session, { claudeSettings, userSettings, fleet });
    if (pathname.startsWith('/home')) {
      const periodic = new URL(req.url, 'http://console').searchParams.get('why') === 'periodic';
      return homeReply(req, res, session, { homes, userSettings, restore: pathname === '/home/restore', periodic, fleet });
    }
    const own = tokensFor?.(session);
    // A private session acts as its owner. Their own token reaches every repo the App is on that they can write to; the
    // project file's githubAccess says whether the session gets it as it is (`full`) or scoped by GitHub to the project's
    // repo (`repo`), for a repo whose content outsiders write. Read from its default branch, as the console's other gates are.
    const readOnly = isAsk(session) || isQa(session) || isReview(session);
    const access = session.owner && githubUser && !readOnly ? await accessFor(session, own) : null;
    const ownerToken = access === 'full';
    if ((access === 'repo' || access === 'repos') && githubUser.scopedTokenFor && own?.repo) {
      let scopedToken;
      try {
        const scope = { repo: own.repo, permissions: own.permissions };
        scopedToken = await githubUser.scopedTokenFor(session.owner, access === 'repos' ? { ...scope, repos: ownerTokenRepos() } : scope);
      } catch (err) {
        if (!err.shown) throw err;
        return reply(res, 409, { error: err.message });
      }
      if (scopedToken) {
        console.log('sessionApi: owner\'s github token handed out, scoped to the project', { sessionId: session.id, owner: session.owner, project: own?.project ?? null, token: 'owner-scoped' });
        return reply(res, 200, { token: scopedToken.token, expiresAt: new Date(scopedToken.expiresAt).toISOString() });
      }
      console.log('sessionApi: no scoped owner token for the session\'s project, the App\'s instead', { sessionId: session.id, project: own?.project ?? null, token: 'installation' });
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
    const source = readOnly ? (own?.asks ?? askTokens) : (own?.sessions ?? tokens);
    if (!source) {
      console.warn('sessionApi: no read-only token for the session', { sessionId: session.id, qa: isQa(session), review: isReview(session) });
      return reply(res, 404, { error: 'this console mints no read-only tokens' });
    }
    const { token, expiresAt } = await source.token();
    console.log('sessionApi: github token handed out', { sessionId: session.id, readOnly, token: 'installation', ...(own ? { project: own.project } : {}) });
    return reply(res, 200, { token, expiresAt: new Date(expiresAt).toISOString() });
  };
}

// A shared session's own databases, which the console starts copying as the session starts: 503 until they are made.
// With them, whose plan it runs on, when the fleet decided at launch that it runs on its starter's.
// A console that makes no databases still answers the plan, as for a review, to an entrypoint that says it reads an
// answer with no database (PLAN_ONLY_HEADER). Anyone else gets the 404 an image from before read as "the environment's
// databases stay": given a 200 with no database, it stops with `the console sent no database user`.
export const PLAN_ONLY_HEADER = 'x-woodshed-plan-only';
async function sharedSettingsReply(res, session, databases, userSettings, { planOnly = false } = {}) {
  if (!databases?.available) {
    const onPlan = planOnly && Boolean(await starterToken(session, userSettings));
    console.log('sessionApi: settings handed out', { sessionId: session.id, owner: null, database: null, plan: onPlan ? session.plan : null });
    if (onPlan) return reply(res, 200, { plan: session.plan });
    return reply(res, 404, { error: 'a shared session has no personal settings, and this console makes it no databases' });
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

// The session's own project's repo settings, which it never names: a session cannot ask for another repo's.
async function repoSettingsReply(req, res, session, repoSettings) {
  req.resume();
  if (!repoSettings || isAsk(session)) return reply(res, 404, { error: 'no repo settings for this session' });
  let answer;
  try {
    answer = await repoSettings.forSession(session);
  } catch (err) {
    console.warn('sessionApi: repo settings not read, the store did not answer', { sessionId: session.id, message: String(err?.message ?? err).split('\n')[0] });
    return reply(res, 503, { error: 'the secret store did not answer: try again' });
  }
  if (!answer) return reply(res, 404, { error: 'no repo settings for this session' });
  return reply(res, 200, answer);
}

// The owner's settings and no one else's: the session is found by its own token, and its owner was fixed when
// the console created it.
async function settingsReply(res, session, userSettings, databases, repoSettings, { planOnly = false } = {}) {
  // A review session has no databases; it asks /settings only for the plan it runs on.
  if (isReview(session)) {
    const onPlan = Boolean(await starterToken(session, userSettings));
    console.log('sessionApi: review settings handed out', { sessionId: session.id, plan: onPlan ? session.plan : null });
    return reply(res, 200, onPlan ? { plan: session.plan } : {});
  }
  if (!session.owner) return sharedSettingsReply(res, session, databases, userSettings, { planOnly });
  const codex = session.options?.agent === 'codex';
  // Grok Build and OpenCode run on their owner's own sign-in, and on nothing else (shared/agents.cjs).
  const own = agents.OWN_SIGN_IN_AGENTS.includes(session.options?.agent) ? agents.agent(session.options.agent) : null;
  const agentAuth = own && userSettings ? await userSettings.agentAuth(session.owner, own.id) : null;
  if (own && !agentAuth) {
    console.warn(`sessionApi: no ${own.product} sign-in for the owner`, { sessionId: session.id, owner: session.owner, agent: own.id });
    return reply(res, 409, { error: `@${session.owner} has no ${own.product} sign-in saved on My settings` });
  }
  const claudeToken = userSettings && !own ? await userSettings.claudeToken(session.owner) : null;
  if (!claudeToken && !codex && !own) {
    console.warn('sessionApi: no Claude token for the owner', { sessionId: session.id, owner: session.owner });
    return reply(res, 409, { error: `@${session.owner} has no Claude token saved on My settings` });
  }
  // The private task definition holds no database password, so a private session has its owner's or none; one that may
  // use production its own copy (fleet.mjs, ownDatabases), never its owner's, which its owner's other sessions read.
  let database = null;
  if (databases?.available && session.ownDatabases) {
    const own = await databases.sessionDatabase(session.id);
    if (own.status === 'working') return reply(res, 503, { error: 'its databases are still being copied' });
    if (!own.database) {
      console.warn('sessionApi: the session\'s databases are not there', { sessionId: session.id, status: own.status, error: own.error });
      return reply(res, 409, { error: `the session's databases could not be made: ${own.error ?? 'the console has no record of them'}` });
    }
    database = own.database;
  } else if (databases?.available) database = await databases.credentials(session.owner);
  if (databases?.available && !database) {
    console.warn('sessionApi: the owner\'s databases are not ready', { sessionId: session.id, owner: session.owner });
    return reply(res, 409, { error: `@${session.owner}'s own databases are not ready: see My settings` });
  }
  // Their own lines for tmux-conf, null for none (userSettings.ownFiles). Their env file values are /repo-settings'.
  const files = await userSettings.ownFiles(session.owner);
  // Their whole files for the session's own repo alone (repoSettings.filesForSession).
  const ownFiles = await repoSettings?.filesForSession?.(session) ?? {};
  console.log('sessionApi: settings handed out', {
    sessionId: session.id, owner: session.owner, ownFiles: Object.keys(files).filter((k) => files[k] !== null), wholeFiles: Object.keys(ownFiles), database: database?.name ?? null,
    terminal: userSettings.terminal?.(session.owner) ?? 'tmux',
  });
  // A Codex session runs on its owner's own sign-in when they saved one, and otherwise on the team's key through /openai.
  const codexAuth = codex ? await userSettings.codexAuth(session.owner) : null;
  if (codex) console.log('sessionApi: Codex sign-in decided', { sessionId: session.id, owner: session.owner, own: Boolean(codexAuth) });
  // What the owner picked on My settings for their agent's terminal (session/agentPane.mjs): a private session's alone.
  const terminal = userSettings.terminal?.(session.owner) ?? 'tmux';
  if (own) console.log(`sessionApi: ${own.product} sign-in handed out`, { sessionId: session.id, owner: session.owner, agent: own.id, apiKey: !agentAuth.startsWith('{') });
  return reply(res, 200, { files, ownFiles, git: userSettings.gitIdentity(session.owner), database, claudeToken, terminal, ...(codex ? { codexAuth } : {}), ...(own ? { agentAuth } : {}) });
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
async function codexAuthReply(req, res, session, userSettings, fleet) {
  // A tainted session sends nothing back (runsCodex): what it holds never reaches the owner's later sessions.
  if (!userSettings || !session.owner || !runsCodex(session) || session.taintedAt) {
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
  // Asked again last, just before the save: a lockdown that started while it arrived or was compared takes a Codex
  // agent's access (fleet.taint).
  if (!runsCodex(session) || session.taintedAt || fleet?.isLocked?.(session)) {
    console.log('sessionApi: Codex sign-in not kept, the session was locked down', { sessionId: session.id, owner: session.owner });
    return reply(res, 404, { error: 'only a private Codex session keeps a sign-in' });
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

// When a login file's tokens run out: the latest expiry among its entries, Grok's `expires_at` or OpenCode's `expires`,
// or null when it gives none to compare.
function loginExpiry(text) {
  try {
    const times = Object.values(JSON.parse(text) ?? {}).map((e) => {
      const at = e?.expires ?? e?.expires_at;
      return typeof at === 'number' ? at : typeof at === 'string' ? Date.parse(at) : NaN;
    }).filter((t) => Number.isFinite(t) && t > 0);
    return times.length ? Math.max(...times) : null;
  } catch {
    return null;
  }
}

/**
 * A private Grok Build or OpenCode session's refreshed login (shared/agents.cjs, `rotates`): their refresh token works
 * once, so the copy saved on My settings stops working once a session used it. Only the owner's own sign-in is replaced,
 * only by their own session of that agent, and never by a login that runs out before the saved one.
 */
// The sign-in a session says it was given (session/statusd.mjs, keepAgentAuth).
const GIVEN_SIGN_IN_HEADER = 'x-woodshed-given-sign-in';

async function agentAuthReply(req, res, session, userSettings) {
  const agent = agents.isAgent(session.options?.agent) ? agents.agent(session.options.agent) : null;
  if (!userSettings || !session.owner || !agent?.signIn?.rotates) {
    req.resume();
    return reply(res, 404, { error: 'only a private Grok Build or OpenCode session keeps a sign-in' });
  }
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > agent.signIn.maxChars) return reply(res, 413, { error: 'too large' });
  }
  // Read, compared and written in one turn of this sign-in's (userSettings.agentAuthTurn): a save on My settings waits
  // for it, or it for the save, so neither lands between the other's read and write.
  const turn = userSettings.agentAuthTurn ?? ((login, id, fn) => fn({ read: () => userSettings.agentAuth(login, id), save: (value) => userSettings.setAgentAuth(login, id, value) }));
  // A refusal answers at once, and says so.
  const refuse = (code, body) => { reply(res, code, body); return true; };
  const answered = await turn(session.owner, agent.id, async ({ read, save }) => {
    const current = await read();
    if (!current) {
      console.log(`sessionApi: ${agent.product} sign-in not kept, the owner has none saved`, { sessionId: session.id, owner: session.owner });
      return refuse(409, { error: `the owner saved no ${agent.product} sign-in` });
    }
    // Only over the sign-in this session was given: one saved on My settings since (a key has no expiry to compare), or
    // another session's refresh, stays. A session that does not say which it was given keeps nothing.
    const given = String(req.headers[GIVEN_SIGN_IN_HEADER] ?? '');
    if (given !== agents.signInDigest(current)) {
      console.log(`sessionApi: ${agent.product} sign-in not kept, the saved one is not the one the session was given`, { sessionId: session.id, owner: session.owner, said: Boolean(given) });
      return refuse(409, { error: `the saved ${agent.product} sign-in changed since this session started` });
    }
    const [incoming, saved] = [loginExpiry(text), loginExpiry(current)];
    if (incoming !== null && saved !== null && incoming < saved) {
      console.log(`sessionApi: ${agent.product} sign-in not kept, the saved one is newer`, { sessionId: session.id, owner: session.owner });
      return refuse(409, { error: `the saved ${agent.product} sign-in is newer` });
    }
    try {
      await save(text);
    } catch (err) {
      if (!err.shown) throw err;
      console.warn(`sessionApi: ${agent.product} sign-in refused`, { sessionId: session.id, owner: session.owner, message: err.message });
      return refuse(400, { error: err.message });
    }
    return null;
  });
  if (answered) return;
  console.log(`sessionApi: ${agent.product} sign-in kept`, { sessionId: session.id, owner: session.owner });
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

// An issue an ask session asks the console to open (asks.openIssue): {repo, title, body, labels?}. The console files it
// with its App; the session's own token reads only. A refusal says why, for the session to tell the thread.
async function issueReply(req, res, session, asks) {
  if (!asks || !isAsk(session)) {
    req.resume();
    return reply(res, 404, { error: 'only a question from Slack opens issues' });
  }
  req.setEncoding('utf8');
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > MAX_ISSUE_BYTES) return reply(res, 413, { error: 'too large' });
  }
  let issue;
  try {
    issue = JSON.parse(text);
  } catch {
    return reply(res, 400, { error: 'not JSON' });
  }
  try {
    return reply(res, 200, await asks.openIssue(session, issue ?? {}));
  } catch (err) {
    if (!err.shown) throw err;
    return reply(res, 403, { error: err.message });
  }
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

// A QA session's result, once: the console writes it into the pull request's QA comment and stops the session.
function qaReportReply(req, res, session, fleet) {
  return reportReply(req, res, session, {
    kind: 'QA', mine: isQa(session), sent: Boolean(session.qa?.conclusion), parse: parseQaReport, finish: fleet.qaFinished,
  });
}

// One of a QA session's browser recordings, read whole and handed to the fleet, which commits it for the QA comment.
// What a QA session sends of its recording: its videos, then one still, each read whole and handed to the fleet.
const VIDEO = { what: 'video', max: () => MAX_QA_VIDEO_BYTES, check: isWebm, type: 'a WebM video', save: 'qaVideo', counts: true };
const POSTER = { what: 'poster', max: () => MAX_QA_POSTER_BYTES, check: isPng, type: 'a PNG image', save: 'qaPoster', counts: false };

async function qaRecordingReply(req, res, session, fleet, kind) {
  const refuse = (code, error) => {
    req.resume();
    return reply(res, code, { error });
  };
  if (!isQa(session) || !fleet[kind.save]) return refuse(404, 'only a QA session has recordings to send');
  if (session.qa?.conclusion) return refuse(409, 'this session already sent its report');
  if (kind.counts && (session.qa?.videos?.length ?? 0) >= MAX_QA_VIDEOS) return refuse(409, `a QA run keeps at most ${MAX_QA_VIDEOS} videos`);
  if (!kind.counts && session.qa?.poster) return refuse(409, 'this session already sent its poster');
  if (Number(req.headers['content-length']) > kind.max()) return refuse(413, 'too large');
  if (qaVideosSending.has(session.id)) return refuse(409, 'another recording of this session is on its way: send them one at a time');
  qaVideosSending.add(session.id);
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > kind.max()) return reply(res, 413, { error: 'too large' });
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    chunks.length = 0;
    if (!kind.check(body)) {
      console.warn(`sessionApi: a QA ${kind.what} refused, not ${kind.type}`, { sessionId: session.id, bytes });
      return reply(res, 400, { error: `the body must be ${kind.type}` });
    }
    // The report may have come in while the body was on its way: its comment is written, and would never link this one.
    if (session.qa?.conclusion) return reply(res, 409, { error: 'this session already sent its report' });
    try {
      return reply(res, 200, await fleet[kind.save](session, body));
    } catch (err) {
      console.warn(`sessionApi: a QA ${kind.what} not saved`, { sessionId: session.id, bytes, message: String(err?.message ?? err).split('\n')[0] });
      return reply(res, 502, { error: `the console did not keep the ${kind.what}` });
    }
  } finally {
    qaVideosSending.delete(session.id);
  }
}

function reviewReportReply(req, res, session, fleet) {
  return reportReply(req, res, session, {
    kind: 'review', mine: isReview(session), sent: Boolean(session.review?.reported), parse: parseReviewReport, finish: fleet.reviewFinished,
  });
}

// A QA or review session's one report: read whole, parsed, then handed to the fleet, which posts it and stops the session.
async function reportReply(req, res, session, { kind, mine, sent, parse, finish }) {
  if (!mine || !finish) {
    req.resume();
    return reply(res, 404, { error: `only a ${kind} session has a report to send` });
  }
  if (sent) {
    req.resume();
    console.warn('sessionApi: a second report refused', { sessionId: session.id, kind });
    return reply(res, 409, { error: 'this session already sent its report' });
  }
  req.setEncoding('utf8');
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > MAX_QA_REPORT_BYTES) return reply(res, 413, { error: 'too large' });
  }
  let result;
  try {
    result = parse(text);
  } catch (err) {
    console.warn('sessionApi: a report refused', { sessionId: session.id, kind, why: err.message });
    return reply(res, 400, { error: err.message });
  }
  await finish(session, result);
  res.writeHead(204).end();
}

// A tainted session's way out, for its entrypoint when it is resumed: its statusd is handed the same when it is tainted.
async function egressReply(req, res, session, egress) {
  req.resume();
  if (!session.taintedAt || !egress?.sessionUrl) return reply(res, 404, { error: 'only a tainted session leaves through the egress proxy' });
  let ca;
  try {
    ca = await egress.caPem();
  } catch (err) {
    console.warn('sessionApi: egress certificate not read', { sessionId: session.id, message: String(err?.message ?? err).split('\n')[0] });
    return reply(res, 503, { error: 'the console could not read its egress certificate' });
  }
  return reply(res, 200, { proxy: egress.sessionUrl, ca });
}

// A private session's turn at its owner's shared Claude settings.
async function claudeSettingsReply(req, res, session, { claudeSettings, userSettings, fleet = null }) {
  if (!claudeSettings || !session.owner) {
    req.resume();
    return reply(res, 404, { error: 'no shared Claude settings for this session' });
  }
  // What a tainted session's claude changed may hold what it saw: it never reaches the owner's other sessions.
  if (session.taintedAt) {
    req.resume();
    return reply(res, 409, { error: 'this session has seen production data, so its settings stay its own' });
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
  // Its lockdown may have started while the body came in: what came after it may hold what it saw. Production data
  // reaches a session only once its lockdown has started, so a body read whole before then cannot carry any.
  if (session.taintedAt || fleet?.isLocked?.(session)) {
    console.log('sessionApi: shared Claude settings refused, the session was being locked down', { sessionId: session.id });
    return reply(res, 409, { error: 'this session has seen production data, so its settings stay its own' });
  }
  try {
    return reply(res, 200, await claudeSettings.sync({ login: session.owner, sessionId: session.id, ...body }));
  } catch (err) {
    if (!err.shown) throw err;
    console.warn('sessionApi: shared Claude settings refused', { sessionId: session.id, owner: session.owner, message: err.message });
    return reply(res, err.status ?? 413, { error: err.message });
  }
}

// The conversation a session's Chat shows while it is stopped or paused, kept beside its own home and gone with it. A
// tainted session's is never kept: statusd sends none, and one that came in as its lockdown started is refused, as its
// settings are. Nor one for an owner who removed My Woodshed, whose stopping sessions would leave it for nobody.
async function conversationReply(req, res, session, { homes, userSettings, fleet }) {
  if (!homes?.putText) {
    req.resume();
    return reply(res, 404, { error: 'this console keeps no Claude homes' });
  }
  if (session.owner && !userSettings?.view(session.owner).setUp) {
    req.resume();
    return reply(res, 409, { error: 'My Woodshed was removed, so nothing is kept' });
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_CONVERSATION_BYTES) {
      req.resume();
      return reply(res, 413, { error: 'the conversation is too large' });
    }
    chunks.push(chunk);
  }
  const conversation = parseSavedConversation(Buffer.concat(chunks).toString('utf8'));
  if (!conversation) return reply(res, 400, { error: 'expected {"agent", "entries", "partial", "writtenAt"}' });
  // Checked once it is all in: what came after a lockdown began may hold what the session saw.
  if (session.taintedAt || fleet?.isLocked?.(session)) {
    console.log('sessionApi: conversation refused, the session has seen production data', { sessionId: session.id });
    return reply(res, 409, { error: 'this session has seen production data, so its conversation is not kept' });
  }
  const savedAt = new Date().toISOString();
  await homes.putText(conversationKey(sessionHomeName(session)), JSON.stringify({ ...conversation, savedAt }));
  fleet.conversationSaved?.(session, savedAt);
  console.log('sessionApi: conversation kept', { sessionId: session.id, entries: conversation.entries.length, bytes });
  res.writeHead(204);
  return res.end();
}

// A Claude home, in and out: a session's own, and for a private session its owner's too. A private session starts
// from its owner's latest home, and a resumed one from its own, so its conversation is the one it left; one saved
// before sessions kept their own falls back to the owner's.
async function homeReply(req, res, session, { homes, userSettings, restore, periodic = false, fleet = null }) {
  if (!homes) {
    req.resume();
    return reply(res, 404, { error: 'this console keeps no Claude homes' });
  }
  const own = sessionHomeName(session);
  if (restore) {
    const fromOwn = !session.owner || Boolean(session.resumeClaude) || Boolean(session.taintedAt);
    const saved = (fromOwn ? await homes.get(own) : null) ?? (session.owner && !session.taintedAt ? await homes.get(session.owner) : null);
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
    // Never a tainted session's: what it saw stays in its own home, which goes when it is removed.
    // Checked once the home is all in: a lockdown that started while it came in counts, as what came after may hold it.
    const locked = Boolean(session.taintedAt) || Boolean(fleet?.isLocked?.(session));
    if (session.owner && !periodic && !locked) {
      await homes.copy(own, session.owner).catch((err) => console.warn('sessionApi: owner\'s Claude home not updated', {
        sessionId: session.id, owner: session.owner, message: String(err?.message ?? err).split('\n')[0],
      }));
      userSettings?.noteHome(session.owner, bytes);
    }
    console.log('sessionApi: Claude home saved', { sessionId: session.id, owner: session.owner ?? null, bytes, periodic, ...(locked ? { tainted: true, toOwner: false } : {}) });
    return reply(res, 200, { bytes });
  } catch (err) {
    if (!err.shown) throw err;
    req.resume();
    return reply(res, err.status ?? 413, { error: err.message });
  }
}
