import { z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  bookingAvailabilityQuerySchema,
  bookingAvailabilitySchema,
  bookingEmbedSchema,
  bookingEventTypeParamSchema,
  bookingEventTypeSchema,
  createBookingEventTypeSchema,
  deletedResponseSchema,
  listBookingEventTypesQuerySchema,
  updateBookingEventTypeSchema,
} from '@amable/api-types';
import { addDays, DAY_MS, parseDateKey, zonedToUtc } from '@amable/booking';
import { callCrm, crmRoute, json, jsonBody } from '../../crm/api/core';
import { invalid } from '../../crm/errors';
import { toIso } from '../../crm/util';
import { audit, getTenant, type AppEnv } from '../../middleware';
import { SLOTS_MAX_AGE_MS } from '../calendar-core';
import { externalBusy, touchCalendars } from '../flow';
import { edgeOrigin } from '../../env';
import { eventTypesTag, MAX_PREVIEW_DAYS, tenantId } from './shared';

export function registerEventTypesRoutes(router: OpenAPIHono<AppEnv>): void {
  router.openapi(
    crmRoute('booking:read', {
      method: 'get',
      path: '/bookingEventTypes',
      tags: eventTypesTag,
      summary: 'List event types',
      request: { query: listBookingEventTypesQuerySchema },
      responses: { 200: json(z.object({ data: z.array(bookingEventTypeSchema) }), 'Event types') },
    }),
    async (c) =>
      c.json({ data: await callCrm(c, 'booking.listEventTypes', c.req.valid('query')) }, 200),
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
    async (c) =>
      c.json(
        await callCrm(c, 'booking.getEventType', { id: c.req.valid('param').eventTypeId }),
        200,
      ),
  );
  router.openapi(
    crmRoute('booking:write', {
      method: 'patch',
      path: '/bookingEventTypes/{eventTypeId}',
      tags: eventTypesTag,
      summary: 'Update an event type (open widgets refresh live)',
      request: {
        params: bookingEventTypeParamSchema,
        body: jsonBody(updateBookingEventTypeSchema),
      },
      responses: { 200: json(bookingEventTypeSchema, 'The event type') },
    }),
    async (c) => {
      const { eventTypeId } = c.req.valid('param');
      const before = await callCrm(c, 'booking.getEventType', { id: eventTypeId });
      const eventType = await callCrm(c, 'booking.updateEventType', {
        id: eventTypeId,
        data: c.req.valid('json'),
      });
      await touchCalendars(c.env, tenantId(c), [
        ...new Set([...before.host_calendar_ids, ...eventType.host_calendar_ids]),
      ]);
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
      const eventType = await callCrm(c, 'booking.getEventType', {
        id: c.req.valid('param').eventTypeId,
      });
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
      summary:
        'Availability preview: bookable slots between two dates (also for inactive event types)',
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
      if (to < from || to - from > MAX_PREVIEW_DAYS * DAY_MS)
        throw invalid('to', `the range must cover 1 to ${String(MAX_PREVIEW_DAYS)} days`);
      const busy = await externalBusy(
        c.env,
        tenantId(c),
        context.calendars,
        from,
        to + DAY_MS,
        SLOTS_MAX_AGE_MS,
      );
      const result = await callCrm(c, 'booking.slots', {
        eventTypeId,
        from,
        to,
        externalBusy: busy,
      });
      return c.json(
        {
          time_zone: timeZone,
          slots: result.slots.map((s) => ({
            start: toIso(s.start),
            end: toIso(s.end),
            calendar_ids: [...s.calendarIds],
          })),
        },
        200,
      );
    },
  );
}
