import type {
  CreateCustomFieldGroupInput,
  CreateCustomFieldInput,
  CreateCustomFieldTabInput,
  CustomField,
  CustomFieldConfig,
  CustomFieldEntity,
  CustomFieldGroup,
  CustomFieldLayout,
  CustomFieldOption,
  CustomFieldTab,
  CustomFieldType,
  CustomFieldValues,
  UpdateCustomFieldGroupInput,
  UpdateCustomFieldInput,
  UpdateCustomFieldTabInput,
} from '@amable/api-types';
import type { CrmContext } from '../context';
import { placeholders } from '../db/sql';
import { CrmError, invalid, invalidMany, notFound, type ErrorDetail } from '../errors';
import { bool, parseJson, toIso } from '../util';
import {
  maskValue,
  normalizeCustomFieldValue,
  storedToApi,
  validateFieldDefinition,
  type NormalizeOptions,
  type StoredValue,
} from './validate';

interface FieldRow {
  id: string;
  entity: CustomFieldEntity;
  key: string;
  label: string;
  type: CustomFieldType;
  group_id: string | null;
  position: number;
  options: string;
  config: string;
  required: number;
  sensitive: number;
  created_at: number;
  updated_at: number;
  owner_app_id?: string | null;
}

/** Parsed definition used by services, validators and the query builder. */
export interface FieldDef {
  id: string;
  entity: CustomFieldEntity;
  key: string;
  label: string;
  type: CustomFieldType;
  groupId: string | null;
  position: number;
  options: CustomFieldOption[];
  config: CustomFieldConfig;
  required: boolean;
  sensitive: boolean;
  createdAt: number;
  updatedAt: number;
  /** Marketplace app that declared the field; it cannot be deleted while the app is installed. */
  ownerAppId: string | null;
}

function toDef(row: FieldRow): FieldDef {
  return {
    id: row.id,
    entity: row.entity,
    key: row.key,
    label: row.label,
    type: row.type,
    groupId: row.group_id,
    position: row.position,
    options: parseJson<CustomFieldOption[]>(row.options, []),
    config: parseJson<CustomFieldConfig>(row.config, {}),
    required: bool(row.required),
    sensitive: bool(row.sensitive),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ownerAppId: row.owner_app_id ?? null,
  };
}

function toApi(def: FieldDef): CustomField {
  return {
    id: def.id,
    entity: def.entity,
    key: def.key,
    label: def.label,
    type: def.type,
    group_id: def.groupId,
    position: def.position,
    options: def.options,
    config: def.config,
    required: def.required,
    sensitive: def.sensitive,
    created_at: toIso(def.createdAt),
    updated_at: toIso(def.updatedAt),
    owner_app_id: def.ownerAppId,
  };
}

export function loadFieldDefs(ctx: CrmContext, entity: CustomFieldEntity): FieldDef[] {
  return ctx.db
    .all<FieldRow>(
      `SELECT * FROM crm_custom_fields WHERE entity = ? AND deleted_at IS NULL ORDER BY position, key`,
      entity,
    )
    .map(toDef);
}

function getFieldRow(ctx: CrmContext, entity: CustomFieldEntity, id: string): FieldDef {
  const row = ctx.db.all<FieldRow>(
    `SELECT * FROM crm_custom_fields WHERE id = ? AND entity = ? AND deleted_at IS NULL`,
    id,
    entity,
  )[0];
  if (row === undefined) throw notFound('custom field', id);
  return toDef(row);
}

function assertGroup(ctx: CrmContext, entity: CustomFieldEntity, groupId: string): void {
  const rows = ctx.db.all(
    `SELECT 1 FROM crm_custom_field_groups g JOIN crm_custom_field_tabs t ON t.id = g.tab_id
     WHERE g.id = ? AND t.entity = ? AND g.deleted_at IS NULL AND t.deleted_at IS NULL`,
    groupId,
    entity,
  );
  if (rows.length === 0) throw invalid('group_id', `group ${groupId} not found for ${entity}`);
}

