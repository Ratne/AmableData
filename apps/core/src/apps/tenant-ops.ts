import { APP_ENTITY_KINDS, appCustomFieldKey, type AppCustomField, type AppEntityKind } from '@amable/core/apps';
import type { CrmContext } from '../crm/context';
import { CrmError, notFound } from '../crm/errors';
import { purgeContactSatellites, updateContact } from '../crm/contacts';
import { applyTagsToContact, findOrCreateTagByName } from '../crm/tags';
import { emit } from '../crm/events';
import { removeDocument } from '../crm/search/index-store';
import { eraseConversationsOf } from '../conversations/ops';

/**
 * Tenant-side storage of marketplace apps (TenantDb, migration t0011), reached
 * through the single CRM RPC like every other tenant operation. The core worker
 * only calls these after resolving which app is acting (its token) or which
 * install the admin manages; `appId` therefore always comes from verified context.
 */

export const APP_DATA_MAX_KEYS = 500;
export const APP_DATA_MAX_VALUE_BYTES = 16 * 1024;
export const APP_ENTITY_MAX_KEYS = 50;

const ENTITY_TABLES: Record<AppEntityKind, string> = {
  contact: 'crm_contacts',
  company: 'crm_companies',
  opportunity: 'crm_opportunities',
  order: 'crm_orders',
};

interface DataRow {
  key: string;
  value: string;
  secret: number;
  updated_at: number;
}

export interface AppDataEntry {
  readonly key: string;
  /** JSON value; for secrets, the encrypted envelope (decrypted by the core worker). */
  readonly value: string;
  readonly secret: boolean;
  readonly updated_at: string;
}

const toEntry = (row: DataRow): AppDataEntry => ({
  key: row.key,
  value: row.value,
  secret: row.secret === 1,
  updated_at: new Date(row.updated_at).toISOString(),
});

function assertValueSize(value: string): void {
  if (new TextEncoder().encode(value).length > APP_DATA_MAX_VALUE_BYTES) {
    throw new CrmError('payload_too_large', `value larger than ${String(APP_DATA_MAX_VALUE_BYTES)} bytes`);
  }
}

function listData(ctx: CrmContext, input: { appId: string; prefix?: string }): AppDataEntry[] {
  return ctx.db
    .all<DataRow>(
      `SELECT key, value, secret, updated_at FROM app_data WHERE app_id = ? AND key LIKE ? ESCAPE '\\' ORDER BY key`,
      input.appId,
      `${(input.prefix ?? '').replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
    )
    .map(toEntry);
}

function getData(ctx: CrmContext, input: { appId: string; key: string }): AppDataEntry {
  const row = ctx.db.all<DataRow>(
    `SELECT key, value, secret, updated_at FROM app_data WHERE app_id = ? AND key = ?`,
    input.appId,
    input.key,
  )[0];
  if (row === undefined) throw notFound('app data', input.key);
  return toEntry(row);
}

function setData(ctx: CrmContext, input: { appId: string; key: string; value: string; secret: boolean }): AppDataEntry {
  assertValueSize(input.value);
  const exists = ctx.db.all(`SELECT 1 FROM app_data WHERE app_id = ? AND key = ?`, input.appId, input.key).length > 0;
  if (!exists) {
    const count = ctx.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM app_data WHERE app_id = ?`, input.appId)[0]?.n ?? 0;
    if (count >= APP_DATA_MAX_KEYS) throw new CrmError('conflict', `at most ${String(APP_DATA_MAX_KEYS)} keys per app`);
  }
  ctx.db.run(
    `INSERT INTO app_data (app_id, key, value, secret, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(app_id, key) DO UPDATE SET value = excluded.value, secret = excluded.secret, updated_at = excluded.updated_at`,
    input.appId,
    input.key,
    input.value,
    input.secret ? 1 : 0,
    ctx.now(),
  );
  return getData(ctx, input);
}

