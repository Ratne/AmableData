import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  broadcastEstimateSchema,
  broadcastPageSchema,
  broadcastScheduleSchema,
  broadcastSchema,
  broadcastStatsSchema,
  createBroadcastSchema,
  deletedResponseSchema,
  idParamSchema,
  listBroadcastsQuerySchema,
  scheduleBroadcastResponseSchema,
  testSendResponseSchema,
  testSendSchema,
  updateBroadcastSchema,
} from '@amable/api-types';
import { crmRoute, json, jsonBody } from '../crm/api/core';
import { assertEditable, LOCKED_RESPONSE, registerEditLockRoutes } from '../edit-lock/routes';
import { callMail } from '../email/http';
import { audit, getAuth, type AppEnv } from '../middleware';

/** Broadcast REST v2 routes, relative to /api/v2/t/{slug}. */
export function registerBroadcastRoutes(app: OpenAPIHono<AppEnv>): void {
  const tags = ['Broadcasts'];
  app.openapi(
    crmRoute('broadcasts:read', {
      method: 'get',
      path: '/broadcasts',
      tags,
      summary: 'List broadcasts',
      request: { query: listBroadcastsQuerySchema },
      responses: { 200: json(broadcastPageSchema, 'A page of broadcasts, newest first') },
    }),
    async (c) => c.json(await callMail(c, 'broadcasts.list', c.req.valid('query')), 200),
  );
  app.openapi(
    crmRoute('broadcasts:write', {
      method: 'post',
      path: '/broadcasts',
      tags,
      summary: 'Create a draft broadcast',
      request: { body: jsonBody(createBroadcastSchema) },
      responses: { 201: json(broadcastSchema, 'The broadcast') },
    }),
    async (c) =>
      c.json(
        await callMail(c, 'broadcasts.create', { ...c.req.valid('json'), createdBy: getAuth(c).user.id }),
        201,
      ),
  );
  app.openapi(
    crmRoute('broadcasts:read', {
      method: 'get',
      path: '/broadcasts/{id}',
      tags,
      summary: 'Get a broadcast',
      request: { params: idParamSchema },
      responses: { 200: json(broadcastSchema, 'The broadcast') },
    }),
    async (c) => c.json(await callMail(c, 'broadcasts.get', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('broadcasts:write', {
      method: 'patch',
      path: '/broadcasts/{id}',
      tags,
      summary: 'Update a draft broadcast',
      request: { params: idParamSchema, body: jsonBody(updateBroadcastSchema) },
      responses: { 200: json(broadcastSchema, 'The broadcast'), ...LOCKED_RESPONSE },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      await assertEditable(c, 'broadcasts', id);
      return c.json(await callMail(c, 'broadcasts.update', { id, data: c.req.valid('json') }), 200);
    },
  );
  app.openapi(
    crmRoute('broadcasts:write', {
      method: 'delete',
      path: '/broadcasts/{id}',
      tags,
      summary: 'Delete a draft, sent or cancelled broadcast',
      request: { params: idParamSchema },
      responses: { 200: json(deletedResponseSchema, 'Deleted'), ...LOCKED_RESPONSE },
    }),
    async (c) => {
      await assertEditable(c, 'broadcasts', c.req.valid('param').id);
      return c.json(await callMail(c, 'broadcasts.delete', c.req.valid('param')), 200);
    },
  );
  app.openapi(
    crmRoute('broadcasts:read', {
      method: 'get',
      path: '/broadcasts/{id}/estimate',
      tags,
      summary: 'Pre-send estimate: recipients, exclusions, warm-up, quota and blocking problems',
      request: { params: idParamSchema },
      responses: { 200: json(broadcastEstimateSchema, 'The estimate') },
    }),
    async (c) => c.json(await callMail(c, 'broadcasts.estimate', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('broadcasts:write', {
      method: 'post',
      path: '/broadcasts/{id}/test',
      tags,
      summary: 'Send the broadcast to tenant members only, marked [Test]',
      request: { params: idParamSchema, body: jsonBody(testSendSchema) },
      responses: { 200: json(testSendResponseSchema, 'Test emails sent') },
    }),
    async (c) =>
      c.json(
        await callMail(c, 'broadcasts.testSend', {
          id: c.req.valid('param').id,
          data: c.req.valid('json'),
          callerId: getAuth(c).user.id,
        }),
        200,
      ),
  );
  app.openapi(
    crmRoute('broadcasts:send', {
      method: 'post',
      path: '/broadcasts/{id}/schedule',
      tags,
      summary: 'Schedule the broadcast: now, at a time, or per contact timezone',
      description:
        'Blocked (409/402/422) when the sending domain is not verified, sending is suspended, the physical address is missing, the segment is empty, the content does not compile, or the QuotaGuard denies the send.',
      request: { params: idParamSchema, body: jsonBody(broadcastScheduleSchema) },
      responses: { 200: json(scheduleBroadcastResponseSchema, 'Scheduled, with send-time buckets'), ...LOCKED_RESPONSE },
    }),
    async (c) => {
      const id = c.req.valid('param').id;
      await assertEditable(c, 'broadcasts', id);
      const result = await callMail(c, 'broadcasts.schedule', { id, schedule: c.req.valid('json') });
      await audit(c, 'broadcast.scheduled', {
        target: id,
        details: { recipients: result.broadcast.progress.recipients },
      });
      return c.json(result, 200);
    },
  );
  for (const action of ['pause', 'resume', 'cancel'] as const) {
    app.openapi(
      crmRoute('broadcasts:send', {
        method: 'post',
        path: `/broadcasts/{id}/${action}`,
        tags,
        summary: `${action[0]?.toUpperCase() ?? ''}${action.slice(1)} the broadcast`,
        request: { params: idParamSchema },
        responses: { 200: json(broadcastSchema, 'The broadcast') },
      }),
      async (c) => {
        const id = c.req.valid('param').id;
        const result = await callMail(c, `broadcasts.${action}`, { id });
        await audit(c, `broadcast.${action === 'cancel' ? 'cancelled' : action === 'pause' ? 'paused' : 'resumed'}`, {
          target: id,
        });
        return c.json(result, 200);
      },
    );
  }
  app.openapi(
    crmRoute('broadcasts:read', {
      method: 'get',
      path: '/broadcasts/{id}/stats',
      tags,
      summary: 'Delivery, open, click, bounce and unsubscribe totals + per-link clicks',
      request: { params: idParamSchema },
      responses: { 200: json(broadcastStatsSchema, 'The statistics') },
    }),
    async (c) => c.json(await callMail(c, 'broadcasts.stats', c.req.valid('param')), 200),
  );
  registerEditLockRoutes(app, {
    kind: 'broadcasts',
    basePath: '/broadcasts',
    tag: 'Broadcast edit lock',
    write: 'broadcasts:write',
    read: 'broadcasts:read',
    takeover: 'broadcasts:send',
    exists: (c, id) => callMail(c, 'broadcasts.get', { id }),
  });
}
