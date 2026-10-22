import { z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  checkoutEmbedSchema,
  checkoutSchema,
  checkoutSummarySchema,
  createCheckoutSchema,
  deletedResponseSchema,
  idSchema,
  listCheckoutsQuerySchema,
  pageOf,
  updateCheckoutSchema,
} from '@amable/api-types';
import { callCrm, crmRoute, json, jsonBody } from '../crm/api/core';
import { assertEditable, LOCKED_RESPONSE, registerEditLockRoutes } from '../edit-lock/routes';
import { audit, getTenant, type AppEnv } from '../middleware';

const tags = ['Checkouts'];
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
      const slug = getTenant(c).tenant.slug;
      const edge = (c.env.EDGE_ORIGIN ?? 'http://localhost:8788').replace(/\/+$/, '');
      const script = `${edge}/checkout.js`;
      return c.json(
        {
          checkout_id: checkout.id,
          tenant: slug,
          script_url: script,
          hosted_url: `${edge}/c/${slug}/${checkout.id}`,
          snippet: `<div data-amable-checkout="${checkout.id}" data-amable-tenant="${slug}"></div>\n<script src="${script}" async></script>`,
          offer_snippet: `<div data-amable-offer data-amable-tenant="${slug}"></div>\n<script src="${script}" async></script>`,
        },
        200,
      );
    },
  );
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
