import type {
  FieldCondition,
  FieldOperator,
  FilterGroup,
  FilterLeaf,
  SearchEntity,
  SearchQuery,
  SearchResult,
  TagCondition,
} from '@amable/api-types';
import type { CrmContext } from '../context';
import { placeholders, type SqlValue } from '../db/sql';
import { CrmError, invalid } from '../errors';
import { loadFieldDefs } from '../custom-fields/repo';
import { kindOfType, maskValue } from '../custom-fields/validate';
import {
  MARKETABLE_STATUSES,
  ORDER_SOURCES,
  ORDER_STATUSES,
  SOURCE_TYPES,
} from '@amable/api-types';
import { decodeCursor, encodeCursor, parseJson } from '../util';
import { matchingIdsSql } from './index-store';

/**
 * Compiles the query-builder JSON into one parameterized SQL statement.
 * The main row is aliased `r`; every expression is a fragment carrying its own
 * bound parameters, so nothing user-provided is ever interpolated into SQL.
 */

interface Fragment {
  text: string;
  params: SqlValue[];
}

const frag = (text: string, ...params: SqlValue[]): Fragment => ({ text, params });

function join(parts: Fragment[], separator: string): Fragment {
  return {
    text: parts.map((p) => p.text).join(separator),
    params: parts.flatMap((p) => p.params),
  };
}

/**
 * Builds `template`, replacing each `$E` with the expression fragment and
 * binding each `?` to the next of `params`, keeping bind order positional.
 */
function withExpr(template: string, expr: Fragment, ...params: SqlValue[]): Fragment {
  const out: Fragment = { text: '', params: [] };
  let next = 0;
  for (const token of template.split(/(\$E|\?)/)) {
    if (token === '$E') {
      out.text += `(${expr.text})`;
      out.params.push(...expr.params);
    } else if (token === '?') {
      if (next >= params.length) throw new CrmError('internal_error', 'missing bind parameter');
      out.text += '?';
      out.params.push(params[next] ?? null);
      next += 1;
    } else {
      out.text += token;
    }
  }
  if (next !== params.length) throw new CrmError('internal_error', 'unused bind parameter');
  return out;
}

type Kind =
  'text' | 'number' | 'date' | 'datetime_ms' | 'datetime_iso' | 'boolean' | 'enum' | 'id' | 'multi';

interface FieldSpec {
  expr: Fragment;
  kind: Kind;
  filterable: boolean;
  sortable: boolean;
  selectable: boolean;
  enumValues?: readonly string[];
  /** For selectable non-scalar columns. */
  decode?: (value: SqlValue) => unknown;
  sensitive?: boolean;
  /** Condition evaluated as EXISTS over a child table (any_email, any_phone). */
  exists?: { table: string; fk: string; column: string; transform?: (v: string) => string };
}

const OPERATORS_BY_KIND: Record<Kind, readonly FieldOperator[]> = {
  text: [
    'equals',
    'not_equals',
    'contains',
    'not_contains',
    'starts_with',
    'ends_with',
    'is_empty',
    'is_not_empty',
    'in',
    'not_in',
  ],
  enum: ['equals', 'not_equals', 'in', 'not_in', 'is_empty', 'is_not_empty'],
  id: ['equals', 'not_equals', 'in', 'not_in', 'is_empty', 'is_not_empty'],
  number: [
    'equals',
    'not_equals',
    'gt',
    'gte',
    'lt',
    'lte',
    'between',
    'in',
    'not_in',
    'is_empty',
    'is_not_empty',
  ],
  date: ['equals', 'not_equals', 'gt', 'gte', 'lt', 'lte', 'between', 'is_empty', 'is_not_empty'],
  datetime_ms: ['equals', 'gt', 'gte', 'lt', 'lte', 'between', 'is_empty', 'is_not_empty'],
  datetime_iso: ['equals', 'gt', 'gte', 'lt', 'lte', 'between', 'is_empty', 'is_not_empty'],
  boolean: ['equals', 'not_equals', 'is_empty', 'is_not_empty'],
  multi: ['contains', 'not_contains', 'in', 'not_in', 'is_empty', 'is_not_empty'],
};

