// The limits and retention numbers on the Console settings page. Each is kept in state.json under `settings`, next
// to the Slack channel, and read every time it is used, so a change applies on the next tick without a restart.
// One never set is the console's environment value (Terraform's, on the base box), or the default below.

import { addedProjectsOf, allProjects } from './projects.mjs';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How long a stopped shared session keeps its conversation and databases, unless the page says otherwise. */
export const DEFAULT_RETENTION = {
  afterCloseMs: 3 * DAY_MS,
  withoutPrMs: 7 * DAY_MS,
  openPrMs: 14 * DAY_MS,
  slackGiveUpMs: 7 * DAY_MS,
  qaWaitMs: 30 * MINUTE_MS,
  removeAfterDeleteMs: 14 * DAY_MS,
};

/** A question from Slack's limits, unless the page says otherwise. Its session idles once it has answered: a follow-up
 * in the thread resumes it with its conversation. */
export const ASK_DEFAULTS = { maxAsks: 3, idleMs: 5 * MINUTE_MS, lifetimeMs: 2 * HOUR_MS };

const retention = (config) => ({ ...DEFAULT_RETENTION, ...config.retention });

/** Each setting, in its own unit and card: `read` is its value from the console's environment. */
export const SETTINGS = [
  {
    key: 'maxRunning', group: 'sessions', label: 'Shared sessions running at once', unit: 'sessions', min: 1, max: 20, step: 1,
    help: 'The rest wait in line. My Woodshed sessions are counted on their own, below.',
    read: (config) => config.maxRunning,
  },
  {
    key: 'maxPrivatePerPerson', group: 'sessions', label: 'My Woodshed sessions per person', unit: 'sessions', min: 1, max: 10, step: 1,
    help: 'Running or waiting, for each person. They take none of the shared slots above.',
    read: (config) => config.maxPrivatePerPerson ?? 3,
  },
  {
    key: 'idleHours', group: 'sessions', label: 'Pause a session waiting for input after', unit: 'hours', min: 0.25, max: 24, step: 0.25,
    help: 'Claude asked something, or its PR is in review, and nothing came in.',
    read: (config) => config.limits.idleMs / HOUR_MS,
  },
  {
    key: 'lifetimeHours', group: 'sessions', label: 'Stop a working session after', unit: 'hours', min: 1, max: 24, step: 1,
    help: 'A backstop for a session stuck in a loop. It is paused, and can be resumed.',
    read: (config) => config.limits.lifetimeMs / HOUR_MS,
  },
  {
    key: 'maxAsks', group: 'questions', label: 'Questions running at once', unit: 'sessions', min: 1, max: 10, step: 1,
    help: 'The rest wait in line. They take none of the shared or My Woodshed slots.',
    read: (config) => config.maxAsks ?? ASK_DEFAULTS.maxAsks,
  },
  {
    key: 'askIdleMinutes', group: 'questions', label: 'Stop a question\'s session when idle for', unit: 'minutes', min: 1, max: 120, step: 1,
    help: 'Counted from its last answer. A follow-up before then is answered at once; after, the session resumes with its conversation, in about 40 seconds.',
    read: (config) => (config.limits.askIdleMs ?? ASK_DEFAULTS.idleMs) / MINUTE_MS,
  },
  {
    key: 'askLifetimeHours', group: 'questions', label: 'Stop a question\'s session after', unit: 'hours', min: 0.5, max: 8, step: 0.5,
    help: 'However busy it is. A follow-up resumes it.',
    read: (config) => (config.limits.askLifetimeMs ?? ASK_DEFAULTS.lifetimeMs) / HOUR_MS,
  },
  {
    key: 'keepAfterCloseDays', group: 'retention', label: 'Delete a merged or closed session after', unit: 'days', min: 0, max: 30, step: 1,
    help: 'Counted from when its pull request merged or closed. 0 deletes it at once.',
    read: (config) => retention(config).afterCloseMs / DAY_MS,
  },
  {
    key: 'keepOpenPrDays', group: 'retention', label: 'Delete a finished session whose PR stays open after', unit: 'days', min: 1, max: 90, step: 1,
    help: 'Counted from when it last stopped. A resume starts the count again.',
    read: (config) => retention(config).openPrMs / DAY_MS,
  },
  {
    key: 'keepWithoutPrDays', group: 'retention', label: 'Delete a paused session with no pull request after', unit: 'days', min: 1, max: 60, step: 1,
    help: 'Counted from when it last stopped.',
    read: (config) => retention(config).withoutPrMs / DAY_MS,
  },
  {
    key: 'removeDeletedDays', group: 'retention', label: 'Take a deleted session off the list after', unit: 'days', min: 0, max: 90, step: 1,
    help: 'Counted from when its conversation and databases were deleted. Its card says Deleted until then. 0 takes it off at once.',
    read: (config) => retention(config).removeAfterDeleteMs / DAY_MS,
  },
  {
    key: 'slackGiveUpDays', group: 'slack', label: 'Stop waiting for the review and the suite after', unit: 'days', min: 1, max: 30, step: 1,
    help: 'A pull request still not approved and green by then is never posted.',
    read: (config) => retention(config).slackGiveUpMs / DAY_MS,
  },
  {
    key: 'qaWaitMinutes', group: 'slack', label: 'Wait for the QA check before the brief for at most', unit: 'minutes', min: 0, max: 180, step: 5,
    help: 'Once a pull request is approved and green. Then its decision brief goes out with QA: not run.',
    read: (config) => retention(config).qaWaitMs / MINUTE_MS,
  },
];

const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

