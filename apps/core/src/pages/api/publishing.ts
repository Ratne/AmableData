import { z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  landingPageDetailSchema,
  pageVersionSchema,
  publishPageResponseSchema,
  publishPageSchema,
} from '@amable/api-types';
import { callCrm, crmRoute, json } from '../../crm/api/core';
import { assertEditable, LOCKED_RESPONSE } from '../../edit-lock/routes';
import { audit, type AppEnv } from '../../middleware';
import { pagesTag, pageIdParam, versionParam, withUrl } from './shared';

export function registerPublishingRoutes(router: OpenAPIHono<AppEnv>): void {
  router.openapi(
    crmRoute('pages:publish', {
      method: 'post',
      path: '/pages/{id}/publish',
      tags: pagesTag,
      summary: 'Publish the current draft as a new version',
      request: {
        params: pageIdParam,
        body: { required: false, content: { 'application/json': { schema: publishPageSchema } } },
      },
      responses: {
        200: json(publishPageResponseSchema, 'Published page and version'),
        ...LOCKED_RESPONSE,
      },
    }),
    async (c) => {
      const raw: unknown = await c.req.json().catch(() => ({}));
      const parsed = publishPageSchema.safeParse(raw ?? {});
      const note = parsed.success ? parsed.data.note : undefined;
      const { id } = c.req.valid('param');
      await assertEditable(c, 'pages', id);
      const result = await callCrm(c, 'pages.publish', {
        id,
        ...(note === undefined ? {} : { note }),
      });
      await audit(c, 'pages.page_published', {
        target: id,
        details: { version: result.version.version },
      });
      return c.json({ page: withUrl(c, result.page), version: result.version }, 200);
    },
  );
  router.openapi(
    crmRoute('pages:publish', {
      method: 'post',
      path: '/pages/{id}/unpublish',
      tags: pagesTag,
      summary: 'Take the page offline (versions are kept)',
      request: { params: pageIdParam },
      responses: { 200: json(landingPageDetailSchema, 'The page'), ...LOCKED_RESPONSE },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      await assertEditable(c, 'pages', id);
      const page = await callCrm(c, 'pages.unpublish', { id });
      await audit(c, 'pages.page_unpublished', { target: id });
      return c.json(withUrl(c, page) as never, 200);
    },
  );
  router.openapi(
    crmRoute('pages:read', {
      method: 'get',
      path: '/pages/{id}/versions',
      tags: pagesTag,
      summary: 'Published versions, newest first',
      request: { params: pageIdParam },
      responses: { 200: json(z.object({ data: z.array(pageVersionSchema) }), 'Versions') },
    }),
    async (c) => c.json(await callCrm(c, 'pages.versions', { id: c.req.valid('param').id }), 200),
  );
  router.openapi(
    crmRoute('pages:write', {
      method: 'post',
      path: '/pages/{id}/versions/{versionId}/restore',
      tags: pagesTag,
      summary: 'Replace the draft with a published version (publish again to go live)',
      request: { params: versionParam },
      responses: { 200: json(landingPageDetailSchema, 'The page'), ...LOCKED_RESPONSE },
    }),
    async (c) => {
      const { id, versionId } = c.req.valid('param');
      await assertEditable(c, 'pages', id);
      return c.json(
        withUrl(c, await callCrm(c, 'pages.restoreVersion', { id, versionId })) as never,
        200,
      );
    },
  );
}
