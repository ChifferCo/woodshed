import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// The folder plan's one-way rules, checked over every import in woodshed/:
//   shared/      imports nothing outside itself, so it can be lifted out or shipped alone (it ships to the box whole);
//   woodshed/    imports nothing outside itself, so it lifts out whole, and no installation's values are in it;
//   console/, session/ reach a provider only through what is passed in, never by importing providers/ (their tests may).
// A tool that embeds shared/ keeps its own rule that it uses nothing else of woodshed/: that rule stays with the tool.
const WOODSHED = path.resolve(import.meta.dirname, '..');

function codeFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '__fixtures__' && !entry.name.startsWith('.')) out.push(...codeFiles(full));
    } else if (/\.(mjs|cjs|js)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// Static `from '…'`, side-effect `import '…'`, dynamic `import('…')` and `require('…')`, relative ones only: a bare
// name is a node builtin or a browser global here, since nothing in these folders has dependencies.
function relativeImports(file) {
  const text = fs.readFileSync(file, 'utf8');
  const specs = [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => m[1]);
  return specs.map((spec) => ({ spec, target: path.resolve(path.dirname(file), spec) }));
}

const within = (dir, file) => file === dir || file.startsWith(`${dir}${path.sep}`);
const rel = (file) => path.relative(WOODSHED, file);

function violations(files, allowed) {
  const bad = [];
  for (const file of files) {
    for (const { spec, target } of relativeImports(file)) {
      if (!allowed(file, target)) bad.push(`${rel(file)} imports ${spec} (${rel(target)})`);
    }
  }
  return bad;
}

test('shared/ imports nothing outside itself', () => {
  const shared = path.join(WOODSHED, 'shared');
  assert.deepEqual(violations(codeFiles(shared), (_, target) => within(shared, target)), []);
});

test('nothing in woodshed/ imports from outside it', () => {
  assert.deepEqual(violations(codeFiles(WOODSHED), (_, target) => within(WOODSHED, target)), []);
});

// Runtime code only: a test may drive a provider's real store over a fake, as settings.test.mjs drives the Secrets
// Manager store over a fake AWS CLI.
test('console/ and session/ do not import providers/ directly', () => {
  const providers = path.join(WOODSHED, 'providers');
  const files = ['console', 'session'].flatMap((d) => codeFiles(path.join(WOODSHED, d))).filter((f) => !f.endsWith('.test.mjs'));
  assert.deepEqual(violations(files, (_, target) => !within(providers, target)), []);
});

test('the import scan sees every form, so an empty answer means something', () => {
  const file = path.join(WOODSHED, 'session/reviewShed/host.mjs');
  const specs = relativeImports(file).map((i) => i.spec);
  assert.ok(specs.includes('../../shared/review/index.mjs'), `dynamic import() is read: ${specs.join(', ')}`);
  assert.ok(relativeImports(path.join(WOODSHED, 'console/server.mjs')).some((i) => i.spec === '../shared/pwa.mjs'), 'static import is read');
});

// Woodshed is for any repo, so nothing in this folder names the one it grew up in: not in code, tests, fixtures or docs.
// What is that repo's goes in its own .woodshed/ (docs/reference.md, "Using it on another repo"). Each exception below is work
// still to do, with the follow-up that removes it; one that no longer occurs fails too, so the list only shrinks.
// The copyright holder, ChifferCo, Inc., is not the repo: the license files and the CLA name it, so its full legal name passes.
const NAMED = /chiffer(?!co, inc\.)|woodrow|taskforce|\bsubscript\b|backend-env|agent-env|backend_env|agent_env|backend\/\.env|agent\/\.env|auth0|aws_s3_test|gotenberg|claude-review|playwright-agent|claude-qa|claude qa|playwright agent|joelbraga|joel braga|c03g108jpg8|c01fkny15hn/gi;
// And its app's conventions: its start script and Procfile, its folders as paths (not `/agent/` in a URL or
// `user-agent/`), its database scripts, its skills, and the folder its standalone shed lives in (Hetzner the hosting
// company is fine to name).
const CONVENTIONS = /scripts\/hetzner|devservers\.sh|procfile\.woodshed|restore_db|backend\/db|(?<![\w.@/-])(?:agent|backend)\/|(?<![\w.-])\/(?:implement|servers)\b(?![\w./-])/gi;
const NAMED_OR_CONVENTION = new RegExp(`${NAMED.source}|${CONVENTIONS.source}`, 'gi');
const STILL_NAMED = {};
const BINARY = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|gz|zip|tar|pdf)$/i;

// What git tracks, so a note of someone's own left in the folder does not fail the guard on their machine alone. A copy
// with no git, such as one unpacked from a tarball, has every file walked instead.
function trackedFiles(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'ls-files', '-z'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\0').filter(Boolean).map((file) => path.join(dir, file));
  } catch {
    const files = [];
    (function walk(at) {
      for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
        const full = path.join(at, entry.name);
        if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== '.git') walk(full); } else files.push(full);
      }
    })(dir);
    return files;
  }
}

test('nothing in woodshed/ names the repo it grew up in, its app or its CI, beyond the exceptions still to remove', () => {
  // A tracked file deleted locally is in the index still; there is nothing of it to read.
  const files = trackedFiles(WOODSHED).filter((file) => !BINARY.test(file) && fs.existsSync(file));
  const found = {};
  for (const file of files) {
    if (rel(file) === 'test/layout.test.mjs') continue;
    const terms = [...new Set((fs.readFileSync(file, 'utf8').match(NAMED_OR_CONVENTION) ?? []).map((t) => t.toLowerCase()))];
    if (terms.length) found[rel(file)] = terms;
  }
  const unexpected = Object.entries(found).flatMap(([file, terms]) => terms.filter((t) => !STILL_NAMED[file]?.terms.includes(t)).map((t) => `${file}: ${t}`));
  assert.deepEqual(unexpected, [], 'name it in the repo\'s own .woodshed/, or use neutral sample data (acme/app, api-env)');
  const stale = Object.entries(STILL_NAMED).flatMap(([file, { terms }]) => terms.filter((t) => !found[file]?.includes(t)).map((t) => `${file}: ${t}`));
  assert.deepEqual(stale, [], 'gone: take it off STILL_NAMED');
});

test('the guard sees the app\'s conventions, and not words that only look like them', () => {
  const seen = (text) => (text.match(NAMED_OR_CONVENTION) ?? []).map((t) => t.toLowerCase());
  assert.deepEqual(seen('run `scripts/devServers.sh start` from backend/Procfile.woodshed'), ['devservers.sh', 'backend/', 'procfile.woodshed']);
  assert.deepEqual(seen("cwd 'agent/app' and `backend/db/migrations`, then /implement --unattended or /servers start"),
    ['agent/', 'backend/db', '/implement', '/servers']);
  assert.deepEqual(seen('user-agent/1.0, GET /api/agent/runs, ~/.cache/servers/x, src/implement.mjs, the agent pane, /implementation'), []);
  assert.deepEqual(seen("the shed in scripts/hetzner/woodshed, on Hetzner Cloud or Hetzner's DNS"), ['scripts/hetzner']);
});
