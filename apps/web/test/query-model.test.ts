import { searchQuerySchema, type FilterGroup } from '@amable/api-types/crm';
import { describe, expect, it } from 'vitest';
import {
  appendNode,
  countConditions,
  emptyGroup,
  fieldCondition,
  fromFilterGroup,
  MAX_GROUP_DEPTH,
  operatorForKind,
  removeNode,
  tagCondition,
  toFilterGroup,
  updateNode,
  type FieldKind,
  type UiGroup,
  type UiNode,
} from '../src/features/search/query-model';

const kinds = new Map<string, FieldKind>([
  ['given_name', 'text'],
  ['score_value', 'number'],
  ['created_at', 'datetime_ms'],
  ['birthday', 'date'],
  ['marketable_status', 'enum'],
  ['owner_id', 'id'],
  ['custom.plan', 'enum'],
  ['custom.interests', 'multi'],
  ['custom.vip', 'boolean'],
  ['custom.lifetime_value', 'number'],
]);

function group(op: 'and' | 'or', conditions: UiNode[]): UiGroup {
  return { ...emptyGroup(op), conditions };
}

function field(
  name: string,
  operator: Parameters<typeof fieldCondition>[1],
  patch: Partial<UiNode> = {},
) {
  return { ...fieldCondition(name, operator), ...patch } as UiNode;
}

/** The serialized filter is a valid `POST /search` body for the server schema. */
function expectValidQuery(filter: FilterGroup | undefined) {
  const parsed = searchQuerySchema.safeParse({ entity: 'contact', ...(filter ? { filter } : {}) });
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
}

