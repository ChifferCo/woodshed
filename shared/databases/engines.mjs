// The engines themselves, apart from index.mjs: project.mjs validates `databases[].engine` against ENGINE_NAMES, and
// index.mjs imports project.mjs, so the list lives where it imports neither.
import mongo from './mongo.mjs';
import postgres from './postgres.mjs';

export const ENGINES = Object.freeze({ postgres, mongo });
export const ENGINE_NAMES = Object.freeze(Object.keys(ENGINES));

/** @returns {typeof postgres} */
export function engine(name) {
  const found = ENGINES[name];
  if (!found) throw new Error(`no database engine called ${name} (there are ${ENGINE_NAMES.join(', ')})`);
  return found;
}
