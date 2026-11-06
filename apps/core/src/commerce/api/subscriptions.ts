import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  billingRunResultSchema,
  cancelSubscriptionSchema,
  changePlanSchema,
  createSubscriptionSchema,
  idParamSchema,
  listSubscriptionsQuerySchema,
  pageOf,
  subscriptionSchema,
} from '@amable/api-types';
import type { AppEnv } from '../../middleware';
import { callCrm, crmRoute, json, jsonBody } from '../../crm/api/core';

export function registerSubscriptionsRoutes(app: OpenAPIHono<AppEnv>): void {
  const subs = ['Subscriptions'];
  app.openapi(
    crmRoute('subscriptions:read', {
      method: 'get',
      path: '/subscriptions',
      tags: subs,
      summary: 'List subscriptions',
      request: { query: listSubscriptionsQuerySchema },
      responses: { 200: json(pageOf(subscriptionSchema), 'A page of subscriptions, newest first') },
    }),
    async (c) => c.json(await callCrm(c, 'subscriptions.list', c.req.valid('query')), 200),
  );
  app.openapi(
    crmRoute('subscriptions:write', {
      method: 'post',
      path: '/subscriptions',
      tags: subs,
      summary: 'Start a subscription on a plan',
      description:
        'With a trial nothing is billed until it ends (`subscription.trial_started`); otherwise the first period order + invoice is generated now. The billing job generates renewal orders on each due date.',
      request: { body: jsonBody(createSubscriptionSchema) },
      responses: { 201: json(subscriptionSchema, 'The subscription') },
    }),
    async (c) => c.json(await callCrm(c, 'subscriptions.create', c.req.valid('json')), 201),
  );
  app.openapi(
    crmRoute('subscriptions:read', {
      method: 'get',
      path: '/subscriptions/{id}',
      tags: subs,
      summary: 'Get a subscription',
      request: { params: idParamSchema },
      responses: { 200: json(subscriptionSchema, 'The subscription') },
    }),
    async (c) => c.json(await callCrm(c, 'subscriptions.get', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('subscriptions:write', {
      method: 'post',
      path: '/subscriptions/{id}/cancel',
      tags: subs,
      summary: 'Cancel at period end (default) or immediately',
      request: { params: idParamSchema, body: jsonBody(cancelSubscriptionSchema) },
      responses: { 200: json(subscriptionSchema, 'The subscription') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'subscriptions.cancel', {
          id: c.req.valid('param').id,
          data: c.req.valid('json'),
        }),
        200,
      ),
  );
  app.openapi(
    crmRoute('subscriptions:write', {
      method: 'post',
      path: '/subscriptions/{id}/pause',
      tags: subs,
      summary: 'Pause billing',
      request: { params: idParamSchema },
      responses: { 200: json(subscriptionSchema, 'The subscription') },
    }),
    async (c) => c.json(await callCrm(c, 'subscriptions.pause', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('subscriptions:write', {
      method: 'post',
      path: '/subscriptions/{id}/resume',
      tags: subs,
      summary: 'Resume a paused subscription or withdraw a scheduled cancellation',
      request: { params: idParamSchema },
      responses: { 200: json(subscriptionSchema, 'The subscription') },
    }),
    async (c) => c.json(await callCrm(c, 'subscriptions.resume', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('subscriptions:write', {
      method: 'post',
      path: '/subscriptions/{id}/changePlan',
      tags: subs,
      summary: 'Change plan from the next period (no proration; emits upgraded/downgraded)',
      request: { params: idParamSchema, body: jsonBody(changePlanSchema) },
      responses: { 200: json(subscriptionSchema, 'The subscription') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'subscriptions.changePlan', {
          id: c.req.valid('param').id,
          data: c.req.valid('json'),
        }),
        200,
      ),
  );
  app.openapi(
    crmRoute('subscriptions:write', {
      method: 'post',
      path: '/billing/run',
      tags: subs,
      summary: 'Run the billing job now (it also runs automatically on every due date)',
      responses: { 200: json(billingRunResultSchema, 'Run summary') },
    }),
    async (c) => c.json(await callCrm(c, 'billing.run', {}), 200),
  );
}
