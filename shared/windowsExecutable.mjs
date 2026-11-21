import fs from 'node:fs';
import { win32 as path } from 'node:path';

const fullyQualified = (name) => /^(?:[A-Za-z]:[\\/]|\\\\)/.test(name);
const realFile = (name) => {
  try { return fs.realpathSync.native(name); } catch { return null; }
};

// Worktrees and submodules can have a .git file in place of a directory.
function checkoutOf(dir, exists) {
  for (;;) {
    if (exists(path.join(dir, '.git'))) return dir;
    const above = path.dirname(dir);
    if (above === dir) return null;
    dir = above;
  }
}

/** Resolve an executable before spawning it. Windows otherwise searches the working directory before PATH. */
export function windowsExecutable(name, { searchPath = process.env.PATH ?? '', from = [process.cwd()], real = realFile, exists = fs.existsSync } = {}) {
  const dirs = new Set(from.flatMap((dir) => [path.resolve(dir), real(dir)].filter(Boolean)));
  const roots = [...dirs].map((dir) => checkoutOf(dir, exists)).filter(Boolean);
  function excluded(file) {
    for (const dir of dirs) {
      if (!path.relative(dir, path.dirname(file))) return true;
    }
    return roots.some((root) => {
      const rel = path.relative(root, file);
      return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..\\');
    });
  }
  const exe = path.extname(name) ? name : name + '.exe';
  const pathDirs = searchPath.split(';').map((dir) => dir.replace(/^"(.*)"$/, '$1')).filter(fullyQualified);
  const candidates = fullyQualified(exe) ? [exe] : path.basename(exe) === exe ? pathDirs.map((dir) => path.join(dir, exe)) : [];
  for (const candidate of candidates) {
    if (excluded(candidate)) continue;
    const resolved = real(candidate);
    if (resolved && !excluded(resolved)) return resolved;
  }
  return null;
}
