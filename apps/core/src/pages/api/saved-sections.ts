import { z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  createSavedSectionSchema,
  deletedResponseSchema,
  savedSectionSchema,
  updateSavedSectionSchema,
} from '@amable/api-types';
import { callCrm, crmRoute, json, jsonBody } from '../../crm/api/core';
import type { AppEnv } from '../../middleware';
import { sectionsTag, pageIdParam } from './shared';

export function registerSavedSectionsRoutes(router: OpenAPIHono<AppEnv>): void {
  router.openapi(
    crmRoute('pages:read', {
      method: 'get',
      path: '/savedSections',
      tags: sectionsTag,
      summary: 'Saved sections (reusable element subtrees)',
      responses: { 200: json(z.object({ data: z.array(savedSectionSchema) }), 'Saved sections') },
    }),
    async (c) => c.json(await callCrm(c, 'pages.listSavedSections', {} as never), 200),
  );
  router.openapi(
    crmRoute('pages:write', {
      method: 'post',
      path: '/savedSections',
      tags: sectionsTag,
      summary: 'Save an element subtree for reuse',
      request: { body: jsonBody(createSavedSectionSchema) },
      responses: { 201: json(savedSectionSchema, 'The saved section') },
    }),
    async (c) => c.json(await callCrm(c, 'pages.createSavedSection', c.req.valid('json')), 201),
  );
  router.openapi(
    crmRoute('pages:write', {
      method: 'patch',
      path: '/savedSections/{id}',
      tags: sectionsTag,
      summary: 'Rename, recategorize or replace a saved section',
      request: { params: pageIdParam, body: jsonBody(updateSavedSectionSchema) },
      responses: { 200: json(savedSectionSchema, 'The saved section') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'pages.updateSavedSection', {
          id: c.req.valid('param').id,
          data: c.req.valid('json'),
        }),
        200,
      ),
  );
  router.openapi(
    crmRoute('pages:write', {
      method: 'delete',
      path: '/savedSections/{id}',
      tags: sectionsTag,
      summary: 'Delete a saved section',
      request: { params: pageIdParam },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) =>
      c.json(await callCrm(c, 'pages.deleteSavedSection', { id: c.req.valid('param').id }), 200),
  );
}
