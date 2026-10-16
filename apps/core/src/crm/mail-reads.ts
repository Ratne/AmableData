import type { BroadcastAudience, BroadcastSegment, Contact, SearchQuery } from '@amable/api-types';
import { contactsByIds } from './contacts';
import type { CrmContext } from './context';
import { placeholders } from './db/sql';
import { savedSearchMemberIds } from './saved-searches';
import { matchingIds } from './search/query-builder';

/**
 * Read-only CRM operations used by the email module (MailDb DO): segment
 * resolution, recipient facts for estimates/scheduling and the contact data
 * Liquid needs at render time. No schema change, no writes.
 */

const MAX_IDS = 500;
/** Durable Object SQLite binds at most 100 parameters per statement. */
const IN_CHUNK = 90;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += IN_CHUNK) out.push(items.slice(i, i + IN_CHUNK));
  return out;
}

export interface MailRecipientFacts {
  id: string;
  email: string | null;
  marketable_status: Contact['marketable_status'];
  time_zone: string | null;
}

export interface MailSendContact {
  contact: Contact;
  tag_names: string[];
  company: { name: string; website: string | null } | null;
}

export function segmentMemberIds(
  ctx: CrmContext,
  input: { segment: BroadcastSegment; max?: number },
): string[] {
  const max = input.max ?? 100_000;
  if (input.segment.type === 'saved_search') {
    return savedSearchMemberIds(ctx, { id: input.segment.saved_search_id, max });
  }
  if (input.segment.type === 'audience') return audienceMemberIds(ctx, input.segment, max);
  const query: SearchQuery = {
    entity: 'contact',
    filter: {
      type: 'group',
      op: 'and',
      conditions: [{ type: 'tags', match: input.segment.match, tag_ids: input.segment.tag_ids }],
    },
  };
  return matchingIds(ctx, query, max);
}

function tagQuery(match: 'any' | 'all', tagIds: readonly string[]): SearchQuery {
  return {
    entity: 'contact',
    filter: {
      type: 'group',
      op: 'and',
      conditions: [{ type: 'tags', match, tag_ids: [...tagIds] }],
    },
  };
}

/** Union of the includes minus the union of the excludes, in include order. */
function audienceMemberIds(ctx: CrmContext, audience: BroadcastAudience, max: number): string[] {
  const included = new Set<string>();
  if (audience.include_tag_ids.length > 0) {
    for (const id of matchingIds(ctx, tagQuery(audience.tag_match, audience.include_tag_ids), max)) {
      included.add(id);
    }
  }
  for (const savedSearchId of audience.include_saved_search_ids) {
    for (const id of savedSearchMemberIds(ctx, { id: savedSearchId, max })) included.add(id);
  }
  if (included.size === 0) return [];
  const excluded = new Set<string>();
  if (audience.exclude_tag_ids.length > 0) {
    for (const id of matchingIds(ctx, tagQuery('any', audience.exclude_tag_ids), max)) excluded.add(id);
  }
  for (const savedSearchId of audience.exclude_saved_search_ids) {
    for (const id of savedSearchMemberIds(ctx, { id: savedSearchId, max })) excluded.add(id);
  }
  const out: string[] = [];
  for (const id of included) {
    if (out.length >= max) break;
    if (!excluded.has(id)) out.push(id);
  }
  return out;
}

function boundedIds(ids: readonly string[]): string[] {
  if (ids.length > MAX_IDS) throw new Error(`at most ${String(MAX_IDS)} ids per call`);
  return [...ids];
}

export function recipientFacts(ctx: CrmContext, input: { ids: string[] }): MailRecipientFacts[] {
  const ids = boundedIds(input.ids);
  return chunks(ids).flatMap((chunk) =>
    ctx.db.all<MailRecipientFacts>(
      `SELECT id, primary_email AS email, marketable_status, time_zone
         FROM crm_contacts
        WHERE id IN (${placeholders(chunk.length)}) AND deleted_at IS NULL`,
      ...chunk,
    ),
  );
}

export function contactsForSend(ctx: CrmContext, input: { ids: string[] }): MailSendContact[] {
  const ids = boundedIds(input.ids);
  const contacts = chunks(ids)
    .flatMap((chunk) => contactsByIds(ctx, chunk))
    .filter((c) => c.deleted_at === null);
  if (contacts.length === 0) return [];
  const live = contacts.map((c) => c.id);
  const tagRows = chunks(live).flatMap((chunk) =>
    ctx.db.all<{ contact_id: string; name: string }>(
      `SELECT ct.contact_id, t.name FROM crm_contact_tags ct
         JOIN crm_tags t ON t.id = ct.tag_id AND t.deleted_at IS NULL
        WHERE ct.contact_id IN (${placeholders(chunk.length)})`,
      ...chunk,
    ),
  );
  const companyIds = [...new Set(contacts.map((c) => c.company_id).filter((id) => id !== null))];
  const companies = chunks(companyIds).flatMap((chunk) =>
    ctx.db.all<{ id: string; name: string; website: string | null }>(
      `SELECT id, name, website FROM crm_companies WHERE id IN (${placeholders(chunk.length)})`,
      ...chunk,
    ),
  );
  const companyById = new Map(companies.map((c) => [c.id, c]));
  return contacts.map((contact) => {
    const company = contact.company_id === null ? undefined : companyById.get(contact.company_id);
    return {
      contact,
      tag_names: tagRows.filter((r) => r.contact_id === contact.id).map((r) => r.name),
      company: company === undefined ? null : { name: company.name, website: company.website },
    };
  });
}
