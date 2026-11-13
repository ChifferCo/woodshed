// When a push notification's reminders come, in the time zone of the phone they go to (push.mjs sends them). Kept
// free of I/O so it can be tested on its own. Quiet hours, 22:00 to 08:00 on the phone's clock, hold a reminder until
// they end; a first notification is never held, and a snoozed reminder comes when it was asked for.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const QUIET_FROM_HOUR = 22;
export const QUIET_UNTIL_HOUR = 8;
// "The next morning": a reminder that waits for the person's day to start.
export const MORNING_HOUR = 9;

const formatters = new Map();

function formatter(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    }));
  }
  return formatters.get(timeZone);
}

/** @returns {boolean}  whether the runtime knows the IANA time zone, such as `America/Los_Angeles` */
export function validTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone || timeZone.length > 64) return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {number} ms
 * @param {string} timeZone
 * @returns {{year: number, month: number, day: number, hour: number, minute: number, second: number}}  the wall clock
 *   there, month 1 to 12
 */
export function zonedParts(ms, timeZone) {
  const parts = {};
  for (const { type, value } of formatter(timeZone).formatToParts(new Date(ms))) {
    if (type !== 'literal') parts[type] = Number(value);
  }
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute, second: parts.second };
}

// How far the zone's wall clock is ahead of UTC at that instant.
function offsetAt(ms, timeZone) {
  const at = Math.floor(ms / 1000) * 1000;
  const p = zonedParts(at, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - at;
}

/**
 * The instant a wall clock time in a zone names. Asked again at the answer, so a date across a change to or from summer
 * time lands on the right side of it.
 * @param {{year: number, month: number, day: number, hour: number, minute?: number}} wall  `day` may run past the month's end
 * @param {string} timeZone
 * @returns {number}  epoch ms
 */
export function zonedTime({ year, month, day, hour, minute = 0 }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetAt(guess, timeZone);
  const second = guess - offsetAt(first, timeZone);
  return second;
}

/** @returns {boolean}  whether the instant falls in quiet hours on that zone's clock */
export function inQuietHours(ms, timeZone) {
  const { hour } = zonedParts(ms, timeZone);
  return hour >= QUIET_FROM_HOUR || hour < QUIET_UNTIL_HOUR;
}

/** @returns {number}  the instant itself, or the end of the quiet hours it falls in */
export function afterQuietHours(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  if (p.hour >= QUIET_FROM_HOUR) return zonedTime({ year: p.year, month: p.month, day: p.day + 1, hour: QUIET_UNTIL_HOUR }, timeZone);
  if (p.hour < QUIET_UNTIL_HOUR) return zonedTime({ year: p.year, month: p.month, day: p.day, hour: QUIET_UNTIL_HOUR }, timeZone);
  return ms;
}

/** @returns {number}  9:00 on the day after the instant's, on that zone's clock */
export function nextMorning(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return zonedTime({ year: p.year, month: p.month, day: p.day + 1, hour: MORNING_HOUR }, timeZone);
}

/**
 * When each reminder of a notification is due, before quiet hours hold any (afterQuietHours), in order. At most two:
 * the caller keeps to the cap as well, past a snooze.
 * @param {string} kind  push.mjs's KINDS
 * @param {{at: number, pauseAt?: number|null}} when  `at`: when the first went out; `pauseAt`: when an idle session
 *   pauses, for `waiting`
 * @param {string} timeZone
 * @returns {number[]}
 */
export function reminderTimes(kind, { at, pauseAt = null }, timeZone) {
  if (kind === 'waiting') {
    // At 15 minutes, then 10 minutes before the idle pause, if that is after the first.
    const first = at + 15 * MINUTE;
    const beforePause = pauseAt === null || pauseAt === undefined ? null : pauseAt - 10 * MINUTE;
    return beforePause !== null && beforePause > first ? [first, beforePause] : [first];
  }
  if (kind === 'prReady' || kind === 'prStuck') {
    // At 4 hours, then 9:00 the next morning: a morning after the first reminder, once quiet hours have held it.
    const first = at + 4 * HOUR;
    const held = afterQuietHours(first, timeZone);
    let morning = nextMorning(at, timeZone);
    while (morning <= held) morning = nextMorning(morning, timeZone);
    return [first, morning];
  }
  if (kind === 'assigned' || kind === 'joinRequest') return [nextMorning(at, timeZone)];
  return [];
}

/**
 * @param {number} ms
 * @param {string} timeZone
 * @param {number} now
 * @returns {string}  `3:00 PM` the same day there, `Sat 3:00 PM` on another
 */
export function clockText(ms, timeZone, now) {
  const p = zonedParts(ms, timeZone);
  const today = zonedParts(now, timeZone);
  const sameDay = p.year === today.year && p.month === today.month && p.day === today.day;
  return new Intl.DateTimeFormat('en-US', {
    timeZone, hour: 'numeric', minute: '2-digit', ...(sameDay ? {} : { weekday: 'short' }),
  }).format(new Date(ms));
}
