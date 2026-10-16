import type { ConditionValue, FieldOperator, FilterGroup, FilterLeaf } from '@amable/api-types/crm';

/**
 * Editable model of the advanced-search filter tree and its serialization to
 * the query-builder JSON of `POST /search` (and saved searches).
 *
 * The UI keeps raw input strings (what the user typed); `toFilterGroup` turns
 * them into typed values per field kind and drops incomplete conditions, so a
 * half-filled builder never produces an invalid request.
 */

export type FieldKind =
  'text' | 'number' | 'date' | 'datetime_ms' | 'datetime_iso' | 'boolean' | 'enum' | 'id' | 'multi';

/** Groups nest up to three levels (root = 1), like the server schema. */
export const MAX_GROUP_DEPTH = 3;

export interface UiFieldCondition {
  readonly id: string;
  readonly type: 'field';
  readonly field: string;
  readonly operator: FieldOperator;
  /** Scalar input (text, number, date, boolean as 'true'/'false'). */
  readonly value: string;
  /** Second bound for `between`. */
  readonly valueTo: string;
  /** Values for `in` / `not_in` (and multi `contains` pickers). */
  readonly values: readonly string[];
}

export interface UiTagCondition {
  readonly id: string;
  readonly type: 'tags';
  readonly match: 'any' | 'all' | 'none';
  readonly tagIds: readonly string[];
}

export interface UiGroup {
  readonly id: string;
  readonly type: 'group';
  readonly op: 'and' | 'or';
  readonly conditions: readonly UiNode[];
}

export type UiNode = UiFieldCondition | UiTagCondition | UiGroup;

let counter = 0;
export function nodeId(): string {
  counter += 1;
  return `n${String(counter)}`;
}

export function emptyGroup(op: 'and' | 'or' = 'and'): UiGroup {
  return { id: nodeId(), type: 'group', op, conditions: [] };
}

export function fieldCondition(field = '', operator: FieldOperator = 'equals'): UiFieldCondition {
  return { id: nodeId(), type: 'field', field, operator, value: '', valueTo: '', values: [] };
}

export function tagCondition(match: UiTagCondition['match'] = 'any'): UiTagCondition {
  return { id: nodeId(), type: 'tags', match, tagIds: [] };
}

// ------------------------------------------------------------- operators

