/** Time-zone helpers built on Intl (no dependency). All instants are epoch ms. */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

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

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function localParts(ts: number, timeZone: string): LocalParts {
  const out: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ts))) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return {
    year: out['year'] ?? 1970,
    month: out['month'] ?? 1,
    day: out['day'] ?? 1,
    hour: (out['hour'] ?? 0) % 24,
    minute: out['minute'] ?? 0,
    second: out['second'] ?? 0,
  };
}

/** Offset (local - UTC) of `timeZone` at instant `ts`, in ms. */
export function tzOffset(ts: number, timeZone: string): number {
  const p = localParts(ts, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** UTC instant of a local wall-clock time (DST-safe for the usual 1 h shifts). */
export function zonedTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  timeZone: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour);
  let ts = guess - tzOffset(guess, timeZone);
  ts = guess - tzOffset(ts, timeZone);
  return ts;
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local calendar day (YYYY-MM-DD) of an instant. */
export function dayKey(ts: number, timeZone: string): string {
  const p = localParts(ts, timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** Start (UTC ms) of a local calendar day. */
export function dayStart(key: string, timeZone: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return zonedTime(y ?? 1970, m ?? 1, d ?? 1, 0, timeZone);
}

/** Next calendar day key. */
export function nextDay(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + 1)).toISOString().slice(0, 10);
}

export type Interval = 'hour' | 'day' | 'week' | 'month';

export interface Bucket {
  start: number;
  end: number;
  /** Local label: `YYYY-MM-DD HH:00` for hours, `YYYY-MM-DD` otherwise. */
  label: string;
}

/** Buckets covering [from, to) in `timeZone`; weeks start on Monday. */
export function buckets(
  from: number,
  to: number,
  interval: Interval,
  timeZone: string,
  max = 2000,
): Bucket[] {
  const out: Bucket[] = [];
  if (interval === 'hour') {
    let start = Math.floor(from / HOUR_MS) * HOUR_MS;
    while (start < to && out.length < max) {
      const p = localParts(start, timeZone);
      out.push({
        start,
        end: start + HOUR_MS,
        label: `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}`,
      });
      start += HOUR_MS;
    }
    return out;
  }
  let key = dayKey(from, timeZone);
  if (interval === 'week') {
    const [y, m, d] = key.split('-').map(Number);
    const dow = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay();
    const back = (dow + 6) % 7;
    key = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) - back)).toISOString().slice(0, 10);
  } else if (interval === 'month') {
    key = `${key.slice(0, 7)}-01`;
  }
  let start = dayStart(key, timeZone);
  while (start < to && out.length < max) {
    let nextKey: string;
    if (interval === 'day') nextKey = nextDay(key);
    else if (interval === 'week') {
      nextKey = key;
      for (let i = 0; i < 7; i++) nextKey = nextDay(nextKey);
    } else {
      const [y, m] = key.split('-').map(Number);
      nextKey = new Date(Date.UTC(y ?? 1970, m ?? 1, 1)).toISOString().slice(0, 10);
    }
    const end = dayStart(nextKey, timeZone);
    out.push({ start, end, label: key });
    key = nextKey;
    start = end;
  }
  return out;
}
