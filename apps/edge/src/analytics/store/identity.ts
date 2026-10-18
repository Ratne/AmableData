import { normalizePhone } from '@amable/ads-providers';
import type { IdentityKey, IdentityKeyType, MergeMechanism, TouchKind, VisitorMerge } from '@amable/api-types';
import { z } from 'zod';
import { first, type SqlDb } from '../db/sql';
import type { EnrichedEvent } from '../types';
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

// ============================================================================
// Identity resolution: normalized keys, automatic and manual merges (origin ←
// child, never rewriting the visitors' own rows), group resolution for the
// queries, reprocessing and the GDPR blacklist gate of the ingest.
// ============================================================================

// ------------------------------------------------------------- normalization

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Trimmed, lower-cased email, or null when it is not a plausible address. */
export function normalizeEmailKey(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1 || email.indexOf('@') !== at || /\s/.test(email)) return null;
  if (!email.slice(at + 1).includes('.') || email.length > 320) return null;
  return email;
}

/** E.164 (`+` and digits), or null. Numbers without `+`/`00` are assumed to carry their country code. */
export function normalizePhoneKey(raw: string): string | null {
  const digits = normalizePhone(raw);
  return digits === null ? null : `+${digits}`;
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/**
 * SHA-256 hex of the UTF-8 text. Synchronous because the store runs inside
 * SQL transactions, where Web Crypto's async digest cannot be awaited.
 */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = bytes.length * 8;
  view.setUint32(padded.length - 8, Math.floor(bits / 0x1_0000_0000));
  view.setUint32(padded.length - 4, bits >>> 0);
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const a = w[i - 15] ?? 0;
      const b = w[i - 2] ?? 0;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = (w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1;
    }
    let [a, b, c, d, e, f, g, hh] = h as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i += 1) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + (SHA256_K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i += 1) h[i] = ((h[i] ?? 0) + (next[i] ?? 0)) >>> 0;
  }
  return h.map((x) => x.toString(16).padStart(8, '0')).join('');
}

/** Identity hints carried by an event or a CRM contact (raw, normalized here). */
export interface IdentitySignals {
  email?: string | null | undefined;
  /** `he=` of a landing link: plain email or SHA-256 hex of the normalized email. */
  landingEmail?: string | null | undefined;
  phone?: string | null | undefined;
  /** Session the identification happened in (`session` merge mechanism). */
  sessionId?: string | null | undefined;
}

/**
 * Email/phone keys of the signals: a plain email is stored both as is and as
 * its SHA-256, so a hashed `he=` matches a visitor known by the clear address.
 */
