import { freezeBroadcastStats } from '../broadcast/frozen';
import type { SqlDb, SqlValue } from '../crm/db/sql';
import { parseJson } from '../crm/util';
import type { ArchiveStream } from './model';

/**
 * SQL of each archived stream, run inside the Durable Object that holds it.
 * A stream is read one month at a time (`[from, to)` on its age column) and,
 * within a month, one partition at a time in id order. `prune` deletes a
 * bounded number of the month's rows and returns how many it removed.
 */
export interface StreamSql {
  /** Age (epoch ms) of the oldest row older than `cutoff`, or null. */
  oldest(db: SqlDb, cutoff: number): number | null;
  partitions(db: SqlDb, from: number, to: number): string[];
  rows(db: SqlDb, from: number, to: number, partition: string, after: string | null, limit: number): Record<string, unknown>[];
  prune(db: SqlDb, from: number, to: number, limit: number, now: number): number;
}

type Row = Record<string, SqlValue>;

const one = (db: SqlDb, sql: string, ...params: SqlValue[]): number | null =>
  db.all<{ v: number | null }>(sql, ...params)[0]?.v ?? null;

function deleteIds(db: SqlDb, table: string, ids: readonly string[]): void {
  if (ids.length > 0) db.run(`DELETE FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids));
}

const idsOf = (rows: readonly { id: string }[]): string[] => rows.map((r) => r.id);

// ----------------------------------------------------------- crm_activities

/**
 * Partitions: `c-<hex>` = contacts whose id ends with that character (the
 * timeline of one contact reads one object per month), `company`,
 * `opportunity`. An activity referencing several subjects is written in each
 * of their partitions.
 */
function activityFilter(partition: string): { sql: string; params: SqlValue[] } {
  if (partition === 'company') return { sql: 'company_id IS NOT NULL', params: [] };
  if (partition === 'opportunity') return { sql: 'opportunity_id IS NOT NULL', params: [] };
  const code = Number.parseInt(partition.slice(2), 16);
  if (!partition.startsWith('c-') || !Number.isFinite(code)) throw new Error(`archive: unknown partition ${partition}`);
  return { sql: `contact_id IS NOT NULL AND contact_id <> '' AND lower(substr(contact_id, -1)) = ?`, params: [String.fromCodePoint(code)] };
}

const activities: StreamSql = {
  oldest: (db, cutoff) =>
    one(db, `SELECT MIN(occurred_at) AS v FROM crm_activities WHERE occurred_at < ?`, cutoff),
  partitions(db, from, to) {
    const buckets = db
      .all<{ b: string }>(
        `SELECT DISTINCT lower(substr(contact_id, -1)) AS b FROM crm_activities
          WHERE occurred_at >= ? AND occurred_at < ? AND contact_id IS NOT NULL AND contact_id <> ''`,
        from,
        to,
      )
      .map((r) => `c-${(r.b.codePointAt(0) ?? 0).toString(16)}`);
    const has = (column: string) =>
      db.all(
        `SELECT 1 FROM crm_activities WHERE occurred_at >= ? AND occurred_at < ? AND ${column} IS NOT NULL LIMIT 1`,
        from,
        to,
      ).length > 0;
    return [...buckets.sort(), ...(has('company_id') ? ['company'] : []), ...(has('opportunity_id') ? ['opportunity'] : [])];
  },
  rows(db, from, to, partition, after, limit) {
    const filter = activityFilter(partition);
    return db
      .all<Row>(
        `SELECT * FROM crm_activities
          WHERE occurred_at >= ? AND occurred_at < ? AND ${filter.sql} AND id > ?
          ORDER BY id LIMIT ?`,
        from,
        to,
        ...filter.params,
        after ?? '',
        limit,
      )
      .map((row) => ({ ...row, data: parseJson<unknown>(row['data'] as string, {}) }));
  },
  prune(db, from, to, limit) {
    const ids = idsOf(
      db.all<{ id: string }>(
        `SELECT id FROM crm_activities WHERE occurred_at >= ? AND occurred_at < ? LIMIT ?`,
        from,
        to,
        limit,
      ),
    );
    deleteIds(db, 'crm_activities', ids);
    return ids.length;
  },
};

// ---------------------------------------------------------- form_submissions

/** Partition = the form. Soft-deleted submissions are not archived, only removed. */
const submissions: StreamSql = {
  oldest: (db, cutoff) =>
    one(db, `SELECT MIN(created_at) AS v FROM form_submissions WHERE created_at < ?`, cutoff),
  partitions: (db, from, to) =>
    db
      .all<{ form_id: string }>(
        `SELECT DISTINCT form_id FROM form_submissions
          WHERE created_at >= ? AND created_at < ? AND deleted_at IS NULL ORDER BY form_id`,
        from,
        to,
      )
      .map((r) => r.form_id),
  rows(db, from, to, partition, after, limit) {
    const rows = db.all<Row & { id: string }>(
      `SELECT * FROM form_submissions
        WHERE created_at >= ? AND created_at < ? AND form_id = ? AND deleted_at IS NULL AND id > ?
        ORDER BY id LIMIT ?`,
      from,
      to,
      partition,
      after ?? '',
      limit,
    );
    const deliveries = new Map<string, Row[]>();
    if (rows.length > 0) {
      for (const d of db.all<Row & { submission_id: string }>(
        `SELECT d.*, c.name AS connection_name, c.type AS connection_type
           FROM form_deliveries d JOIN form_connections c ON c.id = d.connection_id
          WHERE d.submission_id IN (SELECT value FROM json_each(?)) ORDER BY d.created_at`,
        JSON.stringify(idsOf(rows)),
      )) {
        const list = deliveries.get(d.submission_id) ?? [];
        list.push(d);
        deliveries.set(d.submission_id, list);
      }
    }
    return rows.map((row) => ({ ...row, deliveries: deliveries.get(row.id) ?? [] }));
  },
  prune(db, from, to, limit) {
    const ids = idsOf(
      db.all<{ id: string }>(
        `SELECT id FROM form_submissions WHERE created_at >= ? AND created_at < ? LIMIT ?`,
        from,
        to,
        limit,
      ),
    );
    if (ids.length > 0) {
      db.run(`DELETE FROM form_deliveries WHERE submission_id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids));
    }
    deleteIds(db, 'form_submissions', ids);
    return ids.length;
  },
};