// ------------------------------------------------------------ definitions

export function listCustomFields(
  ctx: CrmContext,
  input: { entity: CustomFieldEntity },
): CustomField[] {
  return loadFieldDefs(ctx, input.entity).map(toApi);
}

export function getCustomField(
  ctx: CrmContext,
  input: { entity: CustomFieldEntity; id: string },
): CustomField {
  return toApi(getFieldRow(ctx, input.entity, input.id));
}

export function createCustomField(
  ctx: CrmContext,
  input: { entity: CustomFieldEntity; data: CreateCustomFieldInput },
): CustomField {
  const { entity, data } = input;
  const problem = validateFieldDefinition(data);
  if (problem !== null) throw invalid('options', problem);
  const taken = ctx.db.all(
    `SELECT 1 FROM crm_custom_fields WHERE entity = ? AND key = ? AND deleted_at IS NULL`,
    entity,
    data.key,
  );
  if (taken.length > 0)
    throw new CrmError('conflict', `custom field key "${data.key}" already exists`);
  if (data.group_id !== undefined && data.group_id !== null)
    assertGroup(ctx, entity, data.group_id);

  const id = ctx.newId();
  const now = ctx.now();
  ctx.db.run(
    `INSERT INTO crm_custom_fields
       (id, entity, key, label, type, group_id, position, options, config, required, sensitive, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    entity,
    data.key,
    data.label,
    data.type,
    data.group_id ?? null,
    data.position ?? 0,
    JSON.stringify(data.options ?? []),
    JSON.stringify(data.config ?? {}),
    data.required === true ? 1 : 0,
    (data.sensitive ?? data.type === 'SOCIAL_SECURITY_NUMBER') ? 1 : 0,
    now,
    now,
  );
  return getCustomField(ctx, { entity, id });
}

export function updateCustomField(
  ctx: CrmContext,
  input: { entity: CustomFieldEntity; id: string; data: UpdateCustomFieldInput },
): CustomField {
  const { entity, id, data } = input;
  const current = getFieldRow(ctx, entity, id);
  const options = data.options ?? current.options;
  const config = data.config ?? current.config;
  const problem = validateFieldDefinition({ type: current.type, options, config });
  if (problem !== null) throw invalid('options', problem);
  if (data.group_id !== undefined && data.group_id !== null)
    assertGroup(ctx, entity, data.group_id);
  ctx.db.run(
    `UPDATE crm_custom_fields SET label = ?, group_id = ?, position = ?, options = ?, config = ?,
       required = ?, sensitive = ?, updated_at = ? WHERE id = ?`,
    data.label ?? current.label,
    data.group_id === undefined ? current.groupId : data.group_id,
    data.position ?? current.position,
    JSON.stringify(options),
    JSON.stringify(config),
    (data.required ?? current.required) ? 1 : 0,
    (data.sensitive ?? current.sensitive) ? 1 : 0,
    ctx.now(),
    id,
  );
  return getCustomField(ctx, { entity, id });
}

/** Soft-deletes the definition and drops its stored values. */
export function deleteCustomField(
  ctx: CrmContext,
  input: { entity: CustomFieldEntity; id: string },
): { id: string; deleted: true } {
  const field = getFieldRow(ctx, input.entity, input.id);
  if (field.ownerAppId !== null) {
    throw new CrmError('conflict', `custom field "${field.key}" belongs to the app ${field.ownerAppId}; uninstall the app first`, [
      { path: 'owner_app_id', message: field.ownerAppId },
    ]);
  }
  ctx.db.run(`UPDATE crm_custom_fields SET deleted_at = ? WHERE id = ?`, ctx.now(), input.id);
  ctx.db.run(`DELETE FROM crm_custom_field_values WHERE field_id = ?`, input.id);
  return { id: input.id, deleted: true };
}

// ---------------------------------------------------------- tabs & groups

interface TabRow {
  id: string;
  entity: CustomFieldEntity;
  name: string;
  position: number;
}
interface GroupRow {
  id: string;
  tab_id: string;
  name: string;
  position: number;
}

function getTab(ctx: CrmContext, entity: CustomFieldEntity, id: string): TabRow {
  const row = ctx.db.all<TabRow>(
    `SELECT id, entity, name, position FROM crm_custom_field_tabs WHERE id = ? AND entity = ? AND deleted_at IS NULL`,
    id,
    entity,
  )[0];
  if (row === undefined) throw notFound('custom field tab', id);
  return row;
}

function getGroup(ctx: CrmContext, entity: CustomFieldEntity, id: string): GroupRow {
  const row = ctx.db.all<GroupRow>(
    `SELECT g.id, g.tab_id, g.name, g.position FROM crm_custom_field_groups g
     JOIN crm_custom_field_tabs t ON t.id = g.tab_id
     WHERE g.id = ? AND t.entity = ? AND g.deleted_at IS NULL`,
    id,
    entity,
  )[0];
  if (row === undefined) throw notFound('custom field group', id);
  return row;
}

export function createCustomFieldTab(
  ctx: CrmContext,
  input: { entity: CustomFieldEntity; data: CreateCustomFieldTabInput },
): CustomFieldTab {
  const id = ctx.newId();
  ctx.db.run(
    `INSERT INTO crm_custom_field_tabs (id, entity, name, position, created_at) VALUES (?, ?, ?, ?, ?)`,
    id,
    input.entity,
    input.data.name,
    input.data.position ?? 0,
    ctx.now(),
  );
  return getTab(ctx, input.entity, id);
}

export function updateCustomFieldTab(
  ctx: CrmContext,
  input: { entity: CustomFieldEntity; id: string; data: UpdateCustomFieldTabInput },
): CustomFieldTab {
  const tab = getTab(ctx, input.entity, input.id);
  ctx.db.run(
    `UPDATE crm_custom_field_tabs SET name = ?, position = ? WHERE id = ?`,
    input.data.name ?? tab.name,
    input.data.position ?? tab.position,
    tab.id,
  );
  return getTab(ctx, input.entity, input.id);
}

/** Deletes a tab with its groups; their fields become ungrouped. */
export function deleteCustomFieldTab(
  ctx: CrmContext,
  input: { entity: CustomFieldEntity; id: string },
): { id: string; deleted: true } {
  getTab(ctx, input.entity, input.id);
  const now = ctx.now();
  ctx.db.run(
    `UPDATE crm_custom_fields SET group_id = NULL, updated_at = ?
     WHERE group_id IN (SELECT id FROM crm_custom_field_groups WHERE tab_id = ?)`,
    now,
    input.id,
  );
  ctx.db.run(`UPDATE crm_custom_field_groups SET deleted_at = ? WHERE tab_id = ?`, now, input.id);
  ctx.db.run(`UPDATE crm_custom_field_tabs SET deleted_at = ? WHERE id = ?`, now, input.id);
  return { id: input.id, deleted: true };
}

export function createCustomFieldGroup(
  ctx: CrmContext,
  input: { entity: CustomFieldEntity; data: CreateCustomFieldGroupInput },
): CustomFieldGroup {
  getTab(ctx, input.entity, input.data.tab_id);
  const id = ctx.newId();
  ctx.db.run(
    `INSERT INTO crm_custom_field_groups (id, tab_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)`,
    id,
    input.data.tab_id,
    input.data.name,
    input.data.position ?? 0,
    ctx.now(),
  );
  return getGroup(ctx, input.entity, id);
}

export function updateCustomFieldGroup(
  ctx: CrmContext,
  input: { entity: CustomFieldEntity; id: string; data: UpdateCustomFieldGroupInput },
): CustomFieldGroup {
  const group = getGroup(ctx, input.entity, input.id);
  if (input.data.tab_id !== undefined) getTab(ctx, input.entity, input.data.tab_id);
  ctx.db.run(
    `UPDATE crm_custom_field_groups SET tab_id = ?, name = ?, position = ? WHERE id = ?`,
    input.data.tab_id ?? group.tab_id,
    input.data.name ?? group.name,
    input.data.position ?? group.position,
    group.id,
  );
  return getGroup(ctx, input.entity, input.id);
}

export function deleteCustomFieldGroup(
  ctx: CrmContext,
  input: { entity: CustomFieldEntity; id: string },
): { id: string; deleted: true } {
  getGroup(ctx, input.entity, input.id);
  const now = ctx.now();
  ctx.db.run(
    `UPDATE crm_custom_fields SET group_id = NULL, updated_at = ? WHERE group_id = ?`,
    now,
    input.id,
  );
  ctx.db.run(`UPDATE crm_custom_field_groups SET deleted_at = ? WHERE id = ?`, now, input.id);
  return { id: input.id, deleted: true };
}

export function customFieldLayout(
  ctx: CrmContext,
  input: { entity: CustomFieldEntity },
): CustomFieldLayout {
  const fields = loadFieldDefs(ctx, input.entity).map(toApi);
  const tabs = ctx.db.all<TabRow>(
    `SELECT id, entity, name, position FROM crm_custom_field_tabs
     WHERE entity = ? AND deleted_at IS NULL ORDER BY position, name`,
    input.entity,
  );
  const groups = ctx.db.all<GroupRow>(
    `SELECT g.id, g.tab_id, g.name, g.position FROM crm_custom_field_groups g
     JOIN crm_custom_field_tabs t ON t.id = g.tab_id
     WHERE t.entity = ? AND g.deleted_at IS NULL ORDER BY g.position, g.name`,
    input.entity,
  );
  const groupIds = new Set(groups.map((g) => g.id));
  return {
    tabs: tabs.map((tab) => ({
      ...tab,
      groups: groups
        .filter((g) => g.tab_id === tab.id)
        .map((g) => ({ ...g, fields: fields.filter((f) => f.group_id === g.id) })),
    })),
    ungrouped: fields.filter((f) => f.group_id === null || !groupIds.has(f.group_id)),
  };
}

// ------------------------------------------------------------------ values

export interface PreparedValues {
  entity: CustomFieldEntity;
  set: Array<{ def: FieldDef; value: StoredValue }>;
  clear: FieldDef[];
}

/**
 * Validates a `custom_fields` map against the definitions without writing.
 * Services call this before any write so a bad value aborts the whole mutation.
 */
export function prepareValues(
  ctx: CrmContext,
  entity: CustomFieldEntity,
  values: CustomFieldValues | undefined,
  options: NormalizeOptions & { requireAll?: boolean; defs?: FieldDef[] } = {},
): PreparedValues {
  const defs = options.defs ?? loadFieldDefs(ctx, entity);
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const prepared: PreparedValues = { entity, set: [], clear: [] };
  const errors: ErrorDetail[] = [];
  for (const [key, raw] of Object.entries(values ?? {})) {
    const def = byKey.get(key);
    if (def === undefined) {
      errors.push({ path: `custom_fields.${key}`, message: `unknown custom field "${key}"` });
      continue;
    }
    const result = normalizeCustomFieldValue(def, raw, options);
    if (!result.ok) {
      errors.push({ path: `custom_fields.${key}`, message: `${key}: ${result.error}` });
    } else if (result.value === null) {
      prepared.clear.push(def);
    } else {
      prepared.set.push({ def, value: result.value });
    }
  }
  if (options.requireAll === true) {
    for (const def of defs) {
      if (def.required && !prepared.set.some((s) => s.def.id === def.id)) {
        errors.push({ path: `custom_fields.${def.key}`, message: `${def.key} is required` });
      }
    }
  }
  if (errors.length > 0) throw invalidMany(errors);
  return prepared;
}

/** Writes prepared values; returns the keys that actually changed. */
export function writeValues(ctx: CrmContext, entityId: string, prepared: PreparedValues): string[] {
  const changed: string[] = [];
  const now = ctx.now();
  for (const { def, value } of prepared.set) {
    const before = ctx.db.all<{
      value_text: string | null;
      value_number: number | null;
      value_json: string | null;
    }>(
      `SELECT value_text, value_number, value_json FROM crm_custom_field_values
       WHERE entity = ? AND entity_id = ? AND field_id = ?`,
      prepared.entity,
      entityId,
      def.id,
    )[0];
    if (
      before !== undefined &&
      before.value_text === value.text &&
      before.value_number === value.number &&
      before.value_json === value.json
    ) {
      continue;
    }
    ctx.db.run(
      `INSERT INTO crm_custom_field_values (entity, entity_id, field_id, value_text, value_number, value_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (entity, entity_id, field_id) DO UPDATE SET
         value_text = excluded.value_text, value_number = excluded.value_number,
         value_json = excluded.value_json, updated_at = excluded.updated_at`,
      prepared.entity,
      entityId,
      def.id,
      value.text,
      value.number,
      value.json,
      now,
    );
    changed.push(def.key);
  }
  for (const def of prepared.clear) {
    const existing = ctx.db.all(
      `SELECT 1 FROM crm_custom_field_values WHERE entity = ? AND entity_id = ? AND field_id = ?`,
      prepared.entity,
      entityId,
      def.id,
    );
    if (existing.length === 0) continue;
    ctx.db.run(
      `DELETE FROM crm_custom_field_values WHERE entity = ? AND entity_id = ? AND field_id = ?`,
      prepared.entity,
      entityId,
      def.id,
    );
    changed.push(def.key);
  }
  return changed;
}

/** Loads `custom_fields` maps for many records, masking sensitive values when needed. */
export function readValues(
  ctx: CrmContext,
  entity: CustomFieldEntity,
  ids: string[],
): Map<string, CustomFieldValues> {
  const result = new Map<string, CustomFieldValues>(ids.map((id) => [id, {}]));
  if (ids.length === 0) return result;
  const defs = new Map(loadFieldDefs(ctx, entity).map((d) => [d.id, d]));
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = ctx.db.all<{
      entity_id: string;
      field_id: string;
      value_text: string | null;
      value_number: number | null;
      value_json: string | null;
    }>(
      `SELECT entity_id, field_id, value_text, value_number, value_json FROM crm_custom_field_values
       WHERE entity = ? AND entity_id IN (${placeholders(chunk.length)})`,
      entity,
      ...chunk,
    );
    for (const row of rows) {
      const def = defs.get(row.field_id);
      const target = result.get(row.entity_id);
      if (def === undefined || target === undefined) continue;
      const value = storedToApi(def.type, row);
      target[def.key] = def.sensitive && !ctx.actor.canReadSensitive ? maskValue(value) : value;
    }
  }
  return result;
}

/** Plain-text values of non-sensitive text-like fields, for the search document. */
export function searchableValues(ctx: CrmContext, entity: CustomFieldEntity, id: string): string[] {
  return ctx.db
    .all<{ value_text: string | null }>(
      `SELECT v.value_text FROM crm_custom_field_values v
       JOIN crm_custom_fields f ON f.id = v.field_id
       WHERE v.entity = ? AND v.entity_id = ? AND f.sensitive = 0 AND v.value_text IS NOT NULL
         AND f.type IN ('TEXT', 'TEXT_AREA', 'NAME', 'EMAIL', 'PHONE_NUMBER', 'WEBSITE', 'DROPDOWN', 'RADIO', 'LIST_BOX', 'DRILLDOWN', 'STATE')`,
      entity,
      id,
    )
    .map((row) => row.value_text ?? '');
}

export function deleteValuesOf(ctx: CrmContext, entity: CustomFieldEntity, id: string): void {
  ctx.db.run(`DELETE FROM crm_custom_field_values WHERE entity = ? AND entity_id = ?`, entity, id);
}
