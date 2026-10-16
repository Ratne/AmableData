import { z, type OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { audit, getAuth, getTenant, handleError, type AppEnv } from '../middleware';
import { createCrmRouter, crmRoute, json, jsonBody } from '../crm/api/core';
import { webhookService } from './runtime';
import { WEBHOOK_EVENT_TYPES, WebhookError } from './service';

const tags = ['Webhooks'];

const endpointSchema = z
  .object({
    id: z.string(),
    url: z.string(),
    description: z.string(),
    event_types: z.array(z.string()),
    status: z.enum(['active', 'disabled']),
    disabled_reason: z.string().nullable(),
    consecutive_failures: z.number().int(),
    secret_hint: z.string().describe('Last 4 characters of the signing secret'),
    created_at: z.string(),
    updated_at: z.string(),
    last_success_at: z.string().nullable(),
    last_failure_at: z.string().nullable(),
  })
  .openapi('WebhookEndpoint');

const deliverySchema = z
  .object({
    id: z.string(),
    endpoint_id: z.string(),
    event_id: z.string(),
    event_type: z.string(),
    status: z.enum(['pending', 'retrying', 'succeeded', 'failed']),
    attempts: z.number().int(),
    next_attempt_at: z.string().nullable(),
    last_status: z.number().int().nullable(),
    last_error: z.string().nullable(),
    duration_ms: z.number().int().nullable(),
    replay_of: z.string().nullable(),
    created_at: z.string(),
    completed_at: z.string().nullable(),
  })
  .openapi('WebhookDelivery');

const deliveryDetailSchema = deliverySchema
  .extend({ payload: z.unknown(), last_response: z.string().nullable() })
  .openapi('WebhookDeliveryDetail');

const eventTypesSchema = z.array(z.string()).min(1).max(100);

const createSchema = z
  .strictObject({
    url: z.string().url().max(2000),
    description: z.string().max(200).optional(),
    event_types: eventTypesSchema.describe('Event types to receive; `*` subscribes to all'),
  })
  .openapi('WebhookEndpointCreate');

const updateSchema = z
  .strictObject({
    url: z.string().url().max(2000).optional(),
    description: z.string().max(200).optional(),
    event_types: eventTypesSchema.optional(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .openapi('WebhookEndpointUpdate');

const idParam = z.object({ id: z.string().min(1).max(64) });
const deliveryParam = z.object({ deliveryId: z.string().min(1).max(64) });
const deliveriesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().datetime().optional().describe('Only deliveries created before this instant'),
  status: z.enum(['pending', 'retrying', 'succeeded', 'failed']).optional(),
});

function service(c: Context<AppEnv>) {
  return webhookService(c.env);
}

export function registerWebhookRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(
    crmRoute('webhooks:manage', {
      method: 'get',
      path: '/webhooks/event-types',
      tags,
      summary: 'List subscribable event types',
      responses: { 200: json(z.object({ data: z.array(z.string()) }), 'Event types') },
    }),
    (c) => c.json({ data: [...WEBHOOK_EVENT_TYPES] }, 200),
  );

  app.openapi(
    crmRoute('webhooks:manage', {
      method: 'get',
      path: '/webhooks',
      tags,
      summary: 'List webhook endpoints',
      responses: { 200: json(z.object({ data: z.array(endpointSchema) }), 'Endpoints') },
    }),
    async (c) => c.json({ data: await service(c).list(getTenant(c).tenant.id) }, 200),
  );

  app.openapi(
    crmRoute('webhooks:manage', {
      method: 'post',
      path: '/webhooks',
      tags,
      summary: 'Create a webhook endpoint',
      description:
        'Returns the signing secret once (`whsec_…`). Each delivery is a JSON `POST` with `Amable-Signature: t=<unix>,v1=<hex>` = HMAC-SHA256 of `<t>.<raw body>` with the secret; reject timestamps older than 5 minutes. Failed deliveries are retried with backoff (30 s → 12 h, 9 attempts); 20 failed attempts in a row (or a 410) disable the endpoint.',
      request: { body: jsonBody(createSchema) },
      responses: {
        201: json(z.object({ endpoint: endpointSchema, secret: z.string() }), 'Created endpoint and its secret'),
      },
    }, { stepUp: true }),
    async (c) => {
      const body = c.req.valid('json');
      const result = await service(c).create(getTenant(c).tenant.id, {
        url: body.url,
        event_types: body.event_types,
        createdBy: getAuth(c).user.id,
        ...(body.description === undefined ? {} : { description: body.description }),
      });
      await audit(c, 'webhook.endpoint_created', {
        target: result.endpoint.id,
        details: { events: body.event_types.length },
      });
      return c.json(result, 201);
    },
  );

  app.openapi(
    crmRoute('webhooks:manage', {
      method: 'get',
      path: '/webhooks/{id}',
      tags,
      summary: 'Get a webhook endpoint',
      request: { params: idParam },
      responses: { 200: json(endpointSchema, 'Endpoint') },
    }),
    async (c) => c.json(await service(c).get(getTenant(c).tenant.id, c.req.valid('param').id), 200),
  );

  app.openapi(
    crmRoute('webhooks:manage', {
      method: 'patch',
      path: '/webhooks/{id}',
      tags,
      summary: 'Update a webhook endpoint',
      description: 'Setting `status: active` on a disabled endpoint resets its failure counter.',
      request: { params: idParam, body: jsonBody(updateSchema) },
      responses: { 200: json(endpointSchema, 'Updated endpoint') },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const endpoint = await service(c).update(getTenant(c).tenant.id, id, {
        ...(body.url === undefined ? {} : { url: body.url }),
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.event_types === undefined ? {} : { event_types: body.event_types }),
        ...(body.status === undefined ? {} : { status: body.status }),
      });
      await audit(c, 'webhook.endpoint_updated', { target: id });
      return c.json(endpoint, 200);
    },
  );

  app.openapi(
    crmRoute('webhooks:manage', {
      method: 'delete',
      path: '/webhooks/{id}',
      tags,
      summary: 'Delete a webhook endpoint and its delivery log',
      request: { params: idParam },
      responses: { 200: json(z.object({ ok: z.literal(true) }), 'Deleted') },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      await service(c).remove(getTenant(c).tenant.id, id);
      await audit(c, 'webhook.endpoint_deleted', { target: id });
      return c.json({ ok: true as const }, 200);
    },
  );

  app.openapi(
    crmRoute('webhooks:manage', {
      method: 'post',
      path: '/webhooks/{id}/rotate-secret',
      tags,
      summary: 'Rotate the signing secret',
      description: 'The new secret is returned once; the old one stops working immediately.',
      request: { params: idParam },
      responses: { 200: json(z.object({ secret: z.string() }), 'New secret') },
    }, { stepUp: true }),
    async (c) => {
      const { id } = c.req.valid('param');
      const result = await service(c).rotateSecret(getTenant(c).tenant.id, id);
      await audit(c, 'webhook.secret_rotated', { target: id });
      return c.json(result, 200);
    },
  );

  app.openapi(
    crmRoute('webhooks:manage', {
      method: 'post',
      path: '/webhooks/{id}/test',
      tags,
      summary: 'Send a test delivery now',
      request: { params: idParam },
      responses: { 200: json(deliverySchema, 'Result of the attempt') },
    }),
    async (c) => {
      const { tenant } = getTenant(c);
      return c.json(await service(c).sendTest(tenant.id, tenant.slug, c.req.valid('param').id), 200);
    },
  );

  app.openapi(
    crmRoute('webhooks:manage', {
      method: 'get',
      path: '/webhooks/{id}/deliveries',
      tags,
      summary: 'Delivery log of an endpoint',
      description: 'Newest first; kept 30 days.',
      request: { params: idParam, query: deliveriesQuery },
      responses: { 200: json(z.object({ data: z.array(deliverySchema) }), 'Deliveries') },
    }),
    async (c) => {
      const query = c.req.valid('query');
      const data = await service(c).deliveries(getTenant(c).tenant.id, c.req.valid('param').id, {
        limit: query.limit,
        before: query.before === undefined ? null : Date.parse(query.before),
        ...(query.status === undefined ? {} : { status: query.status }),
      });
      return c.json({ data }, 200);
    },
  );

  app.openapi(
    crmRoute('webhooks:manage', {
      method: 'get',
      path: '/webhooks/deliveries/{deliveryId}',
      tags,
      summary: 'One delivery with its body and response snippet',
      request: { params: deliveryParam },
      responses: { 200: json(deliveryDetailSchema, 'Delivery') },
    }),
    async (c) =>
      c.json(
        await service(c).delivery(getTenant(c).tenant.id, c.req.valid('param').deliveryId),
        200,
      ),
  );

  app.openapi(
    crmRoute('webhooks:manage', {
      method: 'post',
      path: '/webhooks/deliveries/{deliveryId}/replay',
      tags,
      summary: 'Replay a delivery',
      description: 'Sends the same body again as a new delivery (attempted now, retried on failure).',
      request: { params: deliveryParam },
      responses: { 200: json(deliverySchema, 'The new delivery') },
    }),
    async (c) => {
      const { deliveryId } = c.req.valid('param');
      const result = await service(c).replay(getTenant(c).tenant.id, deliveryId);
      await audit(c, 'webhook.delivery_replayed', { target: deliveryId });
      return c.json(result, 200);
    },
  );
}

/** Webhook REST v2 routes, relative to `/api/v2/t/{slug}`. */
export const webhooksApi = createCrmRouter();
webhooksApi.onError((error, c) => {
  if (error instanceof WebhookError) {
    return c.json({ error: error.code, message: error.message }, error.status);
  }
  return handleError(error, c);
});
registerWebhookRoutes(webhooksApi);

export function webhooksOpenApiDocument(): ReturnType<typeof webhooksApi.getOpenAPI31Document> {
  return webhooksApi.getOpenAPI31Document({
    openapi: '3.1.0',
    info: { title: 'amabledata REST API — outgoing webhooks', version: '2.0.0' },
    servers: [{ url: '/api/v2/t/{slug}', variables: { slug: { default: 'demo' } } }],
  });
}
