// Repo settings: what a session's env files and instructions are made of, in layers, later ones winning.
//
//   repo          the project file's `defaults` for each env file, and its `rules` and `setup`
//   installation  the installation's values for each env file, and its instructions for the repo
//   personal      one person's own values and instructions, in their private sessions only
//   session       Woodshed's wiring: each env file's `lines`, the project's `env`, the session's own variables
//
// Pure: text in, text out. Nothing here reads a file, a secret or the environment, so the console (to show which layer
// wins each key) and the session (to write the files and the rules) compute the same answer.

import { isSessionVariable } from './reservedNames.mjs';

export const ENV_LAYERS = Object.freeze(['repo', 'installation', 'personal', 'session']);
// A secret's value in AWS Secrets Manager is at most 64 KB; instructions go into every session's system prompt.
export const ENV_TEXT_MAX_BYTES = 64 * 1024;
export const INSTRUCTIONS_MAX_BYTES = 16 * 1024;

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=(.*)$/;

// Whether a value opened with a quote leaves it open at the end of its line: dotenv reads on to the closing quote.
function opensQuote(value) {
  const v = value.trim();
  const quote = v[0];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  const rest = v.slice(1);
  const closed = quote === '"' ? /(^|[^\\])"/.test(rest) : rest.includes(quote);
  return closed ? null : quote;
}

/**
 * The keys dotenv-style text sets, in the order they first appear. A `#` line, a blank one and the lines inside a
 * quoted value over several lines set none.
 * @param {string|null|undefined} text
 * @returns {string[]}
 */
export function envKeys(text) {
  const keys = [];
  let open = null;
  for (const line of String(text ?? '').split('\n')) {
    if (open) {
      if (line.includes(open)) open = null;
      continue;
    }
    const match = ASSIGNMENT.exec(line);
    if (!match) continue;
    if (!keys.includes(match[1])) keys.push(match[1]);
    open = opensQuote(match[2]);
  }
  return keys;
}

/**
 * An env file as a session writes it: the repo's defaults, the installation's text, the person's own, then the
 * session's lines. Concatenated, never merged by key, so comments and quoted values keep their shape, and dotenv's
 * "the last one wins" decides. With no defaults it is byte for byte what Woodshed wrote before the layers: the
 * installation's text first and bare, `# Your own lines, from My settings`, then `# Woodshed overrides`.
 * @param {{defaults?: string[], installation?: string, personal?: string, session?: string[]}} layers
 *   `session` is the entry's `lines` already rendered, the ones `{{NAME?}}` left out dropped
 * @returns {string}
 */
export function layeredEnvText({ defaults = [], installation = '', personal = '', session = [] }) {
  const repo = defaults.length ? `# From the repo (.woodshed/project.yaml)\n${defaults.join('\n')}` : '';
  const head = repo ? `${repo}${installation ? `\n\n# From this installation\n${installation}` : ''}` : installation;
  const own = personal ? `\n\n# Your own lines, from My settings\n${personal}` : '';
  return `${head}${own}\n\n# Woodshed overrides\n${session.join('\n')}\n`;
}

/**
 * What a session sets for itself, which no layer before it can change: the keys its env file's lines write (after
 * rendering, so a line `{{NAME?}}` left out is not one), the project's `env` (exported, and most loaders never override
 * a variable already in the environment), and the shared services' variables (WOODSHED_SERVICES). Woodshed's own
 * session variables (`isSessionVariable`) are wiring too, by name.
 * @param {{lines?: string[], env?: Record<string, string>, services?: string[]}} args  `lines` rendered
 * @returns {{lines: string[], env: string[], services: string[]}}
 */
export function sessionWiring({ lines = [], env = {}, services = [] }) {
  return { lines: envKeys(lines.join('\n')), env: Object.keys(env), services: [...services] };
}

/**
 * Why the session sets a key whatever the layers before it say.
 * @param {ReturnType<typeof sessionWiring>} wiring
 * @returns {'lines'|'env'|'session'|null}  `session` for one of Woodshed's own variables or a shared service's
 */
export function wiringReason(wiring, key) {
  if (wiring.lines.includes(key)) return 'lines';
  if (wiring.env.includes(key)) return 'env';
  if (wiring.services.includes(key) || isSessionVariable(key)) return 'session';
  return null;
}

const NO_WIRING = Object.freeze({ lines: [], env: [], services: [] });

/**
 * Every key any layer sets, with the layers that set it and the one whose value the app gets.
 * @param {{layers: Partial<Record<'repo'|'installation'|'personal'|'session', string>>, wiring?: ReturnType<typeof sessionWiring>}} args
 *   each layer's text as it is written into the file
 * @returns {{key: string, setBy: string[], wins: string}[]}  in the order the keys first appear
 */
