import { z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  MEDIA_MAX_BYTES,
  createPageSchema,
  createSavedSectionSchema,
  deletedResponseSchema,
  duplicatePageSchema,
  errorResponseSchema,
  idSchema,
  importPageResponseSchema,
  landingPageDetailSchema,
  landingPageSchema,
  listMediaQuerySchema,
  listPagesQuerySchema,
  mediaFileSchema,
  pageOf,
  pagePreviewSchema,
  pageVersionSchema,
  publishPageResponseSchema,
  publishPageSchema,
  savePageDraftResponseSchema,
  savePageDraftSchema,
  savedSectionSchema,
  updatePageSchema,
  updateSavedSectionSchema,
  uploadMediaQuerySchema,
  type LandingPage,
  type MediaFile,
} from '@amable/api-types';
import { renderBuilderDocumentHtml } from '@amable/builder';
import type { Context } from 'hono';
import { ulid } from 'ulid';
import { callCrm, crmRoute, json, jsonBody } from '../crm/api/core';
import { invalidMany } from '../crm/errors';
import { assertEditable, LOCKED_RESPONSE, registerEditLockRoutes } from '../edit-lock/routes';
import { registerFolderRoutes } from '../folders/routes';
import { audit, defer, getTenant, type AppEnv } from '../middleware';
import type { MediaRow } from './library';
import { cleanFilename, mediaExtension, sniffImageType } from './media';
import type { PageDetailRecord, PageRecord } from './pages';
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
  sha256Hex,
  streamPageExport,
  type PageManifest,
} from './transfer';

type Ctx = Context<AppEnv>;

const pagesTag = ['Landing pages'];
const sectionsTag = ['Saved sections'];
const mediaTag = ['Media'];

const pageIdParam = z.object({ id: idSchema });
const versionParam = z.object({ id: idSchema, versionId: idSchema });

export function edgeOrigin(c: Ctx): string {
  return (c.env.EDGE_ORIGIN ?? 'http://localhost:8788').replace(/\/+$/, '');
}

/** `https://<host><path>` once a domain is connected, else the edge fallback `/p/<slug><path>`. */
export function publicUrl(edge: string, slug: string, page: Pick<PageRecord, 'host' | 'path'>): string {
  if (page.host !== null) return `https://${page.host}${page.path}`;
  return `${edge}/p/${slug}${page.path === '/' ? '' : page.path}`;
}

function withUrl<T extends PageRecord>(c: Ctx, page: T): T & { public_url: string } {
  return { ...page, public_url: publicUrl(edgeOrigin(c), getTenant(c).tenant.slug, page) };
}

function serializeMedia(c: Ctx, row: MediaRow): MediaFile {
  const slug = getTenant(c).tenant.slug;
  return {
    id: row.id,
    filename: row.filename,
    content_type: row.content_type,
    size: row.size,
    url: `${edgeOrigin(c)}/m/${slug}/${row.file}`,
    preview_url: `/api/v2/t/${slug}/media/${row.id}/content`,
    created_at: new Date(row.created_at).toISOString(),
  };
}

const errorJson = (description: string) => json(errorResponseSchema, description);