export function operatorsForKind(kind: Kind): readonly FieldOperator[] {
  return OPERATORS_BY_KIND[kind];
}

// ---------------------------------------------------------------- registry

function col(
  column: string,
  kind: Kind,
  extra: Partial<Omit<FieldSpec, 'expr' | 'kind'>> = {},
): FieldSpec {
  return {
    expr: frag(`r.${column}`),
    kind,
    filterable: true,
    sortable: kind !== 'multi',
    selectable: true,
    ...extra,
  };
}

function sub(
  sql: string,
  kind: Kind,
  extra: Partial<Omit<FieldSpec, 'expr' | 'kind'>> = {},
): FieldSpec {
  return {
    expr: frag(sql),
    kind,
    filterable: true,
    sortable: kind !== 'multi',
    selectable: true,
    ...extra,
  };
}

const firstAddress = (column: string): string =>
  `SELECT a.${column} FROM crm_contact_addresses a WHERE a.contact_id = r.id ORDER BY a.position LIMIT 1`;

const CONTACT_FIELDS: Record<string, FieldSpec> = {
  id: col('id', 'id'),
  given_name: col('given_name', 'text'),
  middle_name: col('middle_name', 'text'),
  family_name: col('family_name', 'text'),
  preferred_name: col('preferred_name', 'text'),
  prefix: col('prefix', 'text'),
  suffix: col('suffix', 'text'),
  name: sub(`TRIM(IFNULL(r.given_name, '') || ' ' || IFNULL(r.family_name, ''))`, 'text'),
  job_title: col('job_title', 'text'),
  website: col('website', 'text'),
  spouse_name: col('spouse_name', 'text'),
  time_zone: col('time_zone', 'text'),
  preferred_locale: col('preferred_locale', 'enum'),
  email: col('primary_email', 'text'),
  phone: col('primary_phone', 'text'),
  any_email: {
    ...col('id', 'text'),
    sortable: false,
    selectable: false,
    exists: {
      table: 'crm_contact_emails',
      fk: 'contact_id',
      column: 'email_normalized',
      transform: (v) => v.trim().toLowerCase(),
    },
  },
  any_phone: {
    ...col('id', 'text'),
    sortable: false,
    selectable: false,
    exists: {
      table: 'crm_contact_phones',
      fk: 'contact_id',
      column: 'number_digits',
      transform: (v) => v.replace(/\D/g, ''),
    },
  },
  company_id: col('company_id', 'id'),
  company_name: sub(`SELECT co.name FROM crm_companies co WHERE co.id = r.company_id`, 'text'),
  owner_id: col('owner_id', 'id'),
  lead_source_id: col('lead_source_id', 'id'),
  source_type: col('source_type', 'enum', { enumValues: SOURCE_TYPES }),
  marketable_status: col('marketable_status', 'enum', { enumValues: MARKETABLE_STATUSES }),
  utm_source: col('utm_source', 'text'),
  utm_medium: col('utm_medium', 'text'),
  utm_campaign: col('utm_campaign', 'text'),
  utm_term: col('utm_term', 'text'),
  utm_content: col('utm_content', 'text'),
  score_value: col('score_value', 'number'),
  birthday: col('birthday', 'date'),
  anniversary: col('anniversary', 'date'),
  locality: sub(firstAddress('locality'), 'text'),
  region: sub(firstAddress('region'), 'text'),
  postal_code: sub(firstAddress('postal_code'), 'text'),
  country_code: sub(firstAddress('country_code'), 'enum'),
  created_at: col('created_at', 'datetime_ms'),
  updated_at: col('updated_at', 'datetime_ms'),
  tags: {
    expr: frag(
      `SELECT group_concat(ct.tag_id) FROM crm_contact_tags ct
       JOIN crm_tags t ON t.id = ct.tag_id AND t.deleted_at IS NULL WHERE ct.contact_id = r.id`,
    ),
    kind: 'multi',
    filterable: false,
    sortable: false,
    selectable: true,
    decode: (v) => (typeof v === 'string' && v !== '' ? v.split(',') : []),
  },
  emails: {
    expr: frag(
      `SELECT json_group_array(e.email) FROM
         (SELECT email FROM crm_contact_emails WHERE contact_id = r.id ORDER BY position) e`,
    ),
    kind: 'multi',
    filterable: false,
    sortable: false,
    selectable: true,
    decode: (v) => parseJson<string[]>(typeof v === 'string' ? v : null, []),
  },
};

