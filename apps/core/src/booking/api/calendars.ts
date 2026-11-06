import { z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  bookingAvailabilityRulesSchema,
  bookingCalendarParamSchema,
  bookingCalendarSchema,
  bookingGoogleConnectSchema,
  bookingGoogleFinishSchema,
  bookingSyncResultSchema,
  createBookingCalendarSchema,
  deletedResponseSchema,
  putBookingAvailabilitySchema,
  updateBookingCalendarSchema,
} from '@amable/api-types';
import { OAUTH_SCOPES } from '@amable/core';
import { callCrm, crmRoute, json, jsonBody } from '../../crm/api/core';
import { CrmError } from '../../crm/errors';
import { appOrigin, audit, getTenant, type AppEnv } from '../../middleware';
import type { SyncResult } from '../calendar-core';
import { calendarStub, doRef, touchCalendars } from '../flow';
import { bookingRuntime } from '../runtime';
import {
  calendarsTag,
  tenantId,
  assertMember,
  syncToApi,
  UNAVAILABLE_SYNC,
  syncCalendar,
} from './shared';

export function registerCalendarsRoutes(router: OpenAPIHono<AppEnv>): void {
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
      return c.json(
        {
          data: await callCrm(
            c,
            'booking.listCalendars',
            host === undefined ? {} : { hostUserId: host },
          ),
        },
        200,
      );
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
    async (c) =>
      c.json(await callCrm(c, 'booking.getCalendar', { id: c.req.valid('param').calendarId }), 200),
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
      const calendar = await callCrm(c, 'booking.getCalendar', {
        id: c.req.valid('param').calendarId,
      });
      return c.json(
        {
          time_zone: calendar.time_zone,
          weekly_rules: calendar.weekly_rules,
          date_overrides: calendar.date_overrides,
        },
        200,
      );
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
      const calendar = await callCrm(c, 'booking.updateCalendar', {
        id: calendarId,
        data: c.req.valid('json'),
      });
      await touchCalendars(c.env, tenantId(c), [calendarId]);
      await audit(c, 'booking.availability_updated', { target: calendarId });
      return c.json(
        {
          time_zone: calendar.time_zone,
          weekly_rules: calendar.weekly_rules,
          date_overrides: calendar.date_overrides,
        },
        200,
      );
    },
  );
  router.openapi(
    crmRoute('booking:write', {
      method: 'post',
      path: '/bookingCalendars/{calendarId}/google/connect',
      tags: calendarsTag,
      summary:
        'Start connecting a Google account (central OAuth app); the browser goes to authorize_url',
      request: { params: bookingCalendarParamSchema },
      responses: { 200: json(bookingGoogleConnectSchema, 'Authorization URL') },
    }),
    async (c) => {
      const { calendarId } = c.req.valid('param');
      await callCrm(c, 'booking.getCalendar', { id: calendarId });
      const runtime = await bookingRuntime(c.env);
      if (!runtime.oauth.available)
        throw new CrmError(
          'conflict',
          'connecting Google accounts is not available on this installation',
        );
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
      if (!runtime.oauth.available)
        throw new CrmError(
          'conflict',
          'connecting Google accounts is not available on this installation',
        );
      let finished: Awaited<ReturnType<typeof runtime.oauth.finishConnect>>;
      try {
        finished = await runtime.oauth.finishConnect({
          tenantId: tenantId(c),
          state: body.state,
          code: body.code,
        });
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
      summary:
        'Disconnect the Google account (busy time is no longer read, bookings no longer written)',
      request: { params: bookingCalendarParamSchema },
      responses: { 200: json(bookingCalendarSchema, 'The calendar') },
    }),
    async (c) => {
      const { calendarId } = c.req.valid('param');
      const ref = await callCrm(c, 'booking.calendarForWorker', { id: calendarId });
      if (ref.googleAccountId !== null) {
        const runtime = await bookingRuntime(c.env);
        await runtime.oauth
          .revoke({ tenantId: tenantId(c), provider: 'google', accountId: ref.googleAccountId })
          .catch(() => undefined);
      }
      const calendar = await callCrm(c, 'booking.setCalendarGoogle', {
        id: calendarId,
        accountId: null,
        email: null,
      });
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
      summary:
        'Last busy time sync and booking write status (re-reads the granted scopes, no busy-time fetch)',
      request: { params: bookingCalendarParamSchema },
      responses: { 200: json(bookingSyncResultSchema, 'Sync status') },
    }),
    async (c) => {
      const { calendarId } = c.req.valid('param');
      const ref = await callCrm(c, 'booking.calendarForWorker', { id: calendarId });
      const stub = calendarStub(c.env, tenantId(c), calendarId);
      return c.json(
        stub === null
          ? UNAVAILABLE_SYNC
          : syncToApi((await stub.status(doRef(tenantId(c), ref))) as SyncResult),
        200,
      );
    },
  );
}
