// What a review's Grok Build and OpenCode may put in a model call's body, checked by the console's review agent proxy
// (reviewAgentProxy.mjs) before it reads the author's sign-in or adds it. A model API takes, in a call's body, the IDs
// of things the author's account already holds, and reads them for the model: OpenAI's and xAI's previous_response_id,
// conversation, a stored prompt, an item_reference, a file_id, a file_search tool's vector stores or code_interpreter's
// container; Anthropic's file sources, container and mcp_servers. A review's agent reads a pull request anyone who can
// push to it wrote, and can run commands with the session's token, so a prompt planted there could send such an ID and
// read another workload's data on the author's key. So this is an allowlist, not a denylist: each field the agents were
// measured to send passes, at the top level and nested, and anything else is refused, since a denylist would pass the
// next ID-taking field a provider adds.
//
// Measured in the session image with a recording stand-in for each upstream, over a turn with a tool call and the turn
// after it (grok 1.0.92 on a key; opencode 1.19.6 on Anthropic and on OpenAI). No call sent previous_response_id or any
// other ID of an object the account holds: grok sends its whole conversation to /v1/chat/completions each turn and uses
// /v1/responses once, for its title, with store false; opencode on OpenAI sends store false, and its reasoning items back
// by their encrypted_content, with no id. So no object a review made itself needs naming either, and none is allowed.
// The IDs that do pass are the conversation's own, matched within the same body: a tool call's id or call_id, and the
// tool result's tool_use_id or tool_call_id. Beyond what was measured, only what names nothing passes: an image given
// inline (base64, or a data: URL), never by URL or file; a tool result's is_error; Anthropic's redacted_thinking.
// Tools are functions alone: a provider's own tools (file_search, code_interpreter, web search, MCP) have a `type` of
// their own, or none listed here, and are refused. A tool's JSON schema and a tool call's arguments are the agent's own
// and not walked.

const S = 'string';
const N = 'number';
const B = 'boolean';
const FALSE = { literal: false };
const DATA_URL = { dataUrl: true };
const FREE = { free: true };
// `required`: fields a body must carry, refused by name when left out.
const obj = (fields, required = []) => ({ fields, required });
const arr = (items) => ({ items });
const either = (...options) => ({ either: options });
// An object picked by its `type`: `untyped` is the spec for one with no `type` at all, when the API takes that.
const typed = (byType, untyped = null) => ({ byType, untyped });
const NULL = { literal: null };

// Anthropic's Messages API, as opencode's Anthropic provider calls it.
const CACHE = typed({ ephemeral: obj({ type: S, ttl: S }) });
const A_TEXT = obj({ type: S, text: S, cache_control: CACHE });
const A_IMAGE = obj({ type: S, source: typed({ base64: obj({ type: S, media_type: S, data: S }) }), cache_control: CACHE });
const A_BLOCK = typed({
  text: A_TEXT,
  image: A_IMAGE,
  thinking: obj({ type: S, thinking: S, signature: S }),
  redacted_thinking: obj({ type: S, data: S }),
  tool_use: obj({ type: S, id: S, name: S, input: FREE, cache_control: CACHE }),
  tool_result: obj({ type: S, tool_use_id: S, content: either(S, arr(typed({ text: A_TEXT, image: A_IMAGE }))), is_error: B, cache_control: CACHE }),
});
const ANTHROPIC_MESSAGES = obj({
  model: S, max_tokens: N, stream: B,
  system: either(S, arr(typed({ text: A_TEXT }))),
  messages: arr(obj({ role: S, content: either(S, arr(A_BLOCK)) })),
  // A function tool has no `type`: Anthropic's own tools (web search, code execution, bash, the text editor) have one.
  tools: arr(obj({ name: S, description: S, input_schema: FREE, eager_input_streaming: B, cache_control: CACHE })),
  tool_choice: typed({
    auto: obj({ type: S, disable_parallel_tool_use: B }), any: obj({ type: S, disable_parallel_tool_use: B }),
    tool: obj({ type: S, name: S, disable_parallel_tool_use: B }), none: obj({ type: S }),
  }),
  thinking: typed({
    adaptive: obj({ type: S, display: S, block_binding: obj({ prefix_mismatch_behavior: S }) }),
    enabled: obj({ type: S, budget_tokens: N, display: S }), disabled: obj({ type: S }),
  }),
  output_config: obj({ effort: S }),
});

