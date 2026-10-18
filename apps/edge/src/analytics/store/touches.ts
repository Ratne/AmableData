import { conversionEventSchema, type FunnelTouch, type TouchKind } from '@amable/api-types';
import { z } from 'zod';
import { first, type SqlDb, type SqlValue } from '../db/sql';
import { DAY_MS } from '../time';
import { newObjectId } from './config';

/**
 * Funnel click-log (`touches`, immutable: re-recording a touch id is a no-op)
 * and the conversions received for its hits (`conversion_log`). A touch is
 * `identified` once its visitor has an email/phone key or a CRM contact:
 * anonymous touches expire after 90 days, identified ones are kept.
 */

export const ANONYMOUS_TOUCH_TTL_MS = 90 * DAY_MS;

interface TouchRow {
  id: string;
  ts: number;
  visitor_id: string;
  session_id: string;
  funnel_id: string;
  node_id: string;
  page_id: string | null;
  traffic_source_id: string | null;
  kind: TouchKind;
  action_number: number | null;
  campaign: string | null;
  external_click_id: string | null;
  fields: string | null;
  cost_minor: number | null;
}

function toTouch(row: TouchRow): FunnelTouch {
  return {
    id: row.id,
    ts: row.ts,
    visitor_id: row.visitor_id,
    session_id: row.session_id,
    funnel_id: row.funnel_id,
    node_id: row.node_id,
    page_id: row.page_id,
    traffic_source_id: row.traffic_source_id,
    kind: row.kind,
    action_number: row.action_number,
    campaign: row.campaign,
    external_click_id: row.external_click_id,
    fields: row.fields === null ? null : (JSON.parse(row.fields) as Record<string, string>),
    cost_minor: row.cost_minor,
  };
}

/** Visitors known by email/phone or linked to a CRM contact. */
const IDENTIFIED_VISITOR_SQL = `(
  SELECT visitor_id FROM identity_keys WHERE key_type IN ('email', 'phone')
  UNION SELECT id FROM visitors WHERE contact_id IS NOT NULL OR email IS NOT NULL
)`;

function isIdentified(db: SqlDb, visitorId: string): boolean {
  return (
    first<{ v: string }>(
      db,
      `SELECT visitor_id AS v FROM ${IDENTIFIED_VISITOR_SQL} WHERE visitor_id = ? LIMIT 1`,
      visitorId,
    ) !== undefined
  );
}

/** Inserts the touch unless its id exists; true when inserted. */
export function insertTouch(db: SqlDb, touch: FunnelTouch): boolean {
  const inserted = db.all<{ id: string }>(
    `INSERT INTO touches (id, ts, visitor_id, session_id, funnel_id, node_id, page_id, traffic_source_id, kind,
       action_number, campaign, external_click_id, fields, cost_minor, identified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO NOTHING RETURNING id`,
    touch.id,
    touch.ts,
    touch.visitor_id,
    touch.session_id,
    touch.funnel_id,
    touch.node_id,
    touch.page_id ?? null,
    touch.traffic_source_id ?? null,
    touch.kind,
    touch.action_number ?? null,
    touch.campaign ?? null,
    touch.external_click_id ?? null,
    touch.fields === undefined || touch.fields === null ? null : JSON.stringify(touch.fields),
    touch.cost_minor ?? null,
    isIdentified(db, touch.visitor_id) ? 1 : 0,
  );
  return inserted.length > 0;
}

export function getTouch(db: SqlDb, id: string): FunnelTouch | null {
  const row = first<TouchRow>(db, `SELECT * FROM touches WHERE id = ?`, id);
  return row === undefined ? null : toTouch(row);
}

export function touchesByVisitor(
  db: SqlDb,
  visitorIds: readonly string[],
  limit: number,
): FunnelTouch[] {
  if (visitorIds.length === 0) return [];
  return db
    .all<TouchRow>(
      `SELECT * FROM touches WHERE visitor_id IN (SELECT value FROM json_each(?)) ORDER BY ts, id LIMIT ?`,
      JSON.stringify(visitorIds),
      limit,
    )
    .map(toTouch);
}

