import { z } from 'zod';
import { idSchema, timestampSchema } from '../crm/common';
import { folderFilterQuery } from '../folders/index';

/**
 * Landing pages REST v2 schemas: pages (draft document + published versions),
 * edit lock state, saved sections and the media library. The builder document
 * itself is validated server-side by `builderDocumentSchema` of @amable/builder.
 */

const listQuery = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
};

// ------------------------------------------------------------------ pages

export const PAGE_STATUSES = ['draft', 'published'] as const;
export const pageStatusSchema = z.enum(PAGE_STATUSES);
export type PageStatus = z.infer<typeof pageStatusSchema>;

/** Builder document JSON ({ editorKind, tokens, body, customCss? }) — see @amable/builder. */
export const builderDocumentJsonSchema = z
  .record(z.string(), z.unknown())
  .describe('Builder document: { editorKind: "canvas", tokens, body, customCss? } (schema of @amable/builder)');

/** Path of a page: always starts with `/`, lowercase segments, no trailing slash (except `/`). */
export const pagePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .regex(/^\/?[a-zA-Z0-9\-._~/]*$/, 'letters, digits, - . _ ~ and / only');

/** Host the page is published on (connected customer hostname); null = only the `/p/<slug>/…` URL. */
export const pageHostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, 'expected a hostname');

export const pageSeoSchema = z.strictObject({
  title: z.string().trim().max(200).nullable().optional(),
  description: z.string().trim().max(500).nullable().optional(),
  og_image: z.string().trim().max(2000).nullable().optional(),
  canonical: z.string().trim().max(2000).nullable().optional(),
  noindex: z.boolean().optional(),
});
export type PageSeo = z.infer<typeof pageSeoSchema>;

export const pageSettingsSchema = z.strictObject({
  /** Analytics site the tracker reports to; null = auto (site matching the host, else first site). */
  analytics_site_id: z.string().trim().max(64).nullable().optional(),
  favicon: z.string().trim().max(2000).nullable().optional(),
  /** html lang of the page (BCP 47), default "en". */
  lang: z.string().trim().max(35).nullable().optional(),
});
export type PageSettings = z.infer<typeof pageSettingsSchema>;

export const landingPageSchema = z.object({
  id: idSchema,
  title: z.string(),
  path: z.string(),
  host: z.string().nullable(),
  status: pageStatusSchema,
  /** Folder of the page (null = unfiled). */
  folder_id: idSchema.nullable(),
  published_version_id: idSchema.nullable(),
  published_at: timestampSchema.nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  deleted_at: timestampSchema.nullable(),
  seo: z.object({
    title: z.string().nullable(),
    description: z.string().nullable(),
    og_image: z.string().nullable(),
    canonical: z.string().nullable(),
    noindex: z.boolean(),
  }),
  settings: z.object({
    analytics_site_id: z.string().nullable(),
    favicon: z.string().nullable(),
    lang: z.string().nullable(),
  }),
  /** Public URL of the page: `https://<host><path>` when a host is set, else `<EDGE_ORIGIN>/p/<slug><path>`. */
  public_url: z.string(),
});
export type LandingPage = z.infer<typeof landingPageSchema>;

export const landingPageDetailSchema = landingPageSchema.extend({
  draft: builderDocumentJsonSchema,
  draft_revision: z.number().int(),
});
export type LandingPageDetail = z.infer<typeof landingPageDetailSchema>;

export const listPagesQuerySchema = z.object({
  ...listQuery,
  q: z.string().trim().max(200).optional(),
  /** `deleted` lists soft-deleted pages (restorable). */
  status: z.enum(['draft', 'published', 'deleted']).optional(),
  ...folderFilterQuery,
});
export type ListPagesQuery = z.infer<typeof listPagesQuerySchema>;

export const createPageSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  path: pagePathSchema,
  host: pageHostSchema.nullable().optional(),
  /** Omitted: an empty document with one container. */
  document: builderDocumentJsonSchema.optional(),
  folder_id: idSchema.nullable().optional(),
});
export type CreatePageInput = z.infer<typeof createPageSchema>;

