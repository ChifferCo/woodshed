// Whole-codebase module & dependency scanner for the review page's interactive map.
//
// Scans the review worktree (honouring .gitignore via `git ls-files`) to build
// a top-down architectural view of the entire repository: every module/folder,
// its files, how modules and files interact via static imports, and which areas
// carry changes from the current diff (including deleted files that no longer
// exist on disk).
//
// Plain Node 22, zero dependencies, async throughout, and no shell.

import fs from 'node:fs/promises';
import path from 'node:path';

import { run } from './exec.mjs';

const GIT_TIMEOUT_MS = 30_000;
const MAX_FILES = 2_400;
const MAX_PARSE_BYTES = 64 * 1024;
const READ_CONCURRENCY = 24;
const MAX_FILE_EDGES = 6_000;

// Wrapper directories whose immediate children are almost always the actual
// top-level modules of a codebase (e.g. src/webhooks, src/auth, packages/core).
const WRAPPER_DIRS = new Set([
  'src', 'lib', 'app', 'apps', 'packages', 'services', 'modules',
  'internal', 'pkg', 'cmd', 'crates', 'components', 'features',
]);

// Extensions we parse for static imports/dependencies and line counts.
const JS_EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts']);
const PY_EXTS = new Set(['.py']);
const GO_EXTS = new Set(['.go']);
const RUST_EXTS = new Set(['.rs']);
const RUBY_EXTS = new Set(['.rb']);
const CSS_EXTS = new Set(['.css', '.scss', '.less']);
const C_EXTS = new Set(['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh']);
const SH_EXTS = new Set(['.sh', '.bash', '.zsh']);

const TEXT_EXTS = new Set([
  ...JS_EXTS, ...PY_EXTS, ...GO_EXTS, ...RUST_EXTS, ...RUBY_EXTS,
  ...CSS_EXTS, ...C_EXTS, ...SH_EXTS,
  '.json', '.yaml', '.yml', '.toml', '.md', '.txt', '.html', '.htm',
  '.sql', '.graphql', '.gql', '.prisma', '.proto', '.java', '.kt',
  '.swift', '.php', '.ex', '.exs', '.tf', '.tftpl', '.vue', '.svelte',
]);

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'coverage',
  'vendor', 'target', '__pycache__', '.venv', 'venv', '.turbo', '.cache',
]);

const SKIP_BASENAMES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock',
  'Gemfile.lock', 'poetry.lock', 'composer.lock', 'go.sum',
]);

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function shouldSkipPath(rel) {
  if (!rel) return true;
  const parts = rel.split('/');
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (SKIP_DIRS.has(parts[i])) return true;
  }
  return false;
}

/**
 * List files in the repository worktree using git (honouring .gitignore),
 * falling back to a recursive directory walk if git is unavailable.
 */
async function listRepoFiles(rootDir) {
  if (!rootDir) return [];
  const listed = await run(
    'git',
    ['-C', rootDir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { timeoutMs: GIT_TIMEOUT_MS, maxBytes: 16 * 1024 * 1024 },
  );
  if (listed.status === 0 && typeof listed.stdout === 'string') {
    const raw = listed.stdout.split('\0').filter(Boolean).map(normalizePath);
    // Deduplicate (a staged + untracked edge case) while preserving order.
    const seen = new Set();
    const out = [];
    for (const rel of raw) {
      if (seen.has(rel) || shouldSkipPath(rel)) continue;
      seen.add(rel);
      out.push(rel);
    }
    return out;
  }
  return walkFilesFallback(rootDir, '', []);
}

async function walkFilesFallback(rootDir, prefix, out) {
  if (out.length >= MAX_FILES * 2) return out;
  let entries;
  try {
    entries = await fs.readdir(prefix ? path.join(rootDir, prefix) : rootDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES * 2) break;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const next = prefix ? `${prefix}/${entry.name}` : entry.name;
      await walkFilesFallback(rootDir, next, out);
    } else if (entry.isFile()) {
      out.push(prefix ? `${prefix}/${entry.name}` : entry.name);
    }
  }
  return out;
}

