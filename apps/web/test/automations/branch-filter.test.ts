import type { DecisionNode } from '@amable/api-types';
import { describe, expect, it } from 'vitest';
import {
  branchesToUi,
  filterSize,
  moveBranch,
  newBranch,
  uiToBranches,
} from '../../src/features/automations/lib/branch-filter';
import {
  appendNode,
  fieldCondition,
  tagCondition,
  type FieldKind,
} from '../../src/features/search/query-model';

const kinds = new Map<string, FieldKind>([
  ['score_value', 'number'],
  ['country_code', 'enum'],
  ['created_at', 'datetime_ms'],
]);

const branches: DecisionNode['branches'] = [
  {
    id: 'hot',
    label: 'Hot lead',
    filter: {
      type: 'group',
      op: 'and',
      conditions: [
        { type: 'field', field: 'score_value', operator: 'gte', value: 50 },
        { type: 'tags', match: 'any', tag_ids: ['01JTAG0000000000000000000A'] },
        {
          type: 'group',
          op: 'or',
          conditions: [
            { type: 'field', field: 'country_code', operator: 'in', value: ['IT', 'FR'] },
            {
              type: 'field',
              field: 'created_at',
              operator: 'between',
              value: ['2026-01-01', '2026-06-30'],
            },
          ],
        },
      ],
    },
  },
  { id: 'all', filter: { type: 'group', op: 'and', conditions: [] } },
];

describe('decision branch serialization', () => {
  it('round-trips branches through the query-builder model', () => {
    expect(uiToBranches(branchesToUi(branches), kinds)).toEqual(branches);
  });

  it('keeps an empty filter as an empty group (matches everyone) and trims labels', () => {
    const [ui] = branchesToUi([
      { id: 'b1', label: '  x  ', filter: { type: 'group', op: 'or', conditions: [] } },
    ]);
    expect(uiToBranches([{ ...ui!, label: '   ' }], kinds)).toEqual([
      { id: 'b1', filter: { type: 'group', op: 'or', conditions: [] } },
    ]);
  });

  it('types values by field kind and drops incomplete conditions', () => {
    const base = newBranch(new Set(), 'Scored');
    let root = appendNode(base.root, base.root.id, {
      ...fieldCondition('score_value', 'gt'),
      value: '10,5',
    });
    root = appendNode(root, root.id, fieldCondition('country_code', 'equals'));
    root = appendNode(root, root.id, tagCondition('none'));
    expect(uiToBranches([{ ...base, root }], kinds)).toEqual([
      {
        id: base.id,
        label: 'Scored',
        filter: {
          type: 'group',
          op: 'and',
          conditions: [{ type: 'field', field: 'score_value', operator: 'gt', value: 10.5 }],
        },
      },
    ]);
  });

  it('creates unique branch ids that are never "default"', () => {
    const taken = new Set(['hot', 'all']);
    const ids = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const branch = newBranch(new Set([...taken, ...ids]));
      expect(branch.id).not.toBe('default');
      expect(branch.id).toMatch(/^b_[a-z0-9]{6}$/);
      ids.add(branch.id);
    }
    expect(ids.size).toBe(50);
  });

  it('reorders branches and counts conditions', () => {
    const ui = branchesToUi(branches);
    expect(moveBranch(ui, 0, 1).map((b) => b.id)).toEqual(['all', 'hot']);
    expect(moveBranch(ui, 0, -1).map((b) => b.id)).toEqual(['hot', 'all']);
    expect(filterSize(branches[0]!.filter)).toBe(4);
  });
});