const COMPANY_FIELDS: Record<string, FieldSpec> = {
  id: col('id', 'id'),
  name: col('name', 'text'),
  website: col('website', 'text'),
  email: col('email', 'text'),
  phone: col('phone', 'text'),
  description: col('description', 'text'),
  owner_id: col('owner_id', 'id'),
  locality: col('address_locality', 'text'),
  region: col('address_region', 'text'),
  postal_code: col('address_postal_code', 'text'),
  country_code: col('address_country_code', 'enum'),
  contact_count: sub(
    `SELECT COUNT(*) FROM crm_contacts c2 WHERE c2.company_id = r.id AND c2.deleted_at IS NULL`,
    'number',
  ),
  created_at: col('created_at', 'datetime_ms'),
  updated_at: col('updated_at', 'datetime_ms'),
};

const ORDER_FIELDS: Record<string, FieldSpec> = {
  id: col('id', 'id'),
  number: col('number', 'text'),
  status: col('status', 'enum', { enumValues: ORDER_STATUSES }),
  source: col('source', 'enum', { enumValues: ORDER_SOURCES }),
  contact_id: col('contact_id', 'id'),
  contact_name: sub(
    `SELECT TRIM(IFNULL(c.given_name, '') || ' ' || IFNULL(c.family_name, '')) FROM crm_contacts c WHERE c.id = r.contact_id`,
    'text',
  ),
  contact_email: sub(
    `SELECT c.primary_email FROM crm_contacts c WHERE c.id = r.contact_id`,
    'text',
  ),
  company_id: col('company_id', 'id'),
  owner_id: col('owner_id', 'id'),
  currency: col('currency', 'enum'),
  subtotal_minor: col('subtotal_minor', 'number'),
  discount_minor: col('discount_minor', 'number'),
  tax_minor: col('tax_minor', 'number'),
  shipping_minor: col('shipping_minor', 'number'),
  total_minor: col('total_minor', 'number'),
  paid_minor: col('paid_minor', 'number'),
  refunded_minor: col('refunded_minor', 'number'),
  promo_code: col('promo_code', 'text'),
  subscription_id: col('subscription_id', 'id'),
  analytics_visitor_id: col('analytics_visitor_id', 'text'),
  /** Orders containing a product (EXISTS over the order lines). */
  product_id: {
    ...col('id', 'id'),
    sortable: false,
    selectable: false,
    exists: { table: 'crm_order_items', fk: 'order_id', column: 'product_id' },
  },
  item_count: sub(`SELECT COUNT(*) FROM crm_order_items i WHERE i.order_id = r.id`, 'number'),
  order_date: col('order_date', 'datetime_ms'),
  due_at: col('due_at', 'datetime_ms'),
  paid_at: col('paid_at', 'datetime_ms'),
  cancelled_at: col('cancelled_at', 'datetime_ms'),
  created_at: col('created_at', 'datetime_ms'),
  updated_at: col('updated_at', 'datetime_ms'),
};

const ENTITY_CONFIG: Record<
  SearchEntity,
  { table: string; fields: Record<string, FieldSpec>; defaultColumns: string[] }
> = {
  contact: {
    table: 'crm_contacts',
    fields: CONTACT_FIELDS,
    defaultColumns: [
      'id',
      'given_name',
      'family_name',
      'email',
      'phone',
      'company_id',
      'owner_id',
      'tags',
      'created_at',
      'updated_at',
    ],
  },
  company: {
    table: 'crm_companies',
    fields: COMPANY_FIELDS,
    defaultColumns: [
      'id',
      'name',
      'website',
      'email',
      'phone',
      'owner_id',
      'contact_count',
      'created_at',
    ],
  },
  order: {
    table: 'crm_orders',
    fields: ORDER_FIELDS,
    defaultColumns: [
      'id',
      'number',
      'status',
      'contact_id',
      'contact_name',
      'currency',
      'total_minor',
      'paid_minor',
      'order_date',
    ],
  },
};

