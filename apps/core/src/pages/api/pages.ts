import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  createPageSchema,
  deletedResponseSchema,
  duplicatePageSchema,
  landingPageDetailSchema,
  landingPageSchema,
  listPagesQuerySchema,
  pageOf,
  updatePageSchema,
} from '@amable/api-types';
import { callCrm, crmRoute, json, jsonBody } from '../../crm/api/core';
import { invalidMany } from '../../crm/errors';
import { assertEditable, LOCKED_RESPONSE } from '../../edit-lock/routes';
import { audit, type AppEnv } from '../../middleware';
import { pagesTag, pageIdParam, withUrl } from './shared';

export function registerPageRecordRoutes(router: OpenAPIHono<AppEnv>): void {
  router.openapi(
    crmRoute('pages:read', {
      method: 'get',
      path: '/pages',
      tags: pagesTag,
      summary: 'List landing pages (soft-deleted ones with status=deleted)',
      request: { query: listPagesQuerySchema },
      responses: { 200: json(pageOf(landingPageSchema), 'Pages') },
    }),
    async (c) => {
      const page = await callCrm(c, 'pages.list', c.req.valid('query'));
      return c.json(
        { data: page.data.map((p) => withUrl(c, p)), next_cursor: page.next_cursor },
        200,
      );
    },
  );
  router.openapi(
    crmRoute('pages:write', {
      method: 'post',
      path: '/pages',
      tags: pagesTag,
      summary: 'Create a draft page (without a document: one empty container)',
      request: { body: jsonBody(createPageSchema) },
      responses: { 201: json(landingPageDetailSchema, 'The page') },
    }),
    async (c) => {
      const page = await callCrm(c, 'pages.create', c.req.valid('json'));
      await audit(c, 'pages.page_created', { target: page.id });
      return c.json(withUrl(c, page) as never, 201);
    },
  );
  router.openapi(
    crmRoute('pages:read', {
      method: 'get',
      path: '/pages/{id}',
      tags: pagesTag,
      summary: 'Get a page with its draft document and revision',
      request: { params: pageIdParam },
      responses: { 200: json(landingPageDetailSchema, 'The page') },
    }),
    async (c) =>
      c.json(
        withUrl(c, await callCrm(c, 'pages.get', { id: c.req.valid('param').id })) as never,
        200,
      ),
  );
  router.openapi(
    crmRoute('pages:write', {
      method: 'patch',
      path: '/pages/{id}',
      tags: pagesTag,
      summary: 'Update title, path, host, SEO or settings (live only after the next publish)',
      request: { params: pageIdParam, body: jsonBody(updatePageSchema) },
      responses: { 200: json(landingPageDetailSchema, 'The page'), ...LOCKED_RESPONSE },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      await assertEditable(c, 'pages', id);
      const page = await callCrm(c, 'pages.update', { id, data: c.req.valid('json') });
      return c.json(withUrl(c, page) as never, 200);
    },
  );
  router.openapi(
    crmRoute('pages:write', {
      method: 'delete',
      path: '/pages/{id}',
      tags: pagesTag,
      summary: 'Soft-delete a page (it stops being served; restorable)',
      request: { params: pageIdParam },
      responses: { 200: json(deletedResponseSchema, 'Deleted'), ...LOCKED_RESPONSE },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      await assertEditable(c, 'pages', id);
      const result = await callCrm(c, 'pages.delete', { id });
      await audit(c, 'pages.page_deleted', { target: id });
      return c.json(result, 200);
    },
  );
  router.openapi(
    crmRoute('pages:write', {
      method: 'post',
      path: '/pages/{id}/restore',
      tags: pagesTag,
      summary: 'Restore a soft-deleted page as a draft',
      request: { params: pageIdParam },
      responses: { 200: json(landingPageDetailSchema, 'The page') },
    }),
    async (c) =>
      c.json(
        withUrl(c, await callCrm(c, 'pages.restore', { id: c.req.valid('param').id })) as never,
        200,
      ),
  );
  router.openapi(
    crmRoute('pages:write', {
      method: 'post',
      path: '/pages/{id}/duplicate',
      tags: pagesTag,
      summary:
        'Copy a page (draft, SEO, settings) into a new draft; path defaults to `<path>-copy`',
      request: {
        params: pageIdParam,
        body: { required: false, content: { 'application/json': { schema: duplicatePageSchema } } },
      },
      responses: { 201: json(landingPageDetailSchema, 'The copy') },
    }),
    async (c) => {
      const raw: unknown = await c.req.json().catch(() => ({}));
      const parsed = duplicatePageSchema.safeParse(raw ?? {});
      if (!parsed.success) {
        throw invalidMany(
          parsed.error.issues.map((i) => ({
            path: i.path.map(String).join('.'),
            message: i.message,
          })),
        );
      }
      const page = await callCrm(c, 'pages.duplicate', {
        id: c.req.valid('param').id,
        ...parsed.data,
      });
      return c.json(withUrl(c, page) as never, 201);
    },
  );
}
