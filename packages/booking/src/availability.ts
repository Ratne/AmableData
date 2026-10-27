import {
  addDays,
  compareDates,
  dateKey,
  DAY_MS,
  localDateOf,
  MINUTE_MS,
  parseHm,
  weekdayOf,
  zonedToUtc,
  type LocalDate,
} from './tz';
import type {
  Assignment,
  AvailableSlot,
  EventTypeRules,
  HostSchedule,
  Interval,
  SlotRejection,
} from './types';

/**
 * Availability engine: proposed start times of an event type for a set of
 * host calendars. Pure and synchronous — the TenantDb runs it inside the
 * booking transaction (re-check before insert) and the admin preview uses it
 * as-is. Every host's working windows are computed in its own IANA time zone
 * for each local date, so DST days get their real length.
 *
 * A start `t` is offered for a host when:
 * - `[t, t + duration)` lies inside one working window of the host's local
 *   date of `t` (date overrides replace the weekly rules of that date);
 * - `t` is on the grid of that window (window start + k × interval);
 * - `[t - buffer before, t + duration + buffer after)` overlaps no busy interval;
 * - the host has fewer than `maxPerDay` bookings of this event type that day;
 * and globally `now + min notice ≤ t ≤ now + max days ahead`.
 */

export interface AvailabilityInput {
  readonly now: number;
  readonly rules: EventTypeRules;
  readonly assignment: Assignment;
  readonly hosts: readonly HostSchedule[];
}

export interface AvailabilityRange extends AvailabilityInput {
  /** Earliest / latest start considered (epoch ms, inclusive). */
  readonly from: number;
  readonly to: number;
}

/** Hard cap of a single computation (the public API asks for ≤ 62 days). */
export const MAX_RANGE_DAYS = 93;

function step(rules: EventTypeRules): number {
  const interval = rules.slotIntervalMinutes ?? rules.durationMinutes;
  return Math.max(5, interval) * MINUTE_MS;
}

/** Working windows of a host for one local date, as instants. */
export function windowsForDate(host: HostSchedule, date: LocalDate): Interval[] {
  const key = dateKey(date);
  const override = host.overrides.find((o) => o.date === key);
  const ranges = override !== undefined ? override.intervals : host.weeklyRules.filter((r) => r.weekday === weekdayOf(date));
  const windows: Interval[] = [];
  for (const range of ranges) {
    const start = parseHm(range.start);
    const end = parseHm(range.end);
    if (start === null || end === null || end <= start) continue;
    windows.push({ start: zonedToUtc(date, start, host.timeZone), end: zonedToUtc(date, end, host.timeZone) });
  }
  return windows.sort((a, b) => a.start - b.start);
}

function overlaps(busy: readonly Interval[], start: number, end: number): boolean {
  return busy.some((b) => b.start < end && b.end > start);
}

function bookedOnDay(host: HostSchedule, date: LocalDate): number {
  let count = 0;
  for (const start of host.bookedStarts) {
    if (compareDates(localDateOf(start, host.timeZone), date) === 0) count += 1;
  }
  return count;
}

type HostCheck = { ok: true } | { ok: false; reason: 'out_of_schedule' | 'daily_limit' | 'slot_taken' };

/** Grid membership, busy time and daily cap of one host for a start (notice / horizon checked by callers). */
function checkHost(host: HostSchedule, rules: EventTypeRules, start: number): HostCheck {
  const duration = rules.durationMinutes * MINUTE_MS;
  const date = localDateOf(start, host.timeZone);
  const grid = step(rules);
  const onGrid = windowsForDate(host, date).some(
    (w) => start >= w.start && start + duration <= w.end && (start - w.start) % grid === 0,
  );
  if (!onGrid) return { ok: false, reason: 'out_of_schedule' };
  if (rules.maxPerDay !== null && bookedOnDay(host, date) >= rules.maxPerDay) {
    return { ok: false, reason: 'daily_limit' };
  }
  const from = start - rules.bufferBeforeMinutes * MINUTE_MS;
  const to = start + duration + rules.bufferAfterMinutes * MINUTE_MS;
  if (overlaps(host.busy, from, to)) return { ok: false, reason: 'slot_taken' };
  return { ok: true };
}

function bounds(input: AvailabilityInput): { earliest: number; latest: number } {
  return {
    earliest: input.now + input.rules.minNoticeMinutes * MINUTE_MS,
    latest: input.now + input.rules.maxDaysAhead * DAY_MS,
  };
}

function freeHosts(input: AvailabilityInput, start: number): { free: string[]; reasons: SlotRejection[] } {
  const free: string[] = [];
  const reasons: SlotRejection[] = [];
  for (const host of input.hosts) {
    const check = checkHost(host, input.rules, start);
    if (check.ok) free.push(host.calendarId);
    else reasons.push(check.reason);
  }
  return { free, reasons };
}

