import { z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  clipboardItemSchema,
  createClipboardItemSchema,
  deletedResponseSchema,
} from '@amable/api-types';
import { callCrm, crmRoute, json, jsonBody } from '../../crm/api/core';
import type { AppEnv } from '../../middleware';
import { clipboardTag, pageIdParam } from './shared';

export function registerPersonalClipboardRoutes(router: OpenAPIHono<AppEnv>): void {
  router.openapi(
    crmRoute('pages:read', {
      method: 'get',
      path: '/builderClipboard',
      tags: clipboardTag,
      summary: "The caller's builder clipboard (last 24 hours, newest first)",
      responses: {
        200: json(z.object({ data: z.array(clipboardItemSchema) }), 'Clipboard entries'),
      },
    }),
    async (c) => c.json(await callCrm(c, 'pages.clipboard.list', {} as never), 200),
  );
  router.openapi(
    crmRoute('pages:write', {
      method: 'post',
      path: '/builderClipboard',
      tags: clipboardTag,
      summary: 'Copy blocks to the caller clipboard',
      request: { body: jsonBody(createClipboardItemSchema) },
      responses: { 201: json(clipboardItemSchema, 'The clipboard entry') },
    }),
    async (c) => c.json(await callCrm(c, 'pages.clipboard.create', c.req.valid('json')), 201),
  );
  router.openapi(
    crmRoute('pages:write', {
      method: 'delete',
      path: '/builderClipboard',
      tags: clipboardTag,
      summary: 'Empty the caller clipboard',
      responses: { 200: json(z.object({ deleted: z.number().int() }), 'Emptied') },
    }),
    async (c) => c.json(await callCrm(c, 'pages.clipboard.clear', {} as never), 200),
  );
  router.openapi(
    crmRoute('pages:write', {
      method: 'delete',
      path: '/builderClipboard/{id}',
      tags: clipboardTag,
      summary: 'Remove one clipboard entry',
      request: { params: pageIdParam },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) =>
      c.json(await callCrm(c, 'pages.clipboard.delete', { id: c.req.valid('param').id }), 200),
  );
}
