import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createConsoleSettings, liveConfig, spanText } from './consoleSettings.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function setup(settings) {
  const store = { state: settings ? { settings } : {}, saves: 0, save() { this.saves += 1; } };
  const config = { maxRunning: 5, limits: { idleMs: HOUR, lifetimeMs: 8 * HOUR, startTimeoutMs: 15 * 60_000 } };
  return { store, config, settings: createConsoleSettings({ store, config }), live: liveConfig(config, store) };
}

test('with nothing set, the live config is the environment\'s, and retention its defaults', () => {
  const { live } = setup();
  assert.equal(live.maxRunning, 5);
  assert.deepEqual([live.limits.idleMs, live.limits.lifetimeMs, live.limits.startTimeoutMs], [HOUR, 8 * HOUR, 15 * 60_000]);
  assert.deepEqual([live.retention.afterCloseMs, live.retention.openPrMs, live.retention.withoutPrMs, live.retention.slackGiveUpMs],
    [3 * DAY, 14 * DAY, 7 * DAY, 7 * DAY]);
});

test('a saved setting is read the next time it is used, with no restart', () => {
  const { live, settings, store } = setup();
  settings.setMany({ values: { maxRunning: 8, idleHours: 0.5, keepOpenPrDays: 21 }, by: 'joel' });
  assert.deepEqual([live.maxRunning, live.limits.idleMs, live.retention.openPrMs], [8, HOUR / 2, 21 * DAY]);
  assert.equal(store.saves, 1, 'one save for the card');
  const view = settings.view().find((s) => s.key === 'maxRunning');
  assert.deepEqual([view.value, view.defaultValue, view.set], [8, 5, true]);
});

test('a question\'s limits are settings too, with their defaults until set', () => {
  const { live, settings } = setup();
  assert.deepEqual([live.maxAsks, live.limits.askIdleMs, live.limits.askLifetimeMs], [3, 5 * 60_000, 2 * HOUR]);
  settings.setMany({ values: { maxAsks: 5, askIdleMinutes: 15, askLifetimeHours: 1.5 }, by: 'joel' });
  assert.deepEqual([live.maxAsks, live.limits.askIdleMs, live.limits.askLifetimeMs], [5, 15 * 60_000, 1.5 * HOUR]);
  assert.deepEqual(settings.view().filter((s) => s.group === 'questions').map((s) => s.key), ['maxAsks', 'askIdleMinutes', 'askLifetimeHours']);
  assert.throws(() => settings.setMany({ values: { askIdleMinutes: 0 }, by: 'joel' }), (err) => err.shown && /from 1 to 120 minutes/.test(err.message));
});

test('a card\'s values are all checked before any is kept: one out of bounds keeps none', () => {
  const { settings, store } = setup();
  assert.throws(() => settings.setMany({ values: { maxRunning: 8, keepAfterCloseDays: 45 }, by: 'joel' }),
    (err) => err.shown && /Delete a merged or closed session after must be from 0 to 30 days/.test(err.message));
  assert.equal(store.state.settings, undefined);
  for (const [values, why] of [
    [{ maxRunning: 0 }, /from 1 to 20 sessions/],
    [{ maxRunning: 2.5 }, /steps of 1 sessions/],
    [{ idleHours: 0.3 }, /steps of 0.25 hours/],
    [{ idleHours: '' }, /give a number/],
    [{ nope: 1 }, /no setting called nope/],
  ]) {
    assert.throws(() => settings.setMany({ values, by: 'joel' }), (err) => err.shown && why.test(err.message), JSON.stringify(values));
  }
});

test('a value saved as it already is changes nothing, and logs nothing', () => {
  const { settings, store } = setup();
  assert.equal(settings.setMany({ values: { maxRunning: 5 }, by: 'joel' }), 0);
  assert.equal(store.saves, 0);
});

test('spanText says a duration as the page and the logs do', () => {
  assert.deepEqual([spanText(45 * 60_000), spanText(HOUR), spanText(90 * 60_000), spanText(3 * DAY), spanText(DAY)],
    ['45 min', '1 h', '1 h 30 min', '3 days', '24 h']);
});

test('My Woodshed sessions per person is a setting: 3 by default, from 1 to 10', () => {
  const { live, settings } = setup();
  assert.equal(live.maxPrivatePerPerson, 3);
  settings.setMany({ values: { maxPrivatePerPerson: 1 }, by: 'joel' });
  assert.equal(live.maxPrivatePerPerson, 1);
  assert.throws(() => settings.setMany({ values: { maxPrivatePerPerson: 0 }, by: 'joel' }), /from 1 to 10 sessions/);
});

test('the wait for the QA check before a decision brief is 30 minutes until set, and read live', () => {
  const { live, settings } = setup();
  assert.equal(live.retention.qaWaitMs, 30 * 60_000);
  settings.setMany({ values: { qaWaitMinutes: 45 }, by: 'joel' });
  assert.equal(live.retention.qaWaitMs, 45 * 60_000);
  assert.equal(settings.view().find((s) => s.key === 'qaWaitMinutes').group, 'slack');
  assert.throws(() => settings.setMany({ values: { qaWaitMinutes: 7 }, by: 'joel' }), (err) => err.shown && /steps of 5 minutes/.test(err.message));
});
