import {
  SHORTLINK_RANDOM_KEY_LENGTH,
  SHORTLINK_UTM_FIELDS,
  type CreateShortlinkFolderInput,
  type CreateShortlinkInput,
  type Shortlink,
  type ShortlinkClickInput,
  type ShortlinkFolder,
  type ShortlinkListQuery,
  type ShortlinkStats,
  type ShortlinkTarget,
  type UpdateShortlinkFolderInput,
  type UpdateShortlinkInput,
} from '@amable/api-types';
import type { CrmContext } from '../crm/context';
import type { SqlValue } from '../crm/db/sql';
import { CrmError, invalid, notFound } from '../crm/errors';
import { bool, clean, parseIsoMs, toIso } from '../crm/util';

/**
 * Short links of the TenantDb (merged into `crmOps`). Domains live in the
 * installation D1: the API checks `domain_id` is a verified shortlink domain
 * of the tenant and adds `hostname` / `short_url` to the records.
 */

/** A link as stored; the API completes it into a `Shortlink`. */
export type ShortlinkRecord = Omit<Shortlink, 'hostname' | 'short_url' | 'created_by_name'>;

interface LinkRow {
  id: string;
  domain_id: string;
  folder_id: string | null;
  key: string;
  url: string;
  title: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
  pass_query: number;
  expires_at: number | null;
  expired_url: string | null;
  og_title: string | null;
  og_description: string | null;
  og_image: string | null;
  archived: number;
  clicks: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const RANDOM_KEY_ATTEMPTS = 5;
const DAY_MS = 86_400_000;

export function randomKey(length = SHORTLINK_RANDOM_KEY_LENGTH): string {
  // 248 = 62 * 4: rejecting bytes above it keeps the alphabet uniform.
  let key = '';
  while (key.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const byte of bytes) {
      if (byte < 248 && key.length < length) key += BASE62[byte % 62];
    }
  }
  return key;
}