export interface TouchQuery {
  /** Epoch ms, inclusive. */
  from: number;
  /** Epoch ms, exclusive. */
  to: number;
  funnel_id?: string | undefined;
  traffic_source_id?: string | undefined;
  kind?: TouchKind | undefined;
  limit?: number | undefined;
}

export function listTouches(db: SqlDb, q: TouchQuery): FunnelTouch[] {
  const where = ['ts >= ?', 'ts < ?'];
  const params: SqlValue[] = [q.from, q.to];
  if (q.funnel_id !== undefined) {
    where.push('funnel_id = ?');
    params.push(q.funnel_id);
  }
  if (q.traffic_source_id !== undefined) {
    where.push('traffic_source_id = ?');
    params.push(q.traffic_source_id);
  }
  if (q.kind !== undefined) {
    where.push('kind = ?');
    params.push(q.kind);
  }
  const limit = Math.min(Math.max(q.limit ?? 1000, 1), 10_000);
  return db
    .all<TouchRow>(
      `SELECT * FROM touches WHERE ${where.join(' AND ')} ORDER BY ts, id LIMIT ?`,
      ...params,
      limit,
    )
    .map(toTouch);
}

/** Flags the touches of these visitors as identified (kept past the anonymous TTL). */
export function markTouchesIdentified(db: SqlDb, visitorIds: readonly string[]): void {
  if (visitorIds.length === 0) return;
  db.run(
    `UPDATE touches SET identified = 1 WHERE identified = 0 AND visitor_id IN (SELECT value FROM json_each(?))`,
    JSON.stringify(visitorIds),
  );
}

/**
 * Deletes anonymous touches older than 90 days. Visitors identified since the
 * touch was recorded (CRM link, email set by ingest) are flagged first.
 */
export function purgeAnonymousTouches(db: SqlDb, now: number): number {
  const cutoff = now - ANONYMOUS_TOUCH_TTL_MS;
  db.run(
    `UPDATE touches SET identified = 1
     WHERE identified = 0 AND ts < ? AND visitor_id IN ${IDENTIFIED_VISITOR_SQL}`,
    cutoff,
  );
  return db.all<{ id: string }>(
    `DELETE FROM touches WHERE identified = 0 AND ts < ? RETURNING id`,
    cutoff,
  ).length;
}

// ------------------------------------------------------------- conversion log

export const CONVERSION_STATUSES = ['approved', 'pending', 'rejected'] as const;
export type ConversionStatus = (typeof CONVERSION_STATUSES)[number];

/** Conversion received for a hit (postback, JS conversion, bulk update). Never holds PII. */
export interface ConversionRecord {
  id: string;
  hit: string;
  /** `''` when the postback carried no transaction id. */
  tx: string;
  /** `sale`, `lead` or `event:N`. */
  event: string;
  status: ConversionStatus;
  revenue_minor: number;
  currency: string | null;
  /** Conversion time (epoch ms). */
  ts: number;
  visitor_id: string | null;
  session_id: string | null;
  funnel_id: string | null;
  node_id: string | null;
  page_id: string | null;
  traffic_source_id: string | null;
  source: string;
  data: Record<string, string> | null;
  received_at: number;
  updated_at: number;
}

const optionalId = z.string().min(1).max(128).nullable().optional();

