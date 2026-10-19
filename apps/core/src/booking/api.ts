import { z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  bookingAvailabilityQuerySchema,
  bookingAvailabilityRulesSchema,
  bookingAvailabilitySchema,
  bookingCalendarParamSchema,
  bookingCalendarSchema,
  bookingEmbedSchema,
  bookingEventTypeParamSchema,
  bookingEventTypeSchema,
  bookingGoogleConnectSchema,
  bookingGoogleFinishSchema,
  bookingParamSchema,
  bookingSchema,
  bookingSyncResultSchema,
  cancelBookingSchema,
  createBookingCalendarSchema,
  createBookingEventTypeSchema,
  createBookingSchema,
  deletedResponseSchema,
  listBookingEventTypesQuerySchema,
  listBookingsQuerySchema,
  pageOf,
  putBookingAvailabilitySchema,
  rescheduleBookingSchema,
  updateBookingCalendarSchema,
  updateBookingEventTypeSchema,
  type BookingSyncResult,
} from '@amable/api-types';
import { addDays, DAY_MS, parseDateKey, zonedToUtc } from '@amable/booking';
import { OAUTH_SCOPES } from '@amable/core';
import type { Context } from 'hono';
import { callCrm, crmRoute, json, jsonBody } from '../crm/api/core';
import { CrmError, invalid } from '../crm/errors';
import { toIso } from '../crm/util';
import { appOrigin, audit, getTenant, type AppEnv } from '../middleware';
import type { BookingOutcome } from './bookings';
import type { SyncResult } from './calendar-core';
import type { CalendarRef } from './calendars';
import {
  afterChange,
  calendarStub,
  doRef,
  edgeOrigin,
  externalBusy,
  newManageToken,
  touchCalendars,
} from './flow';
import { bookingRuntime } from './runtime';

type Ctx = Context<AppEnv>;

const calendarsTag = ['Booking calendars'];
const eventTypesTag = ['Booking event types'];
const bookingsTag = ['Bookings'];
const MAX_PREVIEW_DAYS = 62;

function tenantId(c: Ctx): string {
  return getTenant(c).tenant.id;
}

async function assertMember(c: Ctx, userId: string): Promise<void> {
  const row = await c.env.DB.prepare(`SELECT 1 AS ok FROM memberships WHERE user_id = ? AND tenant_id = ?`)
    .bind(userId, tenantId(c))
    .first<{ ok: number }>();
  if (row === null) throw invalid('host_user_id', 'the host must be a member of this workspace');
}

function syncToApi(result: SyncResult): BookingSyncResult {
  return {
    status: result.status,
    busy_count: result.busyCount,
    synced_at: result.syncedAt === null ? null : toIso(result.syncedAt),
    message: result.message,
    write_error: result.writeError ?? null,
    needs_reconnect: result.needsReconnect ?? false,
  };
}

const UNAVAILABLE_SYNC: BookingSyncResult = {
  status: 'unavailable',
  busy_count: 0,
  synced_at: null,
  message: 'calendar service unavailable',
  write_error: null,
  needs_reconnect: false,
};

async function syncCalendar(c: Ctx, calendarId: string): Promise<BookingSyncResult> {
  const ref = await callCrm(c, 'booking.calendarForWorker', { id: calendarId });
  const stub = calendarStub(c.env, tenantId(c), calendarId);
  if (stub === null) return UNAVAILABLE_SYNC;
  return syncToApi((await stub.sync(doRef(tenantId(c), ref))) as SyncResult);
}