function serialize(row: LinkRow): ShortlinkRecord {
  return {
    id: row.id,
    domain_id: row.domain_id,
    folder_id: row.folder_id,
    key: row.key,
    url: row.url,
    title: row.title,
    utm_source: row.utm_source,
    utm_medium: row.utm_medium,
    utm_campaign: row.utm_campaign,
    utm_term: row.utm_term,
    utm_content: row.utm_content,
    pass_query: bool(row.pass_query),
    expires_at: toIso(row.expires_at),
    expired_url: row.expired_url,
    og_title: row.og_title,
    og_description: row.og_description,
    og_image: row.og_image,
    archived: bool(row.archived),
    clicks: row.clicks,
    created_by: row.created_by,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function getRow(ctx: CrmContext, id: string): LinkRow {
  const row = ctx.db.all<LinkRow>(`SELECT * FROM short_links WHERE id = ?`, id)[0];
  if (row === undefined) throw notFound('short link', id);
  return row;
}

function keyTaken(ctx: CrmContext, domainId: string, key: string, exceptId: string | null): boolean {
  return (
    ctx.db.all<{ id: string }>(
      `SELECT id FROM short_links WHERE domain_id = ? AND key = ? AND id IS NOT ?`,
      domainId,
      key,
      exceptId,
    ).length > 0
  );
}

function folderDomainIds(ctx: CrmContext, folderId: string): string[] {
  return ctx.db
    .all<{ domain_id: string }>(
      `SELECT domain_id FROM short_link_folder_domains WHERE folder_id = ? ORDER BY domain_id`,
      folderId,
    )
    .map((r) => r.domain_id);
}

/** The folder exists and, when bound to domains, accepts `domainId`. */
function checkFolder(ctx: CrmContext, folderId: string | null, domainId: string): void {
  if (folderId === null) return;
  const exists = ctx.db.all(`SELECT id FROM short_link_folders WHERE id = ?`, folderId).length > 0;
  if (!exists) throw invalid('folder_id', `folder ${folderId} not found`);
  const domains = folderDomainIds(ctx, folderId);
  if (domains.length > 0 && !domains.includes(domainId)) {
    throw invalid('domain_id', 'the domain is not one of the folder domains');
  }
}

function expiresMs(value: string | null | undefined): number | null | undefined {
  if (value === undefined) return undefined;
  return value === null ? null : parseIsoMs(value, 'expires_at');
}

// ------------------------------------------------------------------ links

export function listLinks(ctx: CrmContext, input: ShortlinkListQuery): { data: ShortlinkRecord[] } {
  const where: string[] = [];
  const params: SqlValue[] = [];
  if (input.folder_id === 'none') where.push('folder_id IS NULL');
  else if (input.folder_id !== undefined) {
    where.push('folder_id = ?');
    params.push(input.folder_id);
  }
  if (input.domain_id !== undefined) {
    where.push('domain_id = ?');
    params.push(input.domain_id);
  }
  if (input.include_archived !== 'true') where.push('archived = 0');
  const q = clean(input.q);
  if (q !== null) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(`(key LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')`);
    params.push(like, like, like);
  }
  const rows = ctx.db.all<LinkRow>(
    `SELECT * FROM short_links ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY created_at DESC, id DESC LIMIT 5000`,
    ...params,
  );
  return { data: rows.map(serialize) };
}

export function getLink(ctx: CrmContext, input: { id: string }): ShortlinkRecord {
  return serialize(getRow(ctx, input.id));
}

export function createLink(ctx: CrmContext, input: CreateShortlinkInput): ShortlinkRecord {
  const folderId = input.folder_id ?? null;
  checkFolder(ctx, folderId, input.domain_id);
  let key = clean(input.key);
  if (key === null) {
    for (let i = 0; i < RANDOM_KEY_ATTEMPTS && key === null; i += 1) {
      const candidate = randomKey();
      if (!keyTaken(ctx, input.domain_id, candidate, null)) key = candidate;
    }
    if (key === null) throw new CrmError('conflict', 'could not generate a free key, retry');
  } else if (keyTaken(ctx, input.domain_id, key, null)) {
    throw new CrmError('conflict', `the key "${key}" is already used on this domain`, [
      { path: 'key', message: 'already used on this domain' },
    ]);
  }
  const id = ctx.newId();
  const now = ctx.now();
  ctx.db.run(
    `INSERT INTO short_links (id, domain_id, folder_id, key, url, title, utm_source, utm_medium,
       utm_campaign, utm_term, utm_content, pass_query, expires_at, expired_url, og_title,
       og_description, og_image, archived, clicks, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    id,
    input.domain_id,
    folderId,
    key,
    input.url,
    clean(input.title),
    clean(input.utm_source),
    clean(input.utm_medium),
    clean(input.utm_campaign),
    clean(input.utm_term),
    clean(input.utm_content),
    input.pass_query === true ? 1 : 0,
    expiresMs(input.expires_at) ?? null,
    clean(input.expired_url),
    clean(input.og_title),
    clean(input.og_description),
    clean(input.og_image),
    input.archived === true ? 1 : 0,
    ctx.actor.id,
    now,
    now,
  );
  return serialize(getRow(ctx, id));
}

export function updateLink(
  ctx: CrmContext,
  input: { id: string; data: UpdateShortlinkInput },
): ShortlinkRecord {
  const row = getRow(ctx, input.id);
  const d = input.data;
  const domainId = d.domain_id ?? row.domain_id;
  const key = d.key ?? row.key;
  const folderId = d.folder_id === undefined ? row.folder_id : d.folder_id;
  if ((domainId !== row.domain_id || key !== row.key) && keyTaken(ctx, domainId, key, row.id)) {
    throw new CrmError('conflict', `the key "${key}" is already used on this domain`, [
      { path: 'key', message: 'already used on this domain' },
    ]);
  }
  if (folderId !== row.folder_id || domainId !== row.domain_id) checkFolder(ctx, folderId, domainId);
  const text = (value: string | null | undefined, current: string | null): string | null =>
    value === undefined ? current : clean(value);
  const expires = expiresMs(d.expires_at);
  ctx.db.run(
    `UPDATE short_links SET domain_id = ?, folder_id = ?, key = ?, url = ?, title = ?, utm_source = ?,
       utm_medium = ?, utm_campaign = ?, utm_term = ?, utm_content = ?, pass_query = ?, expires_at = ?,
       expired_url = ?, og_title = ?, og_description = ?, og_image = ?, archived = ?, updated_at = ?
     WHERE id = ?`,
    domainId,
    folderId,
    key,
    d.url ?? row.url,
    text(d.title, row.title),
    text(d.utm_source, row.utm_source),
    text(d.utm_medium, row.utm_medium),
    text(d.utm_campaign, row.utm_campaign),
    text(d.utm_term, row.utm_term),
    text(d.utm_content, row.utm_content),
    d.pass_query === undefined ? row.pass_query : d.pass_query ? 1 : 0,
    expires === undefined ? row.expires_at : expires,
    text(d.expired_url, row.expired_url),
    text(d.og_title, row.og_title),
    text(d.og_description, row.og_description),
    text(d.og_image, row.og_image),
    d.archived === undefined ? row.archived : d.archived ? 1 : 0,
    ctx.now(),
    row.id,
  );
  return serialize(getRow(ctx, row.id));
}

export function deleteLink(ctx: CrmContext, input: { id: string }): ShortlinkRecord {
  const row = getRow(ctx, input.id);
  ctx.db.run(`DELETE FROM short_link_clicks_daily WHERE link_id = ?`, row.id);
  ctx.db.run(`DELETE FROM short_links WHERE id = ?`, row.id);
  return serialize(row);
}

// ---------------------------------------------------------------- folders

function serializeFolder(ctx: CrmContext, row: { id: string; name: string; created_at: number }): ShortlinkFolder {
  const count = ctx.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM short_links WHERE folder_id = ?`, row.id)[0];
  return {
    id: row.id,
    name: row.name,
    domain_ids: folderDomainIds(ctx, row.id),
    link_count: count?.n ?? 0,
    created_at: toIso(row.created_at),
  };
}

function getFolderRow(ctx: CrmContext, id: string): { id: string; name: string; created_at: number } {
  const row = ctx.db.all<{ id: string; name: string; created_at: number }>(
    `SELECT id, name, created_at FROM short_link_folders WHERE id = ?`,
    id,
  )[0];
  if (row === undefined) throw notFound('folder', id);
  return row;
}

function setFolderDomains(ctx: CrmContext, folderId: string, domainIds: readonly string[]): void {
  ctx.db.run(`DELETE FROM short_link_folder_domains WHERE folder_id = ?`, folderId);
  for (const domainId of new Set(domainIds)) {
    ctx.db.run(
      `INSERT INTO short_link_folder_domains (folder_id, domain_id) VALUES (?, ?)`,
      folderId,
      domainId,
    );
  }
}

export function listFolders(ctx: CrmContext, _input: Record<string, never>): { data: ShortlinkFolder[] } {
  const rows = ctx.db.all<{ id: string; name: string; created_at: number }>(
    `SELECT id, name, created_at FROM short_link_folders ORDER BY name COLLATE NOCASE, id`,
  );
  return { data: rows.map((row) => serializeFolder(ctx, row)) };
}

export function createFolder(ctx: CrmContext, input: CreateShortlinkFolderInput): ShortlinkFolder {
  const id = ctx.newId();
  ctx.db.run(
    `INSERT INTO short_link_folders (id, name, created_at) VALUES (?, ?, ?)`,
    id,
    input.name.trim(),
    ctx.now(),
  );
  setFolderDomains(ctx, id, input.domain_ids ?? []);
  return serializeFolder(ctx, getFolderRow(ctx, id));
}

export function updateFolder(
  ctx: CrmContext,
  input: { id: string; data: UpdateShortlinkFolderInput },
): ShortlinkFolder {
  const row = getFolderRow(ctx, input.id);
  if (input.data.name !== undefined) {
    ctx.db.run(`UPDATE short_link_folders SET name = ? WHERE id = ?`, input.data.name.trim(), row.id);
  }
  if (input.data.domain_ids !== undefined) setFolderDomains(ctx, row.id, input.data.domain_ids);
  return serializeFolder(ctx, getFolderRow(ctx, row.id));
}

/** The links of the folder stay, without folder. */
export function deleteFolder(ctx: CrmContext, input: { id: string }): { id: string; deleted: true; moved_links: number } {
  const folder = serializeFolder(ctx, getFolderRow(ctx, input.id));
  ctx.db.run(`UPDATE short_links SET folder_id = NULL WHERE folder_id = ?`, folder.id);
  ctx.db.run(`DELETE FROM short_link_folder_domains WHERE folder_id = ?`, folder.id);
  ctx.db.run(`DELETE FROM short_link_folders WHERE id = ?`, folder.id);
  return { id: folder.id, deleted: true, moved_links: folder.link_count };
}

// ------------------------------------------------------------- redirect

/** Config of a link for the edge; archived links do not resolve. */
export function resolveLink(ctx: CrmContext, input: { domainId: string; key: string }): ShortlinkTarget | null {
  const row = ctx.db.all<LinkRow>(
    `SELECT * FROM short_links WHERE domain_id = ? AND key = ? AND archived = 0`,
    input.domainId,
    input.key,
  )[0];
  if (row === undefined) return null;
  const utm: Partial<Record<(typeof SHORTLINK_UTM_FIELDS)[number], string>> = {};
  for (const field of SHORTLINK_UTM_FIELDS) {
    const value = row[field];
    if (value !== null && value !== '') utm[field] = value;
  }
  return {
    id: row.id,
    url: row.url,
    utm,
    passQuery: bool(row.pass_query),
    expiresAt: row.expires_at,
    expiredUrl: row.expired_url,
    ogTitle: row.og_title,
    ogDescription: row.og_description,
    ogImage: row.og_image,
  };
}

function dim(value: string | null, max: number): string {
  return (value ?? '').trim().slice(0, max);
}

export function recordClick(ctx: CrmContext, input: ShortlinkClickInput): { ok: true } {
  const exists = ctx.db.all(`SELECT id FROM short_links WHERE id = ?`, input.linkId).length > 0;
  if (!exists) return { ok: true };
  const day = new Date(ctx.now()).toISOString().slice(0, 10);
  ctx.db.run(`UPDATE short_links SET clicks = clicks + 1 WHERE id = ?`, input.linkId);
  ctx.db.run(
    `INSERT INTO short_link_clicks_daily (link_id, day, country, referrer_host, device, browser, os, bot, clicks)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT (link_id, day, country, referrer_host, device, browser, os, bot)
     DO UPDATE SET clicks = clicks + 1`,
    input.linkId,
    day,
    dim(input.country, 8).toUpperCase(),
    dim(input.referrerHost, 253).toLowerCase(),
    dim(input.device, 32),
    dim(input.browser, 64),
    dim(input.os, 64),
    input.bot ? 1 : 0,
  );
  return { ok: true };
}

export function linkStats(ctx: CrmContext, input: { id: string; days: number }): ShortlinkStats {
  const row = getRow(ctx, input.id);
  const today = Math.floor(ctx.now() / DAY_MS) * DAY_MS;
  const days: string[] = [];
  for (let i = input.days - 1; i >= 0; i -= 1) {
    days.push(new Date(today - i * DAY_MS).toISOString().slice(0, 10));
  }
  const from = days[0] ?? new Date(today).toISOString().slice(0, 10);
  const daily = ctx.db.all<{ day: string; bot: number; n: number }>(
    `SELECT day, bot, SUM(clicks) AS n FROM short_link_clicks_daily
     WHERE link_id = ? AND day >= ? GROUP BY day, bot`,
    row.id,
    from,
  );
  const byDay = new Map(days.map((day) => [day, { day, humans: 0, bots: 0 }]));
  let human = 0;
  let bot = 0;
  for (const r of daily) {
    const point = byDay.get(r.day);
    if (r.bot === 1) bot += r.n;
    else human += r.n;
    if (point === undefined) continue;
    if (r.bot === 1) point.bots += r.n;
    else point.humans += r.n;
  }
  const top = (column: 'country' | 'referrer_host' | 'device' | 'browser', limit: number) =>
    ctx.db
      .all<{ value: string; clicks: number }>(
        `SELECT ${column} AS value, SUM(clicks) AS clicks FROM short_link_clicks_daily
         WHERE link_id = ? AND day >= ? AND bot = 0
         GROUP BY ${column} ORDER BY clicks DESC, value LIMIT ?`,
        row.id,
        from,
        limit,
      )
      .map((r) => ({ value: r.value, clicks: r.clicks }));
  return {
    days: input.days,
    total_clicks: row.clicks,
    human_clicks: human,
    bot_clicks: bot,
    series: [...byDay.values()],
    countries: top('country', 10),
    referrers: top('referrer_host', 10),
    devices: top('device', 5),
    browsers: top('browser', 10),
  };
}

/** Cascade of a removed (or re-kinded) shortlink domain. */
export function domainDeleted(ctx: CrmContext, input: { domainId: string }): { deleted_links: number } {
  const ids = ctx.db.all<{ id: string }>(`SELECT id FROM short_links WHERE domain_id = ?`, input.domainId);
  for (const { id } of ids) ctx.db.run(`DELETE FROM short_link_clicks_daily WHERE link_id = ?`, id);
  ctx.db.run(`DELETE FROM short_links WHERE domain_id = ?`, input.domainId);
  ctx.db.run(`DELETE FROM short_link_folder_domains WHERE domain_id = ?`, input.domainId);
  return { deleted_links: ids.length };
}

export const shortlinksOps = {
  'shortlinks.list': listLinks,
  'shortlinks.get': getLink,
  'shortlinks.create': createLink,
  'shortlinks.update': updateLink,
  'shortlinks.delete': deleteLink,
  'shortlinks.folders.list': listFolders,
  'shortlinks.folders.create': createFolder,
  'shortlinks.folders.update': updateFolder,
  'shortlinks.folders.delete': deleteFolder,
  'shortlinks.resolve': resolveLink,
  'shortlinks.click': recordClick,
  'shortlinks.stats': linkStats,
  'shortlinks.domain_deleted': domainDeleted,
} satisfies Record<string, (ctx: CrmContext, input: never) => unknown>;
