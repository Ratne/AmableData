import type { Campaign } from './campaigns';
import { randomId, type SqlDb } from './db';
import { subjectKey, type Subject } from './token';

/**
 * The deadline of one subject in one campaign. The server is the only clock:
 * emails and pages render `deadline_at - now` computed here, so reloading,
 * switching device or editing the page never buys more time.
 */

export interface Deadline {
  readonly id: string;
  readonly campaignId: string;
  readonly subject: string;
  readonly contactId: string | null;
  readonly startedAt: number;
  readonly deadlineAt: number;
  readonly source: string;
}

interface DeadlineRow {
  id: string;
  campaign_id: string;
  subject: string;
  contact_id: string | null;
  started_at: number;
  deadline_at: number;
  source: string;
}

const fromRow = (row: DeadlineRow): Deadline => ({
  id: row.id,
  campaignId: row.campaign_id,
  subject: row.subject,
  contactId: row.contact_id,
  startedAt: row.started_at,
  deadlineAt: row.deadline_at,
  source: row.source,
});

const COLUMNS = 'id, campaign_id, subject, contact_id, started_at, deadline_at, source';

/** When a countdown started now (or at `startedAt`) ends; `durationMinutes` overrides the campaign's. */
export function deadlineFor(
  campaign: Pick<Campaign, 'mode' | 'durationMinutes' | 'fixedEndAt' | 'hardEndAt'>,
  startedAt: number,
  durationMinutes?: number | null,
): number {
  if (campaign.mode === 'fixed') return campaign.fixedEndAt ?? startedAt;
  const end = startedAt + (durationMinutes ?? campaign.durationMinutes ?? 0) * 60_000;
  return campaign.hardEndAt === null ? end : Math.min(end, campaign.hardEndAt);
}

/** The countdown a subject would see before starting: the full window, not running. */
export function previewDeadline(campaign: Campaign, now: number): number {
  return deadlineFor(campaign, now);
}

