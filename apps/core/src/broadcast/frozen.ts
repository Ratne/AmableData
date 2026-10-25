import type { BroadcastStats } from '@amable/api-types';
import { chunked, parseJson } from '../email/context';
import type { SqlDb } from '../crm/db/sql';

/**
 * Broadcast totals frozen in `mail_broadcast_stats` before the archive moves
 * the first message or click of the broadcast to R2. From then on lists, stats
 * and reports read the frozen row instead of counting messages, so archived
 * broadcasts keep their numbers forever.
 */

export type BroadcastTotals = BroadcastStats['totals'];
export type BroadcastLinkStats = BroadcastStats['links'][number];
export type BroadcastProgress = BroadcastStats['progress'];

export interface FrozenBroadcastStats {
  totals: BroadcastTotals;
  links: BroadcastLinkStats[];
  progress: BroadcastProgress;
}

const NO_PROGRESS: BroadcastProgress = { recipients: 0, pending: 0, enqueued: 0, cancelled: 0 };

/** Message totals of a broadcast counted from the live tables (recipients excluded). */
export function liveTotals(db: SqlDb, broadcastId: string): Omit<BroadcastTotals, 'recipients'> {
  return (
    db.all<Omit<BroadcastTotals, 'recipients'>>(
      `SELECT COALESCE(SUM(CASE WHEN sent_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS sent,
              COALESCE(SUM(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS delivered,
              COALESCE(SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS opened,
              COALESCE(SUM(CASE WHEN clicked_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS clicked,
              COALESCE(SUM(CASE WHEN bounced_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS bounced,
              COALESCE(SUM(CASE WHEN complained_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS complained,
              COALESCE(SUM(CASE WHEN unsubscribed_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS unsubscribed,
              COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
              COALESCE(SUM(CASE WHEN status IN ('skipped', 'blocked') THEN 1 ELSE 0 END), 0) AS skipped
         FROM mail_messages WHERE broadcast_id = ?`,
      broadcastId,
    )[0] ?? {
      sent: 0,
      delivered: 0,
      opened: 0,
      clicked: 0,
      bounced: 0,
      complained: 0,
      unsubscribed: 0,
      failed: 0,
      skipped: 0,
    }
  );
}

/** Per-link clicks counted from the live tables, most clicked first. */
export function liveLinks(db: SqlDb, broadcastId: string): BroadcastLinkStats[] {
  const known = new Map<string, BroadcastLinkStats>();
  for (const l of db.all<{ url: string; position: number }>(
    `SELECT l.url AS url, MIN(l.position) AS position FROM mail_message_links l
       JOIN mail_messages m ON m.id = l.message_id
      WHERE m.broadcast_id = ? GROUP BY l.url`,
    broadcastId,
  )) {
    known.set(l.url, { url: l.url, position: l.position, clicks: 0, unique_clicks: 0 });
  }
  for (const c of db.all<BroadcastLinkStats>(
    `SELECT url, MIN(position) AS position, COUNT(*) AS clicks, COUNT(DISTINCT message_id) AS unique_clicks
       FROM mail_clicks WHERE broadcast_id = ? GROUP BY url`,
    broadcastId,
  )) {
    const entry = known.get(c.url);
    known.set(c.url, { ...c, position: entry?.position ?? c.position });
  }
  return [...known.values()].sort((a, b) => b.clicks - a.clicks || a.position - b.position);
}

/** Recipient counters of a broadcast from the live recipients table. */
export function liveProgress(db: SqlDb, broadcastId: string): BroadcastProgress {
  const row = db.all<{ total: number; pending: number; enqueued: number; cancelled: number }>(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
            COALESCE(SUM(CASE WHEN status = 'enqueued' THEN 1 ELSE 0 END), 0) AS enqueued,
            COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled
       FROM mail_broadcast_recipients WHERE broadcast_id = ?`,
    broadcastId,
  )[0];
  return row === undefined
    ? NO_PROGRESS
    : { recipients: row.total, pending: row.pending, enqueued: row.enqueued, cancelled: row.cancelled };
}

interface FrozenRow extends Omit<BroadcastTotals, 'recipients'> {
  broadcast_id: string;
  recipients: number;
  progress: string;
  links: string;
}

/** Frozen stats of the broadcasts in `ids` that have them. */
export function frozenStats(db: SqlDb, ids: readonly string[]): Map<string, FrozenBroadcastStats> {
  const out = new Map<string, FrozenBroadcastStats>();
  for (const chunk of chunked([...ids])) {
    for (const row of db.all<FrozenRow>(
      `SELECT * FROM mail_broadcast_stats WHERE broadcast_id IN (${chunk.map(() => '?').join(', ')})`,
      ...chunk,
    )) {
      out.set(row.broadcast_id, {
        totals: {
          recipients: row.recipients,
          sent: row.sent,
          delivered: row.delivered,
          opened: row.opened,
          clicked: row.clicked,
          bounced: row.bounced,
          complained: row.complained,
          unsubscribed: row.unsubscribed,
          failed: row.failed,
          skipped: row.skipped,
        },
        links: parseJson<BroadcastLinkStats[]>(row.links, []),
        progress: parseJson<BroadcastProgress>(row.progress, NO_PROGRESS),
      });
    }
  }
  return out;
}

/**
 * Freezes the stats of broadcasts that are not frozen yet (an existing row is
 * never recomputed: part of its messages may already be gone). Recipients of a
 * broadcast that is no longer sending are dropped with it: the frozen progress
 * replaces them.
 */
export function freezeBroadcastStats(db: SqlDb, ids: readonly string[], now: number): void {
  const unique = [...new Set(ids.filter((id) => id !== ''))];
  const already = frozenStats(db, unique);
  for (const id of unique) {
    if (already.has(id)) continue;
    const totals = liveTotals(db, id);
    const progress = liveProgress(db, id);
    const total = db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM mail_messages WHERE broadcast_id = ?`, id)[0]?.n ?? 0;
    db.run(
      `INSERT INTO mail_broadcast_stats
         (broadcast_id, recipients, total, sent, delivered, opened, clicked, bounced, complained,
          unsubscribed, failed, skipped, progress, links, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      progress.recipients,
      total,
      totals.sent,
      totals.delivered,
      totals.opened,
      totals.clicked,
      totals.bounced,
      totals.complained,
      totals.unsubscribed,
      totals.failed,
      totals.skipped,
      JSON.stringify(progress),
      JSON.stringify(liveLinks(db, id)),
      now,
    );
  }
  for (const chunk of chunked(unique)) {
    db.run(
      `DELETE FROM mail_broadcast_recipients WHERE broadcast_id IN (
         SELECT id FROM mail_broadcasts WHERE status IN ('sent', 'cancelled')
            AND id IN (${chunk.map(() => '?').join(', ')}))`,
      ...chunk,
    );
  }
}