/** Landing pages REST v2 routes (relative to `/api/v2/t/{slug}`). */
export function registerPagesRoutes(router: OpenAPIHono<AppEnv>): void {
  registerFolderRoutes(router, {
    path: '/pageFolders',
    tag: 'Landing page folders',
    items: 'landing pages',
    read: 'pages:read',
    write: 'pages:write',
    backend: {
      list: (c) => callCrm(c, 'pages.folders.list', {}),
      get: (c, input) => callCrm(c, 'pages.folders.get', input),
      create: (c, input) => callCrm(c, 'pages.folders.create', input),
      update: (c, input) => callCrm(c, 'pages.folders.update', input),
      delete: (c, input) => callCrm(c, 'pages.folders.delete', input),
      moveItems: (c, input) => callCrm(c, 'pages.folders.moveItems', input),
    },
  });

  // -------------------------------------------------------------- pages
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
      return c.json({ data: page.data.map((p) => withUrl(c, p)), next_cursor: page.next_cursor }, 200);
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
    async (c) => c.json(withUrl(c, await callCrm(c, 'pages.get', { id: c.req.valid('param').id })) as never, 200),
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
    async (c) => c.json(withUrl(c, await callCrm(c, 'pages.restore', { id: c.req.valid('param').id })) as never, 200),
  );
  router.openapi(
    crmRoute('pages:write', {
      method: 'post',
      path: '/pages/{id}/duplicate',
      tags: pagesTag,
      summary: 'Copy a page (draft, SEO, settings) into a new draft; path defaults to `<path>-copy`',
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
        throw invalidMany(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })));
      }
      const page = await callCrm(c, 'pages.duplicate', { id: c.req.valid('param').id, ...parsed.data });
      return c.json(withUrl(c, page) as never, 201);
    },
  );

  // ----------------------------------------------------- export / import
  router.openapi(
    crmRoute('pages:read', {
      method: 'get',
      path: '/pages/{id}/export',
      tags: pagesTag,
      summary: 'Download the draft as a .zip (document, SEO, settings, library images) to import into any installation',
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
          source: { slug: getTenant(c).tenant.slug, edge_origin: edgeOrigin(c), page_id: page.id },
          page: { title: page.title, path: page.path, document: page.draft, seo: page.seo, settings: page.settings },
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
      summary: 'Create a draft from a page export (.zip): images join the library, forms/bookings/checkouts must be relinked',
      request: {
        body: { required: true, content: { 'application/zip': { schema: z.string().openapi({ format: 'binary' }) } } },
      },
      responses: {
        201: json(importPageResponseSchema, 'The imported page and what needs attention'),
        400: errorJson('Not a landing page export'),
        413: errorJson(`Larger than ${PAGE_IMPORT_MAX_BYTES} bytes`),
      },
    }),
    async (c) => {
      const tooLarge = { error: 'payload_too_large', message: `max ${Math.floor(PAGE_IMPORT_MAX_BYTES / 1024 / 1024)} MB` };
      if (Number(c.req.header('content-length') ?? '0') > PAGE_IMPORT_MAX_BYTES) return c.json(tooLarge, 413);
      const archive = new Uint8Array(await c.req.arrayBuffer());
      if (archive.byteLength > PAGE_IMPORT_MAX_BYTES) return c.json(tooLarge, 413);
      let manifest: PageManifest;
      try {
        manifest = readPageManifest(archive);
      } catch (error) {
        if (error instanceof PageArchiveError) return c.json({ error: 'invalid_archive', message: error.message }, 400);
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
            from: { edge: manifest.source.edge_origin, slug: manifest.source.slug, pageId: manifest.source.page_id },
            to: { edge: edgeOrigin(c), slug, pageId: id },
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
          details: { source: manifest.source.slug, media_imported: created.length, media_reused: reused },
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

  // ------------------------------------------------------------ draft
  router.openapi(
    crmRoute('pages:write', {
      method: 'put',
      path: '/pages/{id}/draft',
      tags: pagesTag,
      summary: 'Save the draft document (optimistic concurrency on base_revision; needs the edit lock)',
      request: { params: pageIdParam, body: jsonBody(savePageDraftSchema) },
      responses: {
        200: json(savePageDraftResponseSchema, 'New draft revision'),
        409: json(errorResponseSchema.extend({ draft_revision: z.number().int() }), 'The draft moved on (`stale_draft`)'),
        ...LOCKED_RESPONSE,
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      await assertEditable(c, 'pages', id);
      const result = await callCrm(c, 'pages.saveDraft', { id, document: body.document, base_revision: body.base_revision });
      if (!result.ok) {
        return c.json(
          { error: 'stale_draft', message: `the draft is at revision ${result.draft_revision}`, draft_revision: result.draft_revision },
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
      return c.json({ html: renderDraft(page, slug, edgeOrigin(c)) }, 200);
    },
  );

  // --------------------------------------------------------- publishing
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
      responses: { 200: json(publishPageResponseSchema, 'Published page and version'), ...LOCKED_RESPONSE },
    }),
    async (c) => {
      const raw: unknown = await c.req.json().catch(() => ({}));
      const parsed = publishPageSchema.safeParse(raw ?? {});
      const note = parsed.success ? parsed.data.note : undefined;
      const { id } = c.req.valid('param');
      await assertEditable(c, 'pages', id);
      const result = await callCrm(c, 'pages.publish', { id, ...(note === undefined ? {} : { note }) });
      await audit(c, 'pages.page_published', { target: id, details: { version: result.version.version } });
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
      return c.json(withUrl(c, await callCrm(c, 'pages.restoreVersion', { id, versionId })) as never, 200);
    },
  );

  // ---------------------------------------------------------- edit lock
  registerEditLockRoutes(router, {
    kind: 'pages',
    basePath: '/pages',
    tag: 'Landing page edit lock',
    write: 'pages:write',
    read: 'pages:read',
    takeover: 'pages:publish',
    exists: (c, id) => callCrm(c, 'pages.get', { id }),
  });

  // ------------------------------------------------------ saved sections
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
      c.json(await callCrm(c, 'pages.updateSavedSection', { id: c.req.valid('param').id, data: c.req.valid('json') }), 200),
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
    async (c) => c.json(await callCrm(c, 'pages.deleteSavedSection', { id: c.req.valid('param').id }), 200),
  );

  // --------------------------------------------------------------- media
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
      return c.json({ data: page.rows.map((r) => serializeMedia(c, r)), next_cursor: page.next_cursor }, 200);
    },
  );
  router.openapi(
    crmRoute('pages:write', {
      method: 'put',
      path: '/media',
      tags: mediaTag,
      summary: 'Upload an image (raw body, max 10 MB; PNG, JPEG, GIF, WebP, AVIF detected from the content)',
      request: {
        query: uploadMediaQuerySchema,
        body: { required: true, content: { 'application/octet-stream': { schema: z.string().openapi({ format: 'binary' }) } } },
      },
      responses: {
        201: json(mediaFileSchema, 'The uploaded file'),
        413: errorJson('Larger than 10 MB'),
        415: errorJson('Not a supported image'),
      },
    }),
    async (c) => {
      const declared = Number(c.req.header('content-length') ?? '0');
      if (declared > MEDIA_MAX_BYTES) return c.json({ error: 'payload_too_large', message: 'max 10 MB' }, 413);
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      if (bytes.byteLength > MEDIA_MAX_BYTES) return c.json({ error: 'payload_too_large', message: 'max 10 MB' }, 413);
      const type = sniffImageType(bytes);
      if (type === null) {
        return c.json({ error: 'unsupported_media_type', message: 'only PNG, JPEG, GIF, WebP and AVIF images' }, 415);
      }
      const id = ulid();
      const file = `${id}.${mediaExtension(type)}`;
      const key = `tenants/${getTenant(c).tenant.id}/media/${file}`;
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
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

/** `<path segments or "home">.page.zip`, ASCII only (it goes into a quoted header). */
function exportFileName(page: Pick<PageRecord, 'path'>): string {
  const stem = page.path.replace(/^\/+/, '').replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${stem === '' ? 'home' : stem.slice(0, 80)}.page.zip`;
}

/** Draft rendered exactly like the public page, without the tracker. */
export function renderDraft(page: PageDetailRecord, slug: string, edge: string): string {
  const url = publicUrl(edge, slug, page);
  return renderBuilderDocumentHtml(page.draft, {
    mode: 'public',
    tenantSlug: slug,
    pageId: page.id,
    mediaBaseUrl: `${edge}/m/${slug}/`,
    scriptOrigin: edge,
    meta: {
      title: page.seo.title ?? page.title,
      ...(page.seo.description === null ? {} : { description: page.seo.description }),
      canonical: page.seo.canonical ?? url,
      ...(page.seo.og_image === null ? {} : { ogImage: page.seo.og_image }),
      noindex: true,
      ...(page.settings.favicon === null ? {} : { favicon: page.settings.favicon }),
      lang: page.settings.lang ?? 'en',
    },
  });
}

export type { LandingPage };
