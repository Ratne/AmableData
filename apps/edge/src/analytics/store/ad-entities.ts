import {
  AD_CONNECTION_STATUSES,
  AD_PLATFORMS,
  type AdConnection,
  type AdEntity,
  type AdEntityLevel,
  type AdPlatform,
  type AdSpendDay,
} from '@amable/api-types';
import { z } from 'zod';
import { first, type SqlDb, type SqlValue } from '../db/sql';

/**
 * Ad platform data of a site: connections (OAuth tokens stay in the core,
 * only account + status here), entities (campaign → adset → ad) and daily
 * spend. Every write is an upsert on the platform's own keys, so re-syncing a
 * range overwrites it.
 */

export interface AdConnectionRecord extends AdConnection {
  metadata: Record<string, unknown>;
  updated_at: number;
}

export const adConnectionInputSchema = z.object({
  id: z.string().min(1).max(64),
  platform: z.enum(AD_PLATFORMS),
  account_id: z.string().min(1).max(128),
  account_name: z.string().max(500).nullable().optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable()
    .optional(),
  status: z.enum(AD_CONNECTION_STATUSES).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  last_sync_at: z.number().int().nullable().optional(),
  last_error: z.string().max(2000).nullable().optional(),
});
export type AdConnectionInput = z.input<typeof adConnectionInputSchema>;

interface AdConnectionRow extends Omit<AdConnectionRecord, 'metadata'> {
  metadata: string;
}

function toConnection(row: AdConnectionRow): AdConnectionRecord {
  return { ...row, metadata: JSON.parse(row.metadata) as Record<string, unknown> };
}

export function getAdConnection(db: SqlDb, id: string): AdConnectionRecord | null {
  const row = first<AdConnectionRow>(db, `SELECT * FROM ad_connections WHERE id = ?`, id);
  return row === undefined ? null : toConnection(row);
}

export function listAdConnections(db: SqlDb, platform?: AdPlatform): AdConnectionRecord[] {
  const rows =
    platform === undefined
      ? db.all<AdConnectionRow>(`SELECT * FROM ad_connections ORDER BY created_at, id`)
      : db.all<AdConnectionRow>(
          `SELECT * FROM ad_connections WHERE platform = ? ORDER BY created_at, id`,
          platform,
        );
  return rows.map(toConnection);
}

/** Inserts or patches by id: omitted fields keep their stored value. */
export function upsertAdConnection(
  db: SqlDb,
  input: AdConnectionInput,
  now: number,
): AdConnectionRecord {
  const current = getAdConnection(db, input.id);
  const keep = <K extends keyof AdConnectionInput & keyof AdConnectionRecord>(
    key: K,
    fallback: AdConnectionRecord[K],
  ): AdConnectionRecord[K] =>
    input[key] !== undefined
      ? (input[key] as AdConnectionRecord[K])
      : current === null
        ? fallback
        : current[key];
  db.run(
    `INSERT INTO ad_connections (id, platform, account_id, account_name, currency, status, metadata, last_sync_at,
       last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET platform = excluded.platform, account_id = excluded.account_id,
       account_name = excluded.account_name, currency = excluded.currency, status = excluded.status,
       metadata = excluded.metadata, last_sync_at = excluded.last_sync_at, last_error = excluded.last_error,
       updated_at = excluded.updated_at`,
    input.id,
    input.platform,
    input.account_id,
    keep('account_name', null),
    keep('currency', null),
    keep('status', 'active'),
    JSON.stringify(keep('metadata', {})),
    keep('last_sync_at', null),
    keep('last_error', null),
    current?.created_at ?? now,
    now,
  );
  return getAdConnection(db, input.id) as AdConnectionRecord;
}

// ------------------------------------------------------------------ entities

export interface AdEntityRecord extends AdEntity {
  connection_id: string | null;
  updated_at: number;
}