export async function findDeadline(db: SqlDb, campaign: Campaign, subject: Subject): Promise<Deadline | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM deadlines WHERE campaign_id = ? AND subject = ?`)
    .bind(campaign.id, subjectKey(subject))
    .first<DeadlineRow>();
  return row === null ? null : fromRow(row);
}

/**
 * The subject's deadline, created now when missing. Concurrent first hits
 * (an email open and a click in the same second) settle on one row.
 */
export async function getOrStart(
  db: SqlDb,
  campaign: Campaign,
  subject: Subject,
  source: string,
  now: number,
  durationMinutes?: number | null,
): Promise<{ deadline: Deadline; created: boolean }> {
  const existing = await findDeadline(db, campaign, subject);
  if (existing !== null) return { deadline: existing, created: false };
  const { meta } = await db
    .prepare(
      `INSERT INTO deadlines (id, install_id, campaign_id, subject, contact_id, started_at, deadline_at, source, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (campaign_id, subject) DO NOTHING`,
    )
    .bind(
      `dl_${randomId()}`,
      campaign.installId,
      campaign.id,
      subjectKey(subject),
      subject.kind === 'contact' ? subject.id : null,
      now,
      deadlineFor(campaign, now, durationMinutes),
      source,
      now,
    )
    .run();
  const deadline = await findDeadline(db, campaign, subject);
  if (deadline === null) throw new Error('deadline vanished after insert');
  return { deadline, created: meta.changes > 0 };
}

/** Starts the countdown again from now: a new window, new started/expired events. */
export async function restart(
  db: SqlDb,
  campaign: Campaign,
  subject: Subject,
  source: string,
  now: number,
  durationMinutes?: number | null,
): Promise<Deadline> {
  const { deadline, created } = await getOrStart(db, campaign, subject, source, now, durationMinutes);
  if (created) return deadline;
  await db
    .prepare(
      `UPDATE deadlines SET started_at = ?, deadline_at = ?, source = ?, started_fired = 0, expired_fired = 0, updated_at = ?
       WHERE id = ?`,
    )
    .bind(now, deadlineFor(campaign, now, durationMinutes), source, now, deadline.id)
    .run();
  return (await findDeadline(db, campaign, subject))!;
}

/**
 * An anonymous browser turned out to be a contact (they came from an email
 * link): its countdown becomes the contact's, keeping whichever started first.
 */
export async function adoptVisitor(db: SqlDb, campaign: Campaign, visitorId: string, contactId: string, now: number): Promise<void> {
  const visitor = await findDeadline(db, campaign, { kind: 'visitor', id: visitorId });
  if (visitor === null) return;
  const contact = await findDeadline(db, campaign, { kind: 'contact', id: contactId });
  if (contact === null) {
    await db
      .prepare(`UPDATE deadlines SET subject = ?, contact_id = ?, updated_at = ? WHERE id = ?`)
      .bind(subjectKey({ kind: 'contact', id: contactId }), contactId, now, visitor.id)
      .run();
    return;
  }
  const statements = [db.prepare('DELETE FROM deadlines WHERE id = ?').bind(visitor.id)];
  if (visitor.deadlineAt < contact.deadlineAt) {
    statements.push(
      db
        .prepare('UPDATE deadlines SET started_at = ?, deadline_at = ?, expired_fired = 0, updated_at = ? WHERE id = ?')
        .bind(Math.min(visitor.startedAt, contact.startedAt), visitor.deadlineAt, now, contact.id),
    );
  }
  await db.batch(statements);
}

export interface DeadlineListItem extends Deadline {
  readonly expired: boolean;
}

export async function listDeadlines(
  db: SqlDb,
  installId: string,
  campaignId: string,
  options: { contactIds?: readonly string[]; contactsOnly?: boolean; before?: string | null; limit: number; now: number },
): Promise<DeadlineListItem[]> {
  const where = ['install_id = ?', 'campaign_id = ?'];
  const binds: unknown[] = [installId, campaignId];
  if (options.contactIds !== undefined) {
    if (options.contactIds.length === 0) return [];
    where.push(`contact_id IN (${options.contactIds.map(() => '?').join(', ')})`);
    binds.push(...options.contactIds);
  }
  if (options.contactsOnly === true) where.push('contact_id IS NOT NULL');
  if (options.before != null) {
    where.push('id < ?');
    binds.push(options.before);
  }
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM deadlines WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`)
    .bind(...binds, options.limit)
    .all<DeadlineRow>();
  return results.map((row) => ({ ...fromRow(row), expired: row.deadline_at <= options.now }));
}

export async function countDeadlines(db: SqlDb, installId: string, now: number): Promise<Map<string, { running: number; expired: number }>> {
  const { results } = await db
    .prepare(
      `SELECT campaign_id, SUM(CASE WHEN deadline_at > ? THEN 1 ELSE 0 END) AS running, SUM(CASE WHEN deadline_at <= ? THEN 1 ELSE 0 END) AS expired
       FROM deadlines WHERE install_id = ? GROUP BY campaign_id`,
    )
    .bind(now, now, installId)
    .all<{ campaign_id: string; running: number; expired: number }>();
  return new Map(results.map((r) => [r.campaign_id, { running: Number(r.running), expired: Number(r.expired) }]));
}

export type Change =
  | { readonly kind: 'reset' }
  | { readonly kind: 'restart' }
  | { readonly kind: 'extend'; readonly minutes: number }
  | { readonly kind: 'set'; readonly deadlineAt: number };

/**
 * Admin changes on some deadlines of a campaign (all of them when `ids` is
 * null). `reset` deletes: the next email open, visit or automation starts a
 * fresh countdown. The others re-arm the expired event.
 */
