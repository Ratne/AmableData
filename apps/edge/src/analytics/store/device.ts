import type { DeviceSignalsReport } from '@amable/api-types';
import { first, type SqlDb } from '../db/sql';

const ratio = (part: number, whole: number) => (whole === 0 ? 0 : part / whole);

/** What the device signals collected so far say, and the merges of the `device_ip` rule. */
export function deviceSignalsReport(db: SqlDb): DeviceSignalsReport {
  const totals = first<{ collected: number; devices: number; would_merge: number }>(
    db,
    `SELECT COUNT(*) AS collected, COUNT(DISTINCT device_key) AS devices,
       COUNT(candidate) AS would_merge FROM device_signals`,
  ) ?? { collected: 0, devices: 0, would_merge: 0 };
  const groups = db.all<{
    os: string | null;
    browser: string | null;
    visitors: number;
    unique_keys: number;
    back: number;
    stable: number;
  }>(
    `WITH holders AS (SELECT device_key, COUNT(*) AS n FROM device_signals GROUP BY device_key)
     SELECT d.os, d.browser, COUNT(*) AS visitors,
       SUM(CASE WHEN h.n = 1 THEN 1 ELSE 0 END) AS unique_keys,
       SUM(CASE WHEN d.last_seen > d.first_seen THEN 1 ELSE 0 END) AS back,
       SUM(CASE WHEN d.last_seen > d.first_seen AND d.changes = 0 THEN 1 ELSE 0 END) AS stable
     FROM device_signals d JOIN holders h ON h.device_key = d.device_key
     GROUP BY d.os, d.browser ORDER BY visitors DESC LIMIT 12`,
  );
  const precision = first<{ checked: number; correct: number }>(
    db,
    `WITH emails AS (SELECT visitor_id, key_value FROM identity_keys WHERE key_type = 'email'),
     pairs AS (
       SELECT d.visitor_id AS a, d.candidate AS b FROM device_signals d
       WHERE d.candidate IS NOT NULL
         AND EXISTS (SELECT 1 FROM emails WHERE visitor_id = d.visitor_id)
         AND EXISTS (SELECT 1 FROM emails WHERE visitor_id = d.candidate))
     SELECT COUNT(*) AS checked,
       COALESCE(SUM(EXISTS (SELECT 1 FROM emails x JOIN emails y ON y.key_value = x.key_value
         WHERE x.visitor_id = pairs.a AND y.visitor_id = pairs.b)), 0) AS correct
     FROM pairs`,
  ) ?? { checked: 0, correct: 0 };
  const merges = db.all<{
    child_visitor_id: string;
    origin_visitor_id: string;
    created_at: number;
  }>(
    `SELECT child_visitor_id, origin_visitor_id, created_at FROM visitor_merges
     WHERE mechanism = 'device_ip' AND active = 1 ORDER BY created_at DESC LIMIT 200`,
  );
  const merged =
    first<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM visitor_merges WHERE mechanism = 'device_ip' AND active = 1`,
    )?.n ?? 0;
  return {
    ...totals,
    groups: groups.map((g) => ({
      os: g.os,
      browser: g.browser,
      visitors: g.visitors,
      unique_share: ratio(g.unique_keys, g.visitors),
      returning: g.back,
      stable_share: g.back === 0 ? null : g.stable / g.back,
    })),
    precision,
    merges,
    merged,
  };
}

/**
 * Disconnects `device_ip` merges (the given children, or all of them). Like a
 * manual unmerge, the rows stay inactive so no automatic merge reconnects them.
 */
export function unmergeDeviceMerges(
  db: SqlDb,
  childVisitorIds: readonly string[] | null,
  now: number,
): number {
  const changes = db.all<{ n: number }>(
    `UPDATE visitor_merges SET active = 0, updated_at = ?
     WHERE mechanism = 'device_ip' AND active = 1
       AND (? IS NULL OR child_visitor_id IN (SELECT value FROM json_each(?)))
     RETURNING 1 AS n`,
    now,
    childVisitorIds === null ? null : 1,
    JSON.stringify(childVisitorIds ?? []),
  );
  return changes.length;
}