/**
 * Read the head of a text file for line-count estimation and import extraction.
 * Returns null if unreadable or binary.
 */
async function readSnippet(rootDir, rel) {
  const ext = path.extname(rel).toLowerCase();
  const base = path.basename(rel);
  if (SKIP_BASENAMES.has(base)) return { lines: 0, text: '' };
  if (ext && !TEXT_EXTS.has(ext) && base !== 'Dockerfile' && base !== 'Makefile') {
    return null;
  }
  const full = path.join(rootDir, rel);
  let handle;
  try {
    handle = await fs.open(full, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const toRead = Math.min(stat.size, MAX_PARSE_BYTES);
    if (toRead === 0) return { lines: 0, text: '' };
    const buf = Buffer.allocUnsafe(toRead);
    const { bytesRead } = await handle.read(buf, 0, toRead, 0);
    // Quick binary check: NUL byte in the prefix means binary.
    const probe = Math.min(bytesRead, 2048);
    for (let i = 0; i < probe; i += 1) {
      if (buf[i] === 0) return null;
    }
    const text = buf.subarray(0, bytesRead).toString('utf8');
    let lines = 1;
    for (let i = 0; i < text.length; i += 1) {
      if (text.charCodeAt(i) === 10) lines += 1;
    }
    // Estimate total lines proportionally when the file exceeded MAX_PARSE_BYTES.
    if (stat.size > bytesRead && bytesRead > 0) {
      lines = Math.round(lines * (stat.size / bytesRead));
    }
    return { lines, text };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Extract raw local import specifiers from a source file's text.
 */
export function extractImports(rel, text) {
  if (!text) return [];
  const ext = path.extname(rel).toLowerCase();
  const specs = new Set();

  if (JS_EXTS.has(ext)) {
    // Strip block comments and single-line comments lightly to avoid false positives in prose.
    const cleaned = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
    const patterns = [
      /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"\n]+)['"]/g,
      /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
      /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    ];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(cleaned)) !== null) {
        const spec = m[1].trim();
        if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('@/') || spec.startsWith('~/')) {
          specs.add(spec);
        }
      }
    }
  } else if (PY_EXTS.has(ext)) {
    const fromRe = /^\s*from\s+(\.+[A-Za-z0-9_.]*|[A-Za-z0-9_.]+)\s+import\b/gm;
    const impRe = /^\s*import\s+([A-Za-z0-9_.,\s]+)$/gm;
    let m;
    while ((m = fromRe.exec(text)) !== null) specs.add(`py:${m[1].trim()}`);
    while ((m = impRe.exec(text)) !== null) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (name) specs.add(`py:${name}`);
      }
    }
  } else if (GO_EXTS.has(ext)) {
    const singleRe = /^\s*import\s+(?:[A-Za-z0-9_.]+\s+)?"([^"\n]+)"/gm;
    const blockRe = /^\s*import\s*\(([\s\S]*?)\)/gm;
    let m;
    while ((m = singleRe.exec(text)) !== null) specs.add(`go:${m[1].trim()}`);
    while ((m = blockRe.exec(text)) !== null) {
      const lineRe = /"([^"\n]+)"/g;
      let lm;
      while ((lm = lineRe.exec(m[1])) !== null) specs.add(`go:${lm[1].trim()}`);
    }
  } else if (RUST_EXTS.has(ext)) {
    const modRe = /^\s*(?:pub\s+)?mod\s+([A-Za-z0-9_]+)\s*;/gm;
    const useRe = /^\s*(?:pub\s+)?use\s+(crate|super)::([A-Za-z0-9_:]+)/gm;
    let m;
    while ((m = modRe.exec(text)) !== null) specs.add(`rs-mod:${m[1]}`);
    while ((m = useRe.exec(text)) !== null) specs.add(`rs-use:${m[1]}::${m[2]}`);
  } else if (RUBY_EXTS.has(ext)) {
    const re = /\brequire(?:_relative)?\s*\(?\s*['"]([^'"\n]+)['"]\s*\)?/g;
    let m;
    while ((m = re.exec(text)) !== null) specs.add(`rb:${m[1].trim()}`);
  } else if (CSS_EXTS.has(ext)) {
    const re = /@import\s+(?:url\()?['"]([^'"\n]+)['"]\)?/g;
    let m;
    while ((m = re.exec(text)) !== null) specs.add(m[1].trim());
  } else if (C_EXTS.has(ext)) {
    const re = /^\s*#include\s+"([^"\n]+)"/gm;
    let m;
    while ((m = re.exec(text)) !== null) specs.add(m[1].trim());
  } else if (SH_EXTS.has(ext)) {
    const re = /^\s*(?:source|\.)\s+["']?([^"'\s#]+)["']?/gm;
    let m;
    while ((m = re.exec(text)) !== null) {
      const target = m[1].replace(/^\$(?:\{?[A-Za-z0-9_]+\}?)\//, './');
      if (target.endsWith('.sh') || target.startsWith('.')) specs.add(target);
    }
  }

  return [...specs];
}

