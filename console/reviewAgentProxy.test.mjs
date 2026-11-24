import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { MAX_BODY_BYTES, createReviewAgentProxy, reviewAgentRoute, reviewAgentTokenOf } from './reviewAgentProxy.mjs';
import { createSessionApi, sessionTokenOf } from './sessionApi.mjs';

const NOW = Date.parse('2026-11-18T10:00:00Z');
const review = (agents, ownSignIns) => ({ trigger: 'review', review: { base: 'main', agents, ownSignIns } });
const SESSIONS = [
  { id: 'aaaaaaaa', status: 'running', token: 'review-gil', ...review(['claude', 'grok'], { grok: { login: 'gil', via: 'key' } }) },
  { id: 'bbbbbbbb', status: 'running', token: 'review-lou', ...review(['grok'], { grok: { login: 'lou', via: 'login' } }) },
  { id: 'cccccccc', status: 'running', token: 'review-old', ...review(['grok'], { grok: { login: 'old', via: 'login' } }) },
  { id: 'dddddddd', status: 'running', token: 'review-oto', ...review(['claude', 'opencode'], { opencode: { login: 'oto', provider: 'anthropic' } }) },
  { id: 'eeeeeeee', status: 'running', token: 'review-claude', ...review(['claude']) },
  { id: 'ffffffff', status: 'running', token: 'private-grok', owner: 'gil', options: { agent: 'grok' } },
  { id: '11111111', status: 'stopped', token: 'review-stopped', ...review(['grok'], { grok: { login: 'gil', via: 'key' } }) },
  { id: '22222222', status: 'running', token: 'review-tainted', taintedAt: '2026-11-18T09:00:00Z', ...review(['grok'], { grok: { login: 'gil', via: 'key' } }) },
  { id: '33333333', status: 'running', token: 'review-ovi', ...review(['opencode'], { opencode: { login: 'ovi', provider: 'openai' } }) },
  // A review that lists grok but recorded no author's sign-in for it: there is no team key to fall back on.
  { id: '44444444', status: 'running', token: 'review-nobody', ...review(['claude', 'grok']) },
];

// Made-up sign-ins: an xAI key, a login and an expired one, and OpenCode's auth.json with API keys.
const SIGN_INS = {
  grok: {
    gil: 'xai-made-up-gil-0123456789',
    lou: JSON.stringify({ 'https://auth.x.ai::made-up': { key: 'made-up-lou-access', refresh_token: 'made-up-lou-refresh', expires_at: '2026-11-18T12:00:00Z' } }),
    old: JSON.stringify({ 'https://auth.x.ai::made-up': { key: 'made-up-old-access', refresh_token: 'made-up-old-refresh', expires_at: '2026-11-18T09:00:00Z' } }),
  },
  opencode: {
    oto: JSON.stringify({ anthropic: { type: 'api', key: 'sk-ant-made-up-oto' }, openai: { type: 'api', key: 'sk-made-up-oto' } }),
    ovi: JSON.stringify({ openai: { type: 'api', key: 'sk-made-up-ovi' } }),
  },
};

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function setup(t, { on = { grok: ['gil', 'lou', 'old'], opencode: ['oto', 'ovi'] }, signIns = SIGN_INS } = {}) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {}\n\n');
    });
  });
  const up = `http://127.0.0.1:${await listen(upstream)}`;
  const reads = [];
  const userSettings = {
    usesOwnAgentForReviews: (login, id) => (on[id] ?? []).includes(login),
    agentAuth: async (login, id) => { reads.push(id); return signIns[id]?.[login] ?? null; },
  };
  const reviewAgentProxy = createReviewAgentProxy({
    userSettings, now: () => NOW,
    grokUpstreams: { key: `${up}/xai/v1`, login: `${up}/grok-login/v1` }, opencodeUpstreams: { anthropic: `${up}/anthropic`, openai: `${up}/openai` },
  });
  const handle = createSessionApi({ fleet: { sessions: () => SESSIONS }, tokens: { token: async () => ({}) }, reviewAgentProxy });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => { server.close(); upstream.close(); });
  // As sent, with no tidying of `..` (fetch would resolve it before sending).
  // A Responses body carries store: false, as every agent was measured to send it, and as the proxy requires.
  const call = (token, path = '/grok/v1/chat/completions', { method = 'POST', header = 'authorization', extra = {}, body = path.split('?')[0].endsWith('/responses') ? '{"model":"grok-build","store":false}' : '{"model":"grok-build"}' } = {}) => new Promise((resolve, reject) => {
    const auth = token ? { [header]: header === 'authorization' ? `Bearer ${token}` : token } : {};
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', 'x-grok-client-mode': 'headless', ...extra, ...auth } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    r.on('error', reject);
    r.end(method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined);
  });
  return { seen, call, reads };
}

