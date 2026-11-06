import type { OpenAPIHono } from '@hono/zod-openapi';
import { idParamSchema, invoiceSchema, listInvoicesQuerySchema, pageOf } from '@amable/api-types';
import type { AppEnv } from '../../middleware';
import { callCrm, crmRoute, json } from '../../crm/api/core';

export function registerInvoicesRoutes(app: OpenAPIHono<AppEnv>): void {
  const invoices = ['Invoices'];
  app.openapi(
    crmRoute('orders:read', {
      method: 'get',
      path: '/invoices',
      tags: invoices,
      summary: 'List invoices, newest number first',
      request: { query: listInvoicesQuerySchema },
      responses: { 200: json(pageOf(invoiceSchema), 'A page of invoices') },
    }),
    async (c) => c.json(await callCrm(c, 'invoices.list', c.req.valid('query')), 200),
  );
  app.openapi(
    crmRoute('orders:read', {
      method: 'get',
      path: '/invoices/{id}',
      tags: invoices,
      summary: 'Get an invoice',
      request: { params: idParamSchema },
      responses: { 200: json(invoiceSchema, 'The invoice') },
    }),
    async (c) => c.json(await callCrm(c, 'invoices.get', c.req.valid('param')), 200),
  );
}
