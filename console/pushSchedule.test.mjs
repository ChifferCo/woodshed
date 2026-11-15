import { test } from 'node:test';
import assert from 'node:assert/strict';

import { afterQuietHours, clockText, inQuietHours, nextMorning, reminderTimes, validTimeZone, zonedParts, zonedTime } from './pushSchedule.mjs';

const LA = 'America/Los_Angeles';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// November: Los Angeles is on PST, UTC-8.
const la = (day, hour, minute = 0) => Date.UTC(2026, 10, day, hour + 8, minute);

test('a wall clock time in a zone is the instant it names, on either side of a change to summer time', () => {
  assert.equal(zonedTime({ year: 2026, month: 11, day: 13, hour: 9 }, LA), Date.parse('2026-11-13T17:00:00Z'));
  assert.equal(zonedTime({ year: 2026, month: 3, day: 8, hour: 9 }, LA), Date.parse('2026-03-08T16:00:00Z'), 'PDT from 2:00 that morning');
  assert.equal(zonedTime({ year: 2026, month: 3, day: 7, hour: 9 }, LA), Date.parse('2026-03-07T17:00:00Z'));
  assert.equal(zonedTime({ year: 2026, month: 11, day: 31, hour: 9 }, LA), Date.parse('2026-12-01T17:00:00Z'), 'a day past the month runs on');
  assert.deepEqual(zonedParts(Date.parse('2026-11-13T07:30:00Z'), LA), { year: 2026, month: 11, day: 12, hour: 23, minute: 30, second: 0 });
});

test('quiet hours are 22:00 to 08:00 on the phone\'s own clock, and hold an instant to their end', () => {
  assert.equal(inQuietHours(la(13, 21, 59), LA), false);
  assert.equal(inQuietHours(la(13, 22), LA), true);
  assert.equal(inQuietHours(la(14, 7, 59), LA), true);
  assert.equal(inQuietHours(la(14, 8), LA), false);
  assert.equal(afterQuietHours(la(13, 23, 30), LA), la(14, 8), 'late evening: the next morning at 8');
  assert.equal(afterQuietHours(la(14, 3), LA), la(14, 8), 'small hours: the same morning at 8');
  assert.equal(afterQuietHours(la(13, 14), LA), la(13, 14), 'daytime: as it is');
  // The same instant is daytime in Tokyo, 17 hours ahead.
  assert.equal(afterQuietHours(la(13, 23, 30), 'Asia/Tokyo'), la(13, 23, 30));
});

test('the next morning is 9:00 on the following day there, across a change of the clocks too', () => {
  assert.equal(nextMorning(la(13, 10), LA), la(14, 9));
  assert.equal(nextMorning(la(13, 23, 59), LA), la(14, 9));
  assert.equal(nextMorning(la(14, 0, 5), LA), la(15, 9));
  assert.equal(nextMorning(Date.parse('2026-03-07T18:00:00Z'), LA), Date.parse('2026-03-08T16:00:00Z'));
});

test('each kind\'s reminders: waiting at 15 minutes and before the pause, a pull request at 4 hours and the next morning', () => {
  const at = la(13, 10);
  assert.deepEqual(reminderTimes('waiting', { at, pauseAt: at + HOUR }, LA), [at + 15 * MINUTE, at + 50 * MINUTE]);
  assert.deepEqual(reminderTimes('waiting', { at, pauseAt: at + 20 * MINUTE }, LA), [at + 15 * MINUTE], 'the pause is too soon for a second');
  assert.deepEqual(reminderTimes('waiting', { at, pauseAt: null }, LA), [at + 15 * MINUTE]);
  assert.deepEqual(reminderTimes('prReady', { at }, LA), [la(13, 14), la(14, 9)]);
  // At 21:00 the 4 hours end at 1:00, which quiet hours hold to 8:00: the morning's comes after that, at 9:00.
  assert.deepEqual(reminderTimes('prStuck', { at: la(13, 21) }, LA), [la(14, 1), la(14, 9)]);
  // At 6:00 the first is at 10:00, so "the next morning" is the day after.
  assert.deepEqual(reminderTimes('prReady', { at: la(13, 6) }, LA), [la(13, 10), la(14, 9)]);
  assert.deepEqual(reminderTimes('assigned', { at }, LA), [la(14, 9)]);
  assert.deepEqual(reminderTimes('joinRequest', { at: la(13, 23) }, LA), [la(14, 9)]);
  for (const kind of ['startFailed', 'started', 'planLimit', 'planReset']) assert.deepEqual(reminderTimes(kind, { at }, LA), [], kind);
});

test('a time zone is one the runtime knows; the clock reads in it', () => {
  assert.equal(validTimeZone(LA), true);
  assert.equal(validTimeZone('UTC'), true);
  assert.equal(validTimeZone('Mars/Olympus'), false);
  assert.equal(validTimeZone(''), false);
  assert.equal(validTimeZone(42), false);
  assert.equal(clockText(la(13, 15), LA, la(13, 10)), '3:00 PM');
  assert.equal(clockText(la(14, 15), LA, la(13, 10)), 'Sat 3:00 PM');
});