function logged(t) {
  const lines = [];
  for (const level of ['log', 'warn']) t.mock.method(console, level, (...args) => lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')));
  return lines;
}

test('a review\'s grok goes out on its author\'s xAI key, and its session token never reaches xAI', async (t) => {
  const lines = logged(t);
  const { seen, call } = await setup(t);
  const res = await call('review-gil');
  assert.equal(res.status, 200);
  assert.equal(seen[0].url, '/xai/v1/chat/completions', 'the console\'s prefix is dropped, under the key\'s API');
  assert.equal(seen[0].headers.authorization, 'Bearer xai-made-up-gil-0123456789');
  assert.equal(seen[0].headers['x-grok-client-mode'], 'headless', 'grok\'s own headers go along');
  assert.equal(seen[0].body, '{"model":"grok-build"}');
  assert.ok(!JSON.stringify(seen[0].headers).includes('review-gil'));
  assert.equal((await call('review-gil', '/grok/v1/models', { method: 'GET' })).status, 200);
  assert.equal((await call('review-gil', '/grok/v1/responses')).status, 200);
  assert.ok(lines.some((l) => l.includes('reviewAgentProxy: first call on the author\'s Grok Build sign-in') && l.includes('"via":"key"')));
  assert.ok(!lines.join('\n').includes('made-up-gil'), 'no sign-in is logged');
});

test('a review on its author\'s Grok login goes to the login\'s API with its access token, and never refreshes it', async (t) => {
  const { seen, call } = await setup(t);
  assert.equal((await call('review-lou')).status, 200);
  assert.equal(seen[0].url, '/grok-login/v1/chat/completions');
  assert.equal(seen[0].headers.authorization, 'Bearer made-up-lou-access');
  assert.ok(!seen.some((s) => s.body.includes('refresh')), 'the refresh token goes nowhere');
});

test('an expired Grok login is refused, and says so to the review', async (t) => {
  const lines = logged(t);
  const { seen, call } = await setup(t);
  const res = await call('review-old');
  assert.equal(res.status, 403);
  assert.match(JSON.parse(res.body).error.message, /@old's saved Grok Build login has expired/);
  assert.equal(seen.length, 0);
  assert.ok(lines.some((l) => l.includes('reviewAgentProxy: refused, the author\'s sign-in not usable')));
});

test('a switch turned off, or a sign-in removed, since the review started stops it at the next call', async (t) => {
  const off = await setup(t, { on: { grok: [] } });
  const res = await off.call('review-gil');
  assert.equal(res.status, 403);
  assert.match(JSON.parse(res.body).error.message, /@gil no longer has their Grok Build sign-in on for reviews/);
  const gone = await setup(t, { signIns: { grok: {}, opencode: {} } });
  assert.match(JSON.parse((await gone.call('review-gil')).body).error.message, /@gil has no Grok Build sign-in saved/);
  assert.equal(off.seen.length + gone.seen.length, 0);
});

test('only a review that runs the agent on its author\'s sign-in gets through: no other session, and no one else\'s', async (t) => {
  const lines = logged(t);
  const { seen, call } = await setup(t);
  assert.equal((await call('private-grok')).status, 403, 'a private Grok session runs on its own sign-in, never through here');
  assert.equal((await call('review-claude')).status, 403, 'a review that does not run grok');
  assert.equal((await call('review-nobody')).status, 403, 'a review with no author\'s sign-in recorded: no team key to fall back on');
  assert.equal((await call('review-oto')).status, 403, 'a review whose OpenCode runs, asking for grok');
  assert.equal((await call('review-stopped')).status, 401, 'a stopped session');
  assert.equal((await call(null)).status, 401, 'no token');
  assert.equal((await call('review-tainted')).status, 403, 'a tainted session');
  assert.equal(seen.length, 0, 'nothing reached xAI');
  assert.ok(lines.some((l) => l.includes('reviewAgentProxy: refused, not a review session')));
  assert.ok(lines.some((l) => l.includes('reviewAgentProxy: refused, the review does not run it')));
});

test('the author\'s sign-in is the review\'s recorded author\'s, whoever else has one on', async (t) => {
  // gil's review: lou's login is on for reviews too, and never used for it.
  const { seen, call } = await setup(t);
  await call('review-gil');
  await call('review-lou');
  assert.deepEqual(seen.map((s) => s.headers.authorization), ['Bearer xai-made-up-gil-0123456789', 'Bearer made-up-lou-access']);
});

test('only the calls a review\'s agent makes pass, in their plain form', async (t) => {
  const { seen, call } = await setup(t);
  for (const path of ['/grok/v1/files', '/grok/v1/../v1/files', '/grok/v1/chat/completions/../../files', '/grok/v1/%2e%2e/files', '/grok//v1/models',
    '/grok/v1/batches', '/opencode/anthropic/v1/files', '/opencode/openrouter/v1/chat/completions', '/opencode/openai/v1/files', '/opencode']) {
    assert.equal((await call('review-gil', path)).status, 404, path);
  }
  for (const path of ['/opencode/anthropic/v1/files', '/opencode/anthropic/v1/messages/../../v1/files']) assert.equal((await call('review-oto', path, { header: 'x-api-key' })).status, 404, path);
  assert.equal(seen.length, 0);
  assert.deepEqual(reviewAgentRoute('/grok/v1/models', 'GET'), { agent: 'grok', provider: null, path: '/v1/models' });
  assert.match(reviewAgentRoute('/grok/v1/models?x=1', 'GET').refused, /no query string/);
  assert.equal(reviewAgentRoute('/elsewhere'), null);
});

// Every path any of them allows, and a few each refuses, with every method: a recording upstream counts what reached it.
const PATHS = ['/v1/models', '/v1/responses', '/v1/chat/completions', '/v1/messages', '/v1/messages/count_tokens',
  '/v1/responses/resp_made-up', '/v1/chat/completions/chatcmpl-made-up', '/v1/files', '/v1/batches'];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const ALLOWED = {
  grok: { token: 'review-gil', prefix: '/grok', upstream: '/xai', calls: { 'GET /v1/models': 1, 'POST /v1/responses': 1, 'POST /v1/chat/completions': 1 } },
  anthropic: { token: 'review-oto', header: 'x-api-key', prefix: '/opencode/anthropic', upstream: '/anthropic',
    calls: { 'POST /v1/messages': 1, 'POST /v1/messages/count_tokens': 1, 'GET /v1/models': 1 } },
  openai: { token: 'review-ovi', prefix: '/opencode/openai', upstream: '/openai', calls: { 'POST /v1/responses': 1, 'GET /v1/models': 1 } },
};

for (const [name, { token, header = 'authorization', prefix, upstream, calls }] of Object.entries(ALLOWED)) {
  test(`${name}: each path passes only with the method it needs, and nothing else reaches the upstream`, async (t) => {
    const lines = logged(t);
    const { seen, call } = await setup(t);
    for (const path of PATHS) {
      for (const method of METHODS) {
        const before = seen.length;
        const res = await call(token, `${prefix}${path}`, { method, header });
        const key = `${method} ${path}`;
        if (calls[key]) {
          assert.equal(res.status, 200, key);
          assert.equal(seen.length, before + 1, `${key} reached the upstream`);
          assert.deepEqual([seen.at(-1).method, seen.at(-1).url], [method, `${upstream}${path}`]);
        } else {
          assert.equal(res.status, Object.keys(calls).some((c) => c.endsWith(` ${path}`)) ? 405 : 404, key);
          assert.equal(seen.length, before, `${key} never reached the upstream`);
        }
      }
    }
    assert.equal(seen.length, Object.keys(calls).length);
    assert.ok(lines.some((l) => l.includes('reviewAgentProxy: refused a call a review\'s agent does not need')));
  });
}

test('OpenAI\'s stored completions and responses are never read through a review\'s OpenCode, nor any query string passed', async (t) => {
  const lines = logged(t);
  const { seen, call } = await setup(t);
  const list = await call('review-ovi', '/opencode/openai/v1/chat/completions', { method: 'GET' });
  assert.equal(list.status, 404, 'chat completions are not OpenCode\'s on OpenAI at all');
  assert.equal((await call('review-ovi', '/opencode/openai/v1/responses', { method: 'GET' })).status, 405);
  for (const path of ['/opencode/openai/v1/models?limit=100&after=secret-made-up', '/opencode/openai/v1/responses?include=all',
    '/grok/v1/models?metadata=made-up']) {
    const res = await call(path.startsWith('/grok') ? 'review-gil' : 'review-ovi', path, { method: path.includes('responses') ? 'POST' : 'GET' });
    assert.equal(res.status, 404, path);
    assert.match(JSON.parse(res.body).error.message, /no query string/);
  }
  assert.equal(seen.length, 0, 'the upstream got none of them');
  assert.ok(!lines.join('\n').includes('secret-made-up'), 'a refused query is not logged');
});

test('a review\'s OpenCode reaches Anthropic on its author\'s API key, from opencode\'s own x-api-key', async (t) => {
  const { seen, call } = await setup(t);
  const res = await call('review-oto', '/opencode/anthropic/v1/messages', { header: 'x-api-key' });
  assert.equal(res.status, 200);
  assert.equal(seen[0].url, '/anthropic/v1/messages');
  assert.equal(seen[0].headers['x-api-key'], 'sk-ant-made-up-oto');
  assert.equal(seen[0].headers.authorization, undefined);
  assert.equal((await call('review-oto', '/opencode/openai/v1/responses')).status, 403, 'only the provider the review started on');
});

test('a review\'s OpenCode reaches OpenAI on its author\'s API key, and loses it when the key is gone from auth.json', async (t) => {
  const { seen, call } = await setup(t);
  assert.equal((await call('review-ovi', '/opencode/openai/v1/responses', { extra: { 'openai-organization': 'org-other', 'openai-project': 'proj_other' } })).status, 200);
  assert.equal(seen[0].url, '/openai/v1/responses');
  assert.equal(seen[0].headers.authorization, 'Bearer sk-made-up-ovi');
  assert.deepEqual([seen[0].headers['openai-organization'], seen[0].headers['openai-project']], [undefined, undefined], 'the review picks none of the key\'s projects');
  const swapped = await setup(t, { signIns: { opencode: { ovi: JSON.stringify({ anthropic: { type: 'api', key: 'sk-ant-made-up-ovi' } }) } } });
  const res = await swapped.call('review-ovi', '/opencode/openai/v1/responses');
  assert.equal(res.status, 403);
  assert.match(JSON.parse(res.body).error.message, /no longer have the openai API key this review started on/);
  const login = await setup(t, { signIns: { opencode: { ovi: JSON.stringify({ openai: { type: 'oauth', access: 'made-up', refresh: 'made-up', expires: 0 } }) } } });
  assert.equal((await login.call('review-ovi', '/opencode/openai/v1/responses')).status, 403, 'never a login');
  assert.equal(swapped.seen.length + login.seen.length, 0);
});

test('the session API knows the token a review\'s agent sends, as a bearer or as Anthropic\'s x-api-key', () => {
  assert.equal(reviewAgentTokenOf({ authorization: 'Bearer abc' }), 'abc');
  assert.equal(reviewAgentTokenOf({ 'x-api-key': 'abc' }), 'abc');
  assert.equal(reviewAgentTokenOf({}), null);
  assert.equal(sessionTokenOf({ url: '/opencode/anthropic/v1/messages', headers: { 'x-api-key': 'tok' } }), 'tok');
  assert.equal(sessionTokenOf({ url: '/grok/v1/models', headers: { authorization: 'Bearer tok' } }), 'tok');
});

// Bodies in the shapes each agent was measured to send (reviewAgentScope.mjs): the turn after a tool call, its whole
// conversation in it. The values are made up.
const MEASURED = {
  grokTurn: ['review-gil', '/grok/v1/chat/completions', {
    model: 'grok-build', stream: true, stream_options: { include_usage: true },
    messages: [
      { role: 'system', content: 'You review.' }, { role: 'user', content: 'Review this.' },
      { role: 'assistant', content: 'Looking.', model_id: 'grok-build', reasoning_content: 'hm', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'file' },
    ],
    tools: [{ type: 'function', function: { name: 'read_file', description: 'Reads', parameters: { type: 'object', properties: { file_id: { type: 'string' } } } } }],
  }],
  grokTitle: ['review-gil', '/grok/v1/responses', {
    model: 'grok-build', input: [{ type: 'message', role: 'user', content: 'Review this.' }], max_output_tokens: 64,
    reasoning: { summary: 'auto' }, store: false, stream: true, temperature: 0,
    tool_choice: { type: 'function', name: 'title' }, tools: [{ type: 'function', name: 'title', description: 'Names it', parameters: { type: 'object' } }],
  }],
  anthropicTurn: ['review-oto', '/opencode/anthropic/v1/messages', {
    model: 'claude-made-up', max_tokens: 1000, stream: true, output_config: { effort: 'high' },
    thinking: { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'restart' } },
    system: [{ type: 'text', text: 'You review.', cache_control: { type: 'ephemeral' } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Review this.' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm', signature: 'sig' }, { type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command: 'ls', file_id: 'not read' }, cache_control: { type: 'ephemeral' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a b', cache_control: { type: 'ephemeral' } }] },
    ],
    tools: [{ name: 'bash', description: 'Runs', input_schema: { type: 'object' }, eager_input_streaming: true }], tool_choice: { type: 'auto' },
  }],
  openaiTurn: ['review-ovi', '/opencode/openai/v1/responses', {
    model: 'gpt-made-up', prompt_cache_key: 'ses_made_up', reasoning: { effort: 'medium', mode: 'auto', summary: 'auto' },
    store: false, stream: true, text: { verbosity: 'low' }, tool_choice: 'auto',
    input: [
      { role: 'system', content: 'You review.' }, { role: 'user', content: [{ type: 'input_text', text: 'Review this.' }] },
      { type: 'reasoning', encrypted_content: 'opaque', summary: [] }, { role: 'assistant', content: [{ type: 'output_text', text: 'Looking.' }] },
      { type: 'function_call', call_id: 'call_1', name: 'bash', arguments: '{}' }, { type: 'function_call_output', call_id: 'call_1', output: 'a b' },
    ],
    tools: [{ type: 'function', name: 'bash', description: 'Runs', parameters: { type: 'object' }, strict: false }],
  }],
};
const SECRET_ID = 'made-up-foreign-object-7f3a';
const edit = (which, change) => {
  const [token, path, body] = MEASURED[which];
  const copy = structuredClone(body);
  change(copy);
  return [token, path, copy];
};

test('the calls each agent was measured to send pass, whole, on the author\'s sign-in', async (t) => {
  const { seen, call } = await setup(t);
  for (const [name, [token, path, body]] of Object.entries(MEASURED)) {
    const res = await call(token, path, { body });
    assert.equal(res.status, 200, name);
    assert.deepEqual(JSON.parse(seen.at(-1).body), body, `${name} goes on as sent`);
    assert.equal(seen.at(-1).headers['content-length'], String(Buffer.byteLength(JSON.stringify(body))));
  }
  assert.equal(seen.length, Object.keys(MEASURED).length);
});

test('a body naming an object the author\'s account holds is refused, top level or nested, before the sign-in is read', async (t) => {
  const lines = logged(t);
  const { seen, call, reads } = await setup(t);
  const cases = {
    'previous_response_id': edit('openaiTurn', (b) => { b.previous_response_id = SECRET_ID; }),
    'conversation': edit('openaiTurn', (b) => { b.conversation = SECRET_ID; }),
    'prompt': edit('openaiTurn', (b) => { b.prompt = { id: SECRET_ID, version: '1' }; }),
    'store': edit('openaiTurn', (b) => { b.store = true; }),
    'input[].type': edit('openaiTurn', (b) => { b.input.push({ type: 'item_reference', id: SECRET_ID }); }),
    'input[].id': edit('openaiTurn', (b) => { b.input[2].id = SECRET_ID; }),
    'input[].content[].type': edit('openaiTurn', (b) => { b.input[1].content.push({ type: 'input_file', file_id: SECRET_ID }); }),
    'input[].content[].file_id': edit('openaiTurn', (b) => { b.input[1].content.push({ type: 'input_image', file_id: SECRET_ID }); }),
    'input[].content[].image_url': edit('openaiTurn', (b) => { b.input[1].content.push({ type: 'input_image', image_url: `https://files.example/${SECRET_ID}` }); }),
    'tools[].type': edit('openaiTurn', (b) => { b.tools.push({ type: 'file_search', vector_store_ids: [SECRET_ID] }); }),
    'tools[].container': edit('openaiTurn', (b) => { b.tools[0].container = SECRET_ID; }),
    'grok previous_response_id': edit('grokTurn', (b) => { b.previous_response_id = SECRET_ID; }),
    'grok messages[].content[].type': edit('grokTurn', (b) => { b.messages[1].content = [{ type: 'file', file: { file_id: SECRET_ID } }]; }),
    'grok tools[].type': edit('grokTurn', (b) => { b.tools.push({ type: 'collections_search', collection_ids: [SECRET_ID] }); }),
    'grok search_parameters': edit('grokTurn', (b) => { b.search_parameters = { sources: [{ type: 'x' }] }; }),
    'grok title previous_response_id': edit('grokTitle', (b) => { b.previous_response_id = SECRET_ID; }),
    'grok title input[].type': edit('grokTitle', (b) => { b.input.push({ type: 'item_reference', id: SECRET_ID }); }),
    'anthropic document': edit('anthropicTurn', (b) => { b.messages[0].content.push({ type: 'document', source: { type: 'file', file_id: SECRET_ID } }); }),
    'anthropic image by file': edit('anthropicTurn', (b) => { b.messages[0].content.push({ type: 'image', source: { type: 'file', file_id: SECRET_ID } }); }),
    'anthropic tool result image by file': edit('anthropicTurn', (b) => { b.messages[2].content[0].content = [{ type: 'image', source: { type: 'file', file_id: SECRET_ID } }]; }),
    'anthropic container': edit('anthropicTurn', (b) => { b.container = SECRET_ID; }),
    'anthropic mcp_servers': edit('anthropicTurn', (b) => { b.mcp_servers = [{ type: 'url', url: 'https://mcp.example', name: SECRET_ID }]; }),
    'anthropic server tool': edit('anthropicTurn', (b) => { b.tools.push({ type: 'code_execution_20250825', name: 'code_execution' }); }),
  };
  for (const [name, [token, path, body]] of Object.entries(cases)) {
    const res = await call(token, path, { body });
    assert.equal(res.status, 403, name);
    assert.match(JSON.parse(res.body).error.message, /does not send \S+ to \/v1\//, name);
    assert.ok(!res.body.includes(SECRET_ID), `${name}: the answer never quotes a value`);
  }
  assert.equal(seen.length, 0, 'none reached a provider');
  assert.deepEqual(reads, [], 'no sign-in was read for any');
  const refusals = lines.filter((l) => l.includes('reviewAgentProxy: refused, a body a review\'s agent does not send'));
  assert.equal(refusals.length, Object.keys(cases).length);
  for (const field of ['"previous_response_id"', '"input[].type"', '"input[].content[].file_id"', '"tools[].type"', '"messages[].content[].type"', '"container"', '"mcp_servers"', '"messages[].content[].content[].source.type"']) {
    assert.ok(refusals.some((l) => l.includes(`"field":${field}`)), `the log names ${field}`);
  }
  assert.ok(!lines.join('\n').includes(SECRET_ID), 'no value is logged');
});

test('a body that is not JSON, not an object, or compressed is refused, and never reaches the provider', async (t) => {
  const lines = logged(t);
  const { seen, call, reads } = await setup(t);
  assert.equal((await call('review-gil', '/grok/v1/chat/completions', { body: 'model=grok-build' })).status, 400);
  assert.equal((await call('review-oto', '/opencode/anthropic/v1/messages', { body: '' })).status, 400);
  assert.equal((await call('review-ovi', '/opencode/openai/v1/responses', { body: '[{"model":"x"}]' })).status, 403);
  assert.equal((await call('review-gil', '/grok/v1/chat/completions', { body: '{}', extra: { 'content-encoding': 'gzip' } })).status, 415);
  assert.equal(seen.length, 0);
  assert.deepEqual(reads, []);
  assert.ok(lines.some((l) => l.includes('"why":"not JSON"')));
  assert.ok(lines.some((l) => l.includes('"field":"the body"')));
  assert.ok(lines.some((l) => l.includes('"why":"compressed"')));
});

test('grok\'s turns chain by sending the conversation again, and no response id passes: not a made-up one, not another session\'s, not its own', async (t) => {
  const { seen, call } = await setup(t);
  const [token, path, turn] = MEASURED.grokTurn;
  // Turn after turn, each with the conversation so far: what grok was measured to do.
  const first = { ...turn, messages: turn.messages.slice(0, 2) };
  assert.equal((await call(token, path, { body: first })).status, 200);
  assert.equal((await call(token, path, { body: turn })).status, 200);
  const third = structuredClone(turn);
  third.messages.push({ role: 'assistant', content: 'Done.', model_id: 'grok-build' });
  assert.equal((await call(token, path, { body: third })).status, 200);
  assert.equal(seen.length, 3);
  // An id the provider answered this very review with, another review's, and a made-up one: none is needed, none passes.
  for (const id of ['resp_this_review_made', 'resp_another_session', 'resp_made_up']) {
    assert.equal((await call(token, '/grok/v1/responses', { body: { ...MEASURED.grokTitle[2], previous_response_id: id } })).status, 403);
    assert.equal((await call('review-lou', path, { body: { ...turn, previous_response_id: id } })).status, 403);
  }
  assert.equal(seen.length, 3);
});

test('a body over the cap is refused with 413, and the call is answered', async (t) => {
  const lines = logged(t);
  const { seen, call, reads } = await setup(t);
  const res = await call('review-gil', '/grok/v1/chat/completions', { body: `{"model":"${'x'.repeat(MAX_BODY_BYTES)}"}` });
  assert.equal(res.status, 413);
  assert.equal(seen.length, 0);
  assert.deepEqual(reads, []);
  assert.ok(lines.some((l) => l.includes('"why":"too large"')));
});

test('grok\'s conversation ids reach xAI as ids of the review\'s own, never as sent', async (t) => {
  logged(t);
  const { seen, call } = await setup(t);
  const ids = { 'x-grok-conv-id': 'someone-elses-conversation', 'x-grok-session-id': 'sess-1', 'x-grok-conv-group-id': 'group-1' };
  assert.equal((await call('review-gil', '/grok/v1/chat/completions', { extra: ids })).status, 200);
  assert.equal((await call('review-gil', '/grok/v1/chat/completions', { extra: ids })).status, 200);
  assert.equal((await call('review-lou', '/grok/v1/chat/completions', { extra: ids })).status, 200);
  const [first, again, other] = seen.map((s) => s.headers);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  for (const [name, sent] of Object.entries(ids)) {
    assert.match(first[name], uuid, name);
    assert.notEqual(first[name], sent, `${name}: never as the session sent it`);
    assert.equal(again[name], first[name], `${name}: the same within the review, so its turns stay one conversation`);
    assert.notEqual(other[name], first[name], `${name}: another review's same id is another conversation`);
  }
  assert.notEqual(first['x-grok-conv-id'], first['x-grok-session-id'], 'each header its own');
  assert.equal(first['x-grok-client-mode'], 'headless', 'grok\'s other headers go along as they are');
});

test('a Responses body that leaves store out is refused, since left out it is stored by default', async (t) => {
  const lines = logged(t);
  const { seen, call, reads } = await setup(t);
  for (const which of ['openaiTurn', 'grokTitle']) {
    const [token, path, body] = edit(which, (b) => { delete b.store; });
    const res = await call(token, path, { body });
    assert.equal(res.status, 403, which);
    assert.match(res.body, /store/, `${which}: the field is named`);
  }
  assert.equal(seen.length, 0, 'nothing reaches OpenAI or xAI');
  assert.equal(reads.length, 0, 'no sign-in is read');
  assert.ok(lines.some((l) => l.includes('refused, a body a review\'s agent does not send') && l.includes('store')));
  // Grok's chat completions, which store nothing, take none.
  const [token, path, body] = MEASURED.grokTurn;
  assert.equal('store' in body, false);
  assert.equal((await call(token, path, { body })).status, 200);
});