function deleteData(ctx: CrmContext, input: { appId: string; key?: string }): { deleted: number } {
  const before = ctx.db.all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM app_data WHERE app_id = ? AND (? IS NULL OR key = ?)`,
    input.appId,
    input.key ?? null,
    input.key ?? null,
  )[0]?.n;
  ctx.db.run(`DELETE FROM app_data WHERE app_id = ? AND (? IS NULL OR key = ?)`, input.appId, input.key ?? null, input.key ?? null);
  return { deleted: before ?? 0 };
}

// --------------------------------------------------------------- entity data

export interface AppEntityValue {
  readonly app_id: string;
  readonly key: string;
  readonly value: unknown;
  readonly updated_at: string;
}

function assertEntity(ctx: CrmContext, entity: AppEntityKind, entityId: string): void {
  if (!APP_ENTITY_KINDS.includes(entity)) throw new CrmError('validation_failed', `unknown entity ${entity}`);
  const found = ctx.db.all(`SELECT 1 FROM ${ENTITY_TABLES[entity]} WHERE id = ?`, entityId);
  if (found.length === 0) throw notFound(entity, entityId);
}

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/** Values on a record; without `appId`, every app's (contact page, exports). */
function getEntityData(
  ctx: CrmContext,
  input: { appId?: string; entity: AppEntityKind; entityId: string },
): AppEntityValue[] {
  assertEntity(ctx, input.entity, input.entityId);
  return ctx.db
    .all<{ app_id: string; key: string; value: string; updated_at: number }>(
      `SELECT app_id, key, value, updated_at FROM app_entity_data
       WHERE entity = ? AND entity_id = ? AND (? IS NULL OR app_id = ?) ORDER BY app_id, key`,
      input.entity,
      input.entityId,
      input.appId ?? null,
      input.appId ?? null,
    )
    .map((row) => ({
      app_id: row.app_id,
      key: row.key,
      value: parseValue(row.value),
      updated_at: new Date(row.updated_at).toISOString(),
    }));
}

function setEntityData(
  ctx: CrmContext,
  input: { appId: string; entity: AppEntityKind; entityId: string; values: Record<string, unknown> },
): AppEntityValue[] {
  assertEntity(ctx, input.entity, input.entityId);
  const now = ctx.now();
  for (const [key, value] of Object.entries(input.values)) {
    if (value === null) {
      ctx.db.run(
        `DELETE FROM app_entity_data WHERE app_id = ? AND entity = ? AND entity_id = ? AND key = ?`,
        input.appId,
        input.entity,
        input.entityId,
        key,
      );
      continue;
    }
    const raw = JSON.stringify(value);
    assertValueSize(raw);
    ctx.db.run(
      `INSERT INTO app_entity_data (app_id, entity, entity_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(app_id, entity, entity_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      input.appId,
      input.entity,
      input.entityId,
      key,
      raw,
      now,
    );
  }
  const count =
    ctx.db.all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM app_entity_data WHERE app_id = ? AND entity = ? AND entity_id = ?`,
      input.appId,
      input.entity,
      input.entityId,
    )[0]?.n ?? 0;
  if (count > APP_ENTITY_MAX_KEYS) {
    throw new CrmError('conflict', `at most ${String(APP_ENTITY_MAX_KEYS)} keys per app and record`);
  }
  return getEntityData(ctx, input);
}

/** Moves app values of merged contacts onto the survivor (survivor values win). */
export function mergeAppEntityData(ctx: CrmContext, survivorId: string, sourceIds: readonly string[]): void {
  for (const sourceId of sourceIds) {
    ctx.db.run(
      `INSERT OR IGNORE INTO app_entity_data (app_id, entity, entity_id, key, value, updated_at)
       SELECT app_id, entity, ?, key, value, updated_at FROM app_entity_data WHERE entity = 'contact' AND entity_id = ?`,
      survivorId,
      sourceId,
    );
    ctx.db.run(`DELETE FROM app_entity_data WHERE entity = 'contact' AND entity_id = ?`, sourceId);
  }
}

export function deleteAppEntityDataOf(ctx: CrmContext, entity: AppEntityKind, entityId: string): void {
  ctx.db.run(`DELETE FROM app_entity_data WHERE entity = ? AND entity_id = ?`, entity, entityId);
}

// -------------------------------------------------------------- owned fields

/**
 * Creates (or re-adopts) the custom fields an app declares. Keys are
 * `app_<id>_<key>`; a user field already using the key is left untouched and
 * reported as a conflict instead of being taken over.
 */
function ensureFields(
  ctx: CrmContext,
  input: { appId: string; appName: string; fields: AppCustomField[] },
): { created: string[]; adopted: string[]; conflicts: string[] } {
  const created: string[] = [];
  const adopted: string[] = [];
  const conflicts: string[] = [];
  const now = ctx.now();
  for (const field of input.fields) {
    const key = appCustomFieldKey(input.appId, field.key);
    const existing = ctx.db.all<{ id: string; owner_app_id: string | null }>(
      `SELECT id, owner_app_id FROM crm_custom_fields WHERE entity = ? AND key = ? AND deleted_at IS NULL`,
      field.entity,
      key,
    )[0];
    if (existing !== undefined) {
      if (existing.owner_app_id === input.appId) continue;
      if (existing.owner_app_id === null) {
        ctx.db.run(`UPDATE crm_custom_fields SET owner_app_id = ?, updated_at = ? WHERE id = ?`, input.appId, now, existing.id);
        adopted.push(key);
      } else {
        conflicts.push(key);
      }
      continue;
    }
    ctx.db.run(
      `INSERT INTO crm_custom_fields
         (id, entity, key, label, type, group_id, position, options, config, required, sensitive, created_at, updated_at, owner_app_id)
       VALUES (?, ?, ?, ?, ?, NULL, 1000, '[]', '{}', 0, 0, ?, ?, ?)`,
      ctx.newId(),
      field.entity,
      key,
      `${field.label.en} (${input.appName})`,
      field.type,
      now,
      now,
      input.appId,
    );
    created.push(key);
  }
  return { created, adopted, conflicts };
}

/**
 * Final step of an uninstall: drops the app's key/value data, then either
 * deletes its fields and record values or hands them over to the workspace.
 */
function cleanup(ctx: CrmContext, input: { appId: string; keepData: boolean }): { fields: number; values: number } {
  ctx.db.run(`DELETE FROM app_data WHERE app_id = ?`, input.appId);
  const fields = ctx.db.all<{ id: string }>(
    `SELECT id FROM crm_custom_fields WHERE owner_app_id = ? AND deleted_at IS NULL`,
    input.appId,
  );
  const values =
    ctx.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM app_entity_data WHERE app_id = ?`, input.appId)[0]?.n ?? 0;
  const now = ctx.now();
  if (input.keepData) {
    ctx.db.run(`UPDATE crm_custom_fields SET owner_app_id = NULL, updated_at = ? WHERE owner_app_id = ?`, now, input.appId);
  } else {
    for (const field of fields) {
      ctx.db.run(`UPDATE crm_custom_fields SET deleted_at = ?, owner_app_id = NULL WHERE id = ?`, now, field.id);
      ctx.db.run(`DELETE FROM crm_custom_field_values WHERE field_id = ?`, field.id);
    }
    ctx.db.run(`DELETE FROM app_entity_data WHERE app_id = ?`, input.appId);
  }
  return { fields: fields.length, values };
}