function storedValue(store, key) {
  const value = store.state.settings?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** @returns {string|null}  why `value` is no good for `setting`, as the page says it */
export function settingProblem(setting, value) {
  const number = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (String(value ?? '').trim() === '' || !Number.isFinite(number)) return `${setting.label}: give a number.`;
  if (number < setting.min || number > setting.max) return `${setting.label} must be from ${setting.min} to ${setting.max} ${setting.unit}.`;
  if (Math.abs(Math.round(number / setting.step) * setting.step - number) > 1e-9) return `${setting.label} goes in steps of ${setting.step} ${setting.unit}.`;
  return null;
}

/**
 * The console's config with its limits and retention read from the page's settings each time they are used.
 * @param {object} config  from loadConfig
 * @param {{state: object}} store
 * @param {{hostProjects?: {changes: {added: object[], removed: string[]}|null}|null}} [opts]  what an embedding
 *   program's repos hook changed since the installation was built (addedProjects.mjs, createHostProjects)
 * @returns {object}  the same config, its `maxRunning`, `maxPrivatePerPerson`, `maxAsks`, `limits` and `retention` live
 */
export function liveConfig(config, store, { hostProjects = null } = {}) {
  const value = (key) => storedValue(store, key) ?? BY_KEY.get(key).read(config);
  let merged = null;
  return {
    ...config,
    // The installation's repos (with what an embedding program's hook changed of them since), then the ones an admin
    // added on the Console settings page (addedProjects.mjs).
    get projects() {
      const added = addedProjectsOf(store);
      const changes = hostProjects?.changes ?? null;
      if (!added.length && !changes) return config.projects;
      // Rebuilt only when the added list or the hook's changes do, since every session's tick reads it. An added repo
      // the installation has since named itself is left out, so the environment's own entry wins.
      if (merged?.added !== added || merged.changes !== changes) {
        const same = (a, b) => a.name === b.name || a.repo.toLowerCase() === b.repo.toLowerCase();
        let own = allProjects(config);
        if (changes) {
          own = own.filter((p) => !changes.removed.includes(p.name));
          own = [...own, ...changes.added.filter((p) => !own.some((o) => same(o, p)))];
        }
        const list = [...own, ...added.filter((p) => !own.some((o) => same(o, p)))];
        // A console that started with no repo of its own works on the first one added, until it is removed. No session
        // image holds its checkout (the image is the environment's repo's, or has none), so its sessions clone it at
        // start like any added repo's (fleet.mjs, PROJECT_REPO).
        if (list.length && !list.some((p) => p.default)) list[0] = { ...list[0], default: true, clonedAtStart: true };
        merged = { added, changes, list };
      }
      return merged.list;
    },
    get maxRunning() { return value('maxRunning'); },
    get maxPrivatePerPerson() { return value('maxPrivatePerPerson'); },
    get maxAsks() { return value('maxAsks'); },
    limits: {
      ...config.limits,
      get idleMs() { return value('idleHours') * HOUR_MS; },
      get lifetimeMs() { return value('lifetimeHours') * HOUR_MS; },
      get askIdleMs() { return value('askIdleMinutes') * MINUTE_MS; },
      get askLifetimeMs() { return value('askLifetimeHours') * HOUR_MS; },
    },
    retention: {
      get afterCloseMs() { return value('keepAfterCloseDays') * DAY_MS; },
      get openPrMs() { return value('keepOpenPrDays') * DAY_MS; },
      get withoutPrMs() { return value('keepWithoutPrDays') * DAY_MS; },
      get slackGiveUpMs() { return value('slackGiveUpDays') * DAY_MS; },
      get qaWaitMs() { return value('qaWaitMinutes') * MINUTE_MS; },
      get removeAfterDeleteMs() { return value('removeDeletedDays') * DAY_MS; },
    },
  };
}

/**
 * @param {{store: {state: object, save: () => void}, config: object}} deps  `config` as loadConfig made it, for defaults
 */
export function createConsoleSettings({ store, config }) {
  /** @returns {object[]}  each setting with its value now, and what it is when nobody set it */
  function view() {
    return SETTINGS.map(({ key, group, label, unit, min, max, step, help, read }) => {
      const stored = storedValue(store, key);
      return { key, group, label, unit, min, max, step, help, value: stored ?? read(config), defaultValue: read(config), set: stored !== null };
    });
  }

  /**
   * Checks every value before any is kept, so one card's save changes all of them or none.
   * @param {object} values  setting key to its new value
   * @throws {Error}  shown on the page, for an unknown setting or a value out of its bounds
   */
  function check(values) {
    if (typeof values !== 'object' || values === null || Array.isArray(values)) throw Object.assign(new Error('values must be an object'), { shown: true });
    for (const [key, value] of Object.entries(values)) {
      const setting = BY_KEY.get(key);
      if (!setting) throw Object.assign(new Error(`there is no setting called ${key}`), { shown: true });
      const problem = settingProblem(setting, value);
      if (problem) throw Object.assign(new Error(problem), { shown: true });
    }
  }

  /**
   * @param {{values: object, by: string}} args
   * @returns {number}  how many changed
   */
  function setMany({ values, by }) {
    check(values);
    let changed = 0;
    for (const [key, raw] of Object.entries(values)) {
      const to = Number(raw);
      const from = storedValue(store, key) ?? BY_KEY.get(key).read(config);
      if (from === to) continue;
      store.state.settings = { ...store.state.settings, [key]: to };
      changed += 1;
      console.log('settings: changed', { key, from, to, by });
    }
    if (changed) store.save();
    return changed;
  }

  return { view, check, setMany };
}

/** @returns {string}  `45 min`, `1 h`, `1 h 30 min`, `3 days` */
export function spanText(ms) {
  const minutes = Math.round(ms / MINUTE_MS);
  if (minutes >= 2 * 24 * 60 && minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} days`;
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)} h ${rest} min` : `${minutes / 60} h`;
}