export function identityKeyRefs(s: IdentitySignals): IdentityKeyRef[] {
  const out = new Map<string, IdentityKeyRef>();
  const add = (key_type: IdentityKeyType, key_value: string): void => {
    out.set(`${key_type}:${key_value}`, { key_type, key_value });
  };
  const addEmail = (raw: string): void => {
    const email = normalizeEmailKey(raw);
    if (email === null) return;
    add('email', email);
    add('email', sha256Hex(email));
  };
  if (s.email) addEmail(s.email);
  if (s.landingEmail) {
    const v = s.landingEmail.trim().toLowerCase();
    if (SHA256_HEX.test(v)) add('email', v);
    else addEmail(v);
  }
  if (s.phone) {
    const phone = normalizePhoneKey(s.phone);
    if (phone !== null) add('phone', phone);
  }
  return [...out.values()];
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

function landingEmailOf(e: EnrichedEvent): string | null {
  const loose = e as unknown as Record<string, unknown>;
  for (const field of ['la', 'landing']) {
    const v = loose[field];
    if (typeof v === 'object' && v !== null) {
      const he = str((v as Record<string, unknown>)['he']);
      if (he !== null) return he;
    }
  }
  if (e.type !== 'pageview' || e.url === null) return null;
  try {
    return str(new URL(e.url).searchParams.get('he'));
  } catch {
    return null;
  }
}

/** Identity signals of an ingested event (identify, payment, landing `he=`), null when none. */
export function signalsFromEvent(e: EnrichedEvent): IdentitySignals | null {
  const identity = e.identity as (EnrichedEvent['identity'] & { phone?: unknown }) | null;
  const signals: IdentitySignals = {
    email: identity?.email ?? e.payment?.email ?? null,
    landingEmail: landingEmailOf(e),
    phone: str(identity?.phone) ?? str(identity?.traits?.['phone']),
    sessionId: e.sid,
  };
  return signals.email || signals.landingEmail || signals.phone ? signals : null;
}

// ------------------------------------------------------------ merge settings

export const IDENTITY_MERGE_MECHANISMS = ['email', 'phone', 'session'] as const;
export type AutoMergeMechanism = (typeof IDENTITY_MERGE_MECHANISMS)[number];
export type IdentityMergeSettings = Record<AutoMergeMechanism, boolean>;

export const DEFAULT_MERGE_SETTINGS: IdentityMergeSettings = { email: true, phone: true, session: true };

export const identityMergeSettingsPatchSchema = z
  .object({ email: z.boolean(), phone: z.boolean(), session: z.boolean() })
  .partial()
  .strict();

const MERGE_SETTINGS_KEY = 'identity_merge';

/** Automatic merge mechanisms enabled for the site (stored in the instance key/value table). */
export function getMergeSettings(db: SqlDb): IdentityMergeSettings {
  const row = first<{ value: string }>(db, `SELECT value FROM sync_state WHERE key = ?`, MERGE_SETTINGS_KEY);
  if (row === undefined) return { ...DEFAULT_MERGE_SETTINGS };
  const parsed = identityMergeSettingsPatchSchema.safeParse(JSON.parse(row.value));
  return { ...DEFAULT_MERGE_SETTINGS, ...(parsed.success ? parsed.data : {}) };
}

export function setMergeSettings(
  db: SqlDb,
  patch: z.output<typeof identityMergeSettingsPatchSchema>,
): IdentityMergeSettings {
  const next = { ...getMergeSettings(db), ...patch };
  db.run(
    `INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    MERGE_SETTINGS_KEY,
    JSON.stringify(next),
  );
  return next;
}

// -------------------------------------------------------------------- groups

/**
 * `visitor_origin(visitor_id, origin_id)`: every merged visitor with the origin
 * of its group (active merges only). Visitors absent from it are their own
 * origin, so queries group by `COALESCE(vo.origin_id, x.visitor_id)` after
 * `LEFT JOIN visitor_origin vo ON vo.visitor_id = x.visitor_id`.
 */
export const VISITOR_ORIGIN_CTE = `visitor_chain(visitor_id, origin_id, depth) AS (
    SELECT child_visitor_id, origin_visitor_id, 1 FROM visitor_merges WHERE active = 1
    UNION
    SELECT c.visitor_id, m.origin_visitor_id, c.depth + 1 FROM visitor_chain c
    JOIN visitor_merges m ON m.child_visitor_id = c.origin_id AND m.active = 1
    WHERE c.depth < 64
  ),
  visitor_origin(visitor_id, origin_id) AS (
    SELECT visitor_id, origin_id FROM visitor_chain
    WHERE origin_id NOT IN (SELECT child_visitor_id FROM visitor_merges WHERE active = 1)
  )`;

function activeParent(db: SqlDb, visitorId: string): string | null {
  return (
    first<{ origin_visitor_id: string }>(
      db,
      `SELECT origin_visitor_id FROM visitor_merges WHERE child_visitor_id = ? AND active = 1
       ORDER BY updated_at DESC LIMIT 1`,
      visitorId,
    )?.origin_visitor_id ?? null
  );
}

/** Origin of the visitor's group (the visitor itself when not merged). */
export function groupOrigin(db: SqlDb, visitorId: string): string {
  let current = visitorId;
  const seen = new Set([current]);
  for (let parent = activeParent(db, current); parent !== null && !seen.has(parent); parent = activeParent(db, current)) {
    seen.add(parent);
    current = parent;
  }
  return current;
}

/** Origin first, then every visitor merged into it (directly or through another child), sorted. */
export function resolveVisitorGroup(db: SqlDb, visitorId: string): string[] {
  const origin = groupOrigin(db, visitorId);
  const members = db
    .all<{ id: string }>(
      `WITH RECURSIVE down(id) AS (
         SELECT ?
         UNION
         SELECT m.child_visitor_id FROM visitor_merges m JOIN down ON m.origin_visitor_id = down.id AND m.active = 1
       )
       SELECT id FROM down WHERE id <> ? ORDER BY id`,
      origin,
      origin,
    )
    .map((r) => r.id);
  return [origin, ...members];
}

/** Origin of each visitor id (itself when not merged). */
export function visitorOrigins(db: SqlDb, visitorIds: readonly string[]): Map<string, string> {
  const out = new Map(visitorIds.map((id) => [id, id] as const));
  if (visitorIds.length === 0) return out;
  for (const r of db.all<{ visitor_id: string; origin_id: string }>(
    `WITH RECURSIVE ${VISITOR_ORIGIN_CTE}
     SELECT visitor_id, origin_id FROM visitor_origin WHERE visitor_id IN (SELECT value FROM json_each(?))`,
    JSON.stringify(visitorIds),
  )) {
    out.set(r.visitor_id, r.origin_id);
  }
  return out;
}

/** Union of the groups of these visitors (each group origin first). */
export function resolveVisitorGroups(db: SqlDb, visitorIds: readonly string[]): string[] {
  const out = new Set<string>();
  const origins = new Set<string>();
  for (const id of visitorIds) {
    const origin = groupOrigin(db, id);
    if (origins.has(origin)) continue;
    origins.add(origin);
    for (const member of resolveVisitorGroup(db, origin)) out.add(member);
  }
  return [...out];
}

// -------------------------------------------------------------------- merging

function visitorKnown(db: SqlDb, visitorId: string): boolean {
  return (
    first<{ n: number }>(
      db,
      `SELECT 1 AS n FROM visitors WHERE id = ? UNION SELECT 1 FROM identity_keys WHERE visitor_id = ? LIMIT 1`,
      visitorId,
      visitorId,
    ) !== undefined
  );
}

/** When the visitor was first seen (visitor row, else its earliest key); unknown visitors sort last. */
function firstSeenOf(db: SqlDb, visitorId: string): number {
  const row = first<{ ts: number | null }>(
    db,
    `SELECT COALESCE((SELECT first_seen FROM visitors WHERE id = ?),
       (SELECT MIN(first_seen) FROM identity_keys WHERE visitor_id = ?)) AS ts`,
    visitorId,
    visitorId,
  );
  return row?.ts ?? Number.MAX_SAFE_INTEGER;
}

/** True when a merge between the two groups was explicitly disconnected (automatic merges respect it). */
function disconnected(db: SqlDb, groupA: readonly string[], groupB: readonly string[]): boolean {
  return (
    first<{ n: number }>(
      db,
      `SELECT 1 AS n FROM visitor_merges WHERE active = 0 AND (
         (child_visitor_id IN (SELECT value FROM json_each(?)) AND origin_visitor_id IN (SELECT value FROM json_each(?)))
         OR (child_visitor_id IN (SELECT value FROM json_each(?)) AND origin_visitor_id IN (SELECT value FROM json_each(?))))
       LIMIT 1`,
      JSON.stringify(groupA),
      JSON.stringify(groupB),
      JSON.stringify(groupB),
      JSON.stringify(groupA),
    ) !== undefined
  );
}

function groupIdentified(db: SqlDb, group: readonly string[]): boolean {
  const ids = JSON.stringify(group);
  return (
    first<{ n: number }>(
      db,
      `SELECT 1 AS n FROM identity_keys WHERE key_type IN ('email', 'phone') AND visitor_id IN (SELECT value FROM json_each(?))
       UNION SELECT 1 FROM visitors WHERE (contact_id IS NOT NULL OR email IS NOT NULL) AND id IN (SELECT value FROM json_each(?))
       LIMIT 1`,
      ids,
      ids,
    ) !== undefined
  );
}

/**
 * Retro-link: once a group holds an identified visitor, the anonymous touches
 * of all its members belong to an identified journey (kept past the 90-day TTL).
 */
function retroLink(db: SqlDb, visitorId: string): string[] {
  const group = resolveVisitorGroup(db, visitorId);
  if (groupIdentified(db, group)) markTouchesIdentified(db, group);
  return group;
}

/** Links the groups of `a` and `b`: the origin first seen earlier stays origin, the other becomes its child. */
function linkGroups(
  db: SqlDb,
  a: string,
  b: string,
  mechanism: MergeMechanism,
  now: number,
): VisitorMerge | null {
  const ra = groupOrigin(db, a);
  const rb = groupOrigin(db, b);
  if (ra === rb) return null;
  if (disconnected(db, resolveVisitorGroup(db, ra), resolveVisitorGroup(db, rb))) return null;
  const fa = firstSeenOf(db, ra);
  const fb = firstSeenOf(db, rb);
  const [origin, child] = fa < fb || (fa === fb && ra < rb) ? [ra, rb] : [rb, ra];
  upsertVisitorMerge(db, child, origin, mechanism, now);
  retroLink(db, origin);
  return { child_visitor_id: child, origin_visitor_id: origin, mechanism, active: true, created_at: now };
}

export interface IdentityRecordResult {
  added: number;
  merges: VisitorMerge[];
}

/**
 * Stores the visitor's keys and merges it with every visitor sharing one of
 * them through an enabled mechanism (`session`: the identification happened in
 * a session another visitor already holds or identified in).
 */
export function recordIdentity(
  db: SqlDb,
  visitorId: string,
  signals: IdentitySignals,
  ts: number,
  now: number,
): IdentityRecordResult {
  const refs = identityKeyRefs(signals);
  if (refs.length === 0) return { added: 0, merges: [] };
  const sessionId = signals.sessionId ?? null;
  const all: IdentityKeyRef[] = sessionId === null ? refs : [...refs, { key_type: 'session', key_value: sessionId }];
  const added = upsertIdentityKeys(
    db,
    all.map((k) => ({ ...k, visitor_id: visitorId, first_seen: ts })),
  );
  const settings = getMergeSettings(db);
  const merges: VisitorMerge[] = [];
  const link = (other: string, mechanism: AutoMergeMechanism): void => {
    if (other === visitorId || !settings[mechanism]) return;
    const m = linkGroups(db, visitorId, other, mechanism, now);
    if (m !== null) merges.push(m);
  };
  for (const k of all) {
    if (k.key_type === 'ip') continue;
    for (const other of findVisitorsByKey(db, k.key_type, k.key_value)) link(other.visitor_id, k.key_type);
  }
  if (sessionId !== null) {
    const owner = first<{ visitor_id: string }>(db, `SELECT visitor_id FROM sessions WHERE id = ?`, sessionId);
    if (owner !== undefined) link(owner.visitor_id, 'session');
  }
  retroLink(db, visitorId);
  return { added, merges };
}

export const visitorIdentityInputSchema = z.object({
  visitor_id: z.string().min(1).max(128),
  email: z.string().max(320).nullable().optional(),
  phone: z.string().max(64).nullable().optional(),
  ts: z.number().int(),
});
export type VisitorIdentityInput = z.input<typeof visitorIdentityInputSchema>;

/** Identity keys of known visitors from outside the ingest (CRM contacts); blacklisted ones are skipped. */
export function identifyVisitors(
  db: SqlDb,
  items: ReadonlyArray<z.output<typeof visitorIdentityInputSchema>>,
  now: number,
): { added: number; merged: number; skipped: number } {
  let added = 0;
  let merged = 0;
  let skipped = 0;
  for (const item of items) {
    const signals: IdentitySignals = { email: item.email, phone: item.phone };
    const refs = identityKeyRefs(signals);
    if (refs.length === 0 || !visitorKnown(db, item.visitor_id) || isBlacklisted(db, refs)) {
      skipped += 1;
      continue;
    }
    const r = recordIdentity(db, item.visitor_id, signals, item.ts, now);
    added += r.added;
    merged += r.merges.length;
  }
  return { added, merged, skipped };
}

/** Group origin of the earliest visitor holding one of the keys (payments without visitor id). */
export function visitorForKeys(db: SqlDb, refs: readonly IdentityKeyRef[]): string | null {
  let best: IdentityKey | undefined;
  for (const k of refs) {
    const holder = findVisitorsByKey(db, k.key_type, k.key_value)[0];
    if (holder !== undefined && (best === undefined || holder.first_seen < best.first_seen)) best = holder;
  }
  return best === undefined ? null : groupOrigin(db, best.visitor_id);
}

export type ManualMergeResult =
  | { ok: true; merge: VisitorMerge }
  | { ok: false; reason: 'not_found' | 'same_group' };

/** Merges the child's group into the origin's group (explicit choice: no seniority rule). */
export function mergeVisitorsManually(
  db: SqlDb,
  originVisitorId: string,
  childVisitorId: string,
  now: number,
): ManualMergeResult {
  if (!visitorKnown(db, originVisitorId) || !visitorKnown(db, childVisitorId)) return { ok: false, reason: 'not_found' };
  const origin = groupOrigin(db, originVisitorId);
  const child = groupOrigin(db, childVisitorId);
  if (origin === child) return { ok: false, reason: 'same_group' };
  upsertVisitorMerge(db, child, origin, 'manual', now);
  retroLink(db, origin);
  return { ok: true, merge: { child_visitor_id: child, origin_visitor_id: origin, mechanism: 'manual', active: true, created_at: now } };
}

/**
 * Disconnects the visitor from its origin (the visitor keeps its own children).
 * Rows of both visitors are untouched, so each profile is whole again; automatic
 * merges never reconnect the two groups (a manual merge does).
 */
export function unmergeVisitor(
  db: SqlDb,
  childVisitorId: string,
  now: number,
): { origin_visitor_id: string } | null {
  const parent = activeParent(db, childVisitorId);
  if (parent === null) return null;
  setVisitorMergeActive(db, childVisitorId, parent, false, now);
  return { origin_visitor_id: parent };
}

/**
 * Rebuilds merges from the keys first seen in [from, to): every enabled key
 * shared by several visitors links their groups (disconnections respected),
 * and touches of identified groups are flagged again.
 */
export function reprocessIdentities(
  db: SqlDb,
  range: { from: number; to: number },
  now: number,
): { keys: number; merges: number; visitors: number } {
  const settings = getMergeSettings(db);
  const types = IDENTITY_MERGE_MECHANISMS.filter((m) => settings[m]);
  const keys = db.all<{ key_type: AutoMergeMechanism; key_value: string }>(
    `SELECT DISTINCT key_type, key_value FROM identity_keys
     WHERE first_seen >= ? AND first_seen < ? AND key_type IN (SELECT value FROM json_each(?))
     ORDER BY key_type, key_value`,
    range.from,
    range.to,
    JSON.stringify(types),
  );
  let merges = 0;
  for (const k of keys) {
    const holders = findVisitorsByKey(db, k.key_type, k.key_value).map((h) => h.visitor_id);
    const [head, ...rest] = holders;
    if (head === undefined) continue;
    for (const other of rest) if (linkGroups(db, head, other, k.key_type, now) !== null) merges += 1;
  }
  const visitors = db
    .all<{ visitor_id: string }>(
      `SELECT DISTINCT visitor_id FROM identity_keys WHERE first_seen >= ? AND first_seen < ?`,
      range.from,
      range.to,
    )
    .map((r) => r.visitor_id);
  const origins = new Set(visitors.map((v) => groupOrigin(db, v)));
  for (const origin of origins) retroLink(db, origin);
  return { keys: keys.length, merges, visitors: visitors.length };
}

// ---------------------------------------------------------------- inspection

export interface VisitorIdentityGraph {
  visitor_id: string;
  origin_visitor_id: string;
  /** Origin first, then the visitors merged into it. */
  visitor_ids: string[];
  keys: IdentityKey[];
  /** Merges touching the group, disconnected ones included. */
  merges: VisitorMerge[];
  tags: string[];
}

export function visitorIdentityGraph(db: SqlDb, visitorId: string): VisitorIdentityGraph | null {
  if (!visitorKnown(db, visitorId)) return null;
  const group = resolveVisitorGroup(db, visitorId);
  const ids = JSON.stringify(group);
  const merges = db
    .all<MergeRow>(
      `SELECT child_visitor_id, origin_visitor_id, mechanism, active, created_at FROM visitor_merges
       WHERE child_visitor_id IN (SELECT value FROM json_each(?)) OR origin_visitor_id IN (SELECT value FROM json_each(?))
       ORDER BY created_at, child_visitor_id`,
      ids,
      ids,
    )
    .map(toMerge);
  const tags = db
    .all<{ tag: string }>(
      `SELECT DISTINCT tag FROM visitor_tags WHERE visitor_id IN (SELECT value FROM json_each(?)) ORDER BY tag`,
      ids,
    )
    .map((r) => r.tag);
  return {
    visitor_id: visitorId,
    origin_visitor_id: group[0] ?? visitorId,
    visitor_ids: group,
    keys: identityKeysOf(db, group),
    merges,
    tags,
  };
}

/** GDPR: blacklists the email/phone keys of the visitor's whole group; returns how many keys. */
export function blacklistVisitorKeys(db: SqlDb, visitorId: string, now: number): number {
  const keys = identityKeysOf(db, resolveVisitorGroup(db, visitorId))
    .filter((k) => k.key_type === 'email' || k.key_type === 'phone')
    .map((k) => ({ key_type: k.key_type, key_value: k.key_value }));
  addToBlacklist(db, keys, now);
  return new Set(keys.map((k) => `${k.key_type}:${k.key_value}`)).size;
}

/**
 * Touches of anonymous visitors merged into an identified group are flagged
 * identified too (run before the anonymous-touch purge).
 */
export function flagMergedTouchesIdentified(db: SqlDb): void {
  const groups = db.all<{ origin_id: string }>(
    `WITH RECURSIVE ${VISITOR_ORIGIN_CTE}
     SELECT DISTINCT vo.origin_id FROM visitor_origin vo
     JOIN touches t ON t.visitor_id = vo.visitor_id AND t.identified = 0`,
  );
  for (const g of groups) retroLink(db, g.origin_id);
}

// ------------------------------------------------------------------- journey

export interface JourneyFunnelTouch {
  id: string;
  ts: number;
  visitor_id: string;
  kind: TouchKind;
  funnel_id: string;
  funnel_name: string | null;
  node_id: string;
  page_id: string | null;
  traffic_source_id: string | null;
  traffic_source_name: string | null;
  campaign: string | null;
  /** Name of the campaign from the synced ad entities, when known. */
  campaign_name: string | null;
  external_click_id: string | null;
  fields: Record<string, string> | null;
}

/** Funnel/ad touches and tags of the visitors' merge groups (chronological, newest `limit`). */
export function journeyIdentityExtras(
  db: SqlDb,
  visitorIds: readonly string[],
  limit: number,
): { visitor_ids: string[]; funnel_touches: JourneyFunnelTouch[]; tags: string[] } {
  const group = resolveVisitorGroups(db, visitorIds);
  if (group.length === 0) return { visitor_ids: [], funnel_touches: [], tags: [] };
  const ids = JSON.stringify(group);
  const funnelTouches = db
    .all<Omit<JourneyFunnelTouch, 'fields'> & { fields: string | null }>(
      `SELECT * FROM (
         SELECT t.id, t.ts, t.visitor_id, t.kind, t.funnel_id, fg.name AS funnel_name, t.node_id, t.page_id,
           t.traffic_source_id, ts.name AS traffic_source_name, t.campaign,
           (SELECT ae.name FROM ad_entities ae WHERE ae.level = 'campaign' AND ae.external_id = t.campaign
            ORDER BY ae.updated_at DESC LIMIT 1) AS campaign_name,
           t.external_click_id, t.fields
         FROM touches t
         LEFT JOIN funnel_graphs fg ON fg.id = t.funnel_id
         LEFT JOIN traffic_sources ts ON ts.id = t.traffic_source_id
         WHERE t.visitor_id IN (SELECT value FROM json_each(?))
         ORDER BY t.ts DESC, t.id DESC LIMIT ?
       ) ORDER BY ts, id`,
      ids,
      limit,
    )
    .map((r) => ({ ...r, fields: r.fields === null ? null : (JSON.parse(r.fields) as Record<string, string>) }));
  const tags = db
    .all<{ tag: string }>(
      `SELECT DISTINCT tag FROM visitor_tags WHERE visitor_id IN (SELECT value FROM json_each(?)) ORDER BY tag`,
      ids,
    )
    .map((r) => r.tag);
  return { visitor_ids: group, funnel_touches: funnelTouches, tags };
}
