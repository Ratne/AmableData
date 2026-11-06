import { z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  cancelOrderSchema,
  createOrderSchema,
  deletedResponseSchema,
  idParamSchema,
  listOrdersQuerySchema,
  orderItemInputSchema,
  orderItemParamSchema,
  orderItemSchema,
  orderSchema,
  pageOf,
  updateOrderSchema,
} from '@amable/api-types';
import type { AppEnv } from '../../middleware';
import { callCrm, crmRoute, json, jsonBody } from '../../crm/api/core';

export function registerOrdersRoutes(app: OpenAPIHono<AppEnv>): void {
  const orders = ['Orders'];
  app.openapi(
    crmRoute('orders:read', {
      method: 'get',
      path: '/orders',
      tags: orders,
      summary: 'List orders, newest order date first',
      description:
        '`q` uses the full-text index (number, contact, items, SKUs, promo code, notes).',
      request: { query: listOrdersQuerySchema },
      responses: { 200: json(pageOf(orderSchema), 'A page of orders') },
    }),
    async (c) => c.json(await callCrm(c, 'orders.list', c.req.valid('query')), 200),
  );
  app.openapi(
    crmRoute('orders:write', {
      method: 'post',
      path: '/orders',
      tags: orders,
      summary: 'Create an order (manual or API; no checkout)',
      description:
        'Totals are computed server-side in integer minor units. Unless `status` is `draft`, the order is finalized: promo redemption recorded, invoice issued, `order.created` emitted.',
      request: { body: jsonBody(createOrderSchema) },
      responses: { 201: json(orderSchema, 'The order') },
    }),
    async (c) => c.json(await callCrm(c, 'orders.create', c.req.valid('json')), 201),
  );
  app.openapi(
    crmRoute('orders:read', {
      method: 'get',
      path: '/orders/{id}',
      tags: orders,
      summary: 'Get an order',
      request: { params: idParamSchema },
      responses: { 200: json(orderSchema, 'The order') },
    }),
    async (c) => c.json(await callCrm(c, 'orders.get', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('orders:write', {
      method: 'patch',
      path: '/orders/{id}',
      tags: orders,
      summary:
        'Update an order (drafts: everything; finalized: notes, owner, company, due date, custom fields)',
      request: { params: idParamSchema, body: jsonBody(updateOrderSchema) },
      responses: { 200: json(orderSchema, 'The order') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'orders.update', {
          id: c.req.valid('param').id,
          data: c.req.valid('json'),
        }),
        200,
      ),
  );
  app.openapi(
    crmRoute('orders:write', {
      method: 'delete',
      path: '/orders/{id}',
      tags: orders,
      summary: 'Delete a draft order (finalized orders are cancelled instead)',
      request: { params: idParamSchema },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) => c.json(await callCrm(c, 'orders.delete', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('orders:write', {
      method: 'post',
      path: '/orders/{id}/finalize',
      tags: orders,
      summary: 'Finalize a draft: issue the invoice and emit order.created',
      request: { params: idParamSchema },
      responses: { 200: json(orderSchema, 'The order') },
    }),
    async (c) => c.json(await callCrm(c, 'orders.finalize', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('orders:write', {
      method: 'post',
      path: '/orders/{id}/cancel',
      tags: orders,
      summary: 'Cancel an order holding no money (voids the invoice, releases the promo code)',
      request: { params: idParamSchema, body: jsonBody(cancelOrderSchema) },
      responses: { 200: json(orderSchema, 'The order') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'orders.cancel', {
          id: c.req.valid('param').id,
          data: c.req.valid('json'),
        }),
        200,
      ),
  );
  app.openapi(
    crmRoute('orders:read', {
      method: 'get',
      path: '/orders/{id}/items',
      tags: orders,
      summary: 'Lines of an order',
      request: { params: idParamSchema },
      responses: { 200: json(z.object({ data: z.array(orderItemSchema) }), 'Order lines') },
    }),
    async (c) => c.json(await callCrm(c, 'orders.items', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('orders:write', {
      method: 'post',
      path: '/orders/{id}/items',
      tags: orders,
      summary: 'Add a line to a draft order',
      request: { params: idParamSchema, body: jsonBody(orderItemInputSchema) },
      responses: { 201: json(orderSchema, 'The re-priced order') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'orders.addItem', {
          id: c.req.valid('param').id,
          data: c.req.valid('json'),
        }),
        201,
      ),
  );
  app.openapi(
    crmRoute('orders:write', {
      method: 'delete',
      path: '/orders/{id}/items/{itemId}',
      tags: orders,
      summary: 'Remove a line from a draft order',
      request: { params: orderItemParamSchema },
      responses: { 200: json(orderSchema, 'The re-priced order') },
    }),
    async (c) => c.json(await callCrm(c, 'orders.removeItem', c.req.valid('param')), 200),
  );
}
