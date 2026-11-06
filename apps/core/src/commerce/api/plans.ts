import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  createPlanSchema,
  deletedResponseSchema,
  idParamSchema,
  listPlansQuerySchema,
  pageOf,
  planSchema,
  updatePlanSchema,
} from '@amable/api-types';
import type { AppEnv } from '../../middleware';
import { callCrm, crmRoute, json, jsonBody } from '../../crm/api/core';

export function registerPlansRoutes(app: OpenAPIHono<AppEnv>): void {
  const plans = ['Subscription plans'];
  app.openapi(
    crmRoute('products:read', {
      method: 'get',
      path: '/plans',
      tags: plans,
      summary: 'List subscription plans',
      request: { query: listPlansQuerySchema },
      responses: { 200: json(pageOf(planSchema), 'A page of plans') },
    }),
    async (c) => c.json(await callCrm(c, 'plans.list', c.req.valid('query')), 200),
  );
  app.openapi(
    crmRoute('products:write', {
      method: 'post',
      path: '/products/{id}/plans',
      tags: plans,
      summary: 'Add a subscription plan to a product',
      request: { params: idParamSchema, body: jsonBody(createPlanSchema) },
      responses: { 201: json(planSchema, 'The plan') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'plans.create', {
          productId: c.req.valid('param').id,
          data: c.req.valid('json'),
        }),
        201,
      ),
  );
  app.openapi(
    crmRoute('products:read', {
      method: 'get',
      path: '/plans/{id}',
      tags: plans,
      summary: 'Get a plan',
      request: { params: idParamSchema },
      responses: { 200: json(planSchema, 'The plan') },
    }),
    async (c) => c.json(await callCrm(c, 'plans.get', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('products:write', {
      method: 'patch',
      path: '/plans/{id}',
      tags: plans,
      summary: 'Update a plan (running subscriptions keep their snapshot)',
      request: { params: idParamSchema, body: jsonBody(updatePlanSchema) },
      responses: { 200: json(planSchema, 'The plan') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'plans.update', {
          id: c.req.valid('param').id,
          data: c.req.valid('json'),
        }),
        200,
      ),
  );
  app.openapi(
    crmRoute('products:write', {
      method: 'delete',
      path: '/plans/{id}',
      tags: plans,
      summary: 'Delete a plan without live subscriptions',
      request: { params: idParamSchema },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) => c.json(await callCrm(c, 'plans.delete', c.req.valid('param')), 200),
  );
}