const RESOLVE_EXTS = ['', '.mjs', '.js', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts', '.json', '.css', '.scss'];
const INDEX_FILES = ['index.mjs', 'index.js', 'index.cjs', 'index.ts', 'index.tsx', 'index.jsx'];

/**
 * Resolve a raw specifier extracted from `fromFile` to a path present in `fileSet`.
 */
function resolveImport(fromFile, spec, fileSet, dirIndex) {
  const fromDir = path.posix.dirname(fromFile);

  if (spec.startsWith('py:')) {
    const raw = spec.slice(3);
    if (raw.startsWith('.')) {
      const dots = /^\.+/.exec(raw)[0].length;
      const rest = raw.slice(dots).replace(/\./g, '/');
      let base = fromDir === '.' ? '' : fromDir;
      for (let d = 1; d < dots; d += 1) {
        base = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : '';
      }
      const joined = [base, rest].filter(Boolean).join('/');
      if (fileSet.has(`${joined}.py`)) return `${joined}.py`;
      if (fileSet.has(`${joined}/__init__.py`)) return `${joined}/__init__.py`;
      return null;
    }
    const slash = raw.replace(/\./g, '/');
    for (const candidate of [`${slash}.py`, `${slash}/__init__.py`, `src/${slash}.py`, `src/${slash}/__init__.py`]) {
      if (fileSet.has(candidate)) return candidate;
    }
    return null;
  }

  if (spec.startsWith('go:')) {
    const pkgPath = spec.slice(3);
    // Match trailing segments against any repo directory containing .go files.
    const parts = pkgPath.split('/');
    for (let i = 0; i < parts.length; i += 1) {
      const suffix = parts.slice(i).join('/');
      const target = dirIndex.get(suffix);
      if (target && target !== fromFile) return target;
    }
    return null;
  }

  if (spec.startsWith('rs-mod:')) {
    const name = spec.slice(7);
    const base = fromDir === '.' ? '' : `${fromDir}/`;
    for (const c of [`${base}${name}.rs`, `${base}${name}/mod.rs`]) {
      if (fileSet.has(c)) return c;
    }
    return null;
  }

  if (spec.startsWith('rs-use:')) {
    const rest = spec.slice(7);
    const isSuper = rest.startsWith('super::');
    const segs = rest.replace(/^(?:crate|super)::/, '').split('::');
    const modSeg = segs[0];
    if (!modSeg) return null;
    const base = isSuper
      ? (fromDir.includes('/') ? `${fromDir.slice(0, fromDir.lastIndexOf('/'))}/` : '')
      : 'src/';
    for (const c of [`${base}${modSeg}.rs`, `${base}${modSeg}/mod.rs`]) {
      if (fileSet.has(c)) return c;
    }
    return null;
  }

  if (spec.startsWith('rb:')) {
    const raw = spec.slice(3);
    const joined = path.posix.normalize(fromDir === '.' ? raw : `${fromDir}/${raw}`);
    for (const c of [joined, `${joined}.rb`, `lib/${raw}.rb`, `app/${raw}.rb`]) {
      if (fileSet.has(c)) return c;
    }
    return null;
  }

  // Relative / root-aliased JS/TS/CSS/C/Shell specifiers.
  let base;
  if (spec.startsWith('@/') || spec.startsWith('~/')) {
    const sub = spec.slice(2);
    const tried = resolveCandidate(sub, fileSet) || resolveCandidate(`src/${sub}`, fileSet);
    return tried;
  }
  if (spec.startsWith('/')) {
    return resolveCandidate(spec.slice(1), fileSet);
  }
  base = path.posix.normalize(fromDir === '.' ? spec : `${fromDir}/${spec}`);
  if (base.startsWith('../')) return null;
  return resolveCandidate(base, fileSet);
}

function resolveCandidate(base, fileSet) {
  if (fileSet.has(base)) return base;
  // TypeScript ESM imports often write `.js` for a `.ts`/`.tsx` source file.
  if (base.endsWith('.js')) {
    const stem = base.slice(0, -3);
    for (const alt of ['.ts', '.tsx', '.mjs', '.jsx']) {
      if (fileSet.has(`${stem}${alt}`)) return `${stem}${alt}`;
    }
  }
  for (const ext of RESOLVE_EXTS) {
    const c = `${base}${ext}`;
    if (fileSet.has(c)) return c;
  }
  for (const idx of INDEX_FILES) {
    const c = `${base}/${idx}`;
    if (fileSet.has(c)) return c;
  }
  return null;
}

/**
 * Decide which logical module ("district") a file belongs to.
 *
 * Goals:
 *  - Keep a clean, scannable number of top-down modules (typically 4–24) across
 *    both small repos and large multi-folder repos.
 *  - Promote immediate children of wrapper folders (`src/webhooks`, `src/api`)
 *    into first-class modules so `src` is not one giant monolith.
 *  - Split rich subdirectories (those with multiple files or a changed file)
 *    under top-level folders (e.g. `shared/review`, `console/public`) while
 *    keeping tiny leaf folders neatly folded into their parent module.
 */
function assignModules(fileEntries) {
  // Count files & changed files per 2-segment prefix to decide which level-2
  // folders earn their own district.
  const l1Count = new Map();
  const l2Count = new Map();
  const l2Changed = new Map();
  const l1Subdirs = new Map();

  for (const f of fileEntries) {
    const parts = f.path.split('/');
    if (parts.length <= 1) continue;
    const l1 = parts[0];
    l1Count.set(l1, (l1Count.get(l1) || 0) + 1);
    if (parts.length >= 3) {
      const l2 = `${parts[0]}/${parts[1]}`;
      l2Count.set(l2, (l2Count.get(l2) || 0) + 1);
      if (f.changed) l2Changed.set(l2, (l2Changed.get(l2) || 0) + 1);
      if (!l1Subdirs.has(l1)) l1Subdirs.set(l1, new Set());
      l1Subdirs.get(l1).add(l2);
    }
  }

  // Decide which level-2 paths become districts of their own.
  const promotedL2 = new Set();
  for (const [l2, count] of l2Count.entries()) {
    const l1 = l2.split('/')[0];
    const parentTotal = l1Count.get(l1) || 0;
    const isWrapper = WRAPPER_DIRS.has(l1);
    const hasChanges = (l2Changed.get(l2) || 0) > 0;
    if (isWrapper) {
      promotedL2.add(l2);
    } else if (parentTotal >= 14 && (count >= 3 || hasChanges)) {
      promotedL2.add(l2);
    }
  }

  // Avoid exploding into 50+ micro-districts on huge repos: if promotedL2 has
  // too many entries, keep the ones with changes or the largest file counts.
  const MAX_DISTRICTS = 28;
  if (promotedL2.size > MAX_DISTRICTS) {
    const ranked = [...promotedL2].sort((a, b) => {
      const ca = l2Changed.get(a) || 0;
      const cb = l2Changed.get(b) || 0;
      if ((cb > 0) !== (ca > 0)) return cb > 0 ? 1 : -1;
      return (l2Count.get(b) || 0) - (l2Count.get(a) || 0) || a.localeCompare(b);
    });
    promotedL2.clear();
    for (const id of ranked.slice(0, MAX_DISTRICTS)) promotedL2.add(id);
  }

  const modulesById = new Map();
  for (const f of fileEntries) {
    const parts = f.path.split('/');
    let modId;
    let group;
    if (parts.length <= 1) {
      modId = '(root)';
      group = '(root)';
    } else if (parts.length >= 3 && promotedL2.has(`${parts[0]}/${parts[1]}`)) {
      modId = `${parts[0]}/${parts[1]}`;
      group = parts[0];
    } else {
      modId = parts[0];
      group = parts[0];
    }
    let mod = modulesById.get(modId);
    if (!mod) {
      mod = {
        id: modId,
        label: modId === '(root)' ? 'root' : modId,
        group,
        files: [],
        fileCount: 0,
        totalLines: 0,
        changedCount: 0,
        addedCount: 0,
        modifiedCount: 0,
        deletedCount: 0,
        additions: 0,
        deletions: 0,
      };
      modulesById.set(modId, mod);
    }
    const relInMod = modId === '(root)' ? f.path : f.path.slice(modId.length + 1);
    mod.files.push({
      path: f.path,
      name: relInMod || path.posix.basename(f.path),
      lines: f.lines,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      hunksCount: f.hunksCount,
    });
    mod.fileCount += 1;
    mod.totalLines += f.lines;
    if (f.changed) {
      mod.changedCount += 1;
      mod.additions += f.additions;
      mod.deletions += f.deletions;
      if (f.status === 'added') mod.addedCount += 1;
      else if (f.status === 'deleted') mod.deletedCount += 1;
      else mod.modifiedCount += 1;
    }
  }

  // Sort files within each module: changed files first (most lines changed
  // first), then unchanged files alphabetically.
  for (const mod of modulesById.values()) {
    mod.files.sort((a, b) => {
      const ac = a.status !== 'unchanged';
      const bc = b.status !== 'unchanged';
      if (ac !== bc) return ac ? -1 : 1;
      if (ac && bc) {
        const diff = (b.additions + b.deletions) - (a.additions + a.deletions);
        if (diff !== 0) return diff;
      }
      return a.name.localeCompare(b.name);
    });
  }

  const modules = [...modulesById.values()].sort((a, b) => a.id.localeCompare(b.id));
  const fileToModule = new Map();
  for (const mod of modules) {
    for (const f of mod.files) fileToModule.set(f.path, mod.id);
  }
  return { modules, fileToModule };
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next;
      next += 1;
      results[idx] = await fn(items[idx], idx);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Scan the repository at `rootDir` and overlay `diffFiles` to produce a
 * whole-codebase module & interaction graph.
 *
 * @param {{rootDir: string, diffFiles?: Array<object>}} opts
 * @returns {Promise<{
 *   modules: Array<object>,
 *   moduleEdges: Array<object>,
 *   fileEdges: Array<{from: string, to: string}>,
 *   totalFiles: number,
 *   changedFiles: number,
 *   truncated: boolean,
 * }>}
 */
export async function buildCodebaseMap({ rootDir, diffFiles = [] }) {
  const diffByPath = new Map();
  for (const df of diffFiles) {
    if (!df || typeof df.path !== 'string') continue;
    diffByPath.set(normalizePath(df.path), df);
  }

  const repoFiles = await listRepoFiles(rootDir);
  const allSet = new Set(repoFiles);
  // Deleted files (and any diff file missing from ls-files) always belong on the map.
  for (const dp of diffByPath.keys()) allSet.add(dp);

  const allPaths = [...allSet];
  const totalFiles = allPaths.length;
  let truncated = false;
  let selectedPaths = allPaths;

  if (allPaths.length > MAX_FILES) {
    truncated = true;
    // Always include every changed file, then files sharing their directories,
    // then the rest alphabetically up to MAX_FILES.
    const changedDirs = new Set([...diffByPath.keys()].map((p) => path.posix.dirname(p)));
    selectedPaths = allPaths
      .slice()
      .sort((a, b) => {
        const ac = diffByPath.has(a) ? 0 : (changedDirs.has(path.posix.dirname(a)) ? 1 : 2);
        const bc = diffByPath.has(b) ? 0 : (changedDirs.has(path.posix.dirname(b)) ? 1 : 2);
        if (ac !== bc) return ac - bc;
        return a.localeCompare(b);
      })
      .slice(0, MAX_FILES);
  }

  const fileSet = new Set(selectedPaths);
  // Directory -> representative file (used for Go package imports).
  const dirIndex = new Map();
  for (const rel of selectedPaths) {
    if (!rel.endsWith('.go')) continue;
    const dir = path.posix.dirname(rel);
    if (dir !== '.' && !dirIndex.has(dir)) dirIndex.set(dir, rel);
  }

  // Read snippets concurrently to compute line counts and extract local imports.
  const scanned = await mapWithConcurrency(selectedPaths, READ_CONCURRENCY, async (rel) => {
    const df = diffByPath.get(rel);
    const isDeleted = df?.status === 'deleted';
    const snippet = (!isDeleted && rootDir) ? await readSnippet(rootDir, rel) : null;
    const imports = snippet ? extractImports(rel, snippet.text) : [];
    const lines = snippet ? snippet.lines : (df ? df.additions + df.deletions : 0);
    return {
      path: rel,
      lines,
      text: snippet ? snippet.text : '',
      changed: Boolean(df),
      status: df ? (df.status || 'modified') : 'unchanged',
      additions: df ? (df.additions || 0) : 0,
      deletions: df ? (df.deletions || 0) : 0,
      hunksCount: df && Array.isArray(df.hunks) ? df.hunks.length : 0,
      imports,
    };
  });

  const textByPath = new Map();
  for (const entry of scanned) {
    if (entry.text) textByPath.set(entry.path, entry.text);
  }

  const { modules, fileToModule } = assignModules(scanned);

  // Resolve file-to-file edges and aggregate module-to-module interaction highways.
  const seenFileEdges = new Set();
  const fileEdges = [];
  const modEdgeMap = new Map();

  for (const entry of scanned) {
    const fromMod = fileToModule.get(entry.path);
    for (const spec of entry.imports) {
      const target = resolveImport(entry.path, spec, fileSet, dirIndex);
      if (!target || target === entry.path) continue;
      const edgeKey = `${entry.path}\0${target}`;
      if (seenFileEdges.has(edgeKey)) continue;
      seenFileEdges.add(edgeKey);
      if (fileEdges.length < MAX_FILE_EDGES) {
        fileEdges.push({ from: entry.path, to: target });
      }
      const toMod = fileToModule.get(target);
      if (fromMod && toMod && fromMod !== toMod) {
        const modKey = `${fromMod}\0${toMod}`;
        let edge = modEdgeMap.get(modKey);
        if (!edge) {
          edge = {
            from: fromMod,
            to: toMod,
            count: 0,
            touchesChange: false,
            samples: [],
          };
          modEdgeMap.set(modKey, edge);
        }
        edge.count += 1;
        if (diffByPath.has(entry.path) || diffByPath.has(target)) {
          edge.touchesChange = true;
        }
        if (edge.samples.length < 4) {
          edge.samples.push({ from: entry.path, to: target });
        }
      }
    }
  }

  const moduleEdges = [...modEdgeMap.values()].sort(
    (a, b) => (b.touchesChange ? 1 : 0) - (a.touchesChange ? 1 : 0) || b.count - a.count || a.from.localeCompare(b.from),
  );

  // Attach a concise plain-English summary of what each module is for
  // (from its README, package.json, entrypoint doc comment, or structural fallback).
  const inCountByFile = new Map();
  for (const fe of fileEdges) {
    inCountByFile.set(fe.to, (inCountByFile.get(fe.to) || 0) + 1);
  }
  for (const mod of modules) {
    mod.summary = summarizeModule(mod, textByPath, inCountByFile, moduleEdges);
  }

  return {
    modules,
    moduleEdges,
    fileEdges,
    totalFiles,
    changedFiles: diffByPath.size,
    truncated,
  };
}

function cleanProse(raw, maxLen = 135) {
  let s = String(raw || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  // Take up to the first sentence when it is already descriptive enough.
  const sent = /^(.{32,}?[.!?])(?:\s|$)/.exec(s);
  if (sent && sent[1].length <= maxLen) return sent[1];
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > maxLen * 0.55 ? cut.slice(0, sp) : cut).replace(/[,;:\s]+$/, '')}\u2026`;
}

function summaryFromReadme(text) {
  const lines = String(text || '').split('\n');
  let heading = '';
  const para = [];
  let inFence = false;
  let start = 0;
  // Skip YAML frontmatter (--- ... ---) in skill/doc markdown files.
  if (lines.length && lines[0].trim() === '---') {
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i].trim() === '---') { start = i + 1; break; }
    }
  }
  for (let i = start; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('```')) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (!trimmed) {
      if (para.length) break;
      continue;
    }
    if (/^<div\b|^<\/div>|^<p\b|^<\/p>|^!\[|^\[!\[|^<!--/.test(trimmed)) continue;
    if (/^#{1,3}\s+/.test(trimmed)) {
      if (!heading && !para.length) heading = trimmed.replace(/^#{1,3}\s+/, '').trim();
      else if (para.length) break;
      continue;
    }
    if (/^[-*]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed) || /^\|/.test(trimmed)) {
      if (para.length) break;
      continue;
    }
    para.push(trimmed);
  }
  const head = cleanProse(heading, 50);
  const useHead = head && head.length <= 36 && !/[\/`]/.test(head);
  const bodyBudget = useHead ? Math.max(85, 138 - head.length - 2) : 138;
  const body = cleanProse(para.join(' '), bodyBudget);
  if (body) {
    if (useHead && !body.toLowerCase().startsWith(head.toLowerCase().slice(0, 12))) {
      return `${head}: ${body}`;
    }
    return body;
  }
  return head;
}

function summaryFromCodeHeader(text) {
  const lines = String(text || '').split('\n').slice(0, 20);
  const comment = [];
  let inBlock = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) {
      if (comment.length) break;
      continue;
    }
    if (t.startsWith('#!')) continue;
    if (inBlock) {
      const end = t.indexOf('*/');
      const piece = (end === -1 ? t : t.slice(0, end)).replace(/^\*\s?/, '').trim();
      if (piece && !piece.startsWith('@')) comment.push(piece);
      if (end !== -1) break;
      continue;
    }
    if (t.startsWith('/*')) {
      inBlock = true;
      const rest = t.slice(2).replace(/^\*\s?/, '');
      const end = rest.indexOf('*/');
      const piece = (end === -1 ? rest : rest.slice(0, end)).trim();
      if (piece && !piece.startsWith('@')) comment.push(piece);
      if (end !== -1) break;
      continue;
    }
    if (t.startsWith('//') || t.startsWith('#')) {
      const piece = t.replace(/^(?:\/\/|#)\s?/, '').trim();
      if (/^(?:eslint-|@ts-|node --test|prettier-|type:|copyright|license)/i.test(piece)) continue;
      if (piece) comment.push(piece);
      else if (comment.length) break;
      continue;
    }
    break;
  }
  return cleanProse(comment.join(' '), 135);
}

const ENTRYPOINT_NAMES = new Set([
  'index.mjs', 'index.js', 'index.ts', 'index.tsx', 'main.mjs', 'main.js', 'main.ts',
  'main.go', 'lib.rs', 'mod.rs', '__init__.py', 'host.mjs', 'server.mjs', 'app.mjs',
  'entrypoint.sh', 'SKILL.md',
]);

function summarizeModule(mod, textByPath, inCountByFile, moduleEdges) {
  const files = mod.files || [];
  const lower = mod.id.toLowerCase();
  // 0. Well-known meta / fixture / asset folders describe their whole role better
  // than a single file inside them would.
  if (lower.includes('__fixtures__') || lower.endsWith('/fixtures') || lower === 'fixtures') {
    return 'Recorded test fixtures and sample payloads';
  }
  if (lower === '.github') return 'GitHub Actions workflows and repository automation';
  if (lower === '.claude') return 'Claude Code project skills and hooks';
  if (lower === 'test' || lower.endsWith('/test') || lower.endsWith('/tests')) {
    return 'Integration and repository-wide tests';
  }
  // 1. Direct README inside this module.
  const readme = files.find((f) => /^readme(?:\.md|\.txt)?$/i.test(f.name));
  if (readme && textByPath.has(readme.path)) {
    const s = summaryFromReadme(textByPath.get(readme.path));
    if (s) return s;
  }
  // 2. package.json description inside this module.
  const pkg = files.find((f) => f.name === 'package.json');
  if (pkg && textByPath.has(pkg.path)) {
    try {
      const parsed = JSON.parse(textByPath.get(pkg.path));
      if (parsed && typeof parsed.description === 'string' && parsed.description.trim()) {
        return cleanProse(parsed.description, 135);
      }
    } catch {
      // Ignore malformed package.json.
    }
  }
  if (lower.endsWith('/public')) return 'Browser client scripts and stylesheets';
  if (lower.endsWith('/bin')) return 'Runnable CLI and dev scripts';
  // 3. Lead doc-comment of the module's entrypoint, most-imported, or primary non-test source file.
  const candidates = files
    .filter((f) => !/\.(?:test|spec)\.|_test\./i.test(f.name) && textByPath.has(f.path))
    .slice()
    .sort((a, b) => {
      const ae = ENTRYPOINT_NAMES.has(a.name) ? 0 : 1;
      const be = ENTRYPOINT_NAMES.has(b.name) ? 0 : 1;
      if (ae !== be) return ae - be;
      const ai = inCountByFile.get(a.path) || 0;
      const bi = inCountByFile.get(b.path) || 0;
      if (bi !== ai) return bi - ai;
      return (b.lines || 0) - (a.lines || 0);
    });
  for (const cand of candidates.slice(0, 4)) {
    const text = textByPath.get(cand.path);
    const s = cand.name.endsWith('.md') ? summaryFromReadme(text) : summaryFromCodeHeader(text);
    if (s && s.length >= 16) return s;
  }
  // 4. Clean structural fallback based on well-known folder roles and contents.
  if (lower === 'docs' || lower.endsWith('/docs')) return 'Documentation and runbooks';
  if (lower === 'config' || lower.endsWith('/config')) {
    const names = files.slice(0, 3).map((f) => f.name).join(', ');
    return names ? `Configuration files (${names})` : 'Configuration files';
  }
  if (lower === '.woodshed') return 'Woodshed project configuration and review prompts';
  if (lower.endsWith('/scripts') || lower === 'scripts') return 'Repository helper and release scripts';

  const usedBy = moduleEdges.filter((e) => e.to === mod.id).map((e) => e.from).slice(0, 3);
  const uses = moduleEdges.filter((e) => e.from === mod.id).map((e) => e.to).slice(0, 3);
  const topNames = files.filter((f) => !/\.(?:test|spec)\./i.test(f.name)).slice(0, 3).map((f) => f.name.replace(/\.[^.]+$/, ''));
  const parts = [];
  if (topNames.length) parts.push(`Holds ${topNames.join(', ')}`);
  if (usedBy.length) parts.push(`used by ${usedBy.join(', ')}`);
  else if (uses.length) parts.push(`connects to ${uses.join(', ')}`);
  return parts.join(' \u00b7 ');
}