export function upsertAdEntities(
  db: SqlDb,
  entities: readonly AdEntity[],
  connectionId: string | null,
  now: number,
): number {
  for (const e of entities) {
    db.run(
      `INSERT INTO ad_entities (platform, external_id, level, parent_external_id, connection_id, name, status,
         budget_minor, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (platform, external_id) DO UPDATE SET level = excluded.level,
         parent_external_id = excluded.parent_external_id,
         connection_id = COALESCE(excluded.connection_id, ad_entities.connection_id), name = excluded.name,
         status = excluded.status, budget_minor = excluded.budget_minor, updated_at = excluded.updated_at`,
      e.platform,
      e.external_id,
      e.level,
      e.parent_external_id ?? null,
      connectionId,
      e.name,
      e.status,
      e.budget_minor ?? null,
      now,
    );
  }
  return entities.length;
}

export interface AdEntityQuery {
  platform?: AdPlatform | undefined;
  level?: AdEntityLevel | undefined;
  parent_external_id?: string | undefined;
  external_ids?: readonly string[] | undefined;
}

export function listAdEntities(db: SqlDb, q: AdEntityQuery = {}): AdEntityRecord[] {
  const where: string[] = [];
  const params: SqlValue[] = [];
  if (q.platform !== undefined) {
    where.push('platform = ?');
    params.push(q.platform);
  }
  if (q.level !== undefined) {
    where.push('level = ?');
    params.push(q.level);
  }
  if (q.parent_external_id !== undefined) {
    where.push('parent_external_id = ?');
    params.push(q.parent_external_id);
  }
  if (q.external_ids !== undefined) {
    where.push('external_id IN (SELECT value FROM json_each(?))');
    params.push(JSON.stringify(q.external_ids));
  }
  return db.all<AdEntityRecord>(
    `SELECT platform, level, external_id, parent_external_id, name, status, budget_minor, connection_id, updated_at
     FROM ad_entities ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
     ORDER BY platform, level, external_id`,
    ...params,
  );
}

// --------------------------------------------------------------------- spend

export function upsertAdSpend(
  db: SqlDb,
  rows: readonly AdSpendDay[],
  connectionId: string | null,
  now: number,
): number {
  for (const r of rows) {
    db.run(
      `INSERT INTO ad_spend_daily (platform, entity_external_id, day, connection_id, spend_minor, currency, clicks,
         impressions, reported_conversions, reported_revenue_minor, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (platform, entity_external_id, day) DO UPDATE SET
         connection_id = COALESCE(excluded.connection_id, ad_spend_daily.connection_id),
         spend_minor = excluded.spend_minor, currency = excluded.currency, clicks = excluded.clicks,
         impressions = excluded.impressions, reported_conversions = excluded.reported_conversions,
         reported_revenue_minor = excluded.reported_revenue_minor, updated_at = excluded.updated_at`,
      r.platform,
      r.entity_external_id,
      r.day,
      connectionId,
      r.spend_minor,
      r.currency ?? null,
      r.clicks ?? null,
      r.impressions ?? null,
      r.reported_conversions ?? null,
      r.reported_revenue_minor ?? null,
      now,
    );
  }
  return rows.length;
}

export interface AdSpendQuery {
  /** First day, `YYYY-MM-DD`, inclusive. */
  from: string;
  /** Last day, `YYYY-MM-DD`, inclusive. */
  to: string;
  platform?: AdPlatform | undefined;
  entity_external_ids?: readonly string[] | undefined;
}

interface AdSpendRow {
  platform: AdPlatform;
  entity_external_id: string;
  day: string;
  spend_minor: number;
  currency: string | null;
  clicks: number | null;
  impressions: number | null;
  reported_conversions: number | null;
  reported_revenue_minor: number | null;
}

export function listAdSpend(db: SqlDb, q: AdSpendQuery): AdSpendDay[] {
  const where = ['day >= ?', 'day <= ?'];
  const params: SqlValue[] = [q.from, q.to];
  if (q.platform !== undefined) {
    where.push('platform = ?');
    params.push(q.platform);
  }
  if (q.entity_external_ids !== undefined) {
    where.push('entity_external_id IN (SELECT value FROM json_each(?))');
    params.push(JSON.stringify(q.entity_external_ids));
  }
  return db
    .all<AdSpendRow>(
      `SELECT platform, entity_external_id, day, spend_minor, currency, clicks, impressions, reported_conversions,
         reported_revenue_minor
       FROM ad_spend_daily WHERE ${where.join(' AND ')} ORDER BY day, platform, entity_external_id`,
      ...params,
    )
    .map(({ currency, ...r }) => (currency === null ? r : { ...r, currency }));
}
