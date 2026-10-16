import type { AnalyticsInterval } from '@amable/api-types';

export const RANGE_PRESETS = [
  'today',
  'yesterday',
  '7d',
  '30d',
  '90d',
  'month',
  '12m',
  'custom',
] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
export const DEFAULT_PRESET: RangePreset = '30d';

export function isRangePreset(value: unknown): value is RangePreset {
  return typeof value === 'string' && (RANGE_PRESETS as readonly string[]).includes(value);
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
export function isYmd(value: unknown): value is string {
  return typeof value === 'string' && YMD.test(value);
}

/** Local calendar day (YYYY-MM-DD) of `date` in `timeZone`. */
export function todayIn(timeZone: string | undefined, date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export function addDays(ymd: string, days: number): string {
  const date = new Date(`${ymd}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000,
  );
}

export interface DayRange {
  readonly from: string;
  readonly to: string;
}

export function resolveRange(
  preset: RangePreset,
  timeZone: string | undefined,
  custom?: Partial<DayRange>,
): DayRange {
  const today = todayIn(timeZone);
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const day = addDays(today, -1);
      return { from: day, to: day };
    }
    case '7d':
      return { from: addDays(today, -6), to: today };
    case '30d':
      return { from: addDays(today, -29), to: today };
    case '90d':
      return { from: addDays(today, -89), to: today };
    case 'month':
      return { from: `${today.slice(0, 8)}01`, to: today };
    case '12m': {
      const start = new Date(`${today.slice(0, 8)}01T00:00:00Z`);
      start.setUTCMonth(start.getUTCMonth() - 11);
      return { from: start.toISOString().slice(0, 10), to: today };
    }
    case 'custom': {
      const from = isYmd(custom?.from) ? custom.from : addDays(today, -29);
      const to = isYmd(custom?.to) ? custom.to : today;
      return from <= to ? { from, to } : { from: to, to: from };
    }
  }
}

/** Period of the same length right before `range` (comparison of the KPIs). */
export function previousRange(range: DayRange): DayRange {
  const days = daysBetween(range.from, range.to) + 1;
  return { from: addDays(range.from, -days), to: addDays(range.from, -1) };
}

/** Relative change from `previous` to `current`; null when there is nothing to compare. */
export function relativeChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}

/** Sensible bucket size for a range; the user may override it. */
export function defaultInterval(range: DayRange): AnalyticsInterval {
  const days = daysBetween(range.from, range.to) + 1;
  if (days <= 2) return 'hour';
  if (days <= 120) return 'day';
  if (days <= 400) return 'week';
  return 'month';
}

/** Intervals that make sense for the range (no 2 000 hourly buckets). */
export function allowedIntervals(range: DayRange): AnalyticsInterval[] {
  const days = daysBetween(range.from, range.to) + 1;
  const out: AnalyticsInterval[] = [];
  if (days <= 14) out.push('hour');
  out.push('day');
  if (days >= 14) out.push('week');
  if (days >= 60) out.push('month');
  return out;
}