// -------------------------------------------------------------- esign_events

/**
 * Audit events of signature requests that ended (completed, declined, voided,
 * expired) and are sealed (no finalization pending: the audit certificate is
 * built from these events), aged by the end of the request. Partition = the
 * request; requests, signers and the sealed PDF stay.
 */
const ENDED = `r.status IN ('completed', 'declined', 'voided', 'expired') AND r.finalize_due_at IS NULL`;
const ENDED_AT = `COALESCE(r.completed_at, r.declined_at, r.voided_at, r.expires_at, r.updated_at)`;

const esignEvents: StreamSql = {
  oldest: (db, cutoff) =>
    one(
      db,
      `SELECT MIN(${ENDED_AT}) AS v FROM esign_requests r
        WHERE ${ENDED} AND ${ENDED_AT} < ? AND EXISTS (SELECT 1 FROM esign_events e WHERE e.request_id = r.id)`,
      cutoff,
    ),
  partitions: (db, from, to) =>
    db
      .all<{ id: string }>(
        `SELECT r.id FROM esign_requests r
          WHERE ${ENDED} AND ${ENDED_AT} >= ? AND ${ENDED_AT} < ?
            AND EXISTS (SELECT 1 FROM esign_events e WHERE e.request_id = r.id)
          ORDER BY r.id`,
        from,
        to,
      )
      .map((r) => r.id),
  rows: (db, _from, _to, partition, after, limit) =>
    db
      .all<Row>(`SELECT * FROM esign_events WHERE request_id = ? AND id > ? ORDER BY id LIMIT ?`, partition, after ?? '', limit)
      .map((row) => ({ ...row, meta: parseJson<unknown>(row['meta'] as string, {}) })),
  prune(db, from, to, limit) {
    const ids = idsOf(
      db.all<{ id: string }>(
        `SELECT e.id FROM esign_events e JOIN esign_requests r ON r.id = e.request_id
          WHERE ${ENDED} AND ${ENDED_AT} >= ? AND ${ENDED_AT} < ? LIMIT ?`,
        from,
        to,
        limit,
      ),
    );
    deleteIds(db, 'esign_events', ids);
    return ids.length;
  },
};

// ------------------------------------------------------- mail (MailDb side)

const MAIL_PARTITION = `COALESCE(broadcast_id, 'tx')`;

function mailFilter(partition: string): { sql: string; params: SqlValue[] } {
  return partition === 'tx' ? { sql: 'broadcast_id IS NULL', params: [] } : { sql: 'broadcast_id = ?', params: [partition] };
}

