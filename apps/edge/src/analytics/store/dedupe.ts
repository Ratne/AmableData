import type { SqlDb } from '../db/sql';
import { DAY_MS } from '../time';

/**
 * How long applied event ids are remembered. Queue redeliveries, DLQ replays
 * and offline tracker buffers younger than this are deduped by the site DO;
 * older material is never replayed blindly (see `wal.ts`, `REPLAY_HORIZON_MS`).
 * Sized for the 10 GB DO ceiling: ~40 bytes per key, 7 days at 40 ev/s ≈ 1 GB.
 */
export const DEDUPE_HORIZON_MS = 7 * DAY_MS;

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** 64-bit FNV-1a of a string as 16 hex chars: compact dedupe key, sync (the ingest path is sync). */
export function eventKey(eid: string): string {
  let h = FNV_OFFSET;
  for (let i = 0; i < eid.length; i++) {
    h ^= BigInt(eid.charCodeAt(i));
    h = (h * FNV_PRIME) & MASK_64;
  }
  return h.toString(16).padStart(16, '0');
}

/** Records an event id; false when it was already applied inside the dedupe horizon. */
export function claimEvent(db: SqlDb, eid: string, ts: number): boolean {
  return (
    db.all<{ k: string }>(
      `INSERT INTO ingested_keys (k, ts) VALUES (?, ?) ON CONFLICT (k) DO NOTHING RETURNING k`,
      eventKey(eid),
      ts,
    ).length > 0
  );
}

/** Forgets ids older than the dedupe horizon (by apply time), `limit` per call; true when some are left. */
export function pruneEventKeys(db: SqlDb, now: number, limit = 200_000): boolean {
  const cutoff = now - DEDUPE_HORIZON_MS;
  db.run(
    `DELETE FROM ingested_keys WHERE k IN (SELECT k FROM ingested_keys WHERE ts < ? LIMIT ?)`,
    cutoff,
    limit,
  );
  return db.all(`SELECT 1 FROM ingested_keys WHERE ts < ? LIMIT 1`, cutoff).length > 0;
}