// ------------------------------------------------------------------ timeline

export interface AppTimelineInput {
  readonly appId: string;
  readonly appName: string;
  readonly contactId: string;
  readonly title: string;
  readonly body?: string | undefined;
  readonly icon?: string | undefined;
  readonly url?: string | undefined;
  readonly occurred_at?: number | undefined;
}

/** An activity on the contact timeline written by an app ("WhatsApp delivered"). */
/** Effects of a `contact.validate` answer: app-owned fields, tags by name, metadata. */
export interface AppValidationEffects {
  readonly appId: string;
  readonly contactId: string;
  /** Keys without the `app_<id>_` prefix; only fields the app owns are written. */
  readonly fields: Readonly<Record<string, string | number | boolean | null>>;
  readonly tags: readonly string[];
  readonly entityData: Readonly<Record<string, unknown>>;
}

function applyValidation(ctx: CrmContext, input: AppValidationEffects): { fields: string[]; tags: string[] } {
  const exists = ctx.db.all(`SELECT 1 FROM crm_contacts WHERE id = ? AND deleted_at IS NULL`, input.contactId);
  if (exists.length === 0) throw notFound('contact', input.contactId);
  const owned = new Set(
    ctx.db
      .all<{ key: string }>(
        `SELECT key FROM crm_custom_fields WHERE entity = 'contact' AND owner_app_id = ? AND deleted_at IS NULL`,
        input.appId,
      )
      .map((r) => r.key),
  );
  const custom: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(input.fields)) {
    const full = owned.has(key) ? key : appCustomFieldKey(input.appId, key);
    if (owned.has(full)) custom[full] = value;
  }
  if (Object.keys(custom).length > 0) {
    updateContact(ctx, { id: input.contactId, data: { custom_fields: custom } }, { lenient: true });
  }
  const tagIds = input.tags
    .map((name) => name.trim())
    .filter((name) => name !== '' && name.length <= 100)
    .slice(0, 10)
    .map((name) => findOrCreateTagByName(ctx, name));
  if (tagIds.length > 0) applyTagsToContact(ctx, input.contactId, tagIds);
  if (Object.keys(input.entityData).length > 0) {
    setEntityData(ctx, { appId: input.appId, entity: 'contact', entityId: input.contactId, values: { ...input.entityData } });
  }
  return { fields: Object.keys(custom), tags: tagIds };
}