// OpenAI's Responses API, as opencode's OpenAI provider calls it, and xAI's, as grok calls it for its title.
const R_CONTENT = typed({
  input_text: obj({ type: S, text: S }),
  output_text: obj({ type: S, text: S, annotations: arr(obj({})) }),
  input_image: obj({ type: S, image_url: DATA_URL, detail: S }),
});
const R_MESSAGE = obj({ type: S, role: S, content: either(S, arr(R_CONTENT)) });
const R_ITEM = typed({
  message: R_MESSAGE,
  function_call: obj({ type: S, call_id: S, name: S, arguments: S }),
  function_call_output: obj({ type: S, call_id: S, output: S }),
  reasoning: obj({ type: S, encrypted_content: S, summary: arr(typed({ summary_text: obj({ type: S, text: S }) })) }),
}, R_MESSAGE);
const RESPONSES = obj({
  model: S, input: either(S, arr(R_ITEM)), instructions: S, max_output_tokens: N, temperature: N,
  // Stored, a response could be read back or chained to: every call measured sends false, and it must be sent.
  store: FALSE, stream: B,
  reasoning: obj({ effort: S, summary: S, mode: S }), text: obj({ verbosity: S }),
  tool_choice: either(S, typed({ function: obj({ type: S, name: S }) })),
  tools: arr(typed({ function: obj({ type: S, name: S, description: S, parameters: FREE, strict: B }) })),
  prompt_cache_key: S, include: arr({ oneOf: ['reasoning.encrypted_content'] }),
// Left out, OpenAI and xAI store the response in the author's API project, where its members, who may not see the private
// repo, could read it: so it must be there, and false.
}, ['store']);

// xAI's chat completions, as grok calls them for its turns.
const C_CONTENT = either(S, NULL, arr(typed({
  text: obj({ type: S, text: S }),
  image_url: obj({ type: S, image_url: obj({ url: DATA_URL, detail: S }) }),
})));
const CHAT = obj({
  model: S, stream: B, stream_options: obj({ include_usage: B }),
  messages: arr(obj({
    role: S, content: C_CONTENT, model_id: S, reasoning_content: S, tool_call_id: S,
    tool_calls: arr(typed({ function: obj({ type: S, id: S, function: obj({ name: S, arguments: S }) }) })),
  })),
  tools: arr(typed({ function: obj({ type: S, function: obj({ name: S, description: S, parameters: FREE, strict: B }) }) })),
  tool_choice: either(S, typed({ function: obj({ type: S, function: obj({ name: S }) }) })),
});

const BODIES = {
  grok: { '/v1/chat/completions': CHAT, '/v1/responses': RESPONSES },
  anthropic: { '/v1/messages': ANTHROPIC_MESSAGES, '/v1/messages/count_tokens': ANTHROPIC_MESSAGES },
  openai: { '/v1/responses': RESPONSES },
};

// A field's name as logged and answered: its path, with each name as written when it is a plain one, so nothing a call
// carries in a value, or in an odd key, reaches a log.
const nameOf = (key) => (/^[A-Za-z0-9_.-]{1,64}$/.test(key) ? key : '<a field with an unusual name>');

/** @returns {string|null}  the first field of `value` the spec does not allow, as a path, or null */
function firstRefused(value, spec, at, depth = 0) {
  if (depth > 64) return at;
  if (typeof spec === 'string') return typeof value === spec ? null : at;
  if (spec.free) return null;
  if ('literal' in spec) return value === spec.literal ? null : at;
  if (spec.dataUrl) return typeof value === 'string' && /^data:/i.test(value) ? null : at;
  if (spec.oneOf) return spec.oneOf.includes(value) ? null : at;
  if (spec.either) {
    // The option of the same shape decides: a refused field is named inside it, not at the either.
    const fits = spec.either.find((option) => shapeFits(value, option));
    return fits ? firstRefused(value, fits, at, depth + 1) : at;
  }
  if (spec.items) {
    if (!Array.isArray(value)) return at;
    for (const item of value) {
      const refused = firstRefused(item, spec.items, `${at}[]`, depth + 1);
      if (refused !== null) return refused;
    }
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return at;
  if (spec.byType) {
    if (!('type' in value)) return spec.untyped ? firstRefused(value, spec.untyped, at, depth + 1) : `${at}.type`;
    if (typeof value.type !== 'string' || !Object.hasOwn(spec.byType, value.type)) return `${at}.type`;
    return firstRefused(value, spec.byType[value.type], at, depth + 1);
  }
  for (const [key, item] of Object.entries(value)) {
    if (!Object.hasOwn(spec.fields, key)) return `${at}.${nameOf(key)}`;
    const refused = firstRefused(item, spec.fields[key], `${at}.${key}`, depth + 1);
    if (refused !== null) return refused;
  }
  for (const key of spec.required ?? []) if (!Object.hasOwn(value, key)) return `${at}.${key}`;
  return null;
}

function shapeFits(value, spec) {
  if (typeof spec === 'string') return typeof value === spec;
  if ('literal' in spec) return value === spec.literal;
  if (spec.items) return Array.isArray(value);
  if (spec.fields || spec.byType) return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  return firstRefused(value, spec, '') === null;
}

/**
 * Whether a review's agent may send this body to this path.
 * @param {string} api  'grok', 'anthropic' or 'openai'
 * @param {string} path  the API path, under its /v1
 * @param {unknown} body  the call's JSON
 * @returns {string|null}  the first field it may not send, as a path such as `input[].previous_response_id` (`the body`
 *   for a body that is not an object), or null
 */
export function refusedField(api, path, body) {
  const spec = BODIES[api]?.[path];
  const refused = spec ? firstRefused(body, spec, '') : '';
  return refused === null ? null : refused.replace(/^\./, '') || 'the body';
}

/** @returns {boolean}  whether calls to this path carry a body to check */
export function hasBody(api, path) {
  return Boolean(BODIES[api]?.[path]);
}
