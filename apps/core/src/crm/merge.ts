import type {
  AddressInput,
  Contact,
  ContactEmailInput,
  ContactPhoneInput,
  UpdateContactInput,
} from '@amable/api-types';
import type { CrmContext } from './context';
import { invalid } from './errors';
import { emit } from './events';
import { mergeAppEntityData } from '../apps/tenant-ops';
import { mergeConversations } from '../conversations/ops';
import {
  getContact,
  getContactRow,
  indexContact,
  purgeContactSatellites,
  serializeContacts,
  updateContact,
  type ContactRow,
} from './contacts';
import { removeDocument } from './search/index-store';
import { applyTagsToContact } from './tags';

const FILLABLE = [
  'given_name',
  'middle_name',
  'family_name',
  'prefix',
  'suffix',
  'preferred_name',
  'job_title',
  'company_id',
  'birthday',
  'anniversary',
  'website',
  'spouse_name',
  'time_zone',
  'preferred_locale',
  'owner_id',
  'lead_source_id',
] as const satisfies ReadonlyArray<keyof UpdateContactInput & keyof ContactRow>;

const UTM = ['source', 'medium', 'campaign', 'term', 'content'] as const;

/**
 * Folds `sourceIds` into `targetId`:
 * - empty scalar fields of the target are filled from the sources (in order);
 * - emails/phones are unioned (up to 5), addresses taken from the first source
 *   when the target has none; tags are unioned; empty custom fields are filled;
 * - notes, tasks, appointments, opportunities, timeline and signers move to the target;
 * - sources are soft-deleted with `merged_into_id` and leave the search index.
 * Emits `contact.updated` (via the update), `contact.tag_applied` for new tags
 * and one `contact.merged`.
 */
export function mergeContacts(
  ctx: CrmContext,
  input: { targetId: string; sourceIds: string[] },
): Contact {
  const sourceIds = [...new Set(input.sourceIds)];
  if (sourceIds.includes(input.targetId)) {
    throw invalid('source_ids', 'a contact cannot be merged into itself');
  }
  const target = getContactRow(ctx, input.targetId);
  const sourceRows = sourceIds.map((id) => getContactRow(ctx, id));
  const [targetFull, ...sources] = serializeContacts(ctx, [target, ...sourceRows]);
  if (targetFull === undefined) throw invalid('id', 'target not found');

  const data: UpdateContactInput = {};
  for (const field of FILLABLE) {
    if (target[field] !== null) continue;
    const donor = sourceRows.find((s) => s[field] !== null);
    if (donor !== undefined) data[field] = donor[field];
  }
  const utm: NonNullable<UpdateContactInput['utm']> = {};
  for (const key of UTM) {
    if (target[`utm_${key}`] !== null) continue;
    const donor = sourceRows.find((s) => s[`utm_${key}`] !== null);
    if (donor !== undefined) utm[key] = donor[`utm_${key}`];
  }
  if (Object.keys(utm).length > 0) data.utm = utm;
  const maxScore = Math.max(target.score_value, ...sourceRows.map((s) => s.score_value));
  if (maxScore !== target.score_value) data.score_value = maxScore;

  const emails: ContactEmailInput[] = [];
  const seenEmails = new Set<string>();
  for (const contact of [targetFull, ...sources]) {
    for (const e of contact.emails) {
      const key = e.email.toLowerCase();
      if (seenEmails.has(key) || emails.length >= 5) continue;
      seenEmails.add(key);
      emails.push({
        email: e.email,
        ...(e.label === null ? {} : { label: e.label as ContactEmailInput['label'] }),
      });
    }
  }
  if (emails.length !== targetFull.emails.length) data.emails = emails;

  const phones: ContactPhoneInput[] = [];
  const seenPhones = new Set<string>();
  for (const contact of [targetFull, ...sources]) {
    for (const p of contact.phones) {
      const key = p.number.replace(/\D/g, '');
      if (seenPhones.has(key) || phones.length >= 5) continue;
      seenPhones.add(key);
      phones.push({
        number: p.number,
        ...(p.extension === null ? {} : { extension: p.extension }),
        ...(p.type === null ? {} : { type: p.type as ContactPhoneInput['type'] }),
      });
    }
  }
  if (phones.length !== targetFull.phones.length) data.phones = phones;

  if (targetFull.addresses.length === 0) {
    const donor = sources.find((s) => s.addresses.length > 0);
    if (donor !== undefined) {
      data.addresses = donor.addresses.map((a): AddressInput => ({
        ...a,
        type: a.type as AddressInput['type'],
      }));
    }
  }

  // Tags of the sources, applied before they are purged.
  const sourceTags = [...new Set(sources.flatMap((s) => s.tag_ids))];

  const now = ctx.now();
  for (const source of sourceRows) {
    ctx.db.run(
      `INSERT OR IGNORE INTO crm_custom_field_values (entity, entity_id, field_id, value_text, value_number, value_json, updated_at)
       SELECT entity, ?, field_id, value_text, value_number, value_json, ? FROM crm_custom_field_values
       WHERE entity = 'contact' AND entity_id = ?`,
      target.id,
      now,
      source.id,
    );
    for (const table of [
      'crm_notes',
      'crm_tasks',
      'crm_appointments',
      'crm_opportunities',
      'crm_activities',
      'esign_signers',
    ]) {
      ctx.db.run(`UPDATE ${table} SET contact_id = ? WHERE contact_id = ?`, target.id, source.id);
    }
    mergeAppEntityData(ctx, target.id, [source.id]);
    mergeConversations(ctx, target.id, [source.id]);
    purgeContactSatellites(ctx, source.id);
    ctx.db.run(
      `UPDATE crm_contacts SET deleted_at = ?, updated_at = ?, merged_into_id = ?, primary_email = NULL,
         primary_phone = NULL WHERE id = ?`,
      now,
      now,
      target.id,
      source.id,
    );
    removeDocument(ctx, 'contact', source.id);
  }

  updateContact(ctx, { id: target.id, data });
  applyTagsToContact(ctx, target.id, sourceTags);
  emit(ctx, 'contact.merged', { contactId: target.id, mergedContactIds: sourceIds });
  indexContact(ctx, target.id);
  return getContact(ctx, { id: target.id });
}
