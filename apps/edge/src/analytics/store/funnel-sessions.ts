import { funnelTouchSchema, type FunnelGraph, type TrafficSource } from '@amable/api-types';
import { z } from 'zod';
import { first, type SqlDb } from '../db/sql';
import { DAY_MS } from '../time';

/**
 * Routing state of a visitor in a funnel (`funnel_sessions`): the node and
 * page the visitor is on (origin of the next action link), the rotator
 * history (sticky / anti-affinity) and the tracking fields captured at the
 * entrance. One row per (visitor, funnel); the most recent row is the
 * visitor's current funnel. Tags live in `visitor_tags`, data-buffer
 * parameters are never stored.
 */

export const FUNNEL_SESSION_TTL_MS = 90 * DAY_MS;

const id = z.string().min(1).max(128);
const text = (max: number) => z.string().max(max).nullable().optional();

export const funnelSessionInputSchema = z.object({
  visitor_id: id,
  funnel_id: id,
  current_node_id: text(128),
  current_page_id: text(128),
  rotations: z.record(z.string().max(128), z.array(z.string().max(128)).max(100)).default({}),
  traffic_source_id: text(128),
  campaign: text(255),
  external_click_id: text(512),
  fields: z.record(z.string().max(64), z.string().max(512)).nullable().optional(),
});
export type FunnelSessionInput = z.input<typeof funnelSessionInputSchema>;

export interface FunnelSessionRecord {
  visitor_id: string;
  funnel_id: string;
  current_node_id: string | null;
  current_page_id: string | null;
  rotations: Record<string, string[]>;
  traffic_source_id: string | null;
  campaign: string | null;
  external_click_id: string | null;
  /** Tracking fields captured at the entrance, by slot (`c1`…`c20`). */
  fields: Record<string, string> | null;
  created_at: number;
  updated_at: number;
}

interface SessionRow extends Omit<FunnelSessionRecord, 'rotations' | 'fields'> {
  rotations: string;
  fields: string | null;
}

function toSession(row: SessionRow): FunnelSessionRecord {
  return {
    ...row,
    rotations: JSON.parse(row.rotations) as Record<string, string[]>,
    fields: row.fields === null ? null : (JSON.parse(row.fields) as Record<string, string>),
  };
}

/** The visitor's session in `funnelId`, or its most recent one. */
export function getFunnelSession(db: SqlDb, visitorId: string, funnelId?: string | null): FunnelSessionRecord | null {
  const row =
    funnelId == null
      ? first<SessionRow>(
          db,
          `SELECT * FROM funnel_sessions WHERE visitor_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
          visitorId,
        )
      : first<SessionRow>(db, `SELECT * FROM funnel_sessions WHERE visitor_id = ? AND funnel_id = ?`, visitorId, funnelId);
  return row === undefined ? null : toSession(row);
}

/** Upserts the session and drops sessions idle for longer than the TTL. */
export function saveFunnelSession(
  db: SqlDb,
  input: z.output<typeof funnelSessionInputSchema>,
  now: number,
): FunnelSessionRecord {
  db.run(
    `INSERT INTO funnel_sessions (visitor_id, funnel_id, current_node_id, current_page_id, rotations, traffic_source_id,
       campaign, external_click_id, fields, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (visitor_id, funnel_id) DO UPDATE SET
       current_node_id = excluded.current_node_id,
       current_page_id = excluded.current_page_id,
       rotations = excluded.rotations,
       traffic_source_id = excluded.traffic_source_id,
       campaign = excluded.campaign,
       external_click_id = excluded.external_click_id,
       fields = excluded.fields,
       updated_at = excluded.updated_at`,
    input.visitor_id,
    input.funnel_id,
    input.current_node_id ?? null,
    input.current_page_id ?? null,
    JSON.stringify(input.rotations),
    input.traffic_source_id ?? null,
    input.campaign ?? null,
    input.external_click_id ?? null,
    input.fields === undefined || input.fields === null ? null : JSON.stringify(input.fields),
    now,
    now,
  );
  db.run(`DELETE FROM funnel_sessions WHERE updated_at < ?`, now - FUNNEL_SESSION_TTL_MS);
  return getFunnelSession(db, input.visitor_id, input.funnel_id)!;
}

// ------------------------------------------------------------ link routing RPC

export const funnelLinkQuerySchema = z.object({
  funnel_id: id.optional(),
  traffic_source_id: id.optional(),
  visitor_id: id.optional(),
  /** Without a session in `funnel_id`, use the visitor's most recent session (and its funnel). */
  latest_session: z.boolean().default(false),
});
export type FunnelLinkQuery = z.input<typeof funnelLinkQuerySchema>;

/** Everything a link route needs from the site in one call. */
export interface FunnelLinkContext {
  tenant_id: string;
  currency: string;
  timezone: string;
  /** Funnel of the query, else of the visitor's session. */
  graph: FunnelGraph | null;
  /** Source of the query, else of the visitor's session. */
  source: TrafficSource | null;
  session: FunnelSessionRecord | null;
  tags: string[];
}

const tagList = z.array(z.string().trim().min(1).max(64)).max(50).default([]);

export const funnelStepInputSchema = z.object({
  touches: z.array(funnelTouchSchema).max(10),
  session: funnelSessionInputSchema.nullable().optional(),
  tags: z
    .object({ visitor_id: id, add: tagList, remove: tagList })
    .nullable()
    .optional(),
});
export type FunnelStepInput = z.input<typeof funnelStepInputSchema>;

export interface FunnelStepResult {
  inserted: number;
  tags: string[];
}