/** Field registry including the entity's custom fields (`custom.<key>`). */
function resolveFields(ctx: CrmContext, entity: SearchEntity): Map<string, FieldSpec> {
  const fields = new Map(Object.entries(ENTITY_CONFIG[entity].fields));
  for (const def of loadFieldDefs(ctx, entity)) {
    const kind = kindOfType(def.type);
    const column =
      kind === 'multi'
        ? 'value_json'
        : kind === 'number' || kind === 'boolean'
          ? 'value_number'
          : 'value_text';
    fields.set(`custom.${def.key}`, {
      expr: frag(
        `SELECT v.${column} FROM crm_custom_field_values v
         WHERE v.entity = ? AND v.entity_id = r.id AND v.field_id = ?`,
        entity,
        def.id,
      ),
      kind,
      filterable: true,
      sortable: kind !== 'multi',
      selectable: true,
      sensitive: def.sensitive,
      ...(kind === 'enum' && (def.type === 'DROPDOWN' || def.type === 'RADIO')
        ? { enumValues: def.options.map((o) => o.value) }
        : {}),
      ...(kind === 'multi'
        ? { decode: (v: SqlValue) => parseJson<string[]>(typeof v === 'string' ? v : null, []) }
        : {}),
    });
  }
  return fields;
}

/** Field names and kinds available for an entity (drives the UI filter builder). */
export function describeFields(
  ctx: CrmContext,
  input: { entity: SearchEntity },
): Array<{
  field: string;
  kind: Kind;
  operators: FieldOperator[];
  sortable: boolean;
  selectable: boolean;
}> {
  return [...resolveFields(ctx, input.entity).entries()].map(([field, spec]) => ({
    field,
    kind: spec.kind,
    operators: spec.filterable ? [...OPERATORS_BY_KIND[spec.kind]] : [],
    sortable: spec.sortable,
    selectable: spec.selectable,
  }));
}

// ------------------------------------------------------------ value coercion

