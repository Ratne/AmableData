import type {
  AddSuppressionInput,
  EmailMessage,
  ListSuppressionsQuery,
  Page,
  Suppression,
  SuppressionReason,
} from '@amable/api-types';
import {
  chunked,
  decodeCursor,
  encodeCursor,
  isoOf,
  normalizeEmail,
  notFound,
  toIso,
  type MailDeps,
} from './context';

/** Suppression list (never mail these addresses again) and message lookups. */

interface SuppressionRow {
  email: string;
  reason: SuppressionReason;
  source: string | null;
  contact_id: string | null;
  created_at: number;
}

const toSuppression = (row: SuppressionRow): Suppression => ({
  email: row.email,
  reason: row.reason,
  source: row.source,
  contact_id: row.contact_id,
  created_at: isoOf(row.created_at),
});

/** Adds (or keeps) a suppression. The first reason wins, except that a complaint/bounce upgrades a manual entry. */
export function suppress(
  deps: MailDeps,
  input: { email: string; reason: SuppressionReason; source: string | null; contactId: string | null },
): void {
  deps.db.run(
    `INSERT INTO mail_suppressions (email, reason, source, contact_id, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       reason = CASE WHEN mail_suppressions.reason = 'manual' THEN excluded.reason ELSE mail_suppressions.reason END,
       contact_id = COALESCE(mail_suppressions.contact_id, excluded.contact_id)`,
    normalizeEmail(input.email),
    input.reason,
    input.source,
    input.contactId,
    deps.now(),
  );
}

export function suppressedSet(deps: MailDeps, emails: readonly string[]): Set<string> {
  const normalized = [...new Set(emails.map(normalizeEmail))];
  const out = new Set<string>();
  for (const chunk of chunked(normalized)) {
    for (const row of deps.db.all<{ email: string }>(
      `SELECT email FROM mail_suppressions WHERE email IN (${chunk.map(() => '?').join(', ')})`,
      ...chunk,
    )) {
      out.add(row.email);
    }
  }
  return out;
}

export function isSuppressed(deps: MailDeps, email: string): boolean {
  return suppressedSet(deps, [email]).size > 0;
}

export function suppressionReason(deps: MailDeps, email: string): SuppressionReason | null {
  return (
    deps.db.all<{ reason: SuppressionReason }>(
      `SELECT reason FROM mail_suppressions WHERE email = ?`,
      normalizeEmail(email),
    )[0]?.reason ?? null
  );
}

export function listSuppressions(deps: MailDeps, input: ListSuppressionsQuery): Page<Suppression> {
  const limit = input.limit;
  const cursor = decodeCursor(input.cursor);
  const where: string[] = ['1 = 1'];
  const params: (string | number)[] = [];
  if (input.q !== undefined && input.q.trim() !== '') {
    where.push(`email LIKE ? ESCAPE '\\'`);
    params.push(`%${normalizeEmail(input.q).replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
  }
  if (input.reason !== undefined) {
    where.push('reason = ?');
    params.push(input.reason);
  }
  if (cursor !== null) {
    where.push('(created_at < ? OR (created_at = ? AND email < ?))');
    params.push(Number(cursor[0]), Number(cursor[0]), String(cursor[1]));
  }
  const rows = deps.db.all<SuppressionRow>(
    `SELECT * FROM mail_suppressions WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC, email DESC LIMIT ?`,
    ...params,
    limit + 1,
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    data: page.map(toSuppression),
    next_cursor:
      rows.length > limit && last !== undefined ? encodeCursor([last.created_at, last.email]) : null,
  };
}

export function addSuppression(deps: MailDeps, input: AddSuppressionInput): Suppression {
  suppress(deps, { email: input.email, reason: input.reason, source: 'api', contactId: null });
  const row = deps.db.all<SuppressionRow>(
    `SELECT * FROM mail_suppressions WHERE email = ?`,
    normalizeEmail(input.email),
  )[0];
  if (row === undefined) throw notFound('suppression', input.email);
  return toSuppression(row);
}

export function removeSuppression(
  deps: MailDeps,
  input: { email: string },
): { email: string; deleted: true } {
  const email = normalizeEmail(input.email);
  if (deps.db.all(`SELECT 1 AS x FROM mail_suppressions WHERE email = ?`, email).length === 0) {
    throw notFound('suppression', email);
  }
  deps.db.run(`DELETE FROM mail_suppressions WHERE email = ?`, email);
  return { email, deleted: true };
}

// ------------------------------------------------------------------ messages

export interface MessageRow {
  id: string;
  request_id: string;
  contact_id: string;
  email: string | null;
  subject: string | null;
  status: EmailMessage['status'];
  status_reason: string | null;
  source_type: EmailMessage['source_type'];
  source: string | null;
  broadcast_id: string | null;
  provider_message_id: string | null;
  attempts: number;
  lease_until: number | null;
  open_count: number;
  click_count: number;
  sent_at: number | null;
  delivered_at: number | null;
  opened_at: number | null;
  clicked_at: number | null;
  bounced_at: number | null;
  complained_at: number | null;
  unsubscribed_at: number | null;
  created_at: number;
  updated_at: number;
}

export const toMessage = (row: MessageRow): EmailMessage => ({
  id: row.id,
  contact_id: row.contact_id,
  email: row.email,
  subject: row.subject,
  status: row.status,
  status_reason: row.status_reason,
  source_type: row.source_type,
  broadcast_id: row.broadcast_id,
  provider_message_id: row.provider_message_id,
  attempts: row.attempts,
  open_count: row.open_count,
  click_count: row.click_count,
  sent_at: toIso(row.sent_at),
  delivered_at: toIso(row.delivered_at),
  opened_at: toIso(row.opened_at),
  clicked_at: toIso(row.clicked_at),
  bounced_at: toIso(row.bounced_at),
  unsubscribed_at: toIso(row.unsubscribed_at),
  created_at: isoOf(row.created_at),
});

export function getMessageRow(deps: MailDeps, id: string): MessageRow | undefined {
  return deps.db.all<MessageRow>(`SELECT * FROM mail_messages WHERE id = ?`, id)[0];
}

/** Messages of one contact (`mail_messages_contact` index). */
export function countContactMessages(deps: MailDeps, input: { contactId: string }): { count: number } {
  const row = deps.db.all<{ count: number }>(
    `SELECT COUNT(*) AS count FROM mail_messages WHERE contact_id = ?`,
    input.contactId,
  )[0];
  return { count: row?.count ?? 0 };
}

export function listContactMessages(
  deps: MailDeps,
  input: { contactId: string; limit?: number; cursor?: string },
): Page<EmailMessage> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const cursor = decodeCursor(input.cursor);
  const rows =
    cursor === null
      ? deps.db.all<MessageRow>(
          `SELECT * FROM mail_messages WHERE contact_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
          input.contactId,
          limit + 1,
        )
      : deps.db.all<MessageRow>(
          `SELECT * FROM mail_messages WHERE contact_id = ?
              AND (created_at < ? OR (created_at = ? AND id < ?))
            ORDER BY created_at DESC, id DESC LIMIT ?`,
          input.contactId,
          Number(cursor[0]),
          Number(cursor[0]),
          String(cursor[1]),
          limit + 1,
        );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    data: page.map(toMessage),
    next_cursor:
      rows.length > limit && last !== undefined ? encodeCursor([last.created_at, last.id]) : null,
  };
}

export function getMessage(deps: MailDeps, input: { id: string }): EmailMessage {
  const row = getMessageRow(deps, input.id);
  if (row === undefined) throw notFound('message', input.id);
  return toMessage(row);
}