export const updatePageSchema = z.strictObject({
  title: z.string().trim().min(1).max(200).optional(),
  path: pagePathSchema.optional(),
  host: pageHostSchema.nullable().optional(),
  seo: pageSeoSchema.optional(),
  settings: pageSettingsSchema.optional(),
});
export type UpdatePageInput = z.infer<typeof updatePageSchema>;

export const duplicatePageSchema = z.strictObject({
  title: z.string().trim().min(1).max(200).optional(),
  path: pagePathSchema.optional(),
});
export type DuplicatePageInput = z.infer<typeof duplicatePageSchema>;

export const savePageDraftSchema = z.strictObject({
  document: builderDocumentJsonSchema,
  /** `draft_revision` the client edited; mismatch → 409 `stale_draft`. */
  base_revision: z.number().int().nonnegative(),
});
export type SavePageDraftInput = z.infer<typeof savePageDraftSchema>;

export const savePageDraftResponseSchema = z.object({ draft_revision: z.number().int() });

export const pageVersionSchema = z.object({
  id: idSchema,
  version: z.number().int(),
  note: z.string().nullable(),
  published_at: timestampSchema,
  published_by: z.string().nullable(),
});
export type PageVersion = z.infer<typeof pageVersionSchema>;

export const publishPageSchema = z.strictObject({ note: z.string().trim().max(500).optional() });
export type PublishPageInput = z.infer<typeof publishPageSchema>;

export const publishPageResponseSchema = z.object({ page: landingPageSchema, version: pageVersionSchema });

export const pagePreviewSchema = z.object({ html: z.string() });

// -------------------------------------------------------------- edit lock

export const editLockHolderSchema = z.object({
  user_id: z.string(),
  user_name: z.string(),
  /** Epoch ms the holder acquired the lock. */
  since: z.number().int(),
});
export type EditLockHolder = z.infer<typeof editLockHolderSchema>;

/**
 * Lock state, pushed on the `GET /pages/{id}/lock` WebSocket (`type: 'state'`)
 * and returned by `GET /pages/{id}/lock/status`. `role` is the caller's.
 * Client → server messages: `{type:'heartbeat'}` every 10 s, `{type:'release'}`,
 * `{type:'takeover'}` (requires pages:publish).
 */
export const editLockStateSchema = z.object({
  type: z.literal('state'),
  holder: editLockHolderSchema.nullable(),
  role: z.enum(['holder', 'waiting']),
  waiting: z.number().int(),
});
export type EditLockState = z.infer<typeof editLockStateSchema>;

export const editLockClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('heartbeat') }),
  z.object({ type: z.literal('release') }),
  z.object({ type: z.literal('takeover') }),
]);
export type EditLockClientMessage = z.infer<typeof editLockClientMessageSchema>;

// --------------------------------------------------------- saved sections

export const savedSectionSchema = z.object({
  id: idSchema,
  name: z.string(),
  category: z.string().nullable(),
  /** One builder `ElementNode` (usually a container). */
  node: z.record(z.string(), z.unknown()),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type SavedSection = z.infer<typeof savedSectionSchema>;

export const createSavedSectionSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().max(100).nullable().optional(),
  node: z.record(z.string(), z.unknown()),
});
export type CreateSavedSectionInput = z.infer<typeof createSavedSectionSchema>;

export const updateSavedSectionSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  category: z.string().trim().max(100).nullable().optional(),
  node: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateSavedSectionInput = z.infer<typeof updateSavedSectionSchema>;

// ------------------------------------------------------------------ media

export const MEDIA_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'] as const;
export const MEDIA_MAX_BYTES = 10 * 1024 * 1024;

export const mediaFileSchema = z.object({
  id: idSchema,
  filename: z.string(),
  content_type: z.string(),
  size: z.number().int(),
  /** Public URL on the edge: `<EDGE_ORIGIN>/m/<slug>/<file>` (store this in image controls). */
  url: z.string(),
  /** Authenticated URL for the SPA: `/api/v2/t/<slug>/media/<id>/content`. */
  preview_url: z.string(),
  created_at: timestampSchema,
});
export type MediaFile = z.infer<typeof mediaFileSchema>;

export const listMediaQuerySchema = z.object({ ...listQuery });
export type ListMediaQuery = z.infer<typeof listMediaQuerySchema>;

export const uploadMediaQuerySchema = z.object({ filename: z.string().trim().min(1).max(255) });
