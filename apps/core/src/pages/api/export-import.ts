import { z, type OpenAPIHono } from '@hono/zod-openapi';
import { MEDIA_MAX_BYTES, importPageResponseSchema } from '@amable/api-types';
import { ulid } from 'ulid';
import { callCrm, crmRoute, json } from '../../crm/api/core';
import { audit, getTenant, type AppEnv } from '../../middleware';
import type { MediaRow } from '../library';
import { cleanFilename, mediaExtension, sniffImageType } from '../media';
import {
  collectMediaFiles,
  countRelinkEmbeds,
  mapStrings,
  PAGE_EXPORT_FORMAT,
  PAGE_EXPORT_VERSION,
  PAGE_IMPORT_MAX_BYTES,
  PageArchiveError,
  readArchiveEntry,
  readPageManifest,
  retargetString,
  streamPageExport,
  type PageManifest,
} from '../transfer';
import { edgeOrigin } from '../../env';
import { sha256Hex } from '@amable/auth';
import { pagesTag, pageIdParam, withUrl, errorJson, exportFileName } from './shared';

export function registerExportImportRoutes(router: OpenAPIHono<AppEnv>): void {
  router.openapi(
    crmRoute('pages:read', {
      method: 'get',
      path: '/pages/{id}/export',
      tags: pagesTag,
      summary:
        'Download the draft as a .zip (document, SEO, settings, library images) to import into any installation',
      request: { params: pageIdParam },
      responses: { 200: { description: 'application/zip archive' } },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const page = await callCrm(c, 'pages.get', { id });
      const files = collectMediaFiles([page.draft, page.seo, page.settings]);
      const media = files.length === 0 ? [] : await callCrm(c, 'pages.mediaByFiles', { files });
      await audit(c, 'pages.page_exported', { target: id, details: { media: media.length } });
      const stream = streamPageExport({
        bucket: c.env.FILES,
        manifest: {
          format: PAGE_EXPORT_FORMAT,
          version: PAGE_EXPORT_VERSION,
          exported_at: new Date().toISOString(),
          source: {
            slug: getTenant(c).tenant.slug,
            edge_origin: edgeOrigin(c.env),
            page_id: page.id,
          },
          page: {
            title: page.title,
            path: page.path,
            document: page.draft,
            seo: page.seo,
            settings: page.settings,
          },
        },
        media,
      });
      return new Response(stream, {
        headers: {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="${exportFileName(page)}"`,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      }) as never;
    },
  );
  router.openapi(
    crmRoute('pages:write', {
      method: 'post',
      path: '/pages/import',
      tags: pagesTag,
      summary:
        'Create a draft from a page export (.zip): images join the library, forms/bookings/checkouts must be relinked',
      request: {
        body: {
          required: true,
          content: { 'application/zip': { schema: z.string().openapi({ format: 'binary' }) } },
        },
      },
      responses: {
        201: json(importPageResponseSchema, 'The imported page and what needs attention'),
        400: errorJson('Not a landing page export'),
        413: errorJson(`Larger than ${PAGE_IMPORT_MAX_BYTES} bytes`),
      },
    }),
    async (c) => {
      const tooLarge = {
        error: 'payload_too_large',
        message: `max ${Math.floor(PAGE_IMPORT_MAX_BYTES / 1024 / 1024)} MB`,
      };
      if (Number(c.req.header('content-length') ?? '0') > PAGE_IMPORT_MAX_BYTES)
        return c.json(tooLarge, 413);
      const archive = new Uint8Array(await c.req.arrayBuffer());
      if (archive.byteLength > PAGE_IMPORT_MAX_BYTES) return c.json(tooLarge, 413);
      let manifest: PageManifest;
      try {
        manifest = readPageManifest(archive);
      } catch (error) {
        if (error instanceof PageArchiveError)
          return c.json({ error: 'invalid_archive', message: error.message }, 400);
        throw error;
      }

      const slug = getTenant(c).tenant.slug;
      const files = new Map<string, string>();
      const created: MediaRow[] = [];
      const missing: string[] = [];
      let reused = 0;
      try {
        for (const entry of manifest.media) {
          if (files.has(entry.file)) continue;
          const bytes = readArchiveEntry(archive, `media/${entry.file}`, MEDIA_MAX_BYTES);
          const type = bytes === null ? null : sniffImageType(bytes);
          if (bytes === null || type === null || (await sha256Hex(bytes)) !== entry.sha256) {
            missing.push(entry.filename);
            continue;
          }
          const existing = await callCrm(c, 'pages.mediaBySha', { sha256: entry.sha256 });
          if (existing !== null) {
            files.set(entry.file, existing.file);
            reused += 1;
            continue;
          }
          const mediaId = ulid();
          const file = `${mediaId}.${mediaExtension(type)}`;
          const key = `tenants/${getTenant(c).tenant.id}/media/${file}`;
          await c.env.FILES.put(key, bytes, { httpMetadata: { contentType: type } });
          created.push(
            await callCrm(c, 'pages.createMedia', {
              id: mediaId,
              r2_key: key,
              file,
              filename: cleanFilename(entry.filename),
              content_type: type,
              size: bytes.byteLength,
              sha256: entry.sha256,
            }),
          );
          files.set(entry.file, file);
        }

        const id = ulid();
        const retarget = (s: string) =>
          retargetString(s, {
            from: {
              edge: manifest.source.edge_origin,
              slug: manifest.source.slug,
              pageId: manifest.source.page_id,
            },
            to: { edge: edgeOrigin(c.env), slug, pageId: id },
            files,
          });
        const result = await callCrm(c, 'pages.import', {
          id,
          title: manifest.page.title,
          path: manifest.page.path,
          document: mapStrings(manifest.page.document, retarget),
          seo: mapStrings(manifest.page.seo, retarget),
          settings: mapStrings(manifest.page.settings, retarget),
        });
        await audit(c, 'pages.page_imported', {
          target: id,
          details: {
            source: manifest.source.slug,
            media_imported: created.length,
            media_reused: reused,
          },
        });
        return c.json(
          {
            page: withUrl(c, result.page),
            media_imported: created.length,
            media_reused: reused,
            warnings: {
              relink: countRelinkEmbeds(result.page.draft),
              media_missing: missing,
              media_skipped: manifest.media_skipped,
              path_renamed: result.path_renamed,
              analytics_disconnected: result.analytics_disconnected,
            },
          } as never,
          201,
        );
      } catch (error) {
        for (const row of created) {
          await callCrm(c, 'pages.deleteMedia', { id: row.id }).catch(() => undefined);
          await c.env.FILES.delete(row.r2_key).catch(() => undefined);
        }
        throw error;
      }
    },
  );
}
