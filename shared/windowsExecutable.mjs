import fs from 'node:fs';
import { win32 as path } from 'node:path';

const fullyQualified = (name) => /^(?:[A-Za-z]:[\\/]|\\\\)/.test(name);
const realFile = (name) => {
  try { return fs.realpathSync.native(name); } catch { return null; }
};

/** Resolve an executable before spawning it. Windows otherwise searches the working directory before PATH. */
export function windowsExecutable(name, { searchPath = process.env.PATH ?? '', exclude = [process.cwd()], real = realFile } = {}) {
  const roots = exclude.flatMap((dir) => [path.resolve(dir), real(dir)].filter(Boolean));
  const inCheckout = (file) => roots.some((root) => {
    const rel = path.relative(root, file);
    return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..\\');
  });
  const exe = path.extname(name) ? name : name + '.exe';
  const dirs = searchPath.split(';').map((dir) => dir.replace(/^"(.*)"$/, '$1')).filter(fullyQualified);
  const candidates = fullyQualified(exe) ? [exe] : path.basename(exe) === exe ? dirs.map((dir) => path.join(dir, exe)) : [];
  for (const candidate of candidates) {
    if (inCheckout(candidate)) continue;
    const resolved = real(candidate);
    if (resolved && !inCheckout(resolved)) return resolved;
  }
  return null;
}
