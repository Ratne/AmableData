import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  activitySchema,
  companySchema,
  createCompanySchema,
  deletedResponseSchema,
  idParamSchema,
  listCompaniesQuerySchema,
  pageOf,
  pageQuerySchema,
  updateCompanySchema,
} from '@amable/api-types';
import type { AppEnv } from '../../../middleware';
import { callCrm, crmRoute, json, jsonBody } from '../core';

export function registerCompaniesRoutes(app: OpenAPIHono<AppEnv>): void {
  const companies = ['Companies'];
  app.openapi(
    crmRoute('contacts:read', {
      method: 'get',
      path: '/companies',
      tags: companies,
      summary: 'List companies',
      request: { query: listCompaniesQuerySchema },
      responses: { 200: json(pageOf(companySchema), 'A page of companies, by name') },
    }),
    async (c) => c.json(await callCrm(c, 'companies.list', c.req.valid('query')), 200),
  );
  app.openapi(
    crmRoute('contacts:write', {
      method: 'post',
      path: '/companies',
      tags: companies,
      summary: 'Create a company',
      request: { body: jsonBody(createCompanySchema) },
      responses: { 201: json(companySchema, 'The company') },
    }),
    async (c) => c.json(await callCrm(c, 'companies.create', c.req.valid('json')), 201),
  );
  app.openapi(
    crmRoute('contacts:read', {
      method: 'get',
      path: '/companies/{id}',
      tags: companies,
      summary: 'Get a company',
      request: { params: idParamSchema },
      responses: { 200: json(companySchema, 'The company') },
    }),
    async (c) => c.json(await callCrm(c, 'companies.get', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('contacts:write', {
      method: 'patch',
      path: '/companies/{id}',
      tags: companies,
      summary: 'Update a company',
      request: { params: idParamSchema, body: jsonBody(updateCompanySchema) },
      responses: { 200: json(companySchema, 'The company') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'companies.update', {
          id: c.req.valid('param').id,
          data: c.req.valid('json'),
        }),
        200,
      ),
  );
  app.openapi(
    crmRoute('contacts:write', {
      method: 'delete',
      path: '/companies/{id}',
      tags: companies,
      summary: 'Soft-delete a company',
      request: { params: idParamSchema },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) => c.json(await callCrm(c, 'companies.delete', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('contacts:write', {
      method: 'post',
      path: '/companies/{id}/restore',
      tags: companies,
      summary: 'Restore a company',
      request: { params: idParamSchema },
      responses: { 200: json(companySchema, 'The company') },
    }),
    async (c) => c.json(await callCrm(c, 'companies.restore', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('contacts:read', {
      method: 'get',
      path: '/companies/{id}/timeline',
      tags: companies,
      summary: 'Activity timeline of a company',
      request: { params: idParamSchema, query: pageQuerySchema },
      responses: { 200: json(pageOf(activitySchema), 'Activities, newest first') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'timeline', {
          subject: 'company',
          id: c.req.valid('param').id,
          ...c.req.valid('query'),
        }),
        200,
      ),
  );
}
