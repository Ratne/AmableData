import { first, type SqlDb } from '../db/sql';
import { DAY_MS } from '../time';

/**
 * Tenant instance (`tenant:<id>`) state used by the core's CRM sync: the
 * outbox cursor, processed event ids, the tenant-wide visitor ↔ contact
 * registry (a contact can have visitors on several sites) and the sites that
 * queued work for the core.
 */

export interface SyncCursor {
  /** `occurred_at` (epoch ms) and id of the last outbox event read. */
  ts: number;
  id: string;
}

export function getCursor(db: SqlDb): SyncCursor | null {
  const row = first<{ value: string }>(db, `SELECT value FROM sync_state WHERE key = 'outbox'`);
  if (row === undefined) return null;
  const parsed = JSON.parse(row.value) as SyncCursor;
  return typeof parsed.ts === 'number' && typeof parsed.id === 'string' ? parsed : null;
}

export function setCursor(db: SqlDb, cursor: SyncCursor): void {
  db.run(
    `INSERT INTO sync_state (key, value) VALUES ('outbox', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    JSON.stringify(cursor),
  );
}

/** Ids among `ids` that were not processed yet; marks them processed. Old marks expire after 7 days. */
export function claimEvents(db: SqlDb, ids: readonly string[], now: number): string[] {
  return db.transaction(() => {
    const fresh: string[] = [];
    for (const id of ids) {
      const inserted = db.all<{ event_id: string }>(
        `INSERT INTO sync_seen (event_id, ts) VALUES (?, ?) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
        id,
        now,
      );
      if (inserted.length > 0) fresh.push(id);
    }
    db.run(`DELETE FROM sync_seen WHERE ts < ?`, now - 7 * DAY_MS);
    return fresh;
  });
}

export interface ContactVisitor {
  siteId: string;
  visitorId: string;
  contactId: string;
  linkedAt: number;
  source: string;
}

export function registerLinks(db: SqlDb, links: readonly ContactVisitor[]): void {
  db.transaction(() => {
    for (const l of links) {
      db.run(
        `INSERT INTO contact_visitors (site_id, visitor_id, contact_id, linked_at, source) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (site_id, visitor_id) DO UPDATE SET contact_id = excluded.contact_id,
           linked_at = excluded.linked_at, source = excluded.source`,
        l.siteId,
        l.visitorId,
        l.contactId,
        l.linkedAt,
        l.source,
      );
    }
  });
}

export function mergeContacts(db: SqlDb, from: readonly string[], to: string): void {
  for (const f of from) db.run(`UPDATE contact_visitors SET contact_id = ? WHERE contact_id = ?`, to, f);
}

type Row = { site_id: string; visitor_id: string; contact_id: string; linked_at: number; source: string };

const toLink = (r: Row): ContactVisitor => ({
  siteId: r.site_id,
  visitorId: r.visitor_id,
  contactId: r.contact_id,
  linkedAt: r.linked_at,
  source: r.source,
});

export function visitorsOfContact(db: SqlDb, contactId: string): ContactVisitor[] {
  return db
    .all<Row>(`SELECT * FROM contact_visitors WHERE contact_id = ? ORDER BY linked_at, site_id, visitor_id`, contactId)
    .map(toLink);
}

export function contactsOfVisitors(db: SqlDb, visitorIds: readonly string[]): ContactVisitor[] {
  if (visitorIds.length === 0) return [];
  return db
    .all<Row>(`SELECT * FROM contact_visitors WHERE visitor_id IN (SELECT value FROM json_each(?))`, JSON.stringify(visitorIds))
    .map(toLink);
}

export function markDirtySite(db: SqlDb, siteId: string, now: number): void {
  db.run(
    `INSERT INTO dirty_sites (site_id, ts) VALUES (?, ?) ON CONFLICT (site_id) DO UPDATE SET ts = excluded.ts`,
    siteId,
    now,
  );
}

export function dirtySites(db: SqlDb): string[] {
  return db.all<{ site_id: string }>(`SELECT site_id FROM dirty_sites ORDER BY ts`).map((r) => r.site_id);
}

/** Clears a dirty mark unless the site was marked again after `before`. */
export function clearDirtySite(db: SqlDb, siteId: string, before: number): void {
  db.run(`DELETE FROM dirty_sites WHERE site_id = ? AND ts <= ?`, siteId, before);
}

/** Single-runner lease of the CRM sync (cron and request kicks may overlap). */
export function acquireLease(db: SqlDb, holder: string, now: number, ttlMs: number): boolean {
  return db.transaction(() => {
    const row = first<{ value: string }>(db, `SELECT value FROM sync_state WHERE key = 'lease'`);
    if (row !== undefined) {
      const lease = JSON.parse(row.value) as { holder: string; until: number };
      if (lease.until > now && lease.holder !== holder) return false;
    }
    db.run(
      `INSERT INTO sync_state (key, value) VALUES ('lease', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      JSON.stringify({ holder, until: now + ttlMs }),
    );
    return true;
  });
}

export function releaseLease(db: SqlDb, holder: string): void {
  const row = first<{ value: string }>(db, `SELECT value FROM sync_state WHERE key = 'lease'`);
  if (row === undefined) return;
  const lease = JSON.parse(row.value) as { holder: string };
  if (lease.holder === holder) db.run(`DELETE FROM sync_state WHERE key = 'lease'`);
}