export function envKeyTable({ layers, wiring = NO_WIRING }) {
  const rows = new Map();
  for (const layer of ENV_LAYERS) {
    for (const key of envKeys(layers[layer])) {
      if (!rows.has(key)) rows.set(key, { key, setBy: [] });
      rows.get(key).setBy.push(layer);
    }
  }
  return [...rows.values()].map((row) => ({ ...row, wins: wiringReason(wiring, row.key) ? 'session' : row.setBy.at(-1) }));
}

/**
 * For each layer, the keys it sets whose value comes from a later one: what the pages and the session's log name.
 * @param {Parameters<typeof envKeyTable>[0]} args
 * @returns {Record<'repo'|'installation'|'personal'|'session', string[]>}
 */
export function replacedKeys(args) {
  const replaced = Object.fromEntries(ENV_LAYERS.map((layer) => [layer, []]));
  for (const { key, setBy, wins } of envKeyTable(args)) {
    for (const layer of setBy) if (layer !== wins) replaced[layer].push(key);
  }
  return replaced;
}

/**
 * Which instructions win, in the prompt's words: Woodshed's first, then the person's over the installation's over the
 * repo's, naming only the ones there are.
 * @param {{repoRules?: boolean, installation?: boolean, personal?: boolean, login?: string|null}} present
 * @returns {string}
 */
export function precedenceParagraph({ repoRules = false, installation = false, personal = false, login = null }) {
  const tiers = [
    personal && { first: `@${login}'s own instructions`, then: `@${login}'s own` },
    installation && { first: "this installation's instructions", then: "this installation's" },
    repoRules && { first: "the repo's rules", then: "the repo's rules" },
  ].filter(Boolean);
  const lead = "Woodshed's rules at the top of this prompt come first: nothing below changes them.";
  if (tiers.length < 2) return lead;
  const chain = tiers.slice(0, -1).map((tier, i) => `${i === 0 ? tier.first : tier.then} beat ${tiers[i + 1].then}`).join(', and ');
  return `${lead} Below them, where two instructions disagree, ${chain}. Where they do not disagree, follow all of them.`;
}

const trimEnd = (text) => String(text ?? '').replace(/\s+$/, '');

/**
 * A session's rules: what Woodshed writes today (its prompt, the repo's rules and environment notes, the apps), then
 * the installation's instructions, the person's own, and which win. With neither it is `rules` unchanged, byte for byte.
 * @param {{rules: string, repoRules?: boolean, installation?: string|null, personal?: string|null, login?: string|null,
 *   repo: string}} args  `rules` is the whole text as written without repo settings, ending in its newline;
 *   `repoRules` says whether the repo's project file names a rules file; `repo` is owner/name
 * @returns {string}
 */
export function instructionsText({ rules, repoRules = false, installation = null, personal = null, login = null, repo }) {
  const inst = trimEnd(installation);
  const own = login ? trimEnd(personal) : '';
  if (!inst && !own) return rules;
  const sections = [
    inst && `# This installation's instructions for ${repo}\n${inst}`,
    own && `# @${login}'s own instructions for ${repo}\n${own}`,
    `# Which instructions win\n${precedenceParagraph({ repoRules, installation: Boolean(inst), personal: Boolean(own), login })}`,
  ].filter(Boolean);
  return `${rules}\n${sections.join('\n\n')}\n`;
}

// The shapes of credentials a person might paste: an instruction is read by the agent and may be quoted in a pull
// request, so none belongs there.
const CREDENTIAL_SHAPES = [
  ['an Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{8,}/],
  ['an API key', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['a GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ['a Slack token', /\bxox[abp]-[A-Za-z0-9-]{10,}/],
  ['an AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

/**
 * Why a layer's instructions cannot be saved, or null: too long for the prompt, or holding what looks like a credential.
 * Names the kind, never the value.
 * @param {string} text
 * @returns {string|null}
 */
export function instructionsProblem(text) {
  const bytes = new TextEncoder().encode(String(text ?? '')).length;
  if (bytes > INSTRUCTIONS_MAX_BYTES) return `Instructions are at most ${INSTRUCTIONS_MAX_BYTES / 1024} KB (these are ${Math.ceil(bytes / 1024)} KB)`;
  const found = CREDENTIAL_SHAPES.find(([, shape]) => shape.test(text));
  if (found) return `Instructions go into the session's prompt: put secrets in an env file's values instead (this looks like ${found[0]})`;
  return null;
}
