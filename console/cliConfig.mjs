// `woodshed config`: a person's choices on My settings, read and set with the command line's token (cliSessions.mjs),
// through the page's own routes and their own checks. Never a secret: not the Claude token, the Codex sign-in, env
// values, files or tmux lines, which stay on My settings.
//
//   GET  /api/cli/config                     the choices below, and nothing else
//   POST /api/my/terminal                    terminal
//   POST /api/my/reviews                     reviews
//   POST /api/my/codex-auth/reviews          codex-reviews
//   POST /api/my/agent-auth/<agent>/reviews  grok-reviews and opencode-reviews (never the sign-in itself, which is the
//                                            same path without /reviews, and stays on My settings)
//   POST /api/my/claude-token/shared         claude-token-shared
//   POST /api/my/projects/default            default-repo
//   POST /api/my/github/identity             github-name and github-email
//
// Each write runs as the page's does, by the same code; what the command line gets back is this view alone, never the
// page's whole answer (myView, which says more of the person than the command line asks for).

export const CLI_CONFIG_PATH = '/api/cli/config';

export const CONFIG_ROUTES = Object.freeze([
  ['GET', /^\/api\/cli\/config$/],
  ['POST', /^\/api\/my\/(terminal|reviews|codex-auth\/reviews|agent-auth\/(?:grok|opencode)\/reviews|claude-token\/shared|projects\/default|github\/identity)$/],
]);

/** @returns {boolean}  one of the writes above */
export function isConfigWrite(pathname) {
  return CONFIG_ROUTES[1][1].test(pathname);
}

/**
 * The choices, as My settings shows them: a switch reads on only where it has effect (a token or sign-in saved), as the
 * page draws it.
 * @param {{userSettings: object|null, projectsView: (login: string) => Promise<{defaultProject: string|null}>}} deps
 * @returns {Promise<Record<string, string|null>>}
 */
export async function configView({ userSettings, projectsView }, login) {
  const github = userSettings?.view(login).github ?? null;
  const { defaultProject } = await projectsView(login);
  return {
    terminal: userSettings ? userSettings.terminal(login) : 'tmux',
    reviews: userSettings?.reviewAgents(login) ?? 'default',
    'codex-reviews': userSettings?.usesOwnCodexForReviews(login) ? 'on' : 'off',
    'grok-reviews': userSettings?.usesOwnAgentForReviews?.(login, 'grok') ? 'on' : 'off',
    'opencode-reviews': userSettings?.usesOwnAgentForReviews?.(login, 'opencode') ? 'on' : 'off',
    'claude-token-shared': userSettings?.usesOwnTokenForShared(login) ? 'on' : 'off',
    'default-repo': defaultProject ?? null,
    'github-name': github?.connected ? github.name ?? null : null,
    'github-email': github?.connected ? github.email ?? null : null,
  };
}

/**
 * Runs a page's write, then answers with the view instead of what the write answered: its refusal (status and error)
 * as it was, or the view on success.
 * @param {(held: {writeHead: Function, end: Function}) => Promise<unknown>} run  the write, replying into `held`
 * @param {() => Promise<object>} view
 * @param {(res, status: number, body: object) => void} reply
 */
export async function answerWithView(res, run, view, reply) {
  const held = {
    status: 0,
    body: '',
    writeHead(status) { this.status = status; return this; },
    setHeader() {},
    end(body) { this.body = body === undefined ? '' : String(body); },
  };
  await run(held);
  if (held.status >= 200 && held.status < 300) return reply(res, 200, await view());
  let error = null;
  try {
    error = JSON.parse(held.body)?.error ?? null;
  } catch {
    // Not JSON: said as the status alone.
  }
  return reply(res, held.status || 500, { error: typeof error === 'string' ? error : `the console answered ${held.status}` });
}
