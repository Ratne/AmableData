import type { IdentityKey, IdentityKeyType, MergeMechanism, VisitorMerge } from '@amable/api-types';
import type { SqlDb } from '../db/sql';
import { markTouchesIdentified } from './touches';

/**
 * Identity tables: keys (email, phone, session, ip → visitor), visitor merges
 * (child → origin, reversible), visitor tags and the GDPR blacklist. Only
 * storage here; when to merge is decided by the identity resolution.
 */

export interface IdentityKeyRef {
  key_type: IdentityKeyType;
  key_value: string;
}

/** Adds the keys (a known key keeps its earliest `first_seen`); returns how many were new. */
export function upsertIdentityKeys(db: SqlDb, keys: readonly IdentityKey[]): number {
  let added = 0;
  const identified = new Set<string>();
  for (const k of keys) {
    const existed =
      db.all<{ n: number }>(
        `SELECT 1 AS n FROM identity_keys WHERE key_type = ? AND key_value = ? AND visitor_id = ?`,
        k.key_type,
        k.key_value,
        k.visitor_id,
      ).length > 0;
    db.run(
      `INSERT INTO identity_keys (key_type, key_value, visitor_id, first_seen) VALUES (?, ?, ?, ?)
       ON CONFLICT (key_type, key_value, visitor_id) DO UPDATE SET first_seen = MIN(first_seen, excluded.first_seen)`,
      k.key_type,
      k.key_value,
      k.visitor_id,
      k.first_seen,
    );
    if (!existed) added += 1;
    if (k.key_type === 'email' || k.key_type === 'phone') identified.add(k.visitor_id);
  }
  markTouchesIdentified(db, [...identified]);
  return added;
}

/** Visitors holding the key, earliest first. */
export function findVisitorsByKey(
  db: SqlDb,
  keyType: IdentityKeyType,
  keyValue: string,
): IdentityKey[] {
  return db.all<IdentityKey>(
    `SELECT key_type, key_value, visitor_id, first_seen FROM identity_keys
     WHERE key_type = ? AND key_value = ? ORDER BY first_seen, visitor_id`,
    keyType,
    keyValue,
  );
}

export function identityKeysOf(db: SqlDb, visitorIds: readonly string[]): IdentityKey[] {
  if (visitorIds.length === 0) return [];
  return db.all<IdentityKey>(
    `SELECT key_type, key_value, visitor_id, first_seen FROM identity_keys
     WHERE visitor_id IN (SELECT value FROM json_each(?)) ORDER BY first_seen, key_type, key_value`,
    JSON.stringify(visitorIds),
  );
}

// -------------------------------------------------------------------- merges

interface MergeRow {
  child_visitor_id: string;
  origin_visitor_id: string;
  mechanism: MergeMechanism;
  active: number;
  created_at: number;
}

const toMerge = (r: MergeRow): VisitorMerge => ({ ...r, active: r.active === 1 });

/** Records (or re-activates) the child → origin link. */
export function upsertVisitorMerge(
  db: SqlDb,
  childVisitorId: string,
  originVisitorId: string,
  mechanism: MergeMechanism,
  now: number,
): void {
  db.run(
    `INSERT INTO visitor_merges (child_visitor_id, origin_visitor_id, mechanism, active, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT (child_visitor_id, origin_visitor_id) DO UPDATE SET active = 1, mechanism = excluded.mechanism,
       updated_at = excluded.updated_at`,
    childVisitorId,
    originVisitorId,
    mechanism,
    now,
    now,
  );
}

export function setVisitorMergeActive(
  db: SqlDb,
  childVisitorId: string,
  originVisitorId: string,
  active: boolean,
  now: number,
): void {
  db.run(
    `UPDATE visitor_merges SET active = ?, updated_at = ? WHERE child_visitor_id = ? AND origin_visitor_id = ?`,
    active ? 1 : 0,
    now,
    childVisitorId,
    originVisitorId,
  );
}

/** Merges where the visitor is child or origin (active and disconnected). */
export function visitorMerges(db: SqlDb, visitorId: string): VisitorMerge[] {
  return db
    .all<MergeRow>(
      `SELECT child_visitor_id, origin_visitor_id, mechanism, active, created_at FROM visitor_merges
       WHERE child_visitor_id = ? OR origin_visitor_id = ? ORDER BY created_at, child_visitor_id`,
      visitorId,
      visitorId,
    )
    .map(toMerge);
}

// ---------------------------------------------------------------------- tags

export function applyVisitorTags(
  db: SqlDb,
  visitorId: string,
  add: readonly string[],
  remove: readonly string[],
  now: number,
): string[] {
  for (const tag of remove)
    db.run(`DELETE FROM visitor_tags WHERE visitor_id = ? AND tag = ?`, visitorId, tag);
  for (const tag of add) {
    db.run(
      `INSERT INTO visitor_tags (visitor_id, tag, created_at) VALUES (?, ?, ?) ON CONFLICT (visitor_id, tag) DO NOTHING`,
      visitorId,
      tag,
      now,
    );
  }
  return visitorTags(db, visitorId);
}

export function visitorTags(db: SqlDb, visitorId: string): string[] {
  return db
    .all<{ tag: string }>(
      `SELECT tag FROM visitor_tags WHERE visitor_id = ? ORDER BY tag`,
      visitorId,
    )
    .map((r) => r.tag);
}

// ----------------------------------------------------------------- blacklist

export function addToBlacklist(db: SqlDb, keys: readonly IdentityKeyRef[], now: number): void {
  for (const k of keys) {
    db.run(
      `INSERT INTO identity_blacklist (key_type, key_value, created_at) VALUES (?, ?, ?)
       ON CONFLICT (key_type, key_value) DO NOTHING`,
      k.key_type,
      k.key_value,
      now,
    );
  }
}

export function removeFromBlacklist(db: SqlDb, keys: readonly IdentityKeyRef[]): void {
  for (const k of keys) {
    db.run(
      `DELETE FROM identity_blacklist WHERE key_type = ? AND key_value = ?`,
      k.key_type,
      k.key_value,
    );
  }
}

/** True when any of the keys is blacklisted. */
export function isBlacklisted(db: SqlDb, keys: readonly IdentityKeyRef[]): boolean {
  return keys.some(
    (k) =>
      db.all<{ n: number }>(
        `SELECT 1 AS n FROM identity_blacklist WHERE key_type = ? AND key_value = ?`,
        k.key_type,
        k.key_value,
      ).length > 0,
  );
}

export function listBlacklist(db: SqlDb): Array<IdentityKeyRef & { created_at: number }> {
  return db.all<IdentityKeyRef & { created_at: number }>(
    `SELECT key_type, key_value, created_at FROM identity_blacklist ORDER BY created_at, key_type, key_value`,
  );
}
