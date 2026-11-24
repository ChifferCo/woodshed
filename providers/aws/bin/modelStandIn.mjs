// A stand-in for xAI's, Anthropic's and OpenAI's model APIs, for the in-image runs (reviewInImage.mjs): it records the
// shape of every call, each field's path and the value of each `type` and boolean field, never another value, and
// answers well enough for an agent to take a second turn: a tool call first (with a reasoning or thinking part, and a
// line of text, which the agent sends back in its next turn), then a closing text. What it records is what
// console/reviewAgentScope.mjs was measured from.

import http from 'node:http';

let n = 0;

// A model as a `grok login`'s upstream (cli-chat-proxy.grok.com) lists it, read there on 2026-11-24 with its text cut:
// `api_backend: responses` is what makes grok take its turns on /v1/responses rather than /v1/chat/completions, and
// `supports_backend_search` what makes it offer xAI's own x_search tool there (console/reviewAgentScope.mjs). A key's
// list (api.x.ai) has neither, so the stand-in answers the login's path with this one.
const GROK_LOGIN_MODEL = {
  id: 'grok-build', object: 'model', owned_by: 'xAI', model: 'grok-build', model_family: 'xai', name: 'Grok Build',
  context_window: 256000, context_windows: [256000], auto_compact_threshold_percent: 80, system_prompt_label: 'Grok Build',
  api_backend: 'responses', reasoning_effort: 'high', supports_reasoning_effort: true,
  reasoning_efforts: [{ id: 'high', value: 'high', label: 'High', description: 'High', default: true }],
  supports_backend_search: true, compactions_remaining: 1, compaction_at_tokens: true,
};

// Every path in a body, arrays as [], each object in an array tagged with its own `type`; JSON schemas are not walked.
function shape(value, at = '', out = new Set(), depth = 0) {
  if (depth > 40) return out;
  if (Array.isArray(value)) {
    for (const item of value) shape(item, `${at}[]`, out, depth + 1);
    if (!value.length) out.add(`${at}[]`);
    return out;
  }
  if (value && typeof value === 'object') {
    const tag = typeof value.type === 'string' ? `{type=${value.type}}` : '';
    for (const [k, v] of Object.entries(value)) {
      const p = `${at}${tag}.${k}`;
      if (['parameters', 'input_schema', 'schema'].includes(k)) { out.add(`${p}:<schema>`); continue; }
      if (v && typeof v === 'object') shape(v, p, out, depth + 1);
      else out.add(`${p}:${v === null ? 'null' : typeof v === 'boolean' ? v : typeof v}`);
    }
    return out;
  }
  return out;
}

function pickTool(tools, style) {
  const fns = (tools ?? []).map((t) => (style === 'chat' ? t.function : t)).filter((f) => f?.name);
  const f = fns.find((x) => /^(bash|shell|run_terminal_cmd|run_command|execute)$/i.test(x.name))
    ?? fns.find((x) => /^(read|read_file|view|glob|list|ls)$/i.test(x.name)) ?? fns[0];
  if (!f) return null;
  const schema = f.parameters ?? f.input_schema ?? {};
  const args = {};
  for (const name of schema.required ?? []) {
    const prop = schema.properties?.[name] ?? {};
    if (/command|cmd/i.test(name)) args[name] = 'ls';
    else if (/path|file|pattern/i.test(name)) args[name] = /pattern/i.test(name) ? '*' : 'README.md';
    else if (/desc/i.test(name)) args[name] = 'list files';
    else if (prop.type === 'number' || prop.type === 'integer') args[name] = 1;
    else if (prop.type === 'boolean') args[name] = false;
    else if (prop.type === 'array') args[name] = [];
    else args[name] = 'x';
  }
  return { name: f.name, args };
}

const sse = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) res.write(e.event ? `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n` : `data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}\n\n`);
  res.end();
};

function chat(res, body) {
  const done = (body.messages ?? []).some((m) => m.role === 'tool');
  const tool = done ? null : pickTool(body.tools, 'chat');
  const id = `chatcmpl-probe-${++n}`;
  const base = { id, object: 'chat.completion.chunk', created: 1, model: body.model };
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ id, object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, finish_reason: tool ? 'tool_calls' : 'stop', message: tool ? { role: 'assistant', content: null, tool_calls: [{ id: `call_${n}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : { role: 'assistant', content: 'Done.' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  }
  const ev = [];
  if (tool) {
    ev.push({ data: { ...base, choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'thinking', content: 'Looking.', tool_calls: [{ index: 0, id: `call_${n}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }, finish_reason: null }] } });
    ev.push({ data: { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } });
  } else {
    ev.push({ data: { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'Done.' }, finish_reason: null }] } });
    ev.push({ data: { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } });
  }
  ev.push({ data: '[DONE]' });
  sse(res, ev);
}

