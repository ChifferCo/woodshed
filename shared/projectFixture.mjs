// For tests: a project file with every field written, and only the ones a test cares about set.
import { EMPTY_PROJECT } from './project.mjs';

export function fixtureApp(overrides = {}) {
  return {
    start: 'true', stop: null, frontendPort: 3001, backendPort: 9000, logs: {}, paths: [],
    howToProve: 'Start the app and check it.', ...overrides,
  };
}

/** The file's text: JSON, which the project file's YAML reads too. */
export function fixtureProject(overrides = {}) {
  return JSON.stringify({ ...EMPTY_PROJECT, ...overrides });
}
