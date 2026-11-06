import { z } from '@hono/zod-openapi';
import { errorResponseSchema, idSchema, type MediaFile } from '@amable/api-types';
import { renderBuilderDocumentHtml } from '@amable/builder';
import type { Context } from 'hono';
import { json } from '../../crm/api/core';
import { getTenant, type AppEnv } from '../../middleware';
import type { MediaRow } from '../library';
import type { PageDetailRecord, PageRecord } from '../pages';
import { edgeOrigin } from '../../env';

export type Ctx = Context<AppEnv>;

export const pagesTag = ['Landing pages'];

export const sectionsTag = ['Saved sections'];

export const clipboardTag = ['Builder clipboard'];

export const mediaTag = ['Media'];

export const pageIdParam = z.object({ id: idSchema });

export const versionParam = z.object({ id: idSchema, versionId: idSchema });

/** `https://<host><path>` once a domain is connected, else the edge fallback `/p/<slug><path>`. */
function publicUrl(edge: string, slug: string, page: Pick<PageRecord, 'host' | 'path'>): string {
  if (page.host !== null) return `https://${page.host}${page.path}`;
  return `${edge}/p/${slug}${page.path === '/' ? '' : page.path}`;
}

export function withUrl<T extends PageRecord>(c: Ctx, page: T): T & { public_url: string } {
  return { ...page, public_url: publicUrl(edgeOrigin(c.env), getTenant(c).tenant.slug, page) };
}

export function serializeMedia(c: Ctx, row: MediaRow): MediaFile {
  const slug = getTenant(c).tenant.slug;
  return {
    id: row.id,
    filename: row.filename,
    content_type: row.content_type,
    size: row.size,
    url: `${edgeOrigin(c.env)}/m/${slug}/${row.file}`,
    preview_url: `/api/v2/t/${slug}/media/${row.id}/content`,
    created_at: new Date(row.created_at).toISOString(),
  };
}

export const errorJson = (description: string) => json(errorResponseSchema, description);

/** `<path segments or "home">.page.zip`, ASCII only (it goes into a quoted header). */
export function exportFileName(page: Pick<PageRecord, 'path'>): string {
  const stem = page.path
    .replace(/^\/+/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
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
