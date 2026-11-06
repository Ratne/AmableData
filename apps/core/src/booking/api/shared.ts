import type { BookingSyncResult } from '@amable/api-types';
import { DAY_MS } from '@amable/booking';
import type { Context } from 'hono';
import { callCrm } from '../../crm/api/core';
import { invalid } from '../../crm/errors';
import { toIso } from '../../crm/util';
import { getTenant, type AppEnv } from '../../middleware';
import type { BookingOutcome } from '../bookings';
import { BOOKING_MAX_AGE_MS, type SyncResult } from '../calendar-core';
import type { CalendarRef } from '../calendars';
import { afterChange, calendarStub, doRef, externalBusy } from '../flow';
import { bookingRuntime } from '../runtime';

export type Ctx = Context<AppEnv>;

export const calendarsTag = ['Booking calendars'];

export const eventTypesTag = ['Booking event types'];

export const bookingsTag = ['Bookings'];

export const MAX_PREVIEW_DAYS = 62;

export function tenantId(c: Ctx): string {
  return getTenant(c).tenant.id;
}

export async function assertMember(c: Ctx, userId: string): Promise<void> {
  const row = await c.env.DB.prepare(
    `SELECT 1 AS ok FROM memberships WHERE user_id = ? AND tenant_id = ?`,
  )
    .bind(userId, tenantId(c))
    .first<{ ok: number }>();
  if (row === null) throw invalid('host_user_id', 'the host must be a member of this workspace');
}

export function syncToApi(result: SyncResult): BookingSyncResult {
  return {
    status: result.status,
    busy_count: result.busyCount,
    synced_at: result.syncedAt === null ? null : toIso(result.syncedAt),
    message: result.message,
    write_error: result.writeError ?? null,
    needs_reconnect: result.needsReconnect ?? false,
  };
}

export const UNAVAILABLE_SYNC: BookingSyncResult = {
  status: 'unavailable',
  busy_count: 0,
  synced_at: null,
  message: 'calendar service unavailable',
  write_error: null,
  needs_reconnect: false,
};

export async function syncCalendar(c: Ctx, calendarId: string): Promise<BookingSyncResult> {
  const ref = await callCrm(c, 'booking.calendarForWorker', { id: calendarId });
  const stub = calendarStub(c.env, tenantId(c), calendarId);
  if (stub === null) return UNAVAILABLE_SYNC;
  return syncToApi((await stub.sync(doRef(tenantId(c), ref))) as SyncResult);
}

/** Worker-side steps after a booking op (emails, reminders, live version bumps). */
export async function finishChange(
  c: Ctx,
  outcome: BookingOutcome,
  token: string | null,
  notify: boolean,
): Promise<void> {
  const runtime = await bookingRuntime(c.env);
  await afterChange(c.env, {
    tenantId: tenantId(c),
    tenantSlug: getTenant(c).tenant.slug,
    outcome,
    token,
    notify,
    now: runtime.now(),
  });
}

/** Busy time of every host the booking could land on (booking hosts + event type hosts). */
export async function busyFor(
  c: Ctx,
  eventTypeId: string,
  extra: readonly CalendarRef[],
  start: number,
  durationMinutes: number,
) {
  const context = await callCrm(c, 'booking.eventTypeContext', { id: eventTypeId });
  const calendars = [
    ...extra,
    ...context.calendars.filter((h) => !extra.some((e) => e.calendarId === h.calendarId)),
  ];
  return externalBusy(
    c.env,
    tenantId(c),
    calendars,
    start - DAY_MS,
    start + durationMinutes * 60_000 + DAY_MS,
    BOOKING_MAX_AGE_MS,
  );
}

export function startOf(value: string, path: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw invalid(path, 'expected an ISO 8601 date-time');
  return ms;
}
