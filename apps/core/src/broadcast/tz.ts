import type { BroadcastSchedule, ScheduleBucket } from '@amable/api-types';

/** Timezone math for broadcast scheduling (Intl only, no tz database shipped). */

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

export function isTimeZone(value: string): boolean {
  try {
    formatter(value);
    return true;
  } catch {
    return false;
  }
}

/** Offset (ms) of `timeZone` from UTC at instant `ms`. */
export function timeZoneOffset(ms: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(
    parts['year'] ?? 1970,
    (parts['month'] ?? 1) - 1,
    parts['day'] ?? 1,
    parts['hour'] ?? 0,
    parts['minute'] ?? 0,
    parts['second'] ?? 0,
  );
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** UTC instant of wall-clock `date` (YYYY-MM-DD) `time` (HH:MM) in `timeZone`. */
export function zonedLocalToUtc(date: string, time: string, timeZone: string): number {
  const [y = 1970, mo = 1, d = 1] = date.split('-').map(Number);
  const [h = 0, mi = 0] = time.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - timeZoneOffset(guess, timeZone);
  const second = guess - timeZoneOffset(first, timeZone);
  return second;
}

export interface ScheduledRecipient {
  readonly contactId: string;
  readonly timeZone: string;
  readonly sendAt: number;
}

/**
 * Send time of every recipient. `contact_tz` uses the contact's timezone, or
 * the tenant's when missing/invalid; a local time already in the past sends
 * immediately (never a day late).
 */
export function scheduleRecipients(
  recipients: readonly { id: string; time_zone: string | null }[],
  schedule: BroadcastSchedule,
  tenantTimeZone: string,
  now: number,
): ScheduledRecipient[] {
  if (schedule.mode === 'now') {
    return recipients.map((r) => ({ contactId: r.id, timeZone: 'UTC', sendAt: now }));
  }
  if (schedule.mode === 'at') {
    const at = Math.max(Date.parse(schedule.at), now);
    return recipients.map((r) => ({ contactId: r.id, timeZone: 'UTC', sendAt: at }));
  }
  const byZone = new Map<string, number>();
  return recipients.map((r) => {
    const zone = r.time_zone !== null && r.time_zone !== '' && isTimeZone(r.time_zone) ? r.time_zone : tenantTimeZone;
    let at = byZone.get(zone);
    if (at === undefined) {
      at = Math.max(zonedLocalToUtc(schedule.local_date, schedule.local_time, zone), now);
      byZone.set(zone, at);
    }
    return { contactId: r.id, timeZone: zone, sendAt: at };
  });
}

/** Recipients grouped by (timezone, send time), earliest first. */
export function bucketize(scheduled: readonly ScheduledRecipient[]): ScheduleBucket[] {
  const buckets = new Map<string, { time_zone: string; send_at: number; count: number }>();
  for (const r of scheduled) {
    const key = `${r.timeZone}|${String(r.sendAt)}`;
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, { time_zone: r.timeZone, send_at: r.sendAt, count: 1 });
    else bucket.count += 1;
  }
  return [...buckets.values()]
    .sort((a, b) => a.send_at - b.send_at || a.time_zone.localeCompare(b.time_zone))
    .map((b) => ({ time_zone: b.time_zone, send_at: new Date(b.send_at).toISOString(), count: b.count }));
}
