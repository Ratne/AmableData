import { z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  errorResponseSchema,
  pagePreviewSchema,
  savePageDraftResponseSchema,
  savePageDraftSchema,
} from '@amable/api-types';
import { callCrm, crmRoute, json, jsonBody } from '../../crm/api/core';
import { assertEditable, LOCKED_RESPONSE } from '../../edit-lock/routes';
import { getTenant, type AppEnv } from '../../middleware';
import { edgeOrigin } from '../../env';
import { pagesTag, pageIdParam, renderDraft } from './shared';

export function registerDraftRoutes(router: OpenAPIHono<AppEnv>): void {
  router.openapi(
    crmRoute('pages:write', {
      method: 'put',
      path: '/pages/{id}/draft',
      tags: pagesTag,
      summary:
        'Save the draft document (optimistic concurrency on base_revision; needs the edit lock)',
      request: { params: pageIdParam, body: jsonBody(savePageDraftSchema) },
      responses: {
        200: json(savePageDraftResponseSchema, 'New draft revision'),
        409: json(
          errorResponseSchema.extend({ draft_revision: z.number().int() }),
          'The draft moved on (`stale_draft`)',
        ),
        ...LOCKED_RESPONSE,
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      await assertEditable(c, 'pages', id);
      const result = await callCrm(c, 'pages.saveDraft', {
        id,
        document: body.document,
        base_revision: body.base_revision,
      });
      if (!result.ok) {
        return c.json(
          {
            error: 'stale_draft',
            message: `the draft is at revision ${result.draft_revision}`,
            draft_revision: result.draft_revision,
          },
          409,
        );
      }
      return c.json({ draft_revision: result.draft_revision }, 200);
    },
  );
  router.openapi(
    crmRoute('pages:read', {
      method: 'get',
      path: '/pages/{id}/preview',
      tags: pagesTag,
      summary: 'Draft rendered as the public page (show it in a sandboxed iframe)',
      request: { params: pageIdParam },
      responses: { 200: json(pagePreviewSchema, 'Rendered HTML') },
    }),
    async (c) => {
      const page = await callCrm(c, 'pages.get', { id: c.req.valid('param').id });
      const slug = getTenant(c).tenant.slug;
      return c.json({ html: renderDraft(page, slug, edgeOrigin(c.env)) }, 200);
    },
  );
}