export const OPERATORS_BY_KIND: Readonly<Record<FieldKind, readonly FieldOperator[]>> = {
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

export type ValueShape = 'none' | 'single' | 'range' | 'list';

export function valueShape(operator: FieldOperator): ValueShape {
  switch (operator) {
    case 'is_empty':
    case 'is_not_empty':
      return 'none';
    case 'between':
      return 'range';
    case 'in':
    case 'not_in':
      return 'list';
    default:
      return 'single';
  }
}

/** Keeps the operator when still valid for the new field kind, else the kind's first one. */
export function operatorForKind(kind: FieldKind, current: FieldOperator): FieldOperator {
  const allowed = OPERATORS_BY_KIND[kind];
  return allowed.includes(current) ? current : (allowed[0] ?? 'equals');
}

// --------------------------------------------------------- serialization

export type FieldKinds = ReadonlyMap<string, FieldKind>;

function scalar(kind: FieldKind, raw: string): string | number | boolean | null {
  const text = raw.trim();
  if (text === '') return null;
  switch (kind) {
    case 'number': {
      const n = Number(text.replace(',', '.'));
      return Number.isFinite(n) ? n : null;
    }
    case 'boolean':
      if (text === 'true') return true;
      if (text === 'false') return false;
      return null;
    case 'date':
    case 'datetime_ms':
    case 'datetime_iso':
      return /^\d{4}-\d{2}-\d{2}/.test(text) ? text : null;
    default:
      return text;
  }
}

/** Typed value of a field condition, or `undefined` when the condition is incomplete. */
export function conditionValue(
  condition: UiFieldCondition,
  kind: FieldKind,
): ConditionValue | undefined | 'skip' {
  switch (valueShape(condition.operator)) {
    case 'none':
      return undefined;
    case 'range': {
      const from = scalar(kind, condition.value);
      const to = scalar(kind, condition.valueTo);
      if (from === null || to === null) return 'skip';
      return [from, to];
    }
    case 'list': {
      const raw =
        condition.values.length > 0
          ? condition.values
          : condition.value.split(',').filter((part) => part.trim() !== '');
      const items = raw
        .map((item) => scalar(kind === 'multi' ? 'text' : kind, item))
        .filter((item): item is string | number | boolean => item !== null);
      return items.length === 0 ? 'skip' : items;
    }
    case 'single': {
      const source =
        condition.values.length > 0 && condition.value.trim() === ''
          ? (condition.values[0] ?? '')
          : condition.value;
      const value = scalar(kind === 'multi' ? 'text' : kind, source);
      return value === null ? 'skip' : value;
    }
  }
}

function leafOf(node: UiFieldCondition | UiTagCondition, kinds: FieldKinds): FilterLeaf | null {
  if (node.type === 'tags') {
    if (node.tagIds.length === 0) return null;
    return { type: 'tags', match: node.match, tag_ids: [...node.tagIds] };
  }
  if (node.field === '') return null;
  const kind = kinds.get(node.field) ?? 'text';
  if (!OPERATORS_BY_KIND[kind].includes(node.operator)) return null;
  const value = conditionValue(node, kind);
  if (value === 'skip') return null;
  return value === undefined
    ? { type: 'field', field: node.field, operator: node.operator }
    : { type: 'field', field: node.field, operator: node.operator, value };
}

function groupOf(group: UiGroup, kinds: FieldKinds, depth: number): FilterGroup | null {
  const conditions: Array<FilterLeaf | FilterGroup> = [];
  for (const node of group.conditions) {
    if (node.type === 'group') {
      if (depth >= MAX_GROUP_DEPTH) continue;
      const nested = groupOf(node, kinds, depth + 1);
      if (nested !== null) conditions.push(nested);
    } else {
      const leaf = leafOf(node, kinds);
      if (leaf !== null) conditions.push(leaf);
    }
  }
  if (conditions.length === 0) return null;
  return { type: 'group', op: group.op, conditions };
}

/**
 * Query-builder JSON of the tree; `undefined` when nothing is complete enough
 * to filter on. Empty nested groups are dropped; groups deeper than
 * `MAX_GROUP_DEPTH` are ignored.
 */
export function toFilterGroup(root: UiGroup, kinds: FieldKinds): FilterGroup | undefined {
  return groupOf(root, kinds, 1) ?? undefined;
}

// ------------------------------------------------------- deserialization

function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function uiLeaf(leaf: FilterLeaf): UiFieldCondition | UiTagCondition {
  if (leaf.type === 'tags') {
    return { id: nodeId(), type: 'tags', match: leaf.match, tagIds: [...leaf.tag_ids] };
  }
  const base = fieldCondition(leaf.field, leaf.operator);
  const value = leaf.value;
  switch (valueShape(leaf.operator)) {
    case 'none':
      return base;
    case 'range': {
      const [from, to] = Array.isArray(value) ? value : [value, null];
      return { ...base, value: asText(from), valueTo: asText(to) };
    }
    case 'list':
      return { ...base, values: (Array.isArray(value) ? value : [value]).map(asText) };
    case 'single':
      return { ...base, value: asText(Array.isArray(value) ? value[0] : value) };
  }
}

function uiGroup(group: FilterGroup): UiGroup {
  return {
    id: nodeId(),
    type: 'group',
    op: group.op,
    conditions: group.conditions.map((node) =>
      node.type === 'group' ? uiGroup(node) : uiLeaf(node),
    ),
  };
}

/** Editable tree from a stored query (saved search). */
export function fromFilterGroup(filter: FilterGroup | undefined | null): UiGroup {
  return filter === undefined || filter === null ? emptyGroup() : uiGroup(filter);
}

// ------------------------------------------------------------ tree edits

export function updateNode(root: UiGroup, id: string, update: (node: UiNode) => UiNode): UiGroup {
  const visit = (group: UiGroup): UiGroup => ({
    ...group,
    conditions: group.conditions.map((node) => {
      if (node.id === id) return update(node);
      return node.type === 'group' ? visit(node) : node;
    }),
  });
  return root.id === id ? (update(root) as UiGroup) : visit(root);
}

export function removeNode(root: UiGroup, id: string): UiGroup {
  const visit = (group: UiGroup): UiGroup => ({
    ...group,
    conditions: group.conditions
      .filter((node) => node.id !== id)
      .map((node) => (node.type === 'group' ? visit(node) : node)),
  });
  return visit(root);
}

export function appendNode(root: UiGroup, groupId: string, node: UiNode): UiGroup {
  return updateNode(root, groupId, (group) =>
    group.type === 'group' ? { ...group, conditions: [...group.conditions, node] } : group,
  );
}

/** Number of complete leaf conditions (for the "Filters (3)" badge). */
export function countConditions(filter: FilterGroup | undefined): number {
  if (filter === undefined) return 0;
  return filter.conditions.reduce(
    (total, node) => total + (node.type === 'group' ? countConditions(node) : 1),
    0,
  );
}
