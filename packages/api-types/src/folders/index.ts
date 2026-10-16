import { z } from 'zod';
import { idSchema, timestampSchema } from '../crm/common';

/**
 * Folders used to archive automations and landing pages (one tree per kind).
 * A folder lives in the Durable Object that owns its items; items carry a
 * nullable `folder_id` (null = unfiled).
 */

/** Root folders have depth 1; a subtree can never go deeper than this. */
export const FOLDER_MAX_DEPTH = 5;
/** Items per move request (the store writes them in chunks under the 100-parameter limit). */
export const FOLDER_MOVE_MAX_ITEMS = 500;
export const FOLDER_NAME_MAX = 120;

export const FOLDER_KINDS = ['automation', 'page'] as const;
export const folderKindSchema = z.enum(FOLDER_KINDS);
export type FolderKind = z.infer<typeof folderKindSchema>;

export const folderSchema = z.object({
  id: idSchema,
  kind: folderKindSchema,
  parent_id: idSchema.nullable(),
  name: z.string(),
  position: z.number().int(),
  /** 1 for root folders. */
  depth: z.number().int(),
  /** Items directly in this folder. */
  item_count: z.number().int(),
  /** Items in this folder and every subfolder. */
  total_count: z.number().int(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type Folder = z.infer<typeof folderSchema>;

export const folderTreeSchema = z.object({
  /** Every folder of the kind, parents before children, siblings by position then name. */
  data: z.array(folderSchema),
  /** Items without a folder. */
  unfiled_count: z.number().int(),
  /** Every item of the kind. */
  total_count: z.number().int(),
  max_depth: z.number().int(),
});
export type FolderTree = z.infer<typeof folderTreeSchema>;

const folderNameSchema = z.string().trim().min(1).max(FOLDER_NAME_MAX);

export const createFolderSchema = z.strictObject({
  name: folderNameSchema,
  /** Omitted or null: a root folder. */
  parent_id: idSchema.nullable().optional(),
});
export type CreateFolderInput = z.infer<typeof createFolderSchema>;

/** Rename and/or move (reparent, reorder) a folder. */
export const updateFolderSchema = z.strictObject({
  name: folderNameSchema.optional(),
  /** null moves the folder to the root. */
  parent_id: idSchema.nullable().optional(),
  /** Index among the new siblings (0 = first); omitted when moving = last. */
  position: z.number().int().min(0).max(100_000).optional(),
});
export type UpdateFolderInput = z.infer<typeof updateFolderSchema>;

export const folderIdParamSchema = z.object({ id: idSchema });

export const deleteFolderQuerySchema = z.object({
  /**
   * `empty` (default) refuses a folder that still has subfolders or items;
   * `move_to_parent` moves them into the parent folder (or the root) first.
   */
  mode: z.enum(['empty', 'move_to_parent']).default('empty'),
});
export type DeleteFolderQuery = z.infer<typeof deleteFolderQuerySchema>;

export const deleteFolderResultSchema = z.object({
  id: idSchema,
  deleted: z.literal(true),
  moved_folders: z.number().int(),
  moved_items: z.number().int(),
});
export type DeleteFolderResult = z.infer<typeof deleteFolderResultSchema>;

export const moveFolderItemsSchema = z.strictObject({
  ids: z.array(idSchema).min(1).max(FOLDER_MOVE_MAX_ITEMS),
  /** Target folder; null = unfiled. */
  folder_id: idSchema.nullable(),
});
export type MoveFolderItemsInput = z.infer<typeof moveFolderItemsSchema>;

export const moveFolderItemsResultSchema = z.object({
  folder_id: idSchema.nullable(),
  moved: z.number().int(),
  /** Requested ids that do not exist (or are deleted): left untouched. */
  missing: z.array(idSchema),
});
export type MoveFolderItemsResult = z.infer<typeof moveFolderItemsResultSchema>;

/** Query filter shared by the item lists (`/automations`, `/pages`). */
export const folderFilterQuery = {
  /** A folder id, or `none` for unfiled items. Omitted: every item. */
  folder_id: z.union([z.literal('none'), idSchema]).optional(),
  /** With a folder id: also items in its subfolders. */
  include_subfolders: z.enum(['true', 'false']).optional(),
};
