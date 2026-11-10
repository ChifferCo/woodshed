// The names every engine gives the databases and users it makes, so a person's, a session's and the template's are
// the same on each (session/dbAdmin.mjs makes them, console/databases.mjs and console/dbRestore.mjs name them).

// A login's name has one underscore after `woodshed`, and a login never starts with `-`, so no login's name begins
// `woodshed__`: these and the sessions' cannot be anyone's.
export const TEMPLATE = 'woodshed__template';
export const TEMPLATE_NEXT = 'woodshed__template_next';
// Seeds the next template as its owner, as a person's user would.
export const SEEDER = 'woodshed__seed';
// A person's database and user: one underscore after `woodshed`, where a session's and the template's have two.
export const PERSON_RE = /^woodshed_[a-z0-9]/;

/**
 * A person's restore copy and the backup Apply makes, beside their database (console/dbRestore.mjs). A login's name
 * never holds `__`, since a GitHub login never holds `--`, so no person's database can be another's copy.
 * @returns {string[]}
 */
export function restoreNames(name) {
  return [`${name}__restore`, `${name}__previous`];
}
