import type { Duration, SendWindow } from '@amable/api-types';

/**
 * Time-zone arithmetic on top of Intl (no tz database shipped): wall-clock
 * parts of an instant in a zone, and the instant of a wall-clock time in a zone.
 */

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export const DURATION_MS: Record<Duration['unit'], number> = {
  minutes: MINUTE,
  hours: 60 * MINUTE,
  days: DAY,
  weeks: 7 * DAY,
};

export function durationMs(duration: Duration): number {
  return duration.amount * DURATION_MS[duration.unit];
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** ISO weekday, 1 = Monday … 7 = Sunday. */
  weekday: number;
}

export function wallClock(ms: number, timeZone: string): WallClock {
  const values: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  const year = values['year'] ?? 1970;
  const month = values['month'] ?? 1;
  const day = values['day'] ?? 1;
  const jsDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return {
    year,
    month,
    day,
    hour: values['hour'] ?? 0,
    minute: values['minute'] ?? 0,
    second: values['second'] ?? 0,
    weekday: jsDay === 0 ? 7 : jsDay,
  };
}

function offsetMs(ms: number, timeZone: string): number {
  const w = wallClock(ms, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Instant of a wall-clock time in `timeZone` (DST gaps resolve forward). */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetMs(guess, timeZone);
  const second = guess - offsetMs(first, timeZone);
  return second;
}

export function parseTimeOfDay(value: string | undefined, fallback = '00:00'): [number, number] {
  const [h, m] = (value ?? fallback).split(':').map(Number);
  return [h ?? 0, m ?? 0];
}

/** Adds calendar days to a Y-M-D (UTC arithmetic, no zone involved). */
export function addDays(
  date: { year: number; month: number; day: number },
  days: number,
): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function parseDate(value: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (m === null) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

export function formatDate(date: { year: number; month: number; day: number }): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(date.year).padStart(4, '0')}-${pad(date.month)}-${pad(date.day)}`;
}

function minutesOfDay(value: string): number {
  const [h, m] = parseTimeOfDay(value);
  return h * 60 + m;
}

/**
 * Earliest instant >= `now` inside the window, in `timeZone`.
 * A window with end <= start spans midnight (e.g. 22:00-06:00).
 */
export function nextWindowOpening(now: number, window: SendWindow, timeZone: string): number {
  const days = new Set(window.days ?? [1, 2, 3, 4, 5, 6, 7]);
  const start = minutesOfDay(window.start);
  const end = minutesOfDay(window.end);
  const local = wallClock(now, timeZone);
  const today = { year: local.year, month: local.month, day: local.day };
  const nowMinutes = local.hour * 60 + local.minute;
  const overnight = end <= start;

  // Inside today's window (or the tail of yesterday's overnight window)?
  if (days.has(local.weekday)) {
    if (!overnight && nowMinutes >= start && nowMinutes < end) return now;
    if (overnight && nowMinutes >= start) return now;
  }
  if (overnight && nowMinutes < end) {
    const yesterday = local.weekday === 1 ? 7 : local.weekday - 1;
    if (days.has(yesterday)) return now;
  }
  for (let i = 0; i <= 7; i += 1) {
    const date = addDays(today, i);
    const weekday = ((local.weekday - 1 + i) % 7) + 1;
    if (!days.has(weekday)) continue;
    const opening = zonedToUtc(
      date.year,
      date.month,
      date.day,
      Math.floor(start / 60),
      start % 60,
      timeZone,
    );
    if (opening >= now) return opening;
  }
  return now;
}

/**
 * Next yearly occurrence of a month/day at a local time, on or after `notBefore`
 * after applying `shiftMs`. Feb 29 falls back to Feb 28 in non-leap years.
 */
export function nextYearly(
  base: { month: number; day: number },
  hour: number,
  minute: number,
  shiftMs: number,
  notBefore: number,
  timeZone: string,
): number {
  const startYear = wallClock(notBefore, timeZone).year - 1;
  for (let year = startYear; year <= startYear + 3; year += 1) {
    const day = base.month === 2 && base.day === 29 && !isLeap(year) ? 28 : base.day;
    const at = zonedToUtc(year, base.month, day, hour, minute, timeZone) + shiftMs;
    if (at >= notBefore) return at;
  }
  return notBefore;
}

export function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}
