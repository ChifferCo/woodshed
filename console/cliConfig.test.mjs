import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { answerWithView } from './cliConfig.mjs';
import { createCliSignIn } from './cliSignIn.mjs';
import { createReviewAgents } from './reviewAgents.mjs';
import { createHandler } from './server.mjs';
import { createUserSettings } from './userSettings.mjs';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const KEYS = ['terminal', 'reviews', 'codex-reviews', 'grok-reviews', 'opencode-reviews', 'claude-token-shared', 'default-repo', 'github-name', 'github-email'];

// A console with the real My settings (userSettings.mjs) over a secret store that keeps nothing: mia-dev has a Claude
// token saved and GitHub connected, octocat has neither. A command line token for each.
async function consoleFor(t, { writers = null, rememberSecrets = false, saves = null } = {}) {
  const values = new Map();
  const store = {
    state: {
      people: {
        'mia-dev': { claudeTokenAt: '2026-11-01T00:00:00.000Z', github: { connectedAt: '2026-11-01T00:00:00.000Z', name: 'Mia Dev', email: 'mia@example.com' } },
        octocat: { terminal: 'herdr', codexAuthAt: '2026-11-01T00:00:00.000Z' },
      },
    },
    save() { if (saves) saves.push(structuredClone(this.state)); },
  };
  const secrets = rememberSecrets
    ? { read: async (name) => values.get(name) ?? null, save: async (name, value) => { values.set(name, value); }, remove: async (name) => { values.delete(name); }, configured: () => true }
    : { read: async () => null, save: async () => {}, remove: async () => {}, configured: () => true };
  const userSettings = createUserSettings({ store, secrets });
  // GitHub's answer on write access, which cliSignIn.mjs's authenticate asks for every call a token makes.
  const cli = createCliSignIn({ store: { state: {}, save() {} }, canWrite: async (login) => !writers || writers.has(login) });
  const defaults = new Map();
  const projects = [{ name: 'app', repo: 'acme/app' }, { name: 'tools', repo: 'acme/tools' }];
  const projectAccess = {
    view: async (login) => ({ projects, defaultProject: defaults.get(login) ?? 'app', saved: defaults.has(login) }),
    forStart: async (login, name) => projects.find((p) => p.name === (name ?? 'app')) ?? null,
    setDefault: async (login, name) => {
      if (!projects.some((p) => p.name === name)) return null;
      defaults.set(login, name);
      return projectAccess.view(login);
    },
  };
  const fleet = { sessions: () => [], find: () => null };
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => (cookie ? { login: /woodshed_session=([\w-]+)/.exec(cookie)[1] } : null), canWrite: async () => true };
  const config = { host: '127.0.0.1', publicUrl: 'http://pending', extraHosts: [], repo: 'acme/app', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const handle = createHandler({ config, fleet, auth, cli, userSettings, projectAccess, viewPrefs: { view: () => null } });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const origin = `http://localhost:${port}`;
  config.publicUrl = origin;
  const tokenOf = (login) => {
    const { deviceCode, userCode } = cli.start({ name: `${login}-laptop` });
    cli.decide({ code: userCode, login, approve: true });
    return cli.poll(deviceCode).token;
  };
  const tokens = { 'mia-dev': tokenOf('mia-dev'), octocat: tokenOf('octocat') };
  async function call(pathname, { method = 'GET', token = tokens['mia-dev'], headers = {}, body } = {}) {
    const res = await fetch(`${origin}${pathname}`, {
      method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  return { origin, call, tokens, userSettings, cli, secrets };
}

test('GET /api/cli/config answers its person\'s choices, exactly these keys and no secret', async (t) => {
  const c = await consoleFor(t);
  const mine = await c.call('/api/cli/config');
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body, {
    terminal: 'tmux', reviews: 'default', 'codex-reviews': 'off', 'grok-reviews': 'off', 'opencode-reviews': 'off', 'claude-token-shared': 'on', 'default-repo': 'app',
    'github-name': 'Mia Dev', 'github-email': 'mia@example.com',
  });
  const theirs = await c.call('/api/cli/config', { token: c.tokens.octocat });
  assert.deepEqual(Object.keys(theirs.body), KEYS);
  assert.equal(theirs.body.terminal, 'herdr', 'each token reads its own person\'s');
  assert.equal(theirs.body['claude-token-shared'], 'off', 'a switch with no token saved has no effect, and reads off, as the page draws it');
  assert.equal(theirs.body['github-name'], null, 'nothing until GitHub is connected');

  assert.equal((await c.call('/api/cli/config', { token: null })).status, 401, 'no token, no answer');
  assert.equal((await c.call('/api/cli/config', { token: null, headers: { cookie: 'woodshed_session=mia-dev' } })).status, 401, 'a page\'s cookie is not a command line sign-in');
  assert.equal((await c.call('/api/cli/config', { headers: { origin: c.origin } })).status, 403, 'a page\'s call with a token is refused');
  assert.equal((await c.call('/api/cli/config', { method: 'POST', body: {} })).status, 403, 'it is read-only');
});

test('a config write runs the page\'s own route and checks, and answers with the config alone', async (t) => {
  const c = await consoleFor(t);
  const set = await c.call('/api/my/terminal', { method: 'POST', body: { terminal: 'herdr' } });
  assert.equal(set.status, 200);
  assert.deepEqual(Object.keys(set.body), KEYS, 'never the page\'s whole My settings answer');
  assert.equal(set.body.terminal, 'herdr');
  assert.equal(c.userSettings.terminal('mia-dev'), 'herdr');

  const bad = await c.call('/api/my/terminal', { method: 'POST', body: { terminal: 'screen' } });
  assert.deepEqual(bad, { status: 400, body: { error: 'the terminal must be one of tmux, herdr' } }, 'the page\'s check, its refusal as it was');

  assert.equal((await c.call('/api/my/reviews', { method: 'POST', body: { choice: 'codex' } })).body.reviews, 'codex');
  assert.equal((await c.call('/api/my/reviews', { method: 'POST', body: { choice: null } })).body.reviews, 'default');
  assert.equal((await c.call('/api/my/claude-token/shared', { method: 'POST', body: { on: false } })).body['claude-token-shared'], 'off');
  const noSignIn = await c.call('/api/my/codex-auth/reviews', { method: 'POST', body: { on: true } });
  assert.deepEqual(noSignIn, { status: 409, body: { error: 'save your Codex sign-in first' } });
  // With a Codex sign-in saved, the switch turns off and on again, and the console's own record follows.
  const off = await c.call('/api/my/codex-auth/reviews', { method: 'POST', body: { on: false }, token: c.tokens.octocat });
  assert.deepEqual([off.status, off.body['codex-reviews'], c.userSettings.usesOwnCodexForReviews('octocat')], [200, 'off', false]);
  const on = await c.call('/api/my/codex-auth/reviews', { method: 'POST', body: { on: true }, token: c.tokens.octocat });
  assert.deepEqual([on.status, on.body['codex-reviews'], c.userSettings.usesOwnCodexForReviews('octocat')], [200, 'on', true]);
  assert.equal((await c.call('/api/my/projects/default', { method: 'POST', body: { project: 'tools' } })).body['default-repo'], 'tools');
  assert.equal((await c.call('/api/my/projects/default', { method: 'POST', body: { project: 'secret-repo' } })).status, 403);
  const named = await c.call('/api/my/github/identity', { method: 'POST', body: { name: 'Mia D.', email: 'mia@example.org' } });
  assert.deepEqual([named.body['github-name'], named.body['github-email']], ['Mia D.', 'mia@example.org']);
  const notConnected = await c.call('/api/my/github/identity', { method: 'POST', body: { name: 'Octo', email: 'o@example.com' }, token: c.tokens.octocat });
  assert.equal(notConnected.status, 409);
  assert.match(notConnected.body.error, /connect GitHub first/);

  // Grok Build's and OpenCode's switches for reviews, as Codex's: refused with no sign-in saved, and a combined choice.
  assert.deepEqual(await c.call('/api/my/agent-auth/grok/reviews', { method: 'POST', body: { on: true } }), { status: 409, body: { error: 'save your Grok Build sign-in first' } });
  assert.equal((await c.call('/api/my/agent-auth/opencode/reviews', { method: 'POST', body: { on: false } })).body['opencode-reviews'], 'off');
  assert.equal((await c.call('/api/my/reviews', { method: 'POST', body: { choice: 'grok+claude' } })).body.reviews, 'claude+grok', 'saved in the registry\'s order');
  assert.equal((await c.call('/api/my/reviews', { method: 'POST', body: { choice: 'claude+claude' } })).status, 400);

  // A Grok Build or OpenCode sign-in is saved from the command line by `woodshed sign-in push` (cli/agentSignIns.mjs),
  // answered with whether one is set and never the page's view; removing one stays the page's.
  const pushed = await c.call('/api/my/agent-auth/grok', { method: 'POST', body: { value: 'xai-made-up-key-0123456789' } });
  assert.equal(pushed.status, 200);
  assert.deepEqual(Object.keys(pushed.body).sort(), ['agent', 'savedAt', 'set']);
  assert.equal((await c.call('/api/my/agent-auth/grok/remove', { method: 'POST', body: {} })).status, 403, 'a sign-in is never removed from the command line');
  for (const [path, body] of [['/api/my/claude-token', { value: 'sk-ant-x' }], ['/api/my/codex-auth', { value: 'sk-x' }], ['/api/my/files/tmux-conf', { text: 'set -g mouse on' }]]) {
    const out = await c.call(path, { method: 'POST', body });
    assert.equal(out.status, 403, `${path}: a secret is never set from the command line`);
  }
});

test('a first command-line sign-in stays out of reviews until that person turns it on', async (t) => {
  const saves = [];
  const c = await consoleFor(t, { rememberSecrets: true, saves });
  const reviews = createReviewAgents({ userSettings: c.userSettings, connected: async () => ({ claude: true, codex: true }) });
  const grok = 'xai-made-up-key-0123456789';
  const pushed = await c.call('/api/my/agent-auth/grok', { method: 'POST', body: { value: grok } });
  assert.equal(pushed.status, 200);
  assert.equal(c.userSettings.usesOwnAgentForReviews('mia-dev', 'grok'), false, 'a first upload does not turn the reviews switch on');
  // The first settings write that records the sign-in is what a restart reads if the console stops there. It has to
  // already say reviews are off: a later write never runs.
  const first = saves.find((state) => state.people['mia-dev']?.agentAuthAt?.grok);
  assert.equal(first.people['mia-dev'].ownAgentForReviews?.grok, false, 'the sign-in and the reviews-off flag are one settings update');
  assert.equal(first.reviewDefaultKept, true, 'the one-time mark has already run, so a restart does not apply it again');
  const restarted = createUserSettings({ store: { state: structuredClone(first), save() {} }, secrets: c.secrets });
  assert.equal(restarted.usesOwnAgentForReviews('mia-dev', 'grok'), false);
  const afterRestart = createReviewAgents({ userSettings: restarted, connected: async () => ({ claude: true, codex: true }) });
  assert.deepEqual((await afterRestart.forReview({ login: 'mia-dev' })).agents, ['claude', 'codex'], 'the restored snapshot does not put Grok Build in the default');
  assert.equal(c.userSettings.usesExpandedReviewDefault('mia-dev'), true, 'the person stays on the wider default; only this sign-in is left out');
  assert.equal((await c.call('/api/cli/config')).body['grok-reviews'], 'off');
  assert.deepEqual((await reviews.forReview({ login: 'mia-dev' })).agents, ['claude', 'codex']);

  const replaced = await c.call('/api/my/agent-auth/grok', { method: 'POST', body: { value: 'xai-made-up-mia-0123456789' } });
  assert.equal(replaced.status, 200);
  assert.equal(c.userSettings.usesOwnAgentForReviews('mia-dev', 'grok'), false, 'replacing it does not turn the switch on');

  assert.equal((await c.call('/api/my/reviews', { method: 'POST', body: { choice: 'claude+grok' } })).status, 200);
  const named = await reviews.forReview({ login: 'mia-dev' });
  assert.deepEqual(named.agents, ['claude'], 'a choice that names it still leaves it out while the switch is off');
  assert.match(named.why, /Grok Build left out/);

  const on = await c.call('/api/my/agent-auth/grok/reviews', { method: 'POST', body: { on: true } });
  assert.equal(on.body['grok-reviews'], 'on');
  assert.deepEqual((await reviews.forReview({ login: 'mia-dev' })).agents, ['claude', 'grok']);
  assert.equal((await c.call('/api/my/reviews', { method: 'POST', body: { choice: null } })).body.reviews, 'default');
  assert.deepEqual((await reviews.forReview({ login: 'mia-dev' })).agents, ['claude', 'codex', 'grok']);

  await c.userSettings.setAgentAuth('mia-dev', 'opencode', '{"openai":{"type":"api","key":"sk-x"}}');
  assert.equal(c.userSettings.usesOwnAgentForReviews('mia-dev', 'opencode'), true, 'a save through My settings still starts the switch on');
  const kept = await c.call('/api/my/agent-auth/opencode', { method: 'POST', body: { value: '{"anthropic":{"type":"api","key":"sk-ant-api03"}}' } });
  assert.equal(kept.status, 200);
  assert.equal(c.userSettings.usesOwnAgentForReviews('mia-dev', 'opencode'), true, 'replacing a sign-in already on for reviews leaves the switch on');

  const firstOpen = await c.call('/api/my/agent-auth/opencode', { method: 'POST', token: c.tokens.octocat, body: { value: '{"openai":{"type":"api","key":"sk-x"}}' } });
  assert.equal(firstOpen.status, 200);
  assert.equal(c.userSettings.usesOwnAgentForReviews('octocat', 'opencode'), false);
  const page = await c.call('/api/my/agent-auth/grok', {
    method: 'POST', token: null,
    headers: { cookie: 'woodshed_session=octocat', 'x-woodshed': '1' },
    body: { value: grok },
  });
  assert.equal(page.status, 200);
  assert.equal(c.userSettings.usesOwnAgentForReviews('octocat', 'grok'), true, 'My settings\' Save of a first sign-in still turns the switch on');
  const octo = await reviews.forReview({ login: 'octocat' });
  assert.deepEqual(octo.agents, ['claude', 'codex', 'grok']);
  assert.equal(JSON.stringify(pushed).includes(grok), false, 'the answer never carries the sign-in');
});

test('the config routes check a token as every other route does: a person who lost write access is refused, and changes nothing', async (t) => {
  const writers = new Set(['mia-dev', 'octocat']);
  const c = await consoleFor(t, { writers });
  assert.equal((await c.call('/api/cli/config')).status, 200);
  // GitHub is asked at a token's first call (then hourly): octocat's first is after GitHub stopped saying yes.
  writers.delete('octocat');
  const read = await c.call('/api/cli/config', { token: c.tokens.octocat });
  assert.equal(read.status, 401);
  const write = await c.call('/api/my/terminal', { method: 'POST', body: { terminal: 'tmux' }, token: c.tokens.octocat });
  assert.equal(write.status, 401);
  assert.equal(c.userSettings.terminal('octocat'), 'herdr', 'nothing was changed');
  assert.deepEqual(c.cli.list('octocat'), [], 'and every command line sign-in of theirs ended');
});

test('answerWithView passes a refusal through, and answers a success with the view', async () => {
  const replies = [];
  const reply = (res, status, body) => replies.push([status, body]);
  await answerWithView(null, async (held) => { held.writeHead(200, {}); held.end(JSON.stringify({ whole: 'page' })); }, async () => ({ terminal: 'tmux' }), reply);
  await answerWithView(null, async (held) => { held.writeHead(409, {}); held.end(JSON.stringify({ error: 'save your Claude token first' })); }, async () => ({}), reply);
  await answerWithView(null, async (held) => { held.writeHead(502, {}); held.end('<html>'); }, async () => ({}), reply);
  assert.deepEqual(replies, [[200, { terminal: 'tmux' }], [409, { error: 'save your Claude token first' }], [502, { error: 'the console answered 502' }]]);
});
