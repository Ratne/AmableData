/** Pure date helpers for the month / week calendar (local time, Monday-first). */

export type CalendarView = 'month' | 'week';

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** Monday of the week containing `date`. */
export function startOfWeek(date: Date): Date {
  const day = (date.getDay() + 6) % 7;
  return addDays(startOfDay(date), -day);
}

/** Visible days: 6 full weeks around the month, or the 7 days of the week. */
export function visibleRange(
  anchor: Date,
  view: CalendarView,
): { from: Date; to: Date; days: Date[] } {
  const from =
    view === 'month'
      ? startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1))
      : startOfWeek(anchor);
  const count = view === 'month' ? 42 : 7;
  const days = Array.from({ length: count }, (_, i) => addDays(from, i));
  return { from, to: addDays(from, count), days };
}

export function shiftAnchor(anchor: Date, view: CalendarView, step: -1 | 1): Date {
  return view === 'month'
    ? new Date(anchor.getFullYear(), anchor.getMonth() + step, 1)
    : addDays(anchor, 7 * step);
}

export function dayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Groups entries by local day; multi-day entries appear on every day they cover. */
export function bucketByDay<T>(
  items: readonly T[],
  range: { from: Date; to: Date },
  span: (item: T) => { start: number; end: number },
): Map<string, T[]> {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const { start, end } = span(item);
    let day = startOfDay(new Date(Math.max(start, range.from.getTime())));
    const last = Math.min(Math.max(end - 1, start), range.to.getTime() - 1);
    while (day.getTime() <= last) {
      const key = dayKey(day);
      buckets.set(key, [...(buckets.get(key) ?? []), item]);
      day = addDays(day, 1);
    }
  }
  return buckets;
}
