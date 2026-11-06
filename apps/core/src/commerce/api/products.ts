import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  createProductSchema,
  deletedResponseSchema,
  idParamSchema,
  listProductsQuerySchema,
  pageOf,
  productSchema,
  updateProductSchema,
} from '@amable/api-types';
import type { AppEnv } from '../../middleware';
import { callCrm, crmRoute, json, jsonBody } from '../../crm/api/core';

export function registerProductsRoutes(app: OpenAPIHono<AppEnv>): void {
  const products = ['Products'];
  app.openapi(
    crmRoute('products:read', {
      method: 'get',
      path: '/products',
      tags: products,
      summary: 'List products (by name) with their plans',
      request: { query: listProductsQuerySchema },
      responses: { 200: json(pageOf(productSchema), 'A page of products') },
    }),
    async (c) => c.json(await callCrm(c, 'products.list', c.req.valid('query')), 200),
  );
  app.openapi(
    crmRoute('products:write', {
      method: 'post',
      path: '/products',
      tags: products,
      summary: 'Create a product (optionally with subscription plans)',
      request: { body: jsonBody(createProductSchema) },
      responses: { 201: json(productSchema, 'The product') },
    }),
    async (c) => c.json(await callCrm(c, 'products.create', c.req.valid('json')), 201),
  );
  app.openapi(
    crmRoute('products:read', {
      method: 'get',
      path: '/products/{id}',
      tags: products,
      summary: 'Get a product',
      request: { params: idParamSchema },
      responses: { 200: json(productSchema, 'The product') },
    }),
    async (c) => c.json(await callCrm(c, 'products.get', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('products:write', {
      method: 'patch',
      path: '/products/{id}',
      tags: products,
      summary: 'Update a product',
      request: { params: idParamSchema, body: jsonBody(updateProductSchema) },
      responses: { 200: json(productSchema, 'The product') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'products.update', {
          id: c.req.valid('param').id,
          data: c.req.valid('json'),
        }),
        200,
      ),
  );
  app.openapi(
    crmRoute('products:write', {
      method: 'delete',
      path: '/products/{id}',
      tags: products,
      summary: 'Delete a product without live subscriptions',
      request: { params: idParamSchema },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) => c.json(await callCrm(c, 'products.delete', c.req.valid('param')), 200),
  );
}