export const conversionInputSchema = z.object({
  hit: z.string().min(1).max(128),
  tx: z.string().max(255).nullable().optional(),
  event: conversionEventSchema.default('sale'),
  status: z.enum(CONVERSION_STATUSES).default('approved'),
  revenue_minor: z.number().int(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable()
    .optional(),
  ts: z.number().int().optional(),
  /** Filled from the hit's touch when omitted. */
  visitor_id: optionalId,
  session_id: optionalId,
  funnel_id: optionalId,
  node_id: optionalId,
  page_id: optionalId,
  traffic_source_id: optionalId,
  source: z.string().min(1).max(32).default('postback'),
  data: z.record(z.string().max(64), z.string().max(512)).nullable().optional(),
});
export type ConversionInput = z.input<typeof conversionInputSchema>;

interface ConversionRow extends Omit<ConversionRecord, 'data'> {
  data: string | null;
}

function toConversion(row: ConversionRow): ConversionRecord {
  return {
    ...row,
    data: row.data === null ? null : (JSON.parse(row.data) as Record<string, string>),
  };
}

/**
 * Idempotent on (hit, event, tx): the same triple updates the stored
 * conversion, a different tx on the same hit is another conversion.
 */
export function upsertConversion(
  db: SqlDb,
  input: z.output<typeof conversionInputSchema>,
  now: number,
): { id: string; created: boolean } {
  const touch = getTouch(db, input.hit);
  const pick = (v: string | null | undefined, fallback: string | null | undefined): string | null =>
    v ?? fallback ?? null;
  const tx = input.tx ?? '';
  const { event } = input;
  const existing = first<{ id: string }>(
    db,
    `SELECT id FROM conversion_log WHERE hit = ? AND event = ? AND tx = ?`,
    input.hit,
    event,
    tx,
  );
  const values: SqlValue[] = [
    input.status,
    input.revenue_minor,
    input.currency ?? null,
    input.ts ?? now,
    pick(input.visitor_id, touch?.visitor_id),
    pick(input.session_id, touch?.session_id),
    pick(input.funnel_id, touch?.funnel_id),
    pick(input.node_id, touch?.node_id),
    pick(input.page_id, touch?.page_id),
    pick(input.traffic_source_id, touch?.traffic_source_id),
    input.source,
    input.data === undefined || input.data === null ? null : JSON.stringify(input.data),
  ];
  if (existing !== undefined) {
    db.run(
      `UPDATE conversion_log SET status = ?, revenue_minor = ?, currency = ?, ts = ?, visitor_id = ?, session_id = ?,
         funnel_id = ?, node_id = ?, page_id = ?, traffic_source_id = ?, source = ?, data = ?, updated_at = ?
       WHERE id = ?`,
      ...values,
      now,
      existing.id,
    );
    return { id: existing.id, created: false };
  }
  const id = newObjectId('cv');
  db.run(
    `INSERT INTO conversion_log (status, revenue_minor, currency, ts, visitor_id, session_id, funnel_id, node_id,
       page_id, traffic_source_id, source, data, id, hit, tx, event, received_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ...values,
    id,
    input.hit,
    tx,
    event,
    now,
    now,
  );
  return { id, created: true };
}

export function getConversion(db: SqlDb, id: string): ConversionRecord | null {
  const row = first<ConversionRow>(db, `SELECT * FROM conversion_log WHERE id = ?`, id);
  return row === undefined ? null : toConversion(row);
}

export interface ConversionQuery {
  from?: number | undefined;
  to?: number | undefined;
  hit?: string | undefined;
  visitor_id?: string | undefined;
  funnel_id?: string | undefined;
  traffic_source_id?: string | undefined;
  limit?: number | undefined;
}

export function listConversions(db: SqlDb, q: ConversionQuery): ConversionRecord[] {
  const where: string[] = [];
  const params: SqlValue[] = [];
  const add = (sql: string, v: SqlValue | undefined): void => {
    if (v === undefined) return;
    where.push(sql);
    params.push(v);
  };
  add('ts >= ?', q.from);
  add('ts < ?', q.to);
  add('hit = ?', q.hit);
  add('visitor_id = ?', q.visitor_id);
  add('funnel_id = ?', q.funnel_id);
  add('traffic_source_id = ?', q.traffic_source_id);
  const limit = Math.min(Math.max(q.limit ?? 1000, 1), 10_000);
  return db
    .all<ConversionRow>(
      `SELECT * FROM conversion_log ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`} ORDER BY ts, rowid LIMIT ?`,
      ...params,
      limit,
    )
    .map(toConversion);
}