export async function changeDeadlines(
  db: SqlDb,
  campaign: Campaign,
  ids: readonly string[] | null,
  change: Change,
  now: number,
): Promise<number> {
  const scope = ids === null ? '' : ` AND id IN (${ids.map(() => '?').join(', ')})`;
  const binds = [campaign.installId, campaign.id, ...(ids ?? [])];
  if (ids !== null && ids.length === 0) return 0;
  let statement;
  switch (change.kind) {
    case 'reset':
      statement = db.prepare(`DELETE FROM deadlines WHERE install_id = ? AND campaign_id = ?${scope}`).bind(...binds);
      break;
    case 'restart':
      statement = db
        .prepare(
          `UPDATE deadlines SET started_at = ?, deadline_at = ?, started_fired = 0, expired_fired = 0, updated_at = ? WHERE install_id = ? AND campaign_id = ?${scope}`,
        )
        .bind(now, deadlineFor(campaign, now), now, ...binds);
      break;
    case 'extend':
      statement = db
        .prepare(
          `UPDATE deadlines SET deadline_at = MAX(deadline_at, ?) + ?, expired_fired = 0, updated_at = ? WHERE install_id = ? AND campaign_id = ?${scope}`,
        )
        .bind(now, change.minutes * 60_000, now, ...binds);
      break;
    case 'set':
      statement = db
        .prepare(`UPDATE deadlines SET deadline_at = ?, expired_fired = 0, updated_at = ? WHERE install_id = ? AND campaign_id = ?${scope}`)
        .bind(change.deadlineAt, now, ...binds);
      break;
  }
  return (await statement.run()).meta.changes;
}

export async function contactDeadlines(db: SqlDb, installId: string, contactId: string): Promise<Array<Deadline & { campaignName: string }>> {
  const { results } = await db
    .prepare(
      `SELECT d.id, d.campaign_id, d.subject, d.contact_id, d.started_at, d.deadline_at, d.source, c.name AS campaign_name
       FROM deadlines d JOIN campaigns c ON c.id = d.campaign_id WHERE d.install_id = ? AND d.contact_id = ?`,
    )
    .bind(installId, contactId)
    .all<DeadlineRow & { campaign_name: string }>();
  return results.map((row) => ({ ...fromRow(row), campaignName: row.campaign_name }));
}

export async function eraseContact(db: SqlDb, installId: string, contactId: string): Promise<void> {
  await db.prepare('DELETE FROM deadlines WHERE install_id = ? AND contact_id = ?').bind(installId, contactId).run();
}

export interface PendingEvent {
  readonly id: string;
  readonly installId: string;
  readonly contactId: string;
  readonly campaignId: string;
  readonly campaignName: string;
  readonly startedAt: number;
  readonly deadlineAt: number;
}

interface PendingRow {
  id: string;
  install_id: string;
  contact_id: string;
  campaign_id: string;
  campaign_name: string;
  started_at: number;
  deadline_at: number;
}

const pending = (row: PendingRow): PendingEvent => ({
  id: row.id,
  installId: row.install_id,
  contactId: row.contact_id,
  campaignId: row.campaign_id,
  campaignName: row.campaign_name,
  startedAt: row.started_at,
  deadlineAt: row.deadline_at,
});

/** Contact deadlines whose start or expiry was not announced to the CRM yet. */
export async function unannounced(db: SqlDb, now: number, limit: number): Promise<{ started: PendingEvent[]; expired: PendingEvent[] }> {
  const select = `SELECT d.id, d.install_id, d.contact_id, d.campaign_id, c.name AS campaign_name, d.started_at, d.deadline_at
    FROM deadlines d JOIN campaigns c ON c.id = d.campaign_id AND c.deleted_at IS NULL WHERE d.contact_id IS NOT NULL`;
  const [started, expired] = await Promise.all([
    db.prepare(`${select} AND d.started_fired = 0 ORDER BY d.started_at LIMIT ?`).bind(limit).all<PendingRow>(),
    db.prepare(`${select} AND d.expired_fired = 0 AND d.deadline_at <= ? ORDER BY d.deadline_at LIMIT ?`).bind(now, limit).all<PendingRow>(),
  ]);
  return { started: started.results.map(pending), expired: expired.results.map(pending) };
}

/** Marks an announcement done, unless the deadline changed meanwhile (then it is announced again). */
export async function markAnnounced(db: SqlDb, kind: 'started' | 'expired', event: PendingEvent): Promise<void> {
  const column = kind === 'started' ? 'started_fired' : 'expired_fired';
  await db
    .prepare(`UPDATE deadlines SET ${column} = 1 WHERE id = ? AND started_at = ? AND deadline_at = ?`)
    .bind(event.id, event.startedAt, event.deadlineAt)
    .run();
}
