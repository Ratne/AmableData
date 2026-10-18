import {
  AD_PLATFORMS,
  OUTBOUND_KINDS,
  outboundPayloadSchema,
  type AdPlatform,
  type OutboundConversionJob,
  type OutboundKind,
  type OutboundPayload,
  type OutboundStatus,
  type TrafficSource,
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

// ------------------------------------------------- event mapping and gating

/** Conversion event of this CRM (`sale`, `lead`, `event:N`) → kind of outbound job. */
export function outboundKindOf(event: string): OutboundKind {
  if (event === 'sale') return 'purchase';
  if (event === 'lead') return 'lead';
  return 'custom';
}

export interface OutboundRoute {
  connection_id: string;
  platform: AdPlatform;
  /** Platform event name (`Purchase`, `CompletePayment`) or Google conversion action id. */
  platform_event: string;
}

/** Where a conversion of the source goes, or null when the source sends nothing for this event. */
export function outboundRouteFor(source: TrafficSource, event: string): OutboundRoute | null {
  const { ad_connection_id: connectionId, platform, mapping } = source.conversion;
  if (connectionId === null || connectionId === undefined || connectionId === '') return null;
  if (platform === null || platform === undefined) return null;
  const entry = mapping.find((m) => m.event === event);
  return entry === undefined ? null : { connection_id: connectionId, platform, platform_event: entry.platform_event };
}

export const OUTBOUND_SKIP_REASONS = ['no_consent', 'not_approved', 'zero_revenue', 'throttled', 'blacklisted'] as const;
export type OutboundSkipReason = (typeof OUTBOUND_SKIP_REASONS)[number];

export interface OutboundGateInput {
  revenue_minor: number;
  status?: 'approved' | 'pending' | 'rejected' | undefined;
  consent: boolean;
  blacklisted?: boolean | undefined;
  /** Uniform in [0, 1); drawn only when the source throttles. */
  rng: () => number;
}

/** Why the conversion must not reach the platform, or null when it can be sent. */
export function outboundGate(source: TrafficSource, input: OutboundGateInput): OutboundSkipReason | null {
  if (!input.consent) return 'no_consent';
  if (input.status !== undefined && input.status !== 'approved') return 'not_approved';
  if (input.blacklisted === true) return 'blacklisted';
  if (source.skip_zero_revenue_postbacks && input.revenue_minor === 0) return 'zero_revenue';
  const throttle = source.postback_throttle_pct ?? 0;
  if (throttle > 0 && input.rng() * 100 < throttle) return 'throttled';
  return null;
}

/** Value reported to the platform: the source's outgoing revenue modifier applied. */
export function outboundValueMinor(source: TrafficSource, revenueMinor: number): number {
  const pct = source.revenue_modifier_pct ?? 0;
  return pct === 0 ? revenueMinor : Math.round((revenueMinor * (100 + pct)) / 100);
}

/** Click-id parameters each platform matches conversions on; the first is the one a source's external field maps to. */
export const PLATFORM_CLICK_ID_KEYS: Readonly<Record<AdPlatform, readonly string[]>> = {
  meta: ['fbclid', 'fbc', 'fbp'],
  google: ['gclid', 'gbraid', 'wbraid'],
  tiktok: ['ttclid', 'ttp'],
};

/** Click ids captured by the tracker on the visitor's sessions, oldest first (later values win when merged). */
export function sessionClickIds(db: SqlDb, visitorId: string): Record<string, string>[] {
  return db
    .all<{ click_ids: string }>(
      `SELECT click_ids FROM sessions WHERE visitor_id = ? AND click_ids IS NOT NULL ORDER BY started_at, id`,
      visitorId,
    )
    .flatMap((r) => {
      try {
        const parsed = JSON.parse(r.click_ids) as unknown;
        if (parsed === null || typeof parsed !== 'object') return [];
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v;
        return [out];
      } catch {
        return [];
      }
    });
}

// ------------------------------------------------------ closing and resend

const PII_PATHS = `'$.email', '$.phone', '$.ip', '$.user_agent'`;

/** Settles the job; once closed (sent/failed/skipped) its payload loses email, phone, IP and user agent. */
export function finishOutbound(
  db: SqlDb,
  id: string,
  outcome: OutboundOutcome,
  now: number,
): OutboundConversionJob | null {
  settleOutbound(db, id, outcome, now);
  db.run(
    `UPDATE outbound_conversions SET payload = json_remove(payload, ${PII_PATHS})
     WHERE id = ? AND status <> 'pending'`,
    id,
  );
  return getOutbound(db, id);
}

/** Earliest `next_attempt_at` of the pending jobs, for alarm scheduling. */
export function nextOutboundAttemptAt(db: SqlDb): number | null {
  return (
    first<{ t: number | null }>(db, `SELECT MIN(next_attempt_at) AS t FROM outbound_conversions WHERE status = 'pending'`)
      ?.t ?? null
  );
}

/** Puts failed jobs back in the queue with a fresh attempt budget; other statuses are left alone. */
export function resendOutbound(db: SqlDb, ids: readonly string[], now: number): number {
  if (ids.length === 0) return 0;
  return db.all<{ id: string }>(
    `UPDATE outbound_conversions SET status = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL,
       updated_at = ?
     WHERE status = 'failed' AND id IN (SELECT value FROM json_each(?)) RETURNING id`,
    now,
    now,
    JSON.stringify(ids),
  ).length;
}

export const outboundResendFilterSchema = z.object({
  platform: z.enum(AD_PLATFORMS).optional(),
  connection_id: z.string().min(1).max(64).optional(),
  /** `created_at` range, epoch ms (from inclusive, to exclusive). */
  from: z.number().int().optional(),
  to: z.number().int().optional(),
});
export type OutboundResendFilter = z.input<typeof outboundResendFilterSchema>;

/** Bulk resend of every failed job matching the filter. */
export function resendFailedOutbound(
  db: SqlDb,
  filter: z.output<typeof outboundResendFilterSchema>,
  now: number,
): number {
  const where = [`status = 'failed'`];
  const params: SqlValue[] = [];
  const add = (sql: string, v: SqlValue | undefined): void => {
    if (v === undefined) return;
    where.push(sql);
    params.push(v);
  };
  add('platform = ?', filter.platform);
  add('connection_id = ?', filter.connection_id);
  add('created_at >= ?', filter.from);
  add('created_at < ?', filter.to);
  return db.all<{ id: string }>(
    `UPDATE outbound_conversions SET status = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL,
       updated_at = ?
     WHERE ${where.join(' AND ')} RETURNING id`,
    now,
    now,
    ...params,
  ).length;
}

export type OutboundStats = Record<OutboundStatus, number>;

/** Job counts per status (log header), same filters as `listOutbound` minus status. */
export function outboundStats(db: SqlDb, q: Omit<OutboundQuery, 'status' | 'limit'> = {}): OutboundStats {
  const where: string[] = [];
  const params: SqlValue[] = [];
  const add = (sql: string, v: SqlValue | undefined): void => {
    if (v === undefined) return;
    where.push(sql);
    params.push(v);
  };
  add('platform = ?', q.platform);
  add('connection_id = ?', q.connection_id);
  add('event_id = ?', q.event_id);
  add('created_at >= ?', q.from);
  add('created_at < ?', q.to);
  const out: OutboundStats = { pending: 0, sent: 0, failed: 0, skipped: 0 };
  for (const row of db.all<{ status: OutboundStatus; n: number }>(
    `SELECT status, COUNT(*) AS n FROM outbound_conversions ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
     GROUP BY status`,
    ...params,
  )) {
    out[row.status] = row.n;
  }
  return out;
}
