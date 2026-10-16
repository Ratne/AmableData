import type {
  CompareMode,
  DatePreset,
  Granularity,
  ReportDateRange,
} from '@amable/api-types/reports';

/**
 * Calendar arithmetic of the report engine: local days of an IANA time zone,
 * date presets, comparison periods and bucket boundaries (epoch ms). Pure and
 * deterministic (the caller passes `now`).
 */

export interface CivilDate {
  y: number;
  m: number;
  d: number;
}

const DAY_MS = 86_400_000;
/** Bucketed queries join a literal VALUES list: keep it bounded. */
export const MAX_BUCKETS = 400;
const ALL_TIME_START: CivilDate = { y: 2000, m: 1, d: 1 };

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

function wallClock(epochMs: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(epochMs))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return Date.UTC(
    parts['year'] ?? 1970,
    (parts['month'] ?? 1) - 1,
    parts['day'] ?? 1,
    parts['hour'] ?? 0,
    parts['minute'] ?? 0,
    parts['second'] ?? 0,
  );
}

/** Offset (ms) of `timeZone` from UTC at the instant `epochMs`. */
function offsetAt(epochMs: number, timeZone: string): number {
  const rounded = Math.floor(epochMs / 1000) * 1000;
  return wallClock(rounded, timeZone) - rounded;
}

/** Epoch ms of local midnight of `date` in `timeZone`. */
export function startOfLocalDay(date: CivilDate, timeZone: string): number {
  const guess = Date.UTC(date.y, date.m - 1, date.d);
  const first = guess - offsetAt(guess, timeZone);
  return guess - offsetAt(first, timeZone);
}

export function localDate(epochMs: number, timeZone: string): CivilDate {
  const wall = new Date(wallClock(epochMs, timeZone));
  return { y: wall.getUTCFullYear(), m: wall.getUTCMonth() + 1, d: wall.getUTCDate() };
}

export function addDays(date: CivilDate, days: number): CivilDate {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** Adds months, clamping the day to the target month (31/1 + 1 month = 28/2). */
export function addMonths(date: CivilDate, months: number): CivilDate {
  const index = date.y * 12 + (date.m - 1) + months;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { y, m, d: Math.min(date.d, last) };
}

export function compareDates(a: CivilDate, b: CivilDate): number {
  return Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(b.y, b.m - 1, b.d);
}

export function daysBetween(a: CivilDate, b: CivilDate): number {
  return Math.round(compareDates(b, a) / DAY_MS);
}

export function formatDate(date: CivilDate): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${p(date.y, 4)}-${p(date.m)}-${p(date.d)}`;
}

export function parseDate(text: string): CivilDate {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (m === null) throw new RangeError(`invalid date ${text}`);
  const date = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  if (formatDate(addDays(date, 0)) !== text) throw new RangeError(`invalid date ${text}`);
  return date;
}

/** Local days `[from, to]` (both included). */
export interface DayRange {
  from: CivilDate;
  to: CivilDate;
}

export function resolvePreset(preset: DatePreset, today: CivilDate): DayRange {
  const firstOfMonth = { ...today, d: 1 };
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'last_7_days':
      return { from: addDays(today, -6), to: today };
    case 'last_30_days':
      return { from: addDays(today, -29), to: today };
    case 'last_90_days':
      return { from: addDays(today, -89), to: today };
    case 'this_month':
      return { from: firstOfMonth, to: today };
    case 'last_month': {
      const from = addMonths(firstOfMonth, -1);
      return { from, to: addDays(firstOfMonth, -1) };
    }
    case 'this_quarter':
      return { from: { y: today.y, m: Math.floor((today.m - 1) / 3) * 3 + 1, d: 1 }, to: today };
    case 'this_year':
      return { from: { y: today.y, m: 1, d: 1 }, to: today };
    case 'last_year':
      return { from: { y: today.y - 1, m: 1, d: 1 }, to: { y: today.y - 1, m: 12, d: 31 } };
    case 'last_12_months':
      return { from: addMonths(firstOfMonth, -11), to: today };
    case 'all_time':
      return { from: ALL_TIME_START, to: today };
  }
}

export function resolveRange(range: ReportDateRange, now: number, timeZone: string): DayRange {
  if (range.from !== undefined && range.to !== undefined) {
    const from = parseDate(range.from);
    const to = parseDate(range.to);
    if (compareDates(from, to) > 0) throw new RangeError('date_range.from is after date_range.to');
    return { from, to };
  }
  return resolvePreset(range.preset ?? 'last_12_months', localDate(now, timeZone));
}

export function compareRange(range: DayRange, mode: CompareMode): DayRange | null {
  if (mode === 'none') return null;
  if (mode === 'previous_year') {
    return { from: addMonths(range.from, -12), to: addMonths(range.to, -12) };
  }
  const length = daysBetween(range.from, range.to) + 1;
  return { from: addDays(range.from, -length), to: addDays(range.from, -1) };
}

export interface Buckets {
  /** Boundaries in epoch ms: bucket i is `[bounds[i], bounds[i + 1])`. */
  bounds: number[];
  /** Key of each bucket: `YYYY-MM-DD` (day/week start) or `YYYY-MM` (month). */
  keys: string[];
}

/** Epoch-ms half-open interval of a day range. */
export function rangeMs(range: DayRange, timeZone: string): { from: number; to: number } {
  return {
    from: startOfLocalDay(range.from, timeZone),
    to: startOfLocalDay(addDays(range.to, 1), timeZone),
  };
}

/** Buckets covering the range; weeks start on Monday, the first and last may be partial. */
export function buildBuckets(range: DayRange, granularity: Granularity, timeZone: string): Buckets {
  const starts: CivilDate[] = [range.from];
  const end = addDays(range.to, 1);
  let cursor = range.from;
  for (;;) {
    let next: CivilDate;
    if (granularity === 'day') next = addDays(cursor, 1);
    else if (granularity === 'week') {
      const weekday = (new Date(Date.UTC(cursor.y, cursor.m - 1, cursor.d)).getUTCDay() + 6) % 7;
      next = addDays(cursor, 7 - weekday);
    } else next = { y: cursor.m === 12 ? cursor.y + 1 : cursor.y, m: (cursor.m % 12) + 1, d: 1 };
    if (compareDates(next, end) >= 0) break;
    starts.push(next);
    if (starts.length > MAX_BUCKETS) {
      throw new RangeError(
        `more than ${String(MAX_BUCKETS)} ${granularity} buckets: shorten the range or use a coarser granularity`,
      );
    }
    cursor = next;
  }
  const bounds = [...starts, end].map((d) => startOfLocalDay(d, timeZone));
  const keys = starts.map((d) =>
    granularity === 'month' ? formatDate(d).slice(0, 7) : formatDate(d),
  );
  return { bounds, keys };
}
