// Each project's colour: the edge of its cards on the rail and the swatch on its filter chip. One file for the server
// (imported) and the pages (a script that sets `WoodshedProjectColors`), so both read the palette and the rail's
// project filter the same way. A colour names a project and nothing else: none of them is a status colour
// (console/designSystem/README.md).
(function (root, factory) {
  const colors = factory();
  if (typeof module === 'object' && module.exports) module.exports = colors;
  else root.WoodshedProjectColors = colors;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';

  // The order is the one repos with no colour picked take them in, so the first ones are the furthest apart.
  // Each is a `--proj-<key>` token in style.css, with its `-tint`.
  const PALETTE = ['teal', 'plum', 'sienna', 'rose', 'violet', 'moss'];

  /** @returns {boolean}  whether `key` is one of the palette's colours */
  function validColor(key) {
    return typeof key === 'string' && PALETTE.includes(key);
  }

  /**
   * Every project's colour. A pick is kept when it is in the palette and no project listed before it has the same one;
   * the rest take the first colour nobody has, in the order the projects are listed, so adding a repo never changes
   * the colours of those before it. Past six projects the palette runs out and the rest have none (null).
   * @param {{names: string[], picked?: Object<string, string>}} args  the projects in their listed order, and the
   *   colours an admin picked, by project name
   * @returns {Object<string, string|null>}  project name to its colour key
   */
  function projectColors({ names, picked = {} }) {
    const out = {};
    const taken = new Set();
    for (const name of names) {
      const want = picked && Object.hasOwn(picked, name) ? picked[name] : undefined;
      if (validColor(want) && !taken.has(want)) {
        out[name] = want;
        taken.add(want);
      }
    }
    for (const name of names) {
      if (Object.hasOwn(out, name)) continue;
      const free = PALETTE.find((key) => !taken.has(key)) ?? null;
      out[name] = free;
      if (free) taken.add(free);
    }
    return out;
  }

  /**
   * The project the rail is filtered to. A choice kept from before that names a project the console no longer has is
   * no filter at all, so the rail never hides everything for a project that is gone.
   * @param {{saved: unknown, names: string[]}} args
   * @returns {string|null}  the project's name, or null for All
   */
  function railProject({ saved, names }) {
    return typeof saved === 'string' && names.includes(saved) ? saved : null;
  }

  /** @returns {Object<string, number>}  how many of `sessions` are on each project, by name */
  function countByProject(sessions) {
    const counts = {};
    for (const s of sessions) if (s.project) counts[s.project] = (counts[s.project] || 0) + 1;
    return counts;
  }

  return { PALETTE, validColor, projectColors, railProject, countByProject };
});
