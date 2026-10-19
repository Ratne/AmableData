import type { ContactTag, ListContactTagsQuery, Page } from '@amable/api-types';
import { getContactRow } from './contacts';
import type { CrmContext } from './context';
import { decodeCursor, paginate, toIso } from './util';

/** Reads behind the tabs of the contact page (tags list, tab counts). */

interface ContactTagRow {
  id: string;
  name: string;
  category_id: string | null;
  applied_at: number;
  applied_by: string | null;
}

function likeContains(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * The contact's live tags, by name (NOCASE) then id, keyset-paginated; `q`
 * keeps names containing it. Served by the `(contact_id, tag_id)` primary key:
 * a contact has at most a few thousand links, sorted in memory.
 */
export function listContactTags(
  ctx: CrmContext,
  input: { id: string } & ListContactTagsQuery,
): Page<ContactTag> {
  getContactRow(ctx, input.id);
  const after = input.cursor === undefined ? null : decodeCursor(input.cursor);
  const afterName = typeof after?.v === 'string' ? after.v : null;
  const where = ['ct.contact_id = ?', 't.deleted_at IS NULL'];
  const params: (string | number)[] = [input.id];
  if (input.q !== undefined && input.q !== '') {
    where.push(`t.name LIKE ? ESCAPE '\\'`);
    params.push(likeContains(input.q));
  }
  if (input.category_id !== undefined) {
    where.push('t.category_id = ?');
    params.push(input.category_id);
  }
  if (after !== null && afterName !== null) {
    where.push('(t.name > ? COLLATE NOCASE OR (t.name = ? COLLATE NOCASE AND t.id > ?))');
    params.push(afterName, afterName, after.id);
  }
  const rows = ctx.db.all<ContactTagRow>(
    `SELECT t.id, t.name, t.category_id, ct.applied_at, ct.applied_by
     FROM crm_contact_tags ct JOIN crm_tags t ON t.id = ct.tag_id
     WHERE ${where.join(' AND ')}
     ORDER BY t.name COLLATE NOCASE, t.id LIMIT ?`,
    ...params,
    input.limit + 1,
  );
  const page = paginate(rows, input.limit, (r) => ({ v: r.name, id: r.id }));
  return {
    data: page.rows.map((r) => ({ ...r, applied_at: toIso(r.applied_at) })),
    next_cursor: page.nextCursor,
  };
}

export interface ContactTabCounts {
  tags: number;
  notes: number;
  tasks_open: number;
  appointments: number;
  opportunities: number;
  orders: number;
  submissions: number;
  signatures: number;
}

/** One indexed `COUNT(*)` per tab of the TenantDb, in a single statement. */
export function contactTabCounts(ctx: CrmContext, input: { id: string }): ContactTabCounts {
  getContactRow(ctx, input.id);
  const row = ctx.db.all<ContactTabCounts>(
    `SELECT
       (SELECT COUNT(*) FROM crm_contact_tags ct JOIN crm_tags t ON t.id = ct.tag_id
         WHERE ct.contact_id = ? AND t.deleted_at IS NULL) AS tags,
       (SELECT COUNT(*) FROM crm_notes WHERE contact_id = ? AND deleted_at IS NULL) AS notes,
       (SELECT COUNT(*) FROM crm_tasks WHERE contact_id = ? AND deleted_at IS NULL
         AND status = 'open') AS tasks_open,
       (SELECT COUNT(*) FROM crm_appointments WHERE contact_id = ? AND deleted_at IS NULL) AS appointments,
       (SELECT COUNT(*) FROM crm_opportunities WHERE contact_id = ? AND deleted_at IS NULL) AS opportunities,
       (SELECT COUNT(*) FROM crm_orders WHERE contact_id = ? AND deleted_at IS NULL) AS orders,
       (SELECT COUNT(*) FROM form_submissions WHERE contact_id = ? AND deleted_at IS NULL) AS submissions,
       (SELECT COUNT(DISTINCT request_id) FROM esign_signers WHERE contact_id = ?) AS signatures`,
    ...Array<string>(8).fill(input.id),
  )[0];
  return (
    row ?? {
      tags: 0,
      notes: 0,
      tasks_open: 0,
      appointments: 0,
      opportunities: 0,
      orders: 0,
      submissions: 0,
      signatures: 0,
    }
  );
}
