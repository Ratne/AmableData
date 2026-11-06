import { z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  createShortlinkFolderSchema,
  createShortlinkSchema,
  deletedResponseSchema,
  idSchema,
  shortlinkDomainListSchema,
  shortlinkFolderListSchema,
  shortlinkFolderSchema,
  shortlinkListQuerySchema,
  shortlinkListSchema,
  shortlinkSchema,
  shortlinkStatsQuerySchema,
  shortlinkStatsSchema,
  updateShortlinkFolderSchema,
  updateShortlinkSchema,
  type Shortlink,
} from '@amable/api-types';
import type { Context } from 'hono';
import { callCrm, crmRoute, json, jsonBody } from '../crm/api/core';
import { invalid } from '../crm/errors';
import { audit, getTenant, type AppEnv } from '../middleware';
import type { ShortlinkRecord } from './ops';

type Ctx = Context<AppEnv>;

const linksTag = ['Short links'];
const foldersTag = ['Short link folders'];
const idParam = z.object({ id: idSchema });
const D1_IN_CHUNK = 90;

/** Shortlink domains of the tenant (installation D1), id → hostname. */
async function shortlinkDomains(c: Ctx): Promise<Map<string, string>> {
  const rows = await c.env.DB.prepare(
    `SELECT id, hostname FROM domains WHERE tenant_id = ? AND kind = 'shortlink'`,
  )
    .bind(getTenant(c).tenant.id)
    .all<{ id: string; hostname: string }>();
  return new Map(rows.results.map((r) => [r.id, r.hostname]));
}

async function userNames(c: Ctx, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => id !== null))];
  const names = new Map<string, string>();
  for (let i = 0; i < unique.length; i += D1_IN_CHUNK) {
    const chunk = unique.slice(i, i + D1_IN_CHUNK);
    const rows = await c.env.DB.prepare(
      `SELECT id, name, email FROM users WHERE id IN (${chunk.map(() => '?').join(', ')})`,
    )
      .bind(...chunk)
      .all<{ id: string; name: string | null; email: string }>();
    for (const row of rows.results) {
      names.set(row.id, row.name !== null && row.name.trim() !== '' ? row.name : row.email);
    }
  }
  return names;
}

async function complete(c: Ctx, records: readonly ShortlinkRecord[]): Promise<Shortlink[]> {
  const [domains, names] = await Promise.all([
    shortlinkDomains(c),
    userNames(c, records.map((r) => r.created_by)),
  ]);
  return records.map((r) => {
    const hostname = domains.get(r.domain_id) ?? null;
    return {
      ...r,
      hostname,
      short_url: hostname === null ? null : `https://${hostname}/${r.key}`,
      created_by_name: r.created_by === null ? null : (names.get(r.created_by) ?? null),
    };
  });
}

async function completeOne(c: Ctx, record: ShortlinkRecord): Promise<Shortlink> {
  const [link] = await complete(c, [record]);
  if (link === undefined) throw new Error('unreachable');
  return link;
}

async function assertDomain(c: Ctx, domainId: string): Promise<void> {
  const domains = await shortlinkDomains(c);
  if (!domains.has(domainId)) throw invalid('domain_id', 'not a shortlink domain of this workspace');
}

async function assertDomains(c: Ctx, domainIds: readonly string[] | undefined): Promise<void> {
  if (domainIds === undefined || domainIds.length === 0) return;
  const domains = await shortlinkDomains(c);
  const unknown = domainIds.find((id) => !domains.has(id));
  if (unknown !== undefined) throw invalid('domain_ids', `${unknown} is not a shortlink domain of this workspace`);
}