const DAY_MS = 86_400_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function coerceScalar(
  spec: FieldSpec,
  value: unknown,
  path: string,
  bound: 'start' | 'end' = 'start',
): SqlValue {
  const bad = (expected: string): CrmError => invalid(path, `expected ${expected}`);
  switch (spec.kind) {
    case 'text':
    case 'id':
      if (typeof value === 'string') return value;
      if (typeof value === 'number') return String(value);
      throw bad('a string');
    case 'enum':
      if (typeof value !== 'string') throw bad('a string');
      if (spec.enumValues !== undefined && !spec.enumValues.includes(value)) {
        throw invalid(path, `"${value}" is not one of ${spec.enumValues.join(', ')}`);
      }
      return value;
    case 'multi':
      if (typeof value !== 'string') throw bad('a string');
      return value;
    case 'number': {
      const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
      if (!Number.isFinite(n)) throw bad('a number');
      return n;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value ? 1 : 0;
      throw bad('a boolean');
    case 'date':
      if (typeof value === 'string' && DATE_ONLY.test(value)) return value;
      throw bad('a date YYYY-MM-DD');
    case 'datetime_ms':
    case 'datetime_iso': {
      let ms: number;
      if (typeof value === 'number' && Number.isFinite(value)) {
        ms = value;
      } else if (typeof value === 'string' && DATE_ONLY.test(value)) {
        ms = Date.parse(`${value}T00:00:00.000Z`) + (bound === 'end' ? DAY_MS - 1 : 0);
      } else if (typeof value === 'string') {
        ms = Date.parse(value);
      } else {
        ms = NaN;
      }
      if (Number.isNaN(ms)) throw bad('an ISO 8601 date or date-time');
      return spec.kind === 'datetime_ms' ? ms : new Date(ms).toISOString();
    }
  }
}

function isDateOnly(value: unknown): boolean {
  return typeof value === 'string' && DATE_ONLY.test(value);
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// ------------------------------------------------------------ conditions

function compileField(spec: FieldSpec, cond: FieldCondition, path: string): Fragment {
  const op = cond.operator;
  if (!spec.filterable) throw invalid(`${path}.field`, `${cond.field} cannot be filtered`);
  if (!OPERATORS_BY_KIND[spec.kind].includes(op)) {
    throw invalid(
      `${path}.operator`,
      `operator ${op} is not valid for ${cond.field} (${spec.kind}); use ${OPERATORS_BY_KIND[spec.kind].join(', ')}`,
    );
  }
  const valuePath = `${path}.value`;
  const value = cond.value;
  const list = (): SqlValue[] => {
    if (!Array.isArray(value) || value.length === 0)
      throw invalid(valuePath, 'expected a non-empty array');
    return value.map((v, i) => coerceScalar(spec, v, `${valuePath}[${i}]`));
  };
  const single = (bound: 'start' | 'end' = 'start'): SqlValue => {
    if (value === undefined || value === null || Array.isArray(value)) {
      throw invalid(valuePath, 'expected a single value');
    }
    return coerceScalar(spec, value, valuePath, bound);
  };

  if (spec.exists !== undefined) return compileExists(spec, cond, valuePath);

  const E = spec.expr;
  const textual = spec.kind === 'text' || spec.kind === 'enum' || spec.kind === 'id';
  const nocase = spec.kind === 'text' ? ' COLLATE NOCASE' : '';

  switch (op) {
    case 'is_empty':
      if (spec.kind === 'multi') return withExpr(`($E IS NULL OR json_array_length($E) = 0)`, E);
      return textual || spec.kind === 'date' || spec.kind === 'datetime_iso'
        ? withExpr(`($E IS NULL OR $E = '')`, E)
        : withExpr(`$E IS NULL`, E);
    case 'is_not_empty':
      if (spec.kind === 'multi') return withExpr(`json_array_length($E) > 0`, E);
      return textual || spec.kind === 'date' || spec.kind === 'datetime_iso'
        ? withExpr(`($E IS NOT NULL AND $E <> '')`, E)
        : withExpr(`$E IS NOT NULL`, E);
    case 'contains':
      if (spec.kind === 'multi') {
        return withExpr(`EXISTS (SELECT 1 FROM json_each($E) WHERE value = ?)`, E, single());
      }
      return withExpr(`$E LIKE ? ESCAPE '\\'`, E, `%${escapeLike(String(single()))}%`);
    case 'not_contains':
      if (spec.kind === 'multi') {
        return withExpr(`NOT EXISTS (SELECT 1 FROM json_each($E) WHERE value = ?)`, E, single());
      }
      return withExpr(
        `($E IS NULL OR $E NOT LIKE ? ESCAPE '\\')`,
        E,
        `%${escapeLike(String(single()))}%`,
      );
    case 'starts_with':
      return withExpr(`$E LIKE ? ESCAPE '\\'`, E, `${escapeLike(String(single()))}%`);
    case 'ends_with':
      return withExpr(`$E LIKE ? ESCAPE '\\'`, E, `%${escapeLike(String(single()))}`);
    case 'in': {
      const values = list();
      if (spec.kind === 'multi') {
        return withExpr(
          `EXISTS (SELECT 1 FROM json_each($E) WHERE value IN (${placeholders(values.length)}))`,
          E,
          ...values,
        );
      }
      return withExpr(`$E${nocase} IN (${placeholders(values.length)})`, E, ...values);
    }
    case 'not_in': {
      const values = list();
      if (spec.kind === 'multi') {
        return withExpr(
          `NOT EXISTS (SELECT 1 FROM json_each($E) WHERE value IN (${placeholders(values.length)}))`,
          E,
          ...values,
        );
      }
      return withExpr(
        `($E IS NULL OR $E${nocase} NOT IN (${placeholders(values.length)}))`,
        E,
        ...values,
      );
    }
    case 'equals':
      if ((spec.kind === 'datetime_ms' || spec.kind === 'datetime_iso') && isDateOnly(value)) {
        return withExpr(`$E BETWEEN ? AND ?`, E, single('start'), single('end'));
      }
      return withExpr(`$E = ?${nocase}`, E, single());
    case 'not_equals':
      return withExpr(`($E IS NULL OR $E <> ?${nocase})`, E, single());
    case 'gt':
      return withExpr(`$E > ?`, E, single('end'));
    case 'gte':
      return withExpr(`$E >= ?`, E, single('start'));
    case 'lt':
      return withExpr(`$E < ?`, E, single('start'));
    case 'lte':
      return withExpr(`$E <= ?`, E, single('end'));
    case 'between': {
      if (!Array.isArray(value) || value.length !== 2) {
        throw invalid(valuePath, 'between expects [from, to]');
      }
      const from = coerceScalar(spec, value[0], `${valuePath}[0]`, 'start');
      const to = coerceScalar(spec, value[1], `${valuePath}[1]`, 'end');
      return withExpr(`$E BETWEEN ? AND ?`, E, from, to);
    }
  }
}

function compileExists(spec: FieldSpec, cond: FieldCondition, valuePath: string): Fragment {
  const exists = spec.exists;
  if (exists === undefined) throw new CrmError('internal_error', 'not an exists field');
  const base = `SELECT 1 FROM ${exists.table} x WHERE x.${exists.fk} = r.id`;
  const transform = exists.transform ?? ((v: string) => v);
  const one = (): string => {
    if (typeof cond.value !== 'string' && typeof cond.value !== 'number') {
      throw invalid(valuePath, 'expected a string');
    }
    return transform(String(cond.value));
  };
  switch (cond.operator) {
    case 'equals':
      return frag(`EXISTS (${base} AND x.${exists.column} = ?)`, one());
    case 'not_equals':
      return frag(`NOT EXISTS (${base} AND x.${exists.column} = ?)`, one());
    case 'contains':
      return frag(
        `EXISTS (${base} AND x.${exists.column} LIKE ? ESCAPE '\\')`,
        `%${escapeLike(one())}%`,
      );
    case 'not_contains':
      return frag(
        `NOT EXISTS (${base} AND x.${exists.column} LIKE ? ESCAPE '\\')`,
        `%${escapeLike(one())}%`,
      );
    case 'starts_with':
      return frag(
        `EXISTS (${base} AND x.${exists.column} LIKE ? ESCAPE '\\')`,
        `${escapeLike(one())}%`,
      );
    case 'ends_with':
      return frag(
        `EXISTS (${base} AND x.${exists.column} LIKE ? ESCAPE '\\')`,
        `%${escapeLike(one())}`,
      );
    case 'is_empty':
      return frag(`NOT EXISTS (${base})`);
    case 'is_not_empty':
      return frag(`EXISTS (${base})`);
    case 'in':
    case 'not_in': {
      if (!Array.isArray(cond.value) || cond.value.length === 0) {
        throw invalid(valuePath, 'expected a non-empty array');
      }
      const values = cond.value.map((v) => transform(String(v)));
      const clause = `EXISTS (${base} AND x.${exists.column} IN (${placeholders(values.length)}))`;
      return frag(cond.operator === 'in' ? clause : `NOT ${clause}`, ...values);
    }
    default:
      throw invalid(
        `${valuePath.replace(/\.value$/, '')}.operator`,
        `operator ${cond.operator} is not valid for ${cond.field}`,
      );
  }
}

function compileTags(entity: SearchEntity, cond: TagCondition, path: string): Fragment {
  if (entity !== 'contact') throw invalid(`${path}.type`, 'tag conditions only apply to contacts');
  const ids = [...new Set(cond.tag_ids)];
  const inList = placeholders(ids.length);
  switch (cond.match) {
    case 'any':
      return frag(
        `EXISTS (SELECT 1 FROM crm_contact_tags ct JOIN crm_tags t ON t.id = ct.tag_id AND t.deleted_at IS NULL WHERE ct.contact_id = r.id AND ct.tag_id IN (${inList}))`,
        ...ids,
      );
    case 'all':
      return frag(
        `(SELECT COUNT(*) FROM crm_contact_tags ct JOIN crm_tags t ON t.id = ct.tag_id AND t.deleted_at IS NULL WHERE ct.contact_id = r.id AND ct.tag_id IN (${inList})) = ?`,
        ...ids,
        ids.length,
      );
    case 'none':
      return frag(
        `NOT EXISTS (SELECT 1 FROM crm_contact_tags ct JOIN crm_tags t ON t.id = ct.tag_id AND t.deleted_at IS NULL WHERE ct.contact_id = r.id AND ct.tag_id IN (${inList}))`,
        ...ids,
      );
  }
}

interface CompileEnv {
  entity: SearchEntity;
  fields: Map<string, FieldSpec>;
  canReadSensitive: boolean;
}

/** Sensitive fields can be selected (masked) but not filtered or sorted without permission. */
function fieldSpec(env: CompileEnv, field: string, path: string, forSelect = false): FieldSpec {
  const spec = env.fields.get(field);
  if (spec === undefined) throw invalid(path, `unknown field "${field}" for ${env.entity}`);
  if (spec.sensitive === true && !env.canReadSensitive && !forSelect) {
    throw new CrmError('forbidden', `${field} is a sensitive field`);
  }
  return spec;
}

function compileNode(
  env: CompileEnv,
  node: FilterLeaf | FilterGroup,
  path: string,
): Fragment | null {
  if (node.type === 'field')
    return compileField(fieldSpec(env, node.field, `${path}.field`), node, path);
  if (node.type === 'tags') return compileTags(env.entity, node, path);
  return compileGroup(env, node, path);
}

function compileGroup(env: CompileEnv, group: FilterGroup, path: string): Fragment | null {
  const parts = group.conditions
    .map((c, i) => compileNode(env, c, `${path}.conditions[${i}]`))
    .filter((p): p is Fragment => p !== null);
  if (parts.length === 0) return null;
  const joined = join(parts, group.op === 'and' ? ' AND ' : ' OR ');
  return { text: `(${joined.text})`, params: joined.params };
}

// ------------------------------------------------------------- compilation

export interface CompiledQuery {
  sql: string;
  params: SqlValue[];
  countSql: string;
  countParams: SqlValue[];
  columns: string[];
  limit: number;
  decode: (row: Record<string, SqlValue>) => Record<string, unknown>;
  cursorOf: (row: Record<string, SqlValue>) => string;
}

export interface CompileOptions {
  includeDeleted?: boolean;
  /** Extra AND conditions (used by list endpoints and saved-search execution). */
  extra?: FilterLeaf[];
  defaultLimit?: number;
}

const SORT_NULL_NUMBER = -9_007_199_254_740_991;

export function compileSearchQuery(
  ctx: CrmContext,
  query: SearchQuery,
  options: CompileOptions = {},
): CompiledQuery {
  const entity = query.entity;
  const env: CompileEnv = {
    entity,
    fields: resolveFields(ctx, entity),
    canReadSensitive: ctx.actor.canReadSensitive,
  };
  const config = ENTITY_CONFIG[entity];

  // ---- columns
  const columns = ['id', ...(query.columns ?? config.defaultColumns).filter((c) => c !== 'id')];
  const uniqueColumns = [...new Set(columns)];
  const selects: Fragment[] = uniqueColumns.map((name, i) => {
    const spec = fieldSpec(env, name, `columns[${i}]`, true);
    if (!spec.selectable) throw invalid(`columns[${i}]`, `${name} cannot be selected`);
    return { text: `(${spec.expr.text}) AS "c${i}"`, params: spec.expr.params };
  });

  // ---- sort
  const sortField = query.sort?.field ?? 'created_at';
  const direction = query.sort?.direction ?? (query.sort === undefined ? 'desc' : 'asc');
  const sortSpec = fieldSpec(env, sortField, 'sort.field');
  if (!sortSpec.sortable) throw invalid('sort.field', `${sortField} cannot be used for sorting`);
  const numericSort =
    sortSpec.kind === 'number' || sortSpec.kind === 'datetime_ms' || sortSpec.kind === 'boolean';
  const sortExpr: Fragment = numericSort
    ? withExpr(`IFNULL($E, ${SORT_NULL_NUMBER})`, sortSpec.expr)
    : withExpr(`LOWER(IFNULL($E, ''))`, sortSpec.expr);

  // ---- where
  const where: Fragment[] = [];
  if (options.includeDeleted !== true) where.push(frag('r.deleted_at IS NULL'));
  if (query.q !== undefined && query.q.trim() !== '') {
    const match = matchingIdsSql(ctx.searchMode, entity, query.q);
    if (match !== null) where.push({ text: `r.id IN (${match.sql})`, params: match.params });
  }
  if (query.filter !== undefined) {
    const compiled = compileGroup(env, query.filter, 'filter');
    if (compiled !== null) where.push(compiled);
  }
  (options.extra ?? []).forEach((leaf, i) => {
    const compiled = compileNode(env, leaf, `extra[${i}]`);
    if (compiled !== null) where.push(compiled);
  });
  const whereAll = where.length > 0 ? join(where, ' AND ') : frag('1 = 1');

  // ---- keyset
  const keyset: Fragment[] = [];
  if (query.cursor !== undefined) {
    const cursor = decodeCursor(query.cursor);
    const cmp = direction === 'asc' ? '>' : '<';
    const v = cursor.v ?? (numericSort ? SORT_NULL_NUMBER : '');
    keyset.push(withExpr(`($E ${cmp} ? OR ($E = ? AND r.id ${cmp} ?))`, sortExpr, v, v, cursor.id));
  }

  const limit = query.limit ?? options.defaultLimit ?? 50;
  const selectList = join(
    [...selects, { text: `(${sortExpr.text}) AS "__sort"`, params: sortExpr.params }],
    ', ',
  );
  const fullWhere = join([whereAll, ...keyset], ' AND ');
  const dir = direction === 'asc' ? 'ASC' : 'DESC';

  const sql = `SELECT ${selectList.text} FROM ${config.table} r WHERE ${fullWhere.text}
               ORDER BY "__sort" ${dir}, r.id ${dir} LIMIT ?`;
  const params = [...selectList.params, ...fullWhere.params, limit + 1];

  const masked = new Set(
    uniqueColumns.filter(
      (name) => env.fields.get(name)?.sensitive === true && !env.canReadSensitive,
    ),
  );
  const decode = (row: Record<string, SqlValue>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    uniqueColumns.forEach((name, i) => {
      const spec = env.fields.get(name);
      const raw = row[`c${i}`] ?? null;
      let value: unknown = raw;
      if (spec?.decode !== undefined) value = spec.decode(raw);
      else if (spec?.kind === 'datetime_ms')
        value = raw === null ? null : new Date(Number(raw)).toISOString();
      else if (spec?.kind === 'boolean') value = raw === null ? null : raw === 1;
      if (masked.has(name)) value = maskValue(value as string | number | null);
      out[name] = value;
    });
    return out;
  };

  return {
    sql,
    params,
    countSql: `SELECT COUNT(*) AS n FROM ${config.table} r WHERE ${whereAll.text}`,
    countParams: whereAll.params,
    columns: uniqueColumns,
    limit,
    decode,
    cursorOf: (row) => {
      const v = row['__sort'] ?? null;
      const id = row['c0'];
      return encodeCursor({ v, id: typeof id === 'string' ? id : String(id) });
    },
  };
}

export function executeSearch(
  ctx: CrmContext,
  query: SearchQuery,
  options: CompileOptions = {},
): SearchResult {
  const compiled = compileSearchQuery(ctx, query, options);
  const rows = ctx.db.all<Record<string, SqlValue>>(compiled.sql, ...compiled.params);
  const page = rows.slice(0, compiled.limit);
  const last = page[page.length - 1];
  const total =
    query.include_total === true
      ? (ctx.db.all<{ n: number }>(compiled.countSql, ...compiled.countParams)[0]?.n ?? 0)
      : null;
  return {
    entity: query.entity,
    columns: compiled.columns,
    data: page.map(compiled.decode),
    next_cursor:
      rows.length > compiled.limit && last !== undefined ? compiled.cursorOf(last) : null,
    total,
  };
}

/** Iterates every matching id (segments for broadcasts/automations). */
export function matchingIds(ctx: CrmContext, query: SearchQuery, max = 100_000): string[] {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = executeSearch(ctx, {
      ...query,
      columns: ['id'],
      limit: 500,
      cursor,
      include_total: false,
    });
    for (const row of page.data) if (typeof row['id'] === 'string') ids.push(row['id']);
    cursor = page.next_cursor ?? undefined;
  } while (cursor !== undefined && ids.length < max);
  return ids;
}
