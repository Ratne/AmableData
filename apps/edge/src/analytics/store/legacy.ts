import type { ExtraValue } from '../types';
import { first, type SqlDb } from '../db/sql';
import { isContactParam } from '../registry';
import { landingEmailHash, phoneKeyHash } from './identity';

/**
 * One-time conversion of the sites created before the registry split: their
 * rows hold clear emails, phones, names and contact traits, which a site no
 * longer keeps (contact data lives in the workspace registry, sites hold
 * SHA-256 hashes). Each call converts a bounded page and returns true once
 * nothing is left; `analytics_meta.legacy_hashed` then short-cuts every call.
 */

const DONE_KEY = 'legacy_hashed';
const VISITOR_CURSOR_KEY = 'legacy_hashed_visitor';
/** Stored key values that are not a SHA-256 hex digest (clear email or phone). */
const CLEAR_KEY = `(length(key_value) <> 64 OR key_value GLOB '*[^0-9a-f]*')`;

function meta(db: SqlDb, key: string): string | undefined {
  return first<{ value: string }>(db, `SELECT value FROM analytics_meta WHERE key = ?`, key)?.value;
}

function setMeta(db: SqlDb, key: string, value: string): void {
  db.run(
    `INSERT INTO analytics_meta (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    key,
    value,
  );
}

function hashKey(keyType: string, value: string): string | null {
  return keyType === 'email' ? landingEmailHash(value) : phoneKeyHash(value);
}

/** Clear email/phone identity keys (and blacklist entries) replaced by their hash. */
function convertKeys(db: SqlDb, limit: number): number {
  const keys = db.all<{
    key_type: string;
    key_value: string;
    visitor_id: string;
    first_seen: number;
  }>(
    `SELECT key_type, key_value, visitor_id, first_seen FROM identity_keys
     WHERE key_type IN ('email', 'phone') AND ${CLEAR_KEY} LIMIT ?`,
    limit,
  );
  for (const k of keys) {
    const hash = hashKey(k.key_type, k.key_value);
    if (hash !== null)
      db.run(
        `INSERT INTO identity_keys (key_type, key_value, visitor_id, first_seen) VALUES (?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
        k.key_type,
        hash,
        k.visitor_id,
        k.first_seen,
      );
    db.run(
      `DELETE FROM identity_keys WHERE key_type = ? AND key_value = ? AND visitor_id = ?`,
      k.key_type,
      k.key_value,
      k.visitor_id,
    );
  }
  const blocked = db.all<{ key_type: string; key_value: string; created_at: number }>(
    `SELECT key_type, key_value, created_at FROM identity_blacklist
     WHERE key_type IN ('email', 'phone') AND ${CLEAR_KEY} LIMIT ?`,
    limit,
  );
  for (const b of blocked) {
    const hash = hashKey(b.key_type, b.key_value);
    if (hash !== null)
      db.run(
        `INSERT INTO identity_blacklist (key_type, key_value, created_at) VALUES (?, ?, ?)
         ON CONFLICT DO NOTHING`,
        b.key_type,
        hash,
        b.created_at,
      );
    db.run(
      `DELETE FROM identity_blacklist WHERE key_type = ? AND key_value = ?`,
      b.key_type,
      b.key_value,
    );
  }
  return keys.length + blocked.length;
}

/** Traits as the registry split leaves them: phone hashed, contact fields dropped. */
function cleanTraits(raw: string | null): string | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const kept: Record<string, ExtraValue> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, ExtraValue>)) {
    if (key === 'phone') {
      const hash = typeof value === 'string' ? phoneKeyHash(value) : null;
      if (hash !== null) kept['phone'] = hash;
      continue;
    }
    if (!isContactParam(key, value)) kept[key] = value;
  }
  return Object.keys(kept).length > 0 ? JSON.stringify(kept) : null;
}

/** Visitors in id order: email hashed (an email user id becomes it), name and contact traits dropped. */
function convertVisitors(db: SqlDb, limit: number): number {
  const after = meta(db, VISITOR_CURSOR_KEY) ?? '';
  const rows = db.all<{
    id: string;
    user_id: string | null;
    email: string | null;
    name: string | null;
    traits: string | null;
  }>(
    `SELECT id, user_id, email, name, traits FROM visitors WHERE id > ? ORDER BY id LIMIT ?`,
    after,
    limit,
  );
  for (const v of rows) {
    const emailUserId = v.user_id !== null && v.user_id.includes('@');
    const email = v.email ?? (emailUserId ? v.user_id : null);
    const hashed = email === null ? null : landingEmailHash(email);
    const traits = cleanTraits(v.traits);
    if (hashed === v.email && !emailUserId && v.name === null && traits === v.traits) continue;
    db.run(
      `UPDATE visitors SET email = ?, user_id = ?, name = NULL, traits = ? WHERE id = ?`,
      hashed,
      emailUserId ? null : v.user_id,
      traits,
      v.id,
    );
  }
  const last = rows[rows.length - 1];
  if (last !== undefined) setMeta(db, VISITOR_CURSOR_KEY, last.id);
  return rows.length;
}

function convertPayments(db: SqlDb, limit: number): number {
  const rows = db.all<{ id: number; email: string }>(
    `SELECT id, email FROM payments WHERE email LIKE '%@%' LIMIT ?`,
    limit,
  );
  for (const p of rows)
    db.run(`UPDATE payments SET email = ? WHERE id = ?`, landingEmailHash(p.email), p.id);
  return rows.length;
}

/** Converts up to `limit` rows per table; true when the site holds no legacy contact data. */
export function hashLegacyIdentities(db: SqlDb, limit: number): boolean {
  if (meta(db, DONE_KEY) !== undefined) return true;
  return db.transaction(() => {
    const touched =
      convertKeys(db, limit) + convertVisitors(db, limit) + convertPayments(db, limit);
    if (touched > 0) return false;
    // The pre-split dedupe table is no longer read.
    db.run(`DELETE FROM ingested_events`);
    db.run(`DELETE FROM analytics_meta WHERE key = ?`, VISITOR_CURSOR_KEY);
    setMeta(db, DONE_KEY, String(Date.now()));
    return true;
  });
}
