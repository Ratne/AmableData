/**
 * IANA time-zone arithmetic with `Intl` only (no tz database bundled): local
 * calendar dates and wall-clock minutes of an instant, and the instant of a
 * local wall-clock time. Offsets are always computed for the instant, so DST
 * transitions are handled on the exact day they happen.
 */

export interface LocalDate {
  readonly y: number;
  /** 1-12. */
  readonly m: number;
  readonly d: number;
}

export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;

const partFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partFormatters.set(timeZone, formatter);
  }
  return formatter;
}

interface WallClock {
  y: number;
  m: number;
  d: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClock(utcMs: number, timeZone: string): WallClock {
  const out: WallClock = { y: 0, m: 0, d: 0, hour: 0, minute: 0, second: 0 };
  for (const part of partsFormatter(timeZone).formatToParts(new Date(utcMs))) {
    const n = Number(part.value);
    switch (part.type) {
      case 'year':
        out.y = n;
        break;
      case 'month':
        out.m = n;
        break;
      case 'day':
        out.d = n;
        break;
      case 'hour':
        out.hour = n === 24 ? 0 : n;
        break;
      case 'minute':
        out.minute = n;
        break;
      case 'second':
        out.second = n;
        break;
      default:
        break;
    }
  }
  return out;
}

export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone === '') return false;
  try {
    partsFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Offset of `timeZone` from UTC at an instant, in ms (positive east of Greenwich). */
export function tzOffsetMs(utcMs: number, timeZone: string): number {
  const w = wallClock(utcMs, timeZone);
  const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.hour, w.minute, w.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Instant of a local wall-clock time (`minutes` after local midnight, may be
 * 1440 for the end of the day). Times skipped by a DST jump move forward by
 * the jump; repeated times resolve to their first occurrence.
 */
export function zonedToUtc(date: LocalDate, minutes: number, timeZone: string): number {
  const guess = Date.UTC(date.y, date.m - 1, date.d, 0, minutes);
  const before = guess - tzOffsetMs(guess - DAY_MS, timeZone);
  const after = guess - tzOffsetMs(guess + DAY_MS, timeZone);
  const valid = (instant: number): boolean => instant + tzOffsetMs(instant, timeZone) === guess;
  const okBefore = valid(before);
  const okAfter = valid(after);
  if (okBefore && okAfter) return Math.min(before, after);
  if (okAfter) return after;
  return before;
}

export function localDateOf(utcMs: number, timeZone: string): LocalDate {
  const w = wallClock(utcMs, timeZone);
  return { y: w.y, m: w.m, d: w.d };
}

/** Minutes after local midnight of an instant. */
export function localMinutesOf(utcMs: number, timeZone: string): number {
  const w = wallClock(utcMs, timeZone);
  return w.hour * 60 + w.minute;
}

const pad = (n: number): string => String(n).padStart(2, '0');

export function dateKey(date: LocalDate): string {
  return `${String(date.y)}-${pad(date.m)}-${pad(date.d)}`;
}

export function parseDateKey(key: string): LocalDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (match === null) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return { y, m, d };
}

/** Calendar arithmetic on local dates (independent of any time zone). */
export function addDays(date: LocalDate, days: number): LocalDate {
  const next = new Date(Date.UTC(date.y, date.m - 1, date.d + days));
  return { y: next.getUTCFullYear(), m: next.getUTCMonth() + 1, d: next.getUTCDate() };
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(date: LocalDate): number {
  return new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay();
}

export function compareDates(a: LocalDate, b: LocalDate): number {
  return a.y - b.y || a.m - b.m || a.d - b.d;
}

/** `HH:MM` (00:00-24:00) → minutes after midnight, null when malformed. */
export function parseHm(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (match === null) return null;
  const h = Number(match[1]);
  const min = Number(match[2]);
  if (min > 59 || h > 24 || (h === 24 && min !== 0)) return null;
  return h * 60 + min;
}

export function formatHm(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}
