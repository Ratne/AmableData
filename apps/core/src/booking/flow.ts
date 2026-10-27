import { randomToken } from '@amable/auth';
import type { Interval } from '@amable/booking';
import type { Env } from '../env';
import type { BookingOutcome, ExternalBusy } from './bookings';
import type { CalendarDoRef, CalendarEventData, ReminderJob } from './calendar-core';
import type { CalendarRef } from './calendars';
import { emailRequest, type BookingMessageVars, type MessageKind } from './messages';

/**
 * Worker-side steps around the booking ops: external busy time from the
 * calendar DOs before, emails / reminders / live version bumps after. A
 * missing `BOOKING_CALENDAR` binding degrades to "no external busy, no
 * reminders" (the booking itself never depends on it).
 */

export function edgeOrigin(env: Env): string {
  return (env.EDGE_ORIGIN ?? 'http://localhost:8788').replace(/\/+$/, '');
}

export function manageUrl(env: Env, tenantSlug: string, token: string): string {
  return `${edgeOrigin(env)}/b/${tenantSlug}/manage/${token}`;
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Random manage-link token; only its hash is stored. */
export async function newManageToken(): Promise<{ token: string; hash: string }> {
  const token = randomToken(24);
  return { token, hash: await hashToken(token) };
}

export function calendarStub(env: Env, tenantId: string, calendarId: string) {
  const ns = env.BOOKING_CALENDAR;
  if (ns === undefined) return null;
  return ns.get(ns.idFromName(`${tenantId}:${calendarId}`));
}

export function doRef(tenantId: string, ref: CalendarRef): CalendarDoRef {
  return {
    tenantId,
    calendarId: ref.calendarId,
    hostUserId: ref.hostUserId,
    googleAccountId: ref.googleAccountId,
    googleCalendarId: ref.googleCalendarId,
  };
}

/**
 * External busy time of every host calendar, each at most `maxAgeMs` old:
 * `SLOTS_MAX_AGE_MS` for slot lists, `BOOKING_MAX_AGE_MS` before confirming a booking.
 */
export async function externalBusy(
  env: Env,
  tenantId: string,
  calendars: readonly CalendarRef[],
  from: number,
  to: number,
  maxAgeMs: number,
): Promise<ExternalBusy> {
  const out: ExternalBusy = {};
  await Promise.all(
    calendars.map(async (calendar) => {
      const stub = calendarStub(env, tenantId, calendar.calendarId);
      if (stub === null) return;
      try {
        const result = (await stub.busy(doRef(tenantId, calendar), from, to, maxAgeMs)) as { intervals: Interval[] };
        out[calendar.calendarId] = result.intervals;
      } catch (error) {
        console.error('[booking] external busy unavailable', calendar.calendarId, error);
      }
    }),
  );
  return out;
}

/** Availability version of an event type (its first host calendar's DO). */
export async function versionOf(env: Env, tenantId: string, calendarId: string | undefined): Promise<number> {
  if (calendarId === undefined) return 0;
  const stub = calendarStub(env, tenantId, calendarId);
  if (stub === null) return 0;
  try {
    return await stub.version();
  } catch {
    return 0;
  }
}

/** Bumps the live version of calendars whose availability rules changed. */
export async function touchCalendars(env: Env, tenantId: string, calendarIds: readonly string[]): Promise<void> {
  await Promise.all(
    calendarIds.map(async (id) => {
      try {
        await calendarStub(env, tenantId, id)?.touch();
      } catch (error) {
        console.error('[booking] calendar touch failed', id, error);
      }
    }),
  );
}

export async function hostNames(env: Env, userIds: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return names;
  const rows = await env.DB.prepare(
    `SELECT id, name, email FROM users WHERE id IN (${unique.map(() => '?').join(', ')})`,
  )
    .bind(...unique)
    .all<{ id: string; name: string | null; email: string }>();
  for (const row of rows.results) names.set(row.id, row.name !== null && row.name.trim() !== '' ? row.name : row.email);
  return names;
}

const KIND_OF: Record<BookingOutcome['kind'], MessageKind> = {
  booked: 'confirmation',
  rescheduled: 'rescheduled',
  cancelled: 'cancelled',
};

/** Confirmation / change email + the reminder jobs of a booking (empty after a cancellation). */
export function messagesFor(input: {
  tenantId: string;
  outcome: BookingOutcome;
  manageUrl: string;
  hostName: string;
  now: number;
}): { email: ReturnType<typeof emailRequest> | null; reminders: ReminderJob[] } {
  const { booking, eventType } = input.outcome;
  if (booking.contact_id === null || booking.host_user_id === null) return { email: null, reminders: [] };
  const startsAt = Date.parse(booking.starts_at);
  const vars: BookingMessageVars = {
    eventTitle: eventType.title,
    startsAt,
    endsAt: Date.parse(booking.ends_at),
    timeZone: booking.time_zone,
    locale: booking.locale === 'it' ? 'it' : 'en',
    hostName: input.hostName,
    location: eventType.location,
    manageUrl: input.manageUrl,
    inviteeName: booking.invitee_name,
    allowReschedule: eventType.allow_reschedule,
    allowCancel: eventType.allow_cancel,
  };
  const base = {
    tenantId: input.tenantId,
    contactId: booking.contact_id,
    bookingId: booking.id,
    hostUserId: booking.host_user_id,
    messages: eventType.messages,
    vars,
    now: input.now,
  };
  const kind = KIND_OF[input.outcome.kind];
  const email = emailRequest({ ...base, id: `booking:${booking.id}:${kind}:${String(booking.reschedule_count)}`, kind, notAfter: null });
  const endsAt = Date.parse(booking.ends_at);
  const reminders =
    booking.status === 'cancelled'
      ? []
      : eventType.notifications
          .map((n) => ({ ...n, fireAt: n.when === 'before' ? startsAt - n.offset_minutes * 60_000 : endsAt + n.offset_minutes * 60_000 }))
          .filter((n) => n.fireAt > input.now)
          .map((n) => {
            const kind = n.when === 'before' ? 'reminder' : 'followup';
            const id = `booking:${booking.id}:${kind}:${String(n.offset_minutes)}:${String(booking.reschedule_count)}`;
            return {
              id,
              fireAt: n.fireAt,
              request: emailRequest({
                ...base,
                id,
                kind,
                text: { subject: n.subject, body: n.body },
                notAfter: n.when === 'before' ? booking.starts_at : null,
              }),
            };
          });
  return { email, reminders };
}

/** Google Calendar event of a booking, as the host sees it. */
export function calendarEventFor(outcome: BookingOutcome): CalendarEventData {
  const { booking, eventType } = outcome;
  const answers = Object.entries(booking.answers).map(
    ([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`,
  );
  return {
    summary: `${eventType.title} · ${booking.invitee_name}`,
    description: [`${booking.invitee_name} <${booking.invitee_email}>`, ...answers].join('\n'),
    location: eventType.location,
    start: Date.parse(booking.starts_at),
    end: Date.parse(booking.ends_at),
    timeZone: booking.time_zone,
    attendee: { email: booking.invitee_email, name: booking.invitee_name },
  };
}

/**
 * After a booking op: confirmation/change email on `EMAIL_SEND`, reminders
 * and the Google event on the primary host's calendar DO (removed from the
 * others) and a live version bump on every affected calendar.
 */
export async function afterChange(
  env: Env,
  input: {
    tenantId: string;
    tenantSlug: string;
    outcome: BookingOutcome;
    /** Plain manage token when known (new booking, staff reschedule); else reminders keep no link. */
    token: string | null;
    notify: boolean;
    now: number;
  },
): Promise<void> {
  const { outcome } = input;
  if (!outcome.changed) return;
  const names = await hostNames(env, outcome.booking.host_user_id === null ? [] : [outcome.booking.host_user_id]);
  const link = input.token === null ? '' : manageUrl(env, input.tenantSlug, input.token);
  const { email, reminders } = messagesFor({
    tenantId: input.tenantId,
    outcome,
    manageUrl: link,
    hostName: names.get(outcome.booking.host_user_id ?? '') ?? '',
    now: input.now,
  });
  if (input.notify && email !== null) {
    try {
      await env.EMAIL_SEND.send(email);
    } catch (error) {
      console.error('[booking] email enqueue failed', outcome.booking.id, error);
    }
  }
  const primary = outcome.booking.calendar_id;
  const keep = input.notify && (outcome.kind === 'booked' || input.token !== null) ? reminders : [];
  const primaryRef = outcome.calendars.find((c) => c.calendarId === primary) ?? null;
  const event = outcome.booking.status === 'cancelled' ? null : calendarEventFor(outcome);
  await Promise.all(
    outcome.notifyCalendarIds.map(async (calendarId) => {
      const stub = calendarStub(env, input.tenantId, calendarId);
      if (stub === null) return;
      const own = calendarId === primary && primaryRef !== null;
      try {
        await stub.bookingChanged(outcome.booking.id, calendarId === primary ? keep : [], {
          tenantId: input.tenantId,
          ref: own ? doRef(input.tenantId, primaryRef) : null,
          event: own ? event : null,
        });
      } catch (error) {
        console.error('[booking] calendar update failed', calendarId, error);
      }
    }),
  );
}
