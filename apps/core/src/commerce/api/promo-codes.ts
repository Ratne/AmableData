import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  createPromoCodeSchema,
  deletedResponseSchema,
  idParamSchema,
  pageOf,
  pageQuerySchema,
  promoCodeSchema,
  updatePromoCodeSchema,
} from '@amable/api-types';
import type { AppEnv } from '../../middleware';
import { callCrm, crmRoute, json, jsonBody } from '../../crm/api/core';
import { activeQuery } from './shared';

export function registerPromoCodesRoutes(app: OpenAPIHono<AppEnv>): void {
  const promos = ['Promo codes'];
  app.openapi(
    crmRoute('products:read', {
      method: 'get',
      path: '/promoCodes',
      tags: promos,
      summary: 'List promo codes',
      request: { query: pageQuerySchema.extend(activeQuery.shape) },
      responses: { 200: json(pageOf(promoCodeSchema), 'A page of promo codes') },
    }),
    async (c) => c.json(await callCrm(c, 'promoCodes.list', c.req.valid('query')), 200),
  );
  app.openapi(
    crmRoute('products:write', {
      method: 'post',
      path: '/promoCodes',
      tags: promos,
      summary: 'Create a promo code (percent or fixed, limits and validity window)',
      request: { body: jsonBody(createPromoCodeSchema) },
      responses: { 201: json(promoCodeSchema, 'The promo code') },
    }),
    async (c) => c.json(await callCrm(c, 'promoCodes.create', c.req.valid('json')), 201),
  );
  app.openapi(
    crmRoute('products:read', {
      method: 'get',
      path: '/promoCodes/{id}',
      tags: promos,
      summary: 'Get a promo code',
      request: { params: idParamSchema },
      responses: { 200: json(promoCodeSchema, 'The promo code') },
    }),
    async (c) => c.json(await callCrm(c, 'promoCodes.get', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('products:write', {
      method: 'patch',
      path: '/promoCodes/{id}',
      tags: promos,
      summary: 'Update a promo code (code and kind are immutable)',
      request: { params: idParamSchema, body: jsonBody(updatePromoCodeSchema) },
      responses: { 200: json(promoCodeSchema, 'The promo code') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'promoCodes.update', {
          id: c.req.valid('param').id,
          data: c.req.valid('json'),
        }),
        200,
      ),
  );
  app.openapi(
    crmRoute('products:write', {
      method: 'delete',
      path: '/promoCodes/{id}',
      tags: promos,
      summary: 'Delete a promo code',
      request: { params: idParamSchema },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) => c.json(await callCrm(c, 'promoCodes.delete', c.req.valid('param')), 200),
  );
}
