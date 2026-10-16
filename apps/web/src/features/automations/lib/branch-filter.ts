import type { DecisionNode } from '@amable/api-types';
import type { FilterGroup } from '@amable/api-types/crm';
import {
  emptyGroup,
  fromFilterGroup,
  toFilterGroup,
  type FieldKinds,
  type UiGroup,
} from '../../search/query-model';
import { DEFAULT_HANDLE } from './flow-mapping';
import { uniqueId } from './ids';

/**
 * Editable model of decision branches. Each branch filter reuses the CRM
 * advanced-search query model (same JSON the server evaluates against the
 * contact); an empty filter is kept as an empty group, which matches everyone.
 */

export type DecisionBranch = DecisionNode['branches'][number];

export interface UiBranch {
  readonly id: string;
  readonly label: string;
  readonly root: UiGroup;
}

export function branchesToUi(branches: readonly DecisionBranch[]): UiBranch[] {
  return branches.map((branch) => ({
    id: branch.id,
    label: branch.label ?? '',
    root: fromFilterGroup(branch.filter),
  }));
}

function emptyFilter(op: 'and' | 'or'): FilterGroup {
  return { type: 'group', op, conditions: [] };
}

/** Branches as stored in the graph; incomplete conditions are dropped (like saved searches). */
export function uiToBranches(branches: readonly UiBranch[], kinds: FieldKinds): DecisionBranch[] {
  return branches.map((branch) => {
    const label = branch.label.trim();
    return {
      id: branch.id,
      ...(label === '' ? {} : { label }),
      filter: toFilterGroup(branch.root, kinds) ?? emptyFilter(branch.root.op),
    };
  });
}

/** New branch with an id unique among `taken` (never `default`). */
export function newBranch(taken: ReadonlySet<string>, label = ''): UiBranch {
  const ids = new Set(taken);
  ids.add(DEFAULT_HANDLE);
  return { id: uniqueId('b', ids), label, root: emptyGroup() };
}

export function moveBranch(
  branches: readonly UiBranch[],
  index: number,
  delta: -1 | 1,
): UiBranch[] {
  const target = index + delta;
  if (target < 0 || target >= branches.length) return [...branches];
  const next = [...branches];
  const [moved] = next.splice(index, 1);
  if (moved !== undefined) next.splice(target, 0, moved);
  return next;
}

/** Number of complete conditions of a stored filter (shown on the canvas). */
export function filterSize(filter: FilterGroup): number {
  return filter.conditions.reduce(
    (total, node) => total + (node.type === 'group' ? filterSize(node) : 1),
    0,
  );
}
