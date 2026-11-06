import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  bookingParamSchema,
  bookingSchema,
  cancelBookingSchema,
  createBookingSchema,
  listBookingsQuerySchema,
  pageOf,
  rescheduleBookingSchema,
} from '@amable/api-types';
import { callCrm, crmRoute, json, jsonBody } from '../../crm/api/core';
import { invalid } from '../../crm/errors';
import { audit, type AppEnv } from '../../middleware';
import { newManageToken } from '../flow';
import { bookingsTag, finishChange, busyFor, startOf } from './shared';

export function registerBookingsRoutes(router: OpenAPIHono<AppEnv>): void {
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
      summary:
        'Book on behalf of a contact (same availability checks; confirmation email unless notify=false)',
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
        invitee: {
          given_name: body.given_name,
          family_name: body.family_name ?? '',
          email: body.email,
          phone: body.phone ?? '',
        },
        answers: body.answers ?? {},
        source: {
          utm_source: null,
          utm_medium: null,
          utm_campaign: null,
          utm_term: null,
          utm_content: null,
          referrer: null,
          page_url: null,
          page_id: null,
        },
        visitorId: null,
        manageTokenHash: hash,
        externalBusy: busy,
        channel: 'staff',
        ...(body.calendar_id === undefined ? {} : { calendarId: body.calendar_id }),
      });
      await finishChange(c, outcome, token, body.notify !== false);
      await audit(c, 'booking.booking_created', {
        target: outcome.booking.id,
        details: { event_type_id: eventType.id },
      });
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
    async (c) =>
      c.json(await callCrm(c, 'booking.getBooking', { id: c.req.valid('param').bookingId }), 200),
  );
  router.openapi(
    crmRoute('booking:manage_bookings', {
      method: 'post',
      path: '/bookings/{bookingId}/cancel',
      tags: bookingsTag,
      summary:
        'Cancel a booking (its CRM appointment is cancelled; the invitee is notified unless notify=false)',
      request: {
        params: bookingParamSchema,
        body: { required: false, content: { 'application/json': { schema: cancelBookingSchema } } },
      },
      responses: { 200: json(bookingSchema, 'The booking') },
    }),
    async (c) => {
      const { bookingId } = c.req.valid('param');
      const raw: unknown = await c.req.json().catch(() => ({}));
      const parsed = cancelBookingSchema.safeParse(raw ?? {});
      if (!parsed.success)
        throw invalid(
          parsed.error.issues[0]?.path.join('.') ?? 'body',
          parsed.error.issues[0]?.message ?? 'invalid',
        );
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
      const busy = await busyFor(
        c,
        current.eventType.id,
        current.calendars,
        start,
        current.eventType.duration_minutes,
      );
      const { token, hash } = await newManageToken();
      const outcome = await callCrm(c, 'booking.reschedule', {
        id: bookingId,
        start,
        externalBusy: busy,
        by: 'staff',
        newTokenHash: hash,
      });
      await finishChange(c, outcome, token, body.notify !== false);
      await audit(c, 'booking.booking_rescheduled', { target: bookingId });
      return c.json(outcome.booking, 200);
    },
  );
}