/** Worker-side steps after a booking op (emails, reminders, live version bumps). */
export async function finishChange(c: Ctx, outcome: BookingOutcome, token: string | null, notify: boolean): Promise<void> {
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
async function busyFor(c: Ctx, eventTypeId: string, extra: readonly CalendarRef[], start: number, durationMinutes: number) {
  const context = await callCrm(c, 'booking.eventTypeContext', { id: eventTypeId });
  const calendars = [...extra, ...context.calendars.filter((h) => !extra.some((e) => e.calendarId === h.calendarId))];
  return externalBusy(c.env, tenantId(c), calendars, start - DAY_MS, start + durationMinutes * 60_000 + DAY_MS);
}

function startOf(value: string, path: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw invalid(path, 'expected an ISO 8601 date-time');
  return ms;
}

/** Calendars & bookings REST v2 routes (relative to `/api/v2/t/{slug}`). */
export function registerBookingRoutes(router: OpenAPIHono<AppEnv>): void {
  // ------------------------------------------------------------ calendars
  router.openapi(
    crmRoute('booking:read', {
      method: 'get',
      path: '/bookingCalendars',
      tags: calendarsTag,
      summary: 'List host calendars',
      request: { query: z.object({ host_user_id: z.string().max(64).optional() }) },
      responses: { 200: json(z.object({ data: z.array(bookingCalendarSchema) }), 'Calendars') },
    }),
    async (c) => {
      const host = c.req.valid('query').host_user_id;
      return c.json({ data: await callCrm(c, 'booking.listCalendars', host === undefined ? {} : { hostUserId: host }) }, 200);
    },
  );
  router.openapi(
    crmRoute('booking:write', {
      method: 'post',
      path: '/bookingCalendars',
      tags: calendarsTag,
      summary: 'Create a host calendar (default hours Monday-Friday 09:00-17:00)',
      request: { body: jsonBody(createBookingCalendarSchema) },
      responses: { 201: json(bookingCalendarSchema, 'The calendar') },
    }),
    async (c) => {
      const body = c.req.valid('json');
      await assertMember(c, body.host_user_id);
      const calendar = await callCrm(c, 'booking.createCalendar', body);
      await audit(c, 'booking.calendar_created', { target: calendar.id });
      return c.json(calendar, 201);
    },
  );
  router.openapi(
    crmRoute('booking:read', {
      method: 'get',
      path: '/bookingCalendars/{calendarId}',
      tags: calendarsTag,
      summary: 'Get a calendar',
      request: { params: bookingCalendarParamSchema },
      responses: { 200: json(bookingCalendarSchema, 'The calendar') },
    }),
    async (c) => c.json(await callCrm(c, 'booking.getCalendar', { id: c.req.valid('param').calendarId }), 200),
  );
  router.openapi(
    crmRoute('booking:write', {
      method: 'patch',
      path: '/bookingCalendars/{calendarId}',
      tags: calendarsTag,
      summary: 'Update name, host, time zone, hours or the Google calendar read for busy time',
      request: { params: bookingCalendarParamSchema, body: jsonBody(updateBookingCalendarSchema) },
      responses: { 200: json(bookingCalendarSchema, 'The calendar') },
    }),
    async (c) => {
      const { calendarId } = c.req.valid('param');
      const body = c.req.valid('json');
      if (body.host_user_id !== undefined) await assertMember(c, body.host_user_id);
      const calendar = await callCrm(c, 'booking.updateCalendar', { id: calendarId, data: body });
      await touchCalendars(c.env, tenantId(c), [calendarId]);
      await audit(c, 'booking.calendar_updated', { target: calendarId });
      return c.json(calendar, 200);
    },
  );
  router.openapi(
    crmRoute('booking:write', {
      method: 'delete',
      path: '/bookingCalendars/{calendarId}',
      tags: calendarsTag,
      summary: 'Delete a calendar (refused while an event type uses it)',
      request: { params: bookingCalendarParamSchema },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) => {
      const { calendarId } = c.req.valid('param');
      const result = await callCrm(c, 'booking.deleteCalendar', { id: calendarId });
      await audit(c, 'booking.calendar_deleted', { target: calendarId });
      return c.json(result, 200);
    },
  );
  router.openapi(
    crmRoute('booking:read', {
      method: 'get',
      path: '/bookingCalendars/{calendarId}/availability',
      tags: calendarsTag,
      summary: 'Weekly hours and date overrides of a calendar',
      request: { params: bookingCalendarParamSchema },
      responses: { 200: json(bookingAvailabilityRulesSchema, 'Availability rules') },
    }),
    async (c) => {
      const calendar = await callCrm(c, 'booking.getCalendar', { id: c.req.valid('param').calendarId });
      return c.json({ time_zone: calendar.time_zone, weekly_rules: calendar.weekly_rules, date_overrides: calendar.date_overrides }, 200);
    },
  );
  router.openapi(
    crmRoute('booking:write', {
      method: 'put',
      path: '/bookingCalendars/{calendarId}/availability',
      tags: calendarsTag,
      summary: 'Replace weekly hours and date overrides (open widgets refresh live)',
      request: { params: bookingCalendarParamSchema, body: jsonBody(putBookingAvailabilitySchema) },
      responses: { 200: json(bookingAvailabilityRulesSchema, 'Availability rules') },
    }),
    async (c) => {
      const { calendarId } = c.req.valid('param');
      const calendar = await callCrm(c, 'booking.updateCalendar', { id: calendarId, data: c.req.valid('json') });
      await touchCalendars(c.env, tenantId(c), [calendarId]);
      await audit(c, 'booking.availability_updated', { target: calendarId });
      return c.json({ time_zone: calendar.time_zone, weekly_rules: calendar.weekly_rules, date_overrides: calendar.date_overrides }, 200);
    },
  );
  router.openapi(
    crmRoute('booking:write', {
      method: 'post',
      path: '/bookingCalendars/{calendarId}/google/connect',
      tags: calendarsTag,
      summary: 'Start connecting a Google account (central OAuth app); the browser goes to authorize_url',
      request: { params: bookingCalendarParamSchema },
      responses: { 200: json(bookingGoogleConnectSchema, 'Authorization URL') },
    }),
    async (c) => {
      const { calendarId } = c.req.valid('param');
      await callCrm(c, 'booking.getCalendar', { id: calendarId });
      const runtime = await bookingRuntime(c.env);
      if (!runtime.oauth.available) throw new CrmError('conflict', 'connecting Google accounts is not available on this installation');
      const slug = getTenant(c).tenant.slug;
      const start = await runtime.oauth.startConnect({
        tenantId: tenantId(c),
        provider: 'google',
        scopes: [OAUTH_SCOPES.calendarRead, OAUTH_SCOPES.calendar],
        returnUrl: `${appOrigin(c)}/t/${slug}/bookings/calendars?calendar=${encodeURIComponent(calendarId)}`,
      });
      return c.json({ authorize_url: start.authorizeUrl, state: start.state }, 200);
    },
  );
  router.openapi(
    crmRoute('booking:write', {
      method: 'post',
      path: '/bookingCalendars/{calendarId}/google/finish',
      tags: calendarsTag,
      summary: 'Complete the Google connection with the state and code of the OAuth redirect',
      request: { params: bookingCalendarParamSchema, body: jsonBody(bookingGoogleFinishSchema) },
      responses: { 200: json(bookingCalendarSchema, 'The calendar') },
    }),
    async (c) => {
      const { calendarId } = c.req.valid('param');
      const body = c.req.valid('json');
      const runtime = await bookingRuntime(c.env);
      if (!runtime.oauth.available) throw new CrmError('conflict', 'connecting Google accounts is not available on this installation');
      let finished: Awaited<ReturnType<typeof runtime.oauth.finishConnect>>;
      try {
        finished = await runtime.oauth.finishConnect({ tenantId: tenantId(c), state: body.state, code: body.code });
      } catch {
        throw new CrmError('bad_request', 'the Google authorization could not be completed');
      }
      const calendar = await callCrm(c, 'booking.setCalendarGoogle', {
        id: calendarId,
        accountId: finished.account.accountId,
        email: finished.email,
      });
      await syncCalendar(c, calendarId);
      await audit(c, 'booking.google_connected', { target: calendarId });
      return c.json(calendar, 200);
    },
  );
  router.openapi(
    crmRoute('booking:write', {
      method: 'delete',
      path: '/bookingCalendars/{calendarId}/google',
      tags: calendarsTag,
      summary: 'Disconnect the Google account (busy time is no longer read, bookings no longer written)',
      request: { params: bookingCalendarParamSchema },
      responses: { 200: json(bookingCalendarSchema, 'The calendar') },
    }),
    async (c) => {
      const { calendarId } = c.req.valid('param');
      const ref = await callCrm(c, 'booking.calendarForWorker', { id: calendarId });
      if (ref.googleAccountId !== null) {
        const runtime = await bookingRuntime(c.env);
        await runtime.oauth.revoke({ tenantId: tenantId(c), provider: 'google', accountId: ref.googleAccountId }).catch(() => undefined);
      }
      const calendar = await callCrm(c, 'booking.setCalendarGoogle', { id: calendarId, accountId: null, email: null });
      await syncCalendar(c, calendarId);
      await audit(c, 'booking.google_disconnected', { target: calendarId });
      return c.json(calendar, 200);
    },
  );
  router.openapi(
    crmRoute('booking:write', {
      method: 'post',
      path: '/bookingCalendars/{calendarId}/sync',
      tags: calendarsTag,
      summary: 'Refresh the external busy time now (dev stub tokens report `stub`)',
      request: { params: bookingCalendarParamSchema },
      responses: { 200: json(bookingSyncResultSchema, 'Sync result') },
    }),
    async (c) => c.json(await syncCalendar(c, c.req.valid('param').calendarId), 200),
  );
  router.openapi(
    crmRoute('booking:read', {
      method: 'get',
      path: '/bookingCalendars/{calendarId}/sync',
      tags: calendarsTag,
      summary: 'Last busy time sync and booking write status (re-reads the granted scopes, no busy-time fetch)',
      request: { params: bookingCalendarParamSchema },
      responses: { 200: json(bookingSyncResultSchema, 'Sync status') },
    }),
    async (c) => {
      const { calendarId } = c.req.valid('param');
      const ref = await callCrm(c, 'booking.calendarForWorker', { id: calendarId });
      const stub = calendarStub(c.env, tenantId(c), calendarId);
      return c.json(stub === null ? UNAVAILABLE_SYNC : syncToApi((await stub.status(doRef(tenantId(c), ref))) as SyncResult), 200);
    },
  );

  // ---------------------------------------------------------- event types
  router.openapi(
    crmRoute('booking:read', {
      method: 'get',
      path: '/bookingEventTypes',
      tags: eventTypesTag,
      summary: 'List event types',
      request: { query: listBookingEventTypesQuerySchema },
      responses: { 200: json(z.object({ data: z.array(bookingEventTypeSchema) }), 'Event types') },
    }),
    async (c) => c.json({ data: await callCrm(c, 'booking.listEventTypes', c.req.valid('query')) }, 200),
  );
  router.openapi(
    crmRoute('booking:write', {
      method: 'post',
      path: '/bookingEventTypes',
      tags: eventTypesTag,
      summary: 'Create an event type',
      request: { body: jsonBody(createBookingEventTypeSchema) },
      responses: { 201: json(bookingEventTypeSchema, 'The event type') },
    }),
    async (c) => {
      const eventType = await callCrm(c, 'booking.createEventType', c.req.valid('json'));
      await audit(c, 'booking.event_type_created', { target: eventType.id });
      return c.json(eventType, 201);
    },
  );
  router.openapi(
    crmRoute('booking:read', {
      method: 'get',
      path: '/bookingEventTypes/{eventTypeId}',
      tags: eventTypesTag,
      summary: 'Get an event type',
      request: { params: bookingEventTypeParamSchema },
      responses: { 200: json(bookingEventTypeSchema, 'The event type') },
    }),
    async (c) => c.json(await callCrm(c, 'booking.getEventType', { id: c.req.valid('param').eventTypeId }), 200),
  );
  router.openapi(
    crmRoute('booking:write', {
      method: 'patch',
      path: '/bookingEventTypes/{eventTypeId}',
      tags: eventTypesTag,
      summary: 'Update an event type (open widgets refresh live)',
      request: { params: bookingEventTypeParamSchema, body: jsonBody(updateBookingEventTypeSchema) },
      responses: { 200: json(bookingEventTypeSchema, 'The event type') },
    }),
    async (c) => {
      const { eventTypeId } = c.req.valid('param');
      const before = await callCrm(c, 'booking.getEventType', { id: eventTypeId });
      const eventType = await callCrm(c, 'booking.updateEventType', { id: eventTypeId, data: c.req.valid('json') });
      await touchCalendars(c.env, tenantId(c), [...new Set([...before.host_calendar_ids, ...eventType.host_calendar_ids])]);
      await audit(c, 'booking.event_type_updated', { target: eventTypeId });
      return c.json(eventType, 200);
    },
  );
  router.openapi(
    crmRoute('booking:write', {
      method: 'delete',
      path: '/bookingEventTypes/{eventTypeId}',
      tags: eventTypesTag,
      summary: 'Delete an event type (its bookings are kept)',
      request: { params: bookingEventTypeParamSchema },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) => {
      const { eventTypeId } = c.req.valid('param');
      const result = await callCrm(c, 'booking.deleteEventType', { id: eventTypeId });
      await audit(c, 'booking.event_type_deleted', { target: eventTypeId });
      return c.json(result, 200);
    },
  );
  router.openapi(
    crmRoute('booking:read', {
      method: 'get',
      path: '/bookingEventTypes/{eventTypeId}/embed',
      tags: eventTypesTag,
      summary: 'Embed snippet and hosted booking page link',
      request: { params: bookingEventTypeParamSchema },
      responses: { 200: json(bookingEmbedSchema, 'Embed facts') },
    }),
    async (c) => {
      const eventType = await callCrm(c, 'booking.getEventType', { id: c.req.valid('param').eventTypeId });
      const slug = getTenant(c).tenant.slug;
      const edge = edgeOrigin(c.env);
      return c.json(
        {
          event_type_id: eventType.id,
          slug: eventType.slug,
          tenant: slug,
          script_url: `${edge}/booking.js`,
          config_url: `${edge}/b/${slug}/${eventType.slug}/config`,
          hosted_url: `${edge}/b/${slug}/${eventType.slug}`,
          snippet: `<div data-amable-booking="${eventType.slug}" data-amable-tenant="${slug}"></div>\n<script async src="${edge}/booking.js"></script>`,
        },
        200,
      );
    },
  );
  router.openapi(
    crmRoute('booking:read', {
      method: 'get',
      path: '/bookingEventTypes/{eventTypeId}/availability',
      tags: eventTypesTag,
      summary: 'Availability preview: bookable slots between two dates (also for inactive event types)',
      request: { params: bookingEventTypeParamSchema, query: bookingAvailabilityQuerySchema },
      responses: { 200: json(bookingAvailabilitySchema, 'Slots') },
    }),
    async (c) => {
      const { eventTypeId } = c.req.valid('param');
      const query = c.req.valid('query');
      const context = await callCrm(c, 'booking.eventTypeContext', { id: eventTypeId });
      const timeZone = query.time_zone ?? context.calendars[0]?.timeZone ?? 'UTC';
      const fromDate = parseDateKey(query.from);
      const toDate = parseDateKey(query.to);
      if (fromDate === null) throw invalid('from', 'invalid date');
      if (toDate === null) throw invalid('to', 'invalid date');
      const from = zonedToUtc(fromDate, 0, timeZone);
      const to = zonedToUtc(addDays(toDate, 1), 0, timeZone) - 1;
      if (to < from || to - from > MAX_PREVIEW_DAYS * DAY_MS) throw invalid('to', `the range must cover 1 to ${String(MAX_PREVIEW_DAYS)} days`);
      const busy = await externalBusy(c.env, tenantId(c), context.calendars, from, to + DAY_MS);
      const result = await callCrm(c, 'booking.slots', { eventTypeId, from, to, externalBusy: busy });
      return c.json(
        {
          time_zone: timeZone,
          slots: result.slots.map((s) => ({ start: toIso(s.start), end: toIso(s.end), calendar_ids: [...s.calendarIds] })),
        },
        200,
      );
    },
  );

  // ------------------------------------------------------------- bookings
  router.openapi(
    crmRoute('booking:read', {
      method: 'get',
      path: '/bookings',
      tags: bookingsTag,
      summary: 'List bookings (filters: status, event type, calendar, contact, start range)',
      request: { query: listBookingsQuerySchema },
      responses: { 200: json(pageOf(bookingSchema), 'Bookings') },
    }),
    async (c) => c.json(await callCrm(c, 'booking.listBookings', c.req.valid('query')), 200),
  );
  router.openapi(
    crmRoute('booking:manage_bookings', {
      method: 'post',
      path: '/bookings',
      tags: bookingsTag,
      summary: 'Book on behalf of a contact (same availability checks; confirmation email unless notify=false)',
      request: { body: jsonBody(createBookingSchema) },
      responses: { 201: json(bookingSchema, 'The booking') },
    }),
    async (c) => {
      const body = c.req.valid('json');
      const eventType = await callCrm(c, 'booking.getEventType', { id: body.event_type_id });
      const start = startOf(body.start_at, 'start_at');
      const busy = await busyFor(c, eventType.id, [], start, eventType.duration_minutes);
      const { token, hash } = await newManageToken();
      const outcome = await callCrm(c, 'booking.book', {
        eventTypeId: eventType.id,
        start,
        timeZone: body.time_zone,
        locale: body.locale ?? 'en',
        invitee: { given_name: body.given_name, family_name: body.family_name ?? '', email: body.email, phone: body.phone ?? '' },
        answers: body.answers ?? {},
        source: { utm_source: null, utm_medium: null, utm_campaign: null, utm_term: null, utm_content: null, referrer: null, page_url: null, page_id: null },
        visitorId: null,
        manageTokenHash: hash,
        externalBusy: busy,
        channel: 'staff',
        ...(body.calendar_id === undefined ? {} : { calendarId: body.calendar_id }),
      });
      await finishChange(c, outcome, token, body.notify !== false);
      await audit(c, 'booking.booking_created', { target: outcome.booking.id, details: { event_type_id: eventType.id } });
      return c.json(outcome.booking, 201);
    },
  );
  router.openapi(
    crmRoute('booking:read', {
      method: 'get',
      path: '/bookings/{bookingId}',
      tags: bookingsTag,
      summary: 'Get a booking',
      request: { params: bookingParamSchema },
      responses: { 200: json(bookingSchema, 'The booking') },
    }),
    async (c) => c.json(await callCrm(c, 'booking.getBooking', { id: c.req.valid('param').bookingId }), 200),
  );
  router.openapi(
    crmRoute('booking:manage_bookings', {
      method: 'post',
      path: '/bookings/{bookingId}/cancel',
      tags: bookingsTag,
      summary: 'Cancel a booking (its CRM appointment is cancelled; the invitee is notified unless notify=false)',
      request: { params: bookingParamSchema, body: { required: false, content: { 'application/json': { schema: cancelBookingSchema } } } },
      responses: { 200: json(bookingSchema, 'The booking') },
    }),
    async (c) => {
      const { bookingId } = c.req.valid('param');
      const raw: unknown = await c.req.json().catch(() => ({}));
      const parsed = cancelBookingSchema.safeParse(raw ?? {});
      if (!parsed.success) throw invalid(parsed.error.issues[0]?.path.join('.') ?? 'body', parsed.error.issues[0]?.message ?? 'invalid');
      const outcome = await callCrm(c, 'booking.cancel', {
        id: bookingId,
        by: 'staff',
        ...(parsed.data.reason === undefined ? {} : { reason: parsed.data.reason }),
      });
      await finishChange(c, outcome, null, parsed.data.notify !== false);
      await audit(c, 'booking.booking_cancelled', { target: bookingId });
      return c.json(outcome.booking, 200);
    },
  );
  router.openapi(
    crmRoute('booking:manage_bookings', {
      method: 'post',
      path: '/bookings/{bookingId}/reschedule',
      tags: bookingsTag,
      summary: 'Move a booking to another available time (the invitee gets a fresh manage link)',
      request: { params: bookingParamSchema, body: jsonBody(rescheduleBookingSchema) },
      responses: { 200: json(bookingSchema, 'The booking') },
    }),
    async (c) => {
      const { bookingId } = c.req.valid('param');
      const body = c.req.valid('json');
      const current = await callCrm(c, 'booking.bookingContext', { id: bookingId });
      const start = startOf(body.start_at, 'start_at');
      const busy = await busyFor(c, current.eventType.id, current.calendars, start, current.eventType.duration_minutes);
      const { token, hash } = await newManageToken();
      const outcome = await callCrm(c, 'booking.reschedule', { id: bookingId, start, externalBusy: busy, by: 'staff', newTokenHash: hash });
      await finishChange(c, outcome, token, body.notify !== false);
      await audit(c, 'booking.booking_rescheduled', { target: bookingId });
      return c.json(outcome.booking, 200);
    },
  );
}
