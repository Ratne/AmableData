import { z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  checkoutConnectionParamSchema,
  checkoutConnectionSchema,
  checkoutEmbedSchema,
  checkoutSchema,
  connectionTestResultSchema,
  createCheckoutConnectionSchema,
  checkoutSummarySchema,
  createCheckoutSchema,
  deletedResponseSchema,
  idSchema,
  listCheckoutsQuerySchema,
  pageOf,
  updateCheckoutConnectionSchema,
  updateCheckoutSchema,
  type CheckoutConnection,
} from '@amable/api-types';
import { ulid } from 'ulid';
import { callCrm, crmRoute, json, jsonBody } from '../crm/api/core';
import { assertEditable, LOCKED_RESPONSE, registerEditLockRoutes } from '../edit-lock/routes';
import { audit, getTenant, type AppEnv } from '../middleware';
import { edgeOrigin } from '../env';
import { CrmError } from '../crm/errors';
import { touchesConnectionSecrets } from '../forms/api/shared';
import { encryptSecret, secretHint } from '../forms/crypto';
import { formsRuntime } from '../forms/runtime';
import { testCheckoutConnection } from './conversions';

const tags = ['Checkouts'];
const connectionTags = ['Checkout integrations'];
const params = z.object({ id: idSchema });

/** Checkout REST routes, relative to `/api/v2/t/{slug}`. */
export function registerCheckoutRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(
    crmRoute('checkouts:read', {
      method: 'get',
      path: '/checkouts',
      tags,
      summary: 'List checkouts (archived ones with `status=archived`)',
      request: { query: listCheckoutsQuerySchema },
      responses: { 200: json(pageOf(checkoutSummarySchema), 'Checkouts') },
    }),
    async (c) => c.json(await callCrm(c, 'checkouts.list', c.req.valid('query')), 200),
  );
  app.openapi(
    crmRoute('checkouts:write', {
      method: 'post',
      path: '/checkouts',
      tags,
      summary: 'Create a checkout (draft unless `status` says otherwise)',
      request: { body: jsonBody(createCheckoutSchema) },
      responses: { 201: json(checkoutSchema, 'The checkout') },
    }),
    async (c) => {
      const checkout = await callCrm(c, 'checkouts.create', c.req.valid('json'));
      await audit(c, 'checkouts.created', { target: checkout.id });
      return c.json(checkout, 201);
    },
  );
  app.openapi(
    crmRoute('checkouts:read', {
      method: 'get',
      path: '/checkouts/{id}',
      tags,
      summary: 'Get a checkout with its definition and sales stats',
      request: { params },
      responses: { 200: json(checkoutSchema, 'The checkout') },
    }),
    async (c) => c.json(await callCrm(c, 'checkouts.get', { id: c.req.valid('param').id }), 200),
  );
  app.openapi(
    crmRoute('checkouts:write', {
      method: 'patch',
      path: '/checkouts/{id}',
      tags,
      summary: 'Update name, status or definition (`revision` guards concurrent edits)',
      request: { params, body: jsonBody(updateCheckoutSchema) },
      responses: { 200: json(checkoutSchema, 'The checkout'), ...LOCKED_RESPONSE },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      await assertEditable(c, 'checkouts', id);
      return c.json(await callCrm(c, 'checkouts.update', { id, data: c.req.valid('json') }), 200);
    },
  );
  app.openapi(
    crmRoute('checkouts:write', {
      method: 'delete',
      path: '/checkouts/{id}',
      tags,
      summary: 'Delete a checkout (its orders and sessions are kept)',
      request: { params },
      responses: { 200: json(deletedResponseSchema, 'Deleted'), ...LOCKED_RESPONSE },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      await assertEditable(c, 'checkouts', id);
      const result = await callCrm(c, 'checkouts.delete', { id });
      await audit(c, 'checkouts.deleted', { target: id });
      return c.json(result, 200);
    },
  );
  app.openapi(
    crmRoute('checkouts:write', {
      method: 'post',
      path: '/checkouts/{id}/duplicate',
      tags,
      summary: 'Copy a checkout (as a draft)',
      request: { params },
      responses: { 201: json(checkoutSchema, 'The copy') },
    }),
    async (c) => c.json(await callCrm(c, 'checkouts.duplicate', { id: c.req.valid('param').id }), 201),
  );
  app.openapi(
    crmRoute('checkouts:read', {
      method: 'get',
      path: '/checkouts/{id}/embed',
      tags,
      summary: 'Embed snippets (checkout and post-purchase offer block) and hosted page link',
      request: { params },
      responses: { 200: json(checkoutEmbedSchema, 'Embed facts') },
    }),
    async (c) => {
      const checkout = await callCrm(c, 'checkouts.get', { id: c.req.valid('param').id });
      const { id: tenantId, slug } = getTenant(c).tenant;
      const edge = edgeOrigin(c.env);
      const script = `${edge}/checkout.js`;
      // A site domain serving the whole hostname brands the hosted link (path-only sites do not route /c/).
      const site = await c.env.DB.prepare(
        `SELECT hostname FROM domains WHERE tenant_id = ? AND kind = 'app' AND status = 'verified'
           AND (paths IS NULL OR paths = '[]') ORDER BY created_at LIMIT 1`,
      )
        .bind(tenantId)
        .first<{ hostname: string }>();
      const hosted = site === null ? `${edge}/c/${slug}` : `https://${site.hostname}/c/${slug}`;
      return c.json(
        {
          checkout_id: checkout.id,
          tenant: slug,
          script_url: script,
          hosted_url: `${hosted}/${checkout.id}`,
          snippet: `<div data-amable-checkout="${checkout.id}" data-amable-tenant="${slug}"></div>\n<script src="${script}" async></script>`,
          offer_snippet: `<div data-amable-offer data-amable-tenant="${slug}"></div>\n<script src="${script}" async></script>`,
        },
        200,
      );
    },
  );
  registerCheckoutConnectionRoutes(app);
  registerEditLockRoutes(app, {
    kind: 'checkouts',
    basePath: '/checkouts',
    tag: 'Checkout edit lock',
    write: 'checkouts:write',
    read: 'checkouts:read',
    takeover: 'checkouts:write',
    exists: (c, id) => callCrm(c, 'checkouts.get', { id }),
  });
}

/** Config of a checkout connection validated against its type (create and full replacement). */
function checkedConfig(type: CheckoutConnection['type'], name: string, config: unknown): Record<string, unknown> {
  const parsed = createCheckoutConnectionSchema.safeParse({ type, name, secret: 'x', config });
  if (!parsed.success) {
    throw new CrmError(
      'validation_failed',
      'invalid configuration',
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return parsed.data.config;
}

function registerCheckoutConnectionRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(
    crmRoute('checkouts:read', {
      method: 'get',
      path: '/checkouts/{id}/connections',
      tags: connectionTags,
      summary: 'List the integrations of a checkout (access tokens are never returned)',
      request: { params },
      responses: { 200: json(z.object({ data: z.array(checkoutConnectionSchema) }), 'Integrations') },
    }),
    async (c) =>
      c.json({ data: await callCrm(c, 'checkoutConnections.list', { checkoutId: c.req.valid('param').id }) }, 200),
  );
  app.openapi(
    crmRoute(
      'checkouts:write',
      {
        method: 'post',
        path: '/checkouts/{id}/connections',
        tags: connectionTags,
        summary: 'Add a server-side conversion integration (Meta Conversions API, TikTok Events API)',
        request: { params, body: jsonBody(createCheckoutConnectionSchema) },
        responses: { 201: json(checkoutConnectionSchema, 'The integration') },
      },
      { stepUp: true },
    ),
    async (c) => {
      const checkoutId = c.req.valid('param').id;
      const body = c.req.valid('json');
      const id = ulid();
      const tenantId = getTenant(c).tenant.id;
      const connection = await callCrm(c, 'checkoutConnections.create', {
        id,
        checkoutId,
        type: body.type,
        name: body.name,
        enabled: body.enabled ?? true,
        config: body.config,
        secretCiphertext: await encryptSecret(c.get('services').secretBox, tenantId, id, body.secret),
        secretHint: secretHint(body.secret),
      });
      await audit(c, 'checkouts.connection_created', { target: id, details: { checkout_id: checkoutId, type: body.type } });
      return c.json(connection, 201);
    },
  );
  app.openapi(
    crmRoute(
      'checkouts:write',
      {
        method: 'patch',
        path: '/checkouts/{id}/connections/{connectionId}',
        tags: connectionTags,
        summary: 'Update an integration (config is replaced and validated against its type)',
        request: { params: checkoutConnectionParamSchema, body: jsonBody(updateCheckoutConnectionSchema) },
        responses: { 200: json(checkoutConnectionSchema, 'The integration') },
      },
      { stepUp: touchesConnectionSecrets },
    ),
    async (c) => {
      const { id: checkoutId, connectionId } = c.req.valid('param');
      const body = c.req.valid('json');
      const current = await callCrm(c, 'checkoutConnections.get', { checkoutId, id: connectionId });
      const tenantId = getTenant(c).tenant.id;
      const connection = await callCrm(c, 'checkoutConnections.update', {
        checkoutId,
        id: connectionId,
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
        ...(body.config === undefined
          ? {}
          : { config: checkedConfig(current.type, body.name ?? current.name, body.config) }),
        ...(body.secret === undefined
          ? {}
          : {
              secretHint: secretHint(body.secret),
              secretCiphertext: await encryptSecret(c.get('services').secretBox, tenantId, connectionId, body.secret),
            }),
      });
      await audit(c, 'checkouts.connection_updated', {
        target: connectionId,
        details: { checkout_id: checkoutId, secret_changed: body.secret !== undefined },
      });
      return c.json(connection, 200);
    },
  );
  app.openapi(
    crmRoute('checkouts:write', {
      method: 'delete',
      path: '/checkouts/{id}/connections/{connectionId}',
      tags: connectionTags,
      summary: 'Delete an integration',
      request: { params: checkoutConnectionParamSchema },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) => {
      const { id: checkoutId, connectionId } = c.req.valid('param');
      const result = await callCrm(c, 'checkoutConnections.delete', { checkoutId, id: connectionId });
      await audit(c, 'checkouts.connection_deleted', { target: connectionId, details: { checkout_id: checkoutId } });
      return c.json(result, 200);
    },
  );
  app.openapi(
    crmRoute('checkouts:write', {
      method: 'post',
      path: '/checkouts/{id}/connections/{connectionId}/test',
      tags: connectionTags,
      summary: 'Check the token, or send a sample Purchase to the Test Events tool when a test events code is set',
      request: { params: checkoutConnectionParamSchema },
      responses: { 200: json(connectionTestResultSchema, 'Test result') },
    }),
    async (c) => {
      const { id: checkoutId, connectionId } = c.req.valid('param');
      const connection = await callCrm(c, 'checkoutConnections.forWorker', { checkoutId, id: connectionId });
      const result = await testCheckoutConnection({
        runtime: await formsRuntime(c.env),
        tenantId: getTenant(c).tenant.id,
        connection,
      });
      await audit(c, 'checkouts.connection_tested', { target: connectionId, details: { checkout_id: checkoutId, status: result.status } });
      return c.json(result, 200);
    },
  );
}
