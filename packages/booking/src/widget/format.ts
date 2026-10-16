import { addDays, dateKey, localDateOf, parseDateKey, weekdayOf, type LocalDate } from '../tz';

/** Date helpers of the widget: everything is rendered in the viewer's chosen time zone. */

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function timeZones(current: string): string[] {
  let list: string[] = [];
  try {
    list = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    list = [];
  }
  if (list.length === 0) list = ['UTC', 'Europe/Rome', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo'];
  return list.includes(current) ? list : [current, ...list];
}

export function todayIn(timeZone: string): LocalDate {
  return localDateOf(Date.now(), timeZone);
}

export function monthStart(date: LocalDate): LocalDate {
  return { y: date.y, m: date.m, d: 1 };
}

export function addMonths(date: LocalDate, months: number): LocalDate {
  const index = date.y * 12 + (date.m - 1) + months;
  return { y: Math.floor(index / 12), m: (index % 12) + 1, d: 1 };
}

export function daysInMonth(date: LocalDate): number {
  return new Date(Date.UTC(date.y, date.m, 0)).getUTCDate();
}

/** Cells of a month grid starting on Monday (null = padding). */
export function monthCells(month: LocalDate): Array<LocalDate | null> {
  const first = monthStart(month);
  const lead = (weekdayOf(first) + 6) % 7;
  const cells: Array<LocalDate | null> = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= daysInMonth(first); d += 1) cells.push({ y: first.y, m: first.m, d });
  return cells;
}

export function lastDayOfMonth(month: LocalDate): LocalDate {
  return addDays(addMonths(month, 1), -1);
}

export function formatMonth(month: LocalDate, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    Date.UTC(month.y, month.m - 1, 15),
  );
}

export function formatDay(key: string, locale: string): string {
  const date = parseDateKey(key);
  if (date === null) return key;
  return new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(
    Date.UTC(date.y, date.m - 1, date.d, 12),
  );
}

export function formatTime(ms: number, timeZone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', timeZone }).format(ms);
}

export function formatFull(ms: number, timeZone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(ms);
}

export { dateKey };
