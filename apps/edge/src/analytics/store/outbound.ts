import {
  AD_PLATFORMS,
  OUTBOUND_KINDS,
  outboundPayloadSchema,
  type AdPlatform,
  type OutboundConversionJob,
  type OutboundKind,
  type OutboundPayload,
  type OutboundStatus,
} from '@amable/api-types';
import { z } from 'zod';
import { first, type SqlDb, type SqlValue } from '../db/sql';
import { newObjectId } from './config';

/**
 * Queue of conversions sent to the ad platforms. `event_id` is unique: a
 * conversion is enqueued once however many times it is reported. A claim
 * leases the job (pushes `next_attempt_at`) and counts the attempt, so a
 * worker that dies mid-send never blocks it and never resends it early.
 */

export const OUTBOUND_CLAIM_LEASE_MS = 10 * 60_000;

export const outboundEnqueueSchema = z.object({
  platform: z.enum(AD_PLATFORMS),
  connection_id: z.string().min(1).max(64),
  kind: z.enum(OUTBOUND_KINDS),
  payload: outboundPayloadSchema,
  event_id: z.string().min(1).max(128),
  /** First attempt not before (default: now). */
  next_attempt_at: z.number().int().optional(),
});
export type OutboundEnqueueInput = z.input<typeof outboundEnqueueSchema>;

export type OutboundOutcome =
  | { status: 'sent' }
  | { status: 'retry'; error: string; next_attempt_at: number }
  | { status: 'failed'; error: string }
  | { status: 'skipped'; error?: string | undefined };

interface OutboundRow {
  id: string;
  event_id: string;
  platform: AdPlatform;
  connection_id: string;
  kind: OutboundKind;
  payload: string;
  status: OutboundStatus;
  attempts: number;
  last_error: string | null;
  next_attempt_at: number | null;
  sent_at: number | null;
  created_at: number;
}

function toJob(row: OutboundRow): OutboundConversionJob {
  return {
    id: row.id,
    platform: row.platform,
    connection_id: row.connection_id,
    kind: row.kind,
    payload: JSON.parse(row.payload) as OutboundPayload,
    status: row.status,
    attempts: row.attempts,
    last_error: row.last_error,
    event_id: row.event_id,
    created_at: row.created_at,
    next_attempt_at: row.next_attempt_at,
    sent_at: row.sent_at,
  };
}

export function getOutbound(db: SqlDb, id: string): OutboundConversionJob | null {
  const row = first<OutboundRow>(db, `SELECT * FROM outbound_conversions WHERE id = ?`, id);
  return row === undefined ? null : toJob(row);
}

/** Enqueues the job unless its `event_id` is already queued (whatever its status). */
export function enqueueOutbound(
  db: SqlDb,
  input: z.output<typeof outboundEnqueueSchema>,
  now: number,
): { id: string; created: boolean } {
  const id = newObjectId('ob');
  const inserted = db.all<{ id: string }>(
    `INSERT INTO outbound_conversions (id, event_id, platform, connection_id, kind, payload, status, attempts,
       next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
     ON CONFLICT (event_id) DO NOTHING RETURNING id`,
    id,
    input.event_id,
    input.platform,
    input.connection_id,
    input.kind,
    JSON.stringify(input.payload),
    input.next_attempt_at ?? now,
    now,
    now,
  );
  if (inserted.length > 0) return { id, created: true };
  const existing = first<{ id: string }>(
    db,
    `SELECT id FROM outbound_conversions WHERE event_id = ?`,
    input.event_id,
  );
  return { id: existing?.id ?? id, created: false };
}

/** Due pending jobs (oldest due first), leased to the caller. */
export function claimOutboundBatch(db: SqlDb, now: number, limit: number): OutboundConversionJob[] {
  const ids = db
    .all<{ id: string }>(
      `SELECT id FROM outbound_conversions WHERE status = 'pending' AND next_attempt_at <= ?
       ORDER BY next_attempt_at, rowid LIMIT ?`,
      now,
      limit,
    )
    .map((r) => r.id);
  if (ids.length === 0) return [];
  const list = JSON.stringify(ids);
  db.run(
    `UPDATE outbound_conversions SET attempts = attempts + 1, next_attempt_at = ?, updated_at = ?
     WHERE id IN (SELECT value FROM json_each(?))`,
    now + OUTBOUND_CLAIM_LEASE_MS,
    now,
    list,
  );
  return db
    .all<OutboundRow>(
      `SELECT * FROM outbound_conversions WHERE id IN (SELECT value FROM json_each(?))
       ORDER BY rowid`,
      list,
    )
    .map(toJob);
}

export function settleOutbound(
  db: SqlDb,
  id: string,
  outcome: OutboundOutcome,
  now: number,
): OutboundConversionJob | null {
  switch (outcome.status) {
    case 'sent':
      db.run(
        `UPDATE outbound_conversions SET status = 'sent', sent_at = ?, next_attempt_at = NULL, last_error = NULL,
           updated_at = ? WHERE id = ?`,
        now,
        now,
        id,
      );
      break;
    case 'retry':
      db.run(
        `UPDATE outbound_conversions SET status = 'pending', next_attempt_at = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
        outcome.next_attempt_at,
        outcome.error,
        now,
        id,
      );
      break;
    case 'failed':
    case 'skipped':
      db.run(
        `UPDATE outbound_conversions SET status = ?, next_attempt_at = NULL, last_error = ?, updated_at = ?
         WHERE id = ?`,
        outcome.status,
        outcome.error ?? null,
        now,
        id,
      );
      break;
  }
  return getOutbound(db, id);
}

export interface OutboundQuery {
  status?: OutboundStatus | undefined;
  platform?: AdPlatform | undefined;
  connection_id?: string | undefined;
  event_id?: string | undefined;
  /** `created_at` range, epoch ms (from inclusive, to exclusive). */
  from?: number | undefined;
  to?: number | undefined;
  limit?: number | undefined;
}

/** Newest first. */
export function listOutbound(db: SqlDb, q: OutboundQuery = {}): OutboundConversionJob[] {
  const where: string[] = [];
  const params: SqlValue[] = [];
  const add = (sql: string, v: SqlValue | undefined): void => {
    if (v === undefined) return;
    where.push(sql);
    params.push(v);
  };
  add('status = ?', q.status);
  add('platform = ?', q.platform);
  add('connection_id = ?', q.connection_id);
  add('event_id = ?', q.event_id);
  add('created_at >= ?', q.from);
  add('created_at < ?', q.to);
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 1000);
  return db
    .all<OutboundRow>(
      `SELECT * FROM outbound_conversions ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
       ORDER BY rowid DESC LIMIT ?`,
      ...params,
      limit,
    )
    .map(toJob);
}