function addTimeline(ctx: CrmContext, input: AppTimelineInput): { id: string } {
  const exists = ctx.db.all(`SELECT 1 FROM crm_contacts WHERE id = ? AND deleted_at IS NULL`, input.contactId);
  if (exists.length === 0) throw notFound('contact', input.contactId);
  const id = ctx.newId();
  ctx.db.run(
    `INSERT INTO crm_activities (id, type, contact_id, company_id, opportunity_id, actor_type, actor_id, data, occurred_at)
     VALUES (?, 'app.timeline', ?, NULL, NULL, 'app', ?, ?, ?)`,
    id,
    input.contactId,
    input.appId,
    JSON.stringify({
      app_id: input.appId,
      app_name: input.appName,
      title: input.title,
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.icon === undefined ? {} : { icon: input.icon }),
      ...(input.url === undefined ? {} : { url: input.url }),
    }),
    input.occurred_at ?? ctx.now(),
  );
  return { id };
}

// --------------------------------------------------------------- privacy

export interface ContactPrivacyFacts {
  readonly contact_id: string;
  readonly emails: string[];
  readonly phones: string[];
}

function privacyFacts(ctx: CrmContext, input: { contactId: string }): ContactPrivacyFacts {
  const contact = ctx.db.all(`SELECT 1 FROM crm_contacts WHERE id = ?`, input.contactId);
  if (contact.length === 0) throw notFound('contact', input.contactId);
  const emails = ctx.db
    .all<{ email: string }>(`SELECT email FROM crm_contact_emails WHERE contact_id = ?`, input.contactId)
    .map((r) => r.email);
  const phones = ctx.db
    .all<{ number: string }>(`SELECT number FROM crm_contact_phones WHERE contact_id = ?`, input.contactId)
    .map((r) => r.number);
  return { contact_id: input.contactId, emails, phones };
}

const ERASED_COLUMNS = [
  'given_name',
  'middle_name',
  'family_name',
  'prefix',
  'suffix',
  'preferred_name',
  'job_title',
  'birthday',
  'anniversary',
  'website',
  'spouse_name',
  'time_zone',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'primary_email',
  'primary_phone',
];

/**
 * Right to erasure: removes the contact's personal data for good (identity,
 * channels, addresses, custom values, notes, timeline, app values) and keeps
 * an anonymous tombstone so references from orders or deals stay valid.
 * Returns the identifiers apps need to erase their own copies.
 */
function eraseContact(ctx: CrmContext, input: { contactId: string }): ContactPrivacyFacts {
  const facts = privacyFacts(ctx, input);
  purgeContactSatellites(ctx, input.contactId);
  deleteAppEntityDataOf(ctx, 'contact', input.contactId);
  eraseConversationsOf(ctx, input.contactId);
  ctx.db.run(`DELETE FROM crm_notes WHERE contact_id = ?`, input.contactId);
  ctx.db.run(`DELETE FROM crm_activities WHERE contact_id = ?`, input.contactId);
  const now = ctx.now();
  ctx.db.run(
    `UPDATE crm_contacts SET ${ERASED_COLUMNS.map((c) => `${c} = NULL`).join(', ')}, social_accounts = '[]',
       deleted_at = COALESCE(deleted_at, ?), updated_at = ? WHERE id = ?`,
    now,
    now,
    input.contactId,
  );
  removeDocument(ctx, 'contact', input.contactId);
  emit(ctx, 'contact.deleted', { contactId: input.contactId }, { erased: true });
  return facts;
}

export const appTenantOps = {
  'apps.data.list': listData,
  'apps.data.get': getData,
  'apps.data.set': setData,
  'apps.data.delete': deleteData,
  'apps.entity.get': getEntityData,
  'apps.entity.set': setEntityData,
  'apps.fields.ensure': ensureFields,
  'apps.cleanup': cleanup,
  'apps.timeline.add': addTimeline,
  'apps.validation.apply': applyValidation,
  'apps.privacy.facts': privacyFacts,
  'contacts.erase': eraseContact,
} satisfies Record<string, (ctx: CrmContext, input: never) => unknown>;
