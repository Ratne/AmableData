import { z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  MEDIA_MAX_BYTES,
  deletedResponseSchema,
  listMediaQuerySchema,
  mediaFileSchema,
  pageOf,
  uploadMediaQuerySchema,
} from '@amable/api-types';
import { ulid } from 'ulid';
import { callCrm, crmRoute, json } from '../../crm/api/core';
import { audit, defer, getTenant, type AppEnv } from '../../middleware';
import { cleanFilename, mediaExtension, sniffImageType } from '../media';
import { mediaTag, pageIdParam, serializeMedia, errorJson } from './shared';

export function registerMediaRoutes(router: OpenAPIHono<AppEnv>): void {
  router.openapi(
    crmRoute('pages:read', {
      method: 'get',
      path: '/media',
      tags: mediaTag,
      summary: 'Media library, newest first',
      request: { query: listMediaQuerySchema },
      responses: { 200: json(pageOf(mediaFileSchema), 'Media files') },
    }),
    async (c) => {
      const page = await callCrm(c, 'pages.listMedia', c.req.valid('query'));
      return c.json(
        { data: page.rows.map((r) => serializeMedia(c, r)), next_cursor: page.next_cursor },
        200,
      );
    },
  );
  router.openapi(
    crmRoute('pages:write', {
      method: 'put',
      path: '/media',
      tags: mediaTag,
      summary:
        'Upload an image (raw body, max 10 MB; PNG, JPEG, GIF, WebP, AVIF detected from the content)',
      request: {
        query: uploadMediaQuerySchema,
        body: {
          required: true,
          content: {
            'application/octet-stream': { schema: z.string().openapi({ format: 'binary' }) },
          },
        },
      },
      responses: {
        201: json(mediaFileSchema, 'The uploaded file'),
        413: errorJson('Larger than 10 MB'),
        415: errorJson('Not a supported image'),
      },
    }),
    async (c) => {
      const declared = Number(c.req.header('content-length') ?? '0');
      if (declared > MEDIA_MAX_BYTES)
        return c.json({ error: 'payload_too_large', message: 'max 10 MB' }, 413);
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      if (bytes.byteLength > MEDIA_MAX_BYTES)
        return c.json({ error: 'payload_too_large', message: 'max 10 MB' }, 413);
      const type = sniffImageType(bytes);
      if (type === null) {
        return c.json(
          { error: 'unsupported_media_type', message: 'only PNG, JPEG, GIF, WebP and AVIF images' },
          415,
        );
      }
      const id = ulid();
      const file = `${id}.${mediaExtension(type)}`;
      const key = `tenants/${getTenant(c).tenant.id}/media/${file}`;
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const sha256 = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      await c.env.FILES.put(key, bytes, { httpMetadata: { contentType: type } });
      try {
        const row = await callCrm(c, 'pages.createMedia', {
          id,
          r2_key: key,
          file,
          filename: cleanFilename(c.req.valid('query').filename),
          content_type: type,
          size: bytes.byteLength,
          sha256,
        });
        await audit(c, 'pages.media_uploaded', { target: id });
        return c.json(serializeMedia(c, row), 201);
      } catch (error) {
        await c.env.FILES.delete(key).catch(() => undefined);
        throw error;
      }
    },
  );
  router.openapi(
    crmRoute('pages:write', {
      method: 'delete',
      path: '/media/{id}',
      tags: mediaTag,
      summary: 'Delete a media file (pages still using it show a broken image)',
      request: { params: pageIdParam },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) => {
      const row = await callCrm(c, 'pages.deleteMedia', { id: c.req.valid('param').id });
      await defer(c, c.env.FILES.delete(row.r2_key));
      return c.json({ id: row.id, deleted: true as const }, 200);
    },
  );
  router.openapi(
    crmRoute('pages:read', {
      method: 'get',
      path: '/media/{id}/content',
      tags: mediaTag,
      summary: 'The file itself (authenticated; for the editor library)',
      request: { params: pageIdParam },
      responses: { 200: { description: 'File bytes' } },
    }),
    async (c) => {
      const row = await callCrm(c, 'pages.getMedia', { id: c.req.valid('param').id });
      const object = await c.env.FILES.get(row.r2_key);
      if (object === null) return c.json({ error: 'not_found', message: 'file missing' }, 404);
      return new Response(object.body, {
        headers: {
          'content-type': row.content_type,
          'content-length': String(row.size),
          'x-content-type-options': 'nosniff',
          'content-disposition': `inline; filename="${row.filename.replace(/[^\x20-\x7e]|"/g, '_')}"`,
          'cache-control': 'private, max-age=3600',
        },
      }) as never;
    },
  );
}