function accepted(input: AvailabilityInput, free: readonly string[]): boolean {
  if (free.length === 0) return false;
  return input.assignment === 'round_robin' || free.length === input.hosts.length;
}

/** Candidate starts of every host's windows between two instants (deduplicated, sorted). */
function candidates(input: AvailabilityRange, earliest: number, latest: number): number[] {
  const duration = input.rules.durationMinutes * MINUTE_MS;
  const grid = step(input.rules);
  const starts = new Set<number>();
  for (const host of input.hosts) {
    const last = localDateOf(latest, host.timeZone);
    let date = addDays(localDateOf(earliest, host.timeZone), -1);
    for (let guard = 0; guard <= MAX_RANGE_DAYS + 2 && compareDates(date, last) <= 0; guard += 1) {
      for (const window of windowsForDate(host, date)) {
        for (let t = window.start; t + duration <= window.end; t += grid) {
          if (t >= earliest && t <= latest) starts.add(t);
        }
      }
      date = addDays(date, 1);
    }
  }
  return [...starts].sort((a, b) => a - b);
}

/** Bookable slots with a start in `[from, to]`. */
export function computeSlots(input: AvailabilityRange): AvailableSlot[] {
  if (input.hosts.length === 0) return [];
  const limits = bounds(input);
  const earliest = Math.max(input.from, limits.earliest);
  const latest = Math.min(input.to, limits.latest, earliest + MAX_RANGE_DAYS * DAY_MS);
  if (earliest > latest) return [];
  const duration = input.rules.durationMinutes * MINUTE_MS;
  const slots: AvailableSlot[] = [];
  for (const start of candidates(input, earliest, latest)) {
    const { free } = freeHosts(input, start);
    if (accepted(input, free)) slots.push({ start, end: start + duration, calendarIds: free });
  }
  return slots;
}

export type SlotCheck =
  | { ok: true; start: number; end: number; calendarIds: string[] }
  | { ok: false; reason: SlotRejection };

const REASON_PRIORITY: readonly SlotRejection[] = ['slot_taken', 'daily_limit', 'out_of_schedule'];

/**
 * Re-check of one start right before booking it. For round robin the result
 * lists every free host (pick one with `pickRoundRobinHost`); collective
 * lists all hosts.
 */
export function checkSlot(input: AvailabilityInput, start: number): SlotCheck {
  if (input.hosts.length === 0) return { ok: false, reason: 'no_hosts' };
  const limits = bounds(input);
  if (start < limits.earliest) return { ok: false, reason: 'too_soon' };
  if (start > limits.latest) return { ok: false, reason: 'too_far' };
  const { free, reasons } = freeHosts(input, start);
  if (accepted(input, free)) {
    return { ok: true, start, end: start + input.rules.durationMinutes * MINUTE_MS, calendarIds: free };
  }
  const reason = REASON_PRIORITY.find((r) => reasons.includes(r)) ?? 'slot_taken';
  return { ok: false, reason };
}

/**
 * Free host furthest below its share: deficit `share × (total + 1) − count`
 * over every host's recent bookings, so assignments converge to the shares
 * (even shares: the least loaded host). A 0% host only gets a booking when no
 * weighted host is free. Ties: assigned least recently, then the id.
 */
export function pickRoundRobinHost(hosts: readonly HostSchedule[], freeIds: readonly string[]): string | null {
  const even = hosts.length === 0 ? 0 : 1 / hosts.length;
  const total = hosts.reduce((sum, h) => sum + (h.load?.count ?? 0), 0);
  const ranked = hosts
    .filter((h) => freeIds.includes(h.calendarId))
    .map((h) => {
      const share = h.share ?? even;
      const count = h.load?.count ?? 0;
      return { host: h, weighted: share > 0, deficit: share * (total + 1) - count, last: h.load?.lastAssignedAt ?? 0 };
    });
  ranked.sort((a, b) => {
    if (a.weighted !== b.weighted) return a.weighted ? -1 : 1;
    if (Math.abs(a.deficit - b.deficit) > 1e-9) return b.deficit - a.deficit;
    if (a.last !== b.last) return a.last - b.last;
    return a.host.calendarId < b.host.calendarId ? -1 : a.host.calendarId > b.host.calendarId ? 1 : 0;
  });
  return ranked[0]?.host.calendarId ?? null;
}

/** Slots grouped by local date in the viewer's time zone (keys `YYYY-MM-DD`, ascending). */
export function groupSlotsByDay<T extends { start: number }>(
  slots: readonly T[],
  timeZone: string,
): Array<{ date: string; slots: T[] }> {
  const days = new Map<string, T[]>();
  for (const slot of [...slots].sort((a, b) => a.start - b.start)) {
    const key = dateKey(localDateOf(slot.start, timeZone));
    const list = days.get(key);
    if (list === undefined) days.set(key, [slot]);
    else list.push(slot);
  }
  return [...days.entries()].map(([date, list]) => ({ date, slots: list }));
}
