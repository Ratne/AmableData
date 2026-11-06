import { z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  createProductCategorySchema,
  deletedResponseSchema,
  idParamSchema,
  productCategorySchema,
  updateProductCategorySchema,
} from '@amable/api-types';
import type { AppEnv } from '../../middleware';
import { callCrm, crmRoute, json, jsonBody } from '../../crm/api/core';

export function registerCategoriesRoutes(app: OpenAPIHono<AppEnv>): void {
  const categories = ['Product categories'];
  app.openapi(
    crmRoute('products:read', {
      method: 'get',
      path: '/productCategories',
      tags: categories,
      summary: 'List product categories',
      responses: { 200: json(z.object({ data: z.array(productCategorySchema) }), 'Categories') },
    }),
    async (c) => c.json({ data: await callCrm(c, 'productCategories.list', {}) }, 200),
  );
  app.openapi(
    crmRoute('products:write', {
      method: 'post',
      path: '/productCategories',
      tags: categories,
      summary: 'Create a product category',
      request: { body: jsonBody(createProductCategorySchema) },
      responses: { 201: json(productCategorySchema, 'The category') },
    }),
    async (c) => c.json(await callCrm(c, 'productCategories.create', c.req.valid('json')), 201),
  );
  app.openapi(
    crmRoute('products:read', {
      method: 'get',
      path: '/productCategories/{id}',
      tags: categories,
      summary: 'Get a product category',
      request: { params: idParamSchema },
      responses: { 200: json(productCategorySchema, 'The category') },
    }),
    async (c) => c.json(await callCrm(c, 'productCategories.get', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('products:write', {
      method: 'patch',
      path: '/productCategories/{id}',
      tags: categories,
      summary: 'Update a product category',
      request: { params: idParamSchema, body: jsonBody(updateProductCategorySchema) },
      responses: { 200: json(productCategorySchema, 'The category') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'productCategories.update', {
          id: c.req.valid('param').id,
          data: c.req.valid('json'),
        }),
        200,
      ),
  );
  app.openapi(
    crmRoute('products:write', {
      method: 'delete',
      path: '/productCategories/{id}',
      tags: categories,
      summary: 'Delete a product category (its products become uncategorized)',
      request: { params: idParamSchema },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) => c.json(await callCrm(c, 'productCategories.delete', c.req.valid('param')), 200),
  );
}