/** Short links REST v2 routes (relative to `/api/v2/t/{slug}`). */
export function registerShortlinksRoutes(router: OpenAPIHono<AppEnv>): void {
  router.openapi(
    crmRoute('shortlinks:read', {
      method: 'get',
      path: '/shortlinks/domains',
      tags: linksTag,
      summary: 'List the shortlink domains of the workspace',
      description: 'Domains connected with kind `shortlink`; only verified ones answer publicly.',
      responses: { 200: json(shortlinkDomainListSchema, 'Domains') },
    }),
    async (c) => {
      const rows = await c.env.DB.prepare(
        `SELECT id, hostname, status FROM domains WHERE tenant_id = ? AND kind = 'shortlink' ORDER BY hostname`,
      )
        .bind(getTenant(c).tenant.id)
        .all<{ id: string; hostname: string; status: 'pending' | 'verified' | 'failed' }>();
      return c.json({ data: rows.results }, 200);
    },
  );

  // ----------------------------------------------------------- folders
  router.openapi(
    crmRoute('shortlinks:read', {
      method: 'get',
      path: '/shortlinks/folders',
      tags: foldersTag,
      summary: 'List the short link folders (with link count and bound domains)',
      responses: { 200: json(shortlinkFolderListSchema, 'Folders') },
    }),
    async (c) => c.json(await callCrm(c, 'shortlinks.folders.list', {}), 200),
  );
  router.openapi(
    crmRoute('shortlinks:write', {
      method: 'post',
      path: '/shortlinks/folders',
      tags: foldersTag,
      summary: 'Create a short link folder',
      description: '`domain_ids` restricts the links of the folder to those shortlink domains (empty = any).',
      request: { body: jsonBody(createShortlinkFolderSchema) },
      responses: { 201: json(shortlinkFolderSchema, 'The folder') },
    }),
    async (c) => {
      const body = c.req.valid('json');
      await assertDomains(c, body.domain_ids);
      const folder = await callCrm(c, 'shortlinks.folders.create', body);
      await audit(c, 'shortlinks.folder_created', { target: folder.id, details: { name: folder.name } });
      return c.json(folder, 201);
    },
  );
  router.openapi(
    crmRoute('shortlinks:write', {
      method: 'patch',
      path: '/shortlinks/folders/{id}',
      tags: foldersTag,
      summary: 'Rename a folder or change its domains',
      request: { params: idParam, body: jsonBody(updateShortlinkFolderSchema) },
      responses: { 200: json(shortlinkFolderSchema, 'The folder') },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      await assertDomains(c, body.domain_ids);
      const folder = await callCrm(c, 'shortlinks.folders.update', { id, data: body });
      await audit(c, 'shortlinks.folder_updated', { target: id });
      return c.json(folder, 200);
    },
  );
  router.openapi(
    crmRoute('shortlinks:write', {
      method: 'delete',
      path: '/shortlinks/folders/{id}',
      tags: foldersTag,
      summary: 'Delete a folder (its links stay, without folder)',
      request: { params: idParam },
      responses: {
        200: json(
          z.object({ id: idSchema, deleted: z.literal(true), moved_links: z.number().int() }),
          'Deleted',
        ),
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const result = await callCrm(c, 'shortlinks.folders.delete', { id });
      await audit(c, 'shortlinks.folder_deleted', { target: id, details: { moved_links: result.moved_links } });
      return c.json(result, 200);
    },
  );

  // ------------------------------------------------------------- links
  router.openapi(
    crmRoute('shortlinks:read', {
      method: 'get',
      path: '/shortlinks',
      tags: linksTag,
      summary: 'List short links (newest first; archived ones with include_archived=true)',
      request: { query: shortlinkListQuerySchema },
      responses: { 200: json(shortlinkListSchema, 'Short links') },
    }),
    async (c) => {
      const { data } = await callCrm(c, 'shortlinks.list', c.req.valid('query'));
      return c.json({ data: await complete(c, data) }, 200);
    },
  );
  router.openapi(
    crmRoute('shortlinks:write', {
      method: 'post',
      path: '/shortlinks',
      tags: linksTag,
      summary: 'Create a short link',
      description:
        'On a `shortlink` domain of the workspace. Without `key` a random 7-character key is generated; an existing key on the domain is a 409. The response carries `short_url`.',
      request: { body: jsonBody(createShortlinkSchema) },
      responses: { 201: json(shortlinkSchema, 'The short link') },
    }),
    async (c) => {
      const body = c.req.valid('json');
      await assertDomain(c, body.domain_id);
      const link = await completeOne(c, await callCrm(c, 'shortlinks.create', body));
      await audit(c, 'shortlinks.link_created', { target: link.id, details: { short_url: link.short_url } });
      return c.json(link, 201);
    },
  );
  router.openapi(
    crmRoute('shortlinks:write', {
      method: 'patch',
      path: '/shortlinks/{id}',
      tags: linksTag,
      summary: 'Update a short link',
      description: 'Changes reach the public redirect within a minute (edge cache).',
      request: { params: idParam, body: jsonBody(updateShortlinkSchema) },
      responses: { 200: json(shortlinkSchema, 'The short link') },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      if (body.domain_id !== undefined) await assertDomain(c, body.domain_id);
      const link = await completeOne(c, await callCrm(c, 'shortlinks.update', { id, data: body }));
      await audit(c, 'shortlinks.link_updated', { target: id, details: { fields: Object.keys(body).join(',') } });
      return c.json(link, 200);
    },
  );
  router.openapi(
    crmRoute('shortlinks:write', {
      method: 'delete',
      path: '/shortlinks/{id}',
      tags: linksTag,
      summary: 'Delete a short link and its statistics',
      request: { params: idParam },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const removed = await callCrm(c, 'shortlinks.delete', { id });
      await audit(c, 'shortlinks.link_deleted', { target: id, details: { key: removed.key } });
      return c.json({ id, deleted: true as const }, 200);
    },
  );
  router.openapi(
    crmRoute('shortlinks:read', {
      method: 'get',
      path: '/shortlinks/{id}/stats',
      tags: linksTag,
      summary: 'Click statistics of a short link',
      description:
        'Daily series of human and bot clicks over `days` (1–90, default 30, UTC days), top countries, referrers, devices and browsers (human clicks only), lifetime total.',
      request: { params: idParam, query: shortlinkStatsQuerySchema },
      responses: { 200: json(shortlinkStatsSchema, 'Statistics') },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const { days } = c.req.valid('query');
      return c.json(await callCrm(c, 'shortlinks.stats', { id, days }), 200);
    },
  );
}