function responses(res, body) {
  const input = Array.isArray(body.input) ? body.input : [];
  const done = Boolean(body.previous_response_id) || input.some((i) => i?.type === 'function_call_output');
  const tool = done ? null : pickTool(body.tools, 'responses');
  const id = `resp_probe_${++n}`;
  const item = tool
    ? { id: `fc_${n}`, type: 'function_call', status: 'completed', call_id: `call_${n}`, name: tool.name, arguments: JSON.stringify(tool.args) }
    : { id: `msg_${n}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Done.', annotations: [] }] };
  const resp = (status, output) => ({ id, object: 'response', created_at: 1, status, model: body.model, output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } });
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(resp('completed', [item])));
  }
  const ev = [{ event: 'response.created', data: { type: 'response.created', sequence_number: 0, response: resp('in_progress', []) } }];
  const rs = { id: `rs_${n}`, type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking' }], encrypted_content: 'enc-probe' };
  if (tool) { ev.push({ event: 'response.output_item.added', data: { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { ...rs, summary: [] } } }); ev.push({ event: 'response.output_item.done', data: { type: 'response.output_item.done', sequence_number: 1, output_index: 0, item: rs } });
    const m = { id: `msg_a${n}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Looking.', annotations: [] }] };
    ev.push({ event: 'response.output_item.added', data: { type: 'response.output_item.added', sequence_number: 1, output_index: 1, item: { ...m, content: [] } } });
    ev.push({ event: 'response.content_part.added', data: { type: 'response.content_part.added', sequence_number: 1, output_index: 1, item_id: m.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } } });
    ev.push({ event: 'response.output_text.delta', data: { type: 'response.output_text.delta', sequence_number: 1, output_index: 1, item_id: m.id, content_index: 0, delta: 'Looking.' } });
    ev.push({ event: 'response.output_text.done', data: { type: 'response.output_text.done', sequence_number: 1, output_index: 1, item_id: m.id, content_index: 0, text: 'Looking.' } });
    ev.push({ event: 'response.content_part.done', data: { type: 'response.content_part.done', sequence_number: 1, output_index: 1, item_id: m.id, content_index: 0, part: m.content[0] } });
    ev.push({ event: 'response.output_item.done', data: { type: 'response.output_item.done', sequence_number: 1, output_index: 1, item: m } }); }
  ev.push({ event: 'response.output_item.added', data: { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { ...item, status: 'in_progress', ...(tool ? { arguments: '' } : { content: [] }) } } });
  if (tool) ev.push({ event: 'response.function_call_arguments.done', data: { type: 'response.function_call_arguments.done', sequence_number: 2, output_index: 0, item_id: item.id, arguments: item.arguments } });
  else {
    ev.push({ event: 'response.content_part.added', data: { type: 'response.content_part.added', sequence_number: 2, output_index: 0, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } } });
    ev.push({ event: 'response.output_text.delta', data: { type: 'response.output_text.delta', sequence_number: 3, output_index: 0, item_id: item.id, content_index: 0, delta: 'Done.' } });
    ev.push({ event: 'response.output_text.done', data: { type: 'response.output_text.done', sequence_number: 4, output_index: 0, item_id: item.id, content_index: 0, text: 'Done.' } });
    ev.push({ event: 'response.content_part.done', data: { type: 'response.content_part.done', sequence_number: 5, output_index: 0, item_id: item.id, content_index: 0, part: item.content[0] } });
  }
  ev.push({ event: 'response.output_item.done', data: { type: 'response.output_item.done', sequence_number: 6, output_index: 0, item } });
  ev.push({ event: 'response.completed', data: { type: 'response.completed', sequence_number: 7, response: resp('completed', [item]) } });
  sse(res, ev);
}

function messages(res, body) {
  const done = (body.messages ?? []).some((m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'tool_result'));
  const tool = done ? null : pickTool(body.tools, 'anthropic');
  const id = `msg_probe_${++n}`;
  const usage = { input_tokens: 1, output_tokens: 1 };
  const block = tool ? { type: 'tool_use', id: `toolu_${n}`, name: tool.name, input: tool.args } : { type: 'text', text: 'Done.' };
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: body.model, content: [block], stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null, usage }));
  }
  const ev = [{ event: 'message_start', data: { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } } }];
  if (tool) {
    ev.push({ event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } } });
    ev.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'thinking' } } });
    ev.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-probe' } } });
    ev.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } });
    ev.push({ event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } });
    ev.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Looking.' } } });
    ev.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } });
    ev.push({ event: 'content_block_start', data: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } } });
    ev.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.args) } } });
  } else {
    ev.push({ event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    ev.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } } });
  }
  ev.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: tool ? 2 : 0 } });
  ev.push({ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } } });
  ev.push({ event: 'message_stop', data: { type: 'message_stop' } });
  sse(res, ev);
}

/**
 * @param {(req: import('node:http').IncomingMessage) => object} [inspect]  more to record of each call: never a header's value
 * @returns {Promise<{server: import('node:http').Server, url: string, calls: object[]}>}
 */
export function modelStandIn(inspect = () => ({})) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { /* recorded as not JSON */ }
      const path = req.url.split('?')[0];
      calls.push({
        method: req.method, url: req.url, headers: Object.keys(req.headers).sort(),
        json: raw ? body !== null : null, fields: body ? [...shape(body)].sort() : [], ...inspect(req),
      });
      if (path.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        if (path.includes('/grok-login/')) return res.end(JSON.stringify({ object: 'list', data: [GROK_LOGIN_MODEL] }));
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'grok-build', object: 'model', owned_by: 'xai', created: 1 }, { id: 'claude-sonnet-4-5', type: 'model', display_name: 'x', created_at: '2025-01-01T00:00:00Z' }, { id: 'gpt-5', object: 'model', owned_by: 'openai', created: 1 }], has_more: false }));
      }
      if (!body) { res.writeHead(400); return res.end('{}'); }
      if (path.endsWith('/chat/completions')) return chat(res, body);
      if (path.endsWith('/responses')) return responses(res, body);
      if (path.endsWith('/messages/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"input_tokens":1}'); }
      if (path.endsWith('/messages')) return messages(res, body);
      res.writeHead(404); res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, calls })));
}