describe('query builder serialization', () => {
  it('returns undefined for an empty or incomplete tree', () => {
    expect(toFilterGroup(emptyGroup(), kinds)).toBeUndefined();
    const incomplete = group('and', [
      fieldCondition(), // no field
      field('given_name', 'equals'), // no value
      tagCondition('any'), // no tags
      group('or', []), // empty nested group
    ]);
    expect(toFilterGroup(incomplete, kinds)).toBeUndefined();
  });

  it('types values per field kind', () => {
    const root = group('and', [
      field('given_name', 'contains', { value: '  ross ' } as Partial<UiNode>),
      field('score_value', 'gte', { value: '50,5' } as Partial<UiNode>),
      field('custom.vip', 'equals', { value: 'true' } as Partial<UiNode>),
      field('birthday', 'between', {
        value: '1990-01-01',
        valueTo: '1999-12-31',
      } as Partial<UiNode>),
      field('custom.plan', 'in', { values: ['pro', 'team'] } as Partial<UiNode>),
      field('given_name', 'not_in', { value: 'a, b,,c' } as Partial<UiNode>),
      field('custom.interests', 'contains', { values: ['golf'] } as Partial<UiNode>),
      field('owner_id', 'is_empty'),
    ]);
    const filter = toFilterGroup(root, kinds);
    expect(filter).toEqual({
      type: 'group',
      op: 'and',
      conditions: [
        { type: 'field', field: 'given_name', operator: 'contains', value: 'ross' },
        { type: 'field', field: 'score_value', operator: 'gte', value: 50.5 },
        { type: 'field', field: 'custom.vip', operator: 'equals', value: true },
        {
          type: 'field',
          field: 'birthday',
          operator: 'between',
          value: ['1990-01-01', '1999-12-31'],
        },
        { type: 'field', field: 'custom.plan', operator: 'in', value: ['pro', 'team'] },
        { type: 'field', field: 'given_name', operator: 'not_in', value: ['a', 'b', 'c'] },
        { type: 'field', field: 'custom.interests', operator: 'contains', value: 'golf' },
        { type: 'field', field: 'owner_id', operator: 'is_empty' },
      ],
    });
    expectValidQuery(filter);
  });

  it('drops values that do not fit the kind instead of sending them', () => {
    const root = group('and', [
      field('score_value', 'gt', { value: 'abc' } as Partial<UiNode>),
      field('birthday', 'equals', { value: 'yesterday' } as Partial<UiNode>),
      field('score_value', 'between', { value: '1', valueTo: '' } as Partial<UiNode>),
      // operator not allowed for the kind (contains on a number)
      field('score_value', 'contains', { value: '1' } as Partial<UiNode>),
    ]);
    expect(toFilterGroup(root, kinds)).toBeUndefined();
  });

  it('serializes tag conditions ANY / ALL / NONE', () => {
    const root = group('or', [
      { ...tagCondition('any'), tagIds: ['t1', 't2'] },
      { ...tagCondition('all'), tagIds: ['t3'] },
      { ...tagCondition('none'), tagIds: ['t4'] },
    ]);
    const filter = toFilterGroup(root, kinds);
    expect(filter?.conditions).toEqual([
      { type: 'tags', match: 'any', tag_ids: ['t1', 't2'] },
      { type: 'tags', match: 'all', tag_ids: ['t3'] },
      { type: 'tags', match: 'none', tag_ids: ['t4'] },
    ]);
    expectValidQuery(filter);
  });

  it('nests groups up to three levels and ignores deeper ones', () => {
    expect(MAX_GROUP_DEPTH).toBe(3);
    const level4 = group('and', [
      field('given_name', 'equals', { value: 'deep' } as Partial<UiNode>),
    ]);
    const level3 = group('or', [
      field('score_value', 'lt', { value: '10' } as Partial<UiNode>),
      level4,
    ]);
    const level2 = group('and', [{ ...tagCondition('all'), tagIds: ['vip'] }, level3]);
    const root = group('or', [
      field('given_name', 'starts_with', { value: 'A' } as Partial<UiNode>),
      level2,
    ]);
    const filter = toFilterGroup(root, kinds);
    expect(filter).toEqual({
      type: 'group',
      op: 'or',
      conditions: [
        { type: 'field', field: 'given_name', operator: 'starts_with', value: 'A' },
        {
          type: 'group',
          op: 'and',
          conditions: [
            { type: 'tags', match: 'all', tag_ids: ['vip'] },
            {
              type: 'group',
              op: 'or',
              conditions: [{ type: 'field', field: 'score_value', operator: 'lt', value: 10 }],
            },
          ],
        },
      ],
    });
    expectValidQuery(filter);
    expect(countConditions(filter)).toBe(3);
  });

  it('round-trips a stored filter through the editable tree', () => {
    const stored: FilterGroup = {
      type: 'group',
      op: 'and',
      conditions: [
        { type: 'field', field: 'custom.plan', operator: 'in', value: ['pro', 'team'] },
        { type: 'tags', match: 'all', tag_ids: ['vip', 'customer'] },
        {
          type: 'group',
          op: 'or',
          conditions: [
            { type: 'field', field: 'score_value', operator: 'gte', value: 50 },
            {
              type: 'field',
              field: 'created_at',
              operator: 'between',
              value: ['2026-01-01', '2026-06-30'],
            },
            { type: 'field', field: 'custom.vip', operator: 'equals', value: false },
            { type: 'field', field: 'owner_id', operator: 'is_not_empty' },
          ],
        },
      ],
    };
    expect(toFilterGroup(fromFilterGroup(stored), kinds)).toEqual(stored);
    expect(toFilterGroup(fromFilterGroup(undefined), kinds)).toBeUndefined();
  });

  it('edits the tree immutably (append, update, remove)', () => {
    const root = emptyGroup();
    const condition = fieldCondition('given_name', 'equals');
    const withCondition = appendNode(root, root.id, condition);
    expect(root.conditions).toHaveLength(0);
    const updated = updateNode(
      withCondition,
      condition.id,
      (node) => ({ ...node, value: 'Ada' }) as UiNode,
    );
    expect(toFilterGroup(updated, kinds)?.conditions).toEqual([
      { type: 'field', field: 'given_name', operator: 'equals', value: 'Ada' },
    ]);
    expect(removeNode(updated, condition.id).conditions).toHaveLength(0);
  });

  it('keeps a valid operator when the field kind changes, else picks the first one', () => {
    expect(operatorForKind('number', 'gte')).toBe('gte');
    expect(operatorForKind('text', 'gte')).toBe('equals');
    expect(operatorForKind('multi', 'equals')).toBe('contains');
  });
});