/** Broadcasts having rows of `table` in the month: their stats are frozen before any row goes. */
function freezeMonth(db: SqlDb, table: string, from: number, to: number, now: number): void {
  const ids = db
    .all<{ id: string }>(
      `SELECT DISTINCT broadcast_id AS id FROM ${table}
        WHERE created_at >= ? AND created_at < ? AND broadcast_id IS NOT NULL`,
      from,
      to,
    )
    .map((r) => r.id);
  freezeBroadcastStats(db, ids, now);
}

/** Messages with their links. Partition = the broadcast, or `tx` for every other email. */
const mailMessages: StreamSql = {
  oldest: (db, cutoff) => one(db, `SELECT MIN(created_at) AS v FROM mail_messages WHERE created_at < ?`, cutoff),
  partitions: (db, from, to) =>
    db
      .all<{ p: string }>(
        `SELECT DISTINCT ${MAIL_PARTITION} AS p FROM mail_messages WHERE created_at >= ? AND created_at < ? ORDER BY p`,
        from,
        to,
      )
      .map((r) => r.p),
  rows(db, from, to, partition, after, limit) {
    const filter = mailFilter(partition);
    const rows = db.all<Row & { id: string }>(
      `SELECT * FROM mail_messages WHERE created_at >= ? AND created_at < ? AND ${filter.sql} AND id > ?
        ORDER BY id LIMIT ?`,
      from,
      to,
      ...filter.params,
      after ?? '',
      limit,
    );
    const links = new Map<string, Array<{ position: number; url: string }>>();
    if (rows.length > 0) {
      for (const l of db.all<{ message_id: string; position: number; url: string }>(
        `SELECT message_id, position, url FROM mail_message_links
          WHERE message_id IN (SELECT value FROM json_each(?)) ORDER BY message_id, position`,
        JSON.stringify(idsOf(rows)),
      )) {
        const list = links.get(l.message_id) ?? [];
        list.push({ position: l.position, url: l.url });
        links.set(l.message_id, list);
      }
    }
    return rows.map((row) => ({ ...row, links: links.get(row.id) ?? [] }));
  },
  prune(db, from, to, limit, now) {
    freezeMonth(db, 'mail_messages', from, to, now);
    const ids = idsOf(
      db.all<{ id: string }>(`SELECT id FROM mail_messages WHERE created_at >= ? AND created_at < ? LIMIT ?`, from, to, limit),
    );
    if (ids.length > 0) {
      db.run(`DELETE FROM mail_message_links WHERE message_id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids));
    }
    deleteIds(db, 'mail_messages', ids);
    return ids.length;
  },
};

const mailClicks: StreamSql = {
  oldest: (db, cutoff) => one(db, `SELECT MIN(created_at) AS v FROM mail_clicks WHERE created_at < ?`, cutoff),
  partitions: (db, from, to) =>
    db
      .all<{ p: string }>(
        `SELECT DISTINCT ${MAIL_PARTITION} AS p FROM mail_clicks WHERE created_at >= ? AND created_at < ? ORDER BY p`,
        from,
        to,
      )
      .map((r) => r.p),
  rows(db, from, to, partition, after, limit) {
    const filter = mailFilter(partition);
    return db.all<Row>(
      `SELECT * FROM mail_clicks WHERE created_at >= ? AND created_at < ? AND ${filter.sql} AND id > ?
        ORDER BY id LIMIT ?`,
      from,
      to,
      ...filter.params,
      after ?? '',
      limit,
    );
  },
  prune(db, from, to, limit, now) {
    freezeMonth(db, 'mail_clicks', from, to, now);
    const ids = idsOf(
      db.all<{ id: string }>(`SELECT id FROM mail_clicks WHERE created_at >= ? AND created_at < ? LIMIT ?`, from, to, limit),
    );
    deleteIds(db, 'mail_clicks', ids);
    return ids.length;
  },
};

export const STREAM_SQL: Readonly<Record<ArchiveStream, StreamSql>> = {
  crm_activities: activities,
  form_submissions: submissions,
  esign_events: esignEvents,
  mail_messages: mailMessages,
  mail_clicks: mailClicks,
};

/** Consumed outbox rows older than `before`, a bounded batch at a time. */
export function purgeOutbox(db: SqlDb, table: 'crm_outbox' | 'mail_outbox', before: number, limit: number): number {
  const consumed = table === 'crm_outbox' ? 'dispatched_at' : 'acked_at';
  const ids = idsOf(
    db.all<{ id: string }>(
      `SELECT id FROM ${table} WHERE ${consumed} IS NOT NULL AND ${consumed} < ? LIMIT ?`,
      before,
      limit,
    ),
  );
  deleteIds(db, table, ids);
  return ids.length;
}
