// The colour of each project on the rail, set by an admin on the Console settings page's Repos card and kept in
// state.json under `projectColors` (project name to a palette key). A project nobody picked a colour for takes the
// first free one, in the order the projects are listed (public/projectColors.cjs), so the installation's own repos
// have colours before anyone opens the page.

import projectColorsShared from './public/projectColors.cjs';
import { allProjects } from './projects.mjs';

const { PALETTE, validColor, projectColors } = projectColorsShared;

const shown = (message) => Object.assign(new Error(message), { shown: true });

function pickedOf(store) {
  const picked = store.state.projectColors;
  return picked && typeof picked === 'object' && !Array.isArray(picked) ? picked : {};
}

/**
 * @param {{store: {state: object, save: () => void}, config: object}} deps  `config` is the live one, whose `projects`
 *   hold the repos added on the page too
 */
export function createProjectColors({ store, config }) {
  /** @returns {Object<string, string|null>}  each project's colour now, by name */
  function view() {
    return projectColors({ names: allProjects(config).map((p) => p.name), picked: pickedOf(store) });
  }

  /**
   * @param {{name: string, color: string, by: string}} args
   * @throws {Error}  with `shown`, for an unknown project, a colour not in the palette, or one another project has
   */
  function set({ name, color, by }) {
    const now = view();
    if (typeof name !== 'string' || !Object.hasOwn(now, name)) throw shown(`There is no project called ${name}.`);
    if (!validColor(color)) throw shown(`The colour is one of ${PALETTE.join(', ')}.`);
    if (now[name] === color) return;
    const holder = Object.keys(now).find((other) => other !== name && now[other] === color);
    if (holder) throw shown(`${holder} has ${color} already: pick another colour, or change ${holder}'s first.`);
    // Every other project keeps the colour it shows now, picked or not: the one freed here would otherwise move to
    // the next project with none picked.
    const kept = Object.fromEntries(Object.entries(now).filter(([, key]) => key));
    store.state.projectColors = { ...pickedOf(store), ...kept, [name]: color };
    store.save();
    console.log('projects: colour set', { project: name, from: now[name], to: color, by });
  }

  return { view, set };
}
