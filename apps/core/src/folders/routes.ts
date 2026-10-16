import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  createFolderSchema,
  deleteFolderQuerySchema,
  deleteFolderResultSchema,
  folderIdParamSchema,
  folderSchema,
  folderTreeSchema,
  moveFolderItemsResultSchema,
  moveFolderItemsSchema,
  updateFolderSchema,
  type CreateFolderInput,
  type DeleteFolderResult,
  type Folder,
  type FolderTree,
  type MoveFolderItemsInput,
  type MoveFolderItemsResult,
  type UpdateFolderInput,
} from '@amable/api-types';
import type { Permission } from '@amable/core';
import type { Context } from 'hono';
import { crmRoute, json, jsonBody } from '../crm/api/core';
import type { AppEnv } from '../middleware';

type Ctx = Context<AppEnv>;

/** How a module reaches the folder store of the DO that owns its items. */
export interface FolderBackend {
  list(c: Ctx): Promise<FolderTree>;
  get(c: Ctx, input: { id: string }): Promise<Folder>;
  create(c: Ctx, input: CreateFolderInput): Promise<Folder>;
  update(c: Ctx, input: { id: string; data: UpdateFolderInput }): Promise<Folder>;
  delete(
    c: Ctx,
    input: { id: string; mode: 'empty' | 'move_to_parent' },
  ): Promise<DeleteFolderResult>;
  moveItems(c: Ctx, input: MoveFolderItemsInput): Promise<MoveFolderItemsResult>;
}

export interface FolderRoutesConfig {
  /** e.g. `/automationFolders`. */
  readonly path: string;
  readonly tag: string;
  /** Plural noun used in summaries, e.g. `automations`. */
  readonly items: string;
  readonly read: Permission;
  readonly write: Permission;
  readonly backend: FolderBackend;
}

/** CRUD + move routes of one folder tree (relative to `/api/v2/t/{slug}`). */
export function registerFolderRoutes(
  router: OpenAPIHono<AppEnv>,
  config: FolderRoutesConfig,
): void {
  const { path, items, read, write, backend } = config;
  const tags = [config.tag];

  router.openapi(
    crmRoute(read, {
      method: 'get',
      path,
      tags,
      summary: `List the folder tree of ${items} with item counts`,
      responses: {
        200: json(folderTreeSchema, 'Every folder, parents first, with direct and total counts'),
      },
    }),
    async (c) => c.json(await backend.list(c), 200),
  );
  router.openapi(
    crmRoute(write, {
      method: 'post',
      path,
      tags,
      summary: `Create a folder of ${items} (root or inside a parent)`,
      description:
        'Names are unique per parent (case-insensitive); folders nest at most 5 levels deep.',
      request: { body: jsonBody(createFolderSchema) },
      responses: { 201: json(folderSchema, 'The folder') },
    }),
    async (c) => c.json(await backend.create(c, c.req.valid('json')), 201),
  );
  router.openapi(
    crmRoute(write, {
      method: 'post',
      path: `${path}/moveItems`,
      tags,
      summary: `Move ${items} into a folder (or unfile them with folder_id null)`,
      description:
        'Single or bulk (up to 500 ids). Unknown or deleted ids are reported in `missing`.',
      request: { body: jsonBody(moveFolderItemsSchema) },
      responses: { 200: json(moveFolderItemsResultSchema, 'Moved and missing ids') },
    }),
    async (c) => c.json(await backend.moveItems(c, c.req.valid('json')), 200),
  );
  router.openapi(
    crmRoute(read, {
      method: 'get',
      path: `${path}/{id}`,
      tags,
      summary: 'Get a folder with its counts',
      request: { params: folderIdParamSchema },
      responses: { 200: json(folderSchema, 'The folder') },
    }),
    async (c) => c.json(await backend.get(c, c.req.valid('param')), 200),
  );
  router.openapi(
    crmRoute(write, {
      method: 'patch',
      path: `${path}/{id}`,
      tags,
      summary: 'Rename, move (reparent) or reorder a folder',
      description:
        '`parent_id` null moves it to the root. Moving into itself or a subfolder, or beyond the depth limit, is rejected with 422.',
      request: { params: folderIdParamSchema, body: jsonBody(updateFolderSchema) },
      responses: { 200: json(folderSchema, 'The folder') },
    }),
    async (c) =>
      c.json(
        await backend.update(c, { id: c.req.valid('param').id, data: c.req.valid('json') }),
        200,
      ),
  );
  router.openapi(
    crmRoute(write, {
      method: 'delete',
      path: `${path}/{id}`,
      tags,
      summary: 'Delete a folder',
      description:
        '`mode=empty` (default) answers 409 when the folder still has subfolders or items; `mode=move_to_parent` moves them to the parent first (clashing subfolder names get a numeric suffix).',
      request: { params: folderIdParamSchema, query: deleteFolderQuerySchema },
      responses: { 200: json(deleteFolderResultSchema, 'Deleted') },
    }),
    async (c) =>
      c.json(
        await backend.delete(c, { id: c.req.valid('param').id, mode: c.req.valid('query').mode }),
        200,
      ),
  );
}
