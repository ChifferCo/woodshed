// What an install keeps in a `node_modules` that this image never loads, removed before the image keeps it
// (session/deps.sh, depsPrune):
//
//   - a native variant for another libc, os or cpu (its package.json's `libc`, `os` and `cpu`, the fields npm itself
//     reads), and only when a package that lists it in its `optionalDependencies` has a variant for this image
//     installed too: npm installs every libc's variant on Linux, so a glibc image holds the musl ones as well;
//   - source maps (`*.map` files that are JSON), which nothing in a session reads at run time.
//
//   node pruneDeps.mjs <node_modules>...   prints one summary line; exits non-zero only when it could not finish
//
// Symlinks are never followed: a workspace's link points into the checkout, not into what the install made. It imports
// nothing of Woodshed's: the image's deps stage mounts this file alone.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** The image's platform, as npm names it in `os`, `cpu` and `libc`. */
export function imagePlatform() {
  const glibc = process.platform === 'linux' ? process.report.getReport().header.glibcVersionRuntime : undefined;
  return { os: process.platform, cpu: process.arch, libc: process.platform !== 'linux' ? null : glibc ? 'glibc' : 'musl' };
}

// npm's rule: a list with `!x` refuses x, and a list with any plain entry needs the value among them.
function allows(list, value) {
  if (!Array.isArray(list) || !list.length || value === null) return true;
  if (list.includes(`!${value}`)) return false;
  const plain = list.filter((entry) => typeof entry === 'string' && !entry.startsWith('!'));
  return !plain.length || plain.includes(value);
}

function isNative(pkg) {
  return ['os', 'cpu', 'libc'].some((field) => Array.isArray(pkg[field]) && pkg[field].length);
}

function fits(pkg, platform) {
  return allows(pkg.os, platform.os) && allows(pkg.cpu, platform.cpu) && allows(pkg.libc, platform.libc);
}

function readPackage(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error instanceof SyntaxError) return null;
    throw error;
  }
}

function isSourceMap(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    return head.subarray(0, read).toString('utf8').trimStart().startsWith('{');
  } finally {
    fs.closeSync(fd);
  }
}

function folderSize(dir) {
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) bytes += folderSize(full);
    else if (entry.isFile()) bytes += fs.lstatSync(full).size;
  }
  return bytes;
}

// Every package folder (`node_modules/<name>` and `node_modules/@scope/<name>`, nested ones too) and every source map.
function walk(root) {
  const packages = [];
  const maps = [];
  const visit = (dir, parentIsModules, inScope) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isFile()) {
        if (entry.name.endsWith('.map') && isSourceMap(full)) maps.push(full);
        continue;
      }
      if (!entry.isDirectory()) continue;
      const scope = parentIsModules && !inScope && entry.name.startsWith('@');
      if ((parentIsModules || inScope) && !scope) {
        const pkg = readPackage(full);
        if (pkg?.name) packages.push({ dir: full, pkg });
      }
      visit(full, entry.name === 'node_modules', scope);
    }
  };
  visit(root, true, false);
  return { packages, maps };
}

// The variants that do not fit, each only when a package listing it as optional has one that fits installed.
function unfitVariants(packages, platform) {
  const installed = new Map();
  for (const { pkg } of packages) installed.set(pkg.name, [...(installed.get(pkg.name) ?? []), pkg]);
  const fitting = (name) => (installed.get(name) ?? []).some((pkg) => isNative(pkg) && fits(pkg, platform));
  const replaced = new Set();
  for (const { pkg } of packages) {
    const optional = Object.keys(pkg.optionalDependencies ?? {});
    if (!optional.some(fitting)) continue;
    for (const name of optional) replaced.add(name);
  }
  return packages.filter(({ pkg }) => isNative(pkg) && !fits(pkg, platform) && replaced.has(pkg.name));
}

/**
 * @param {{roots: string[], platform?: {os: string, cpu: string, libc: string|null}}} options
 * @returns {{packages: string[], maps: number, bytes: number}}  the removed packages' names, the source maps' count, and
 *   the bytes both took
 */
export function pruneDeps({ roots, platform = imagePlatform() }) {
  const removed = { packages: [], maps: 0, bytes: 0 };
  for (const root of roots) {
    if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) continue;
    const { packages, maps } = walk(root);
    const unfit = unfitVariants(packages, platform);
    const inside = (file) => unfit.some(({ dir }) => file.startsWith(`${dir}${path.sep}`));
    for (const file of maps) {
      if (inside(file)) continue;
      removed.bytes += fs.lstatSync(file).size;
      fs.rmSync(file);
      removed.maps += 1;
    }
    for (const { dir, pkg } of unfit) {
      removed.bytes += folderSize(dir);
      fs.rmSync(dir, { recursive: true });
      removed.packages.push(pkg.name);
    }
  }
  return removed;
}

function summary({ roots, platform, removed }) {
  const where = [platform.os, platform.cpu, platform.libc].filter(Boolean).join(' ');
  const mb = (removed.bytes / 1024 / 1024).toFixed(1);
  const names = removed.packages.length ? `: ${removed.packages.join(' ')}` : '';
  return `deps: pruned ${roots.join(' ')} (${removed.packages.length} packages not for ${where}, ${removed.maps} source maps, ${mb} MB)${names}`;
}

// As shared/isMain.mjs, which the deps stage does not have: run through a symlink, argv[1] is the link.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const roots = process.argv.slice(2);
  const platform = imagePlatform();
  console.log(summary({ roots, platform, removed: pruneDeps({ roots, platform }) }));
}
