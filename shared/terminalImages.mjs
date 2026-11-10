// Which image a click on a terminal path may open.
//
// Claude Code prints every image it reads as `[image] <path>`, and the page
// turns those paths into links that open the picture over the terminal. The
// browser can only ask for a path, so the server decides what that path may
// reach: an image file, under one of a few roots, after symlinks are resolved.
// There is no auth on the shed, but a route that streams any file on the box
// to whoever can name it is a bigger door than this feature needs.
//
// Kept apart from server.mjs, and taking its roots and types as arguments, so
// the refusals can be tested against a temp tree.

import fs from 'node:fs';
import path from 'node:path';

import { isInsideDir } from './devServerProcs.mjs';

function realpathOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;  // no such file, or a root that does not exist on this box
  }
}

// `requested` is what the page read off the terminal: absolute, starting
// with `~/`, which is how Claude Code shortens the home directory, or
// relative to `cwd`, the directory the session runs in, which is how it
// prints a file inside its worktree. `types` maps a lowercase extension to
// its MIME. Returns null for anything that may not be served, without saying
// which rule refused it.
export function resolveTerminalImage({ requested, cwd, roots, home, types }) {
  if (typeof requested !== 'string' || !requested) return null;
  let full = requested;
  if (full.startsWith('~/')) full = path.join(home, full.slice(2));
  else if (!path.isAbsolute(full) && cwd) full = path.resolve(cwd, full);
  if (!path.isAbsolute(full)) return null;

  // Resolved before any check, so neither `..` nor a symlink inside a root
  // can point it somewhere else, and the type comes from the target: a
  // `shot.png` linking to a `.html` must not be served at all. The roots are
  // resolved too: a root that is itself a symlink would otherwise refuse
  // everything under it.
  const real = realpathOrNull(full);
  if (!real) return null;
  const mime = types.get(path.extname(real).slice(1).toLowerCase());
  if (!mime) return null;
  const inside = roots.some((root) => isInsideDir(real, realpathOrNull(root)));
  if (!inside) return null;
  if (!fs.statSync(real).isFile()) return null;
  return { file: real, mime };
}
