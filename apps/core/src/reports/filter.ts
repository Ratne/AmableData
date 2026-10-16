import { filterGroupSchema, type FilterGroup } from '@amable/api-types';
import type { CrmContext } from '../crm/context';
import { CrmError } from '../crm/errors';
import { compileSearchQuery } from '../crm/search/query-builder';
import type { Fragment } from './aggregate';

const COUNT_PREFIX = 'SELECT COUNT(*) AS n FROM ';

/**
 * `column IN (SELECT r.id FROM crm_contacts r WHERE …)` from a query-builder
 * filter: the same compiler (operators, custom fields, tags, sensitive-field
 * rules) as the search API and saved searches.
 */
export function filterFragment(
  ctx: CrmContext,
  entity: 'contact' | 'company',
  filter: unknown,
  column: string,
): Fragment | null {
  if (filter === undefined || filter === null) return null;
  const parsed = filterGroupSchema.safeParse(filter);
  if (!parsed.success)
    throw new CrmError('validation_failed', 'filter: invalid query-builder filter');
  const group = parsed.data as FilterGroup;
  if (group.conditions.length === 0) return null;
  const compiled = compileSearchQuery(ctx, { entity, filter: group, columns: ['id'] });
  if (!compiled.countSql.startsWith(COUNT_PREFIX)) throw new Error('unexpected search SQL shape');
  return {
    sql: `${column} IN (SELECT r.id FROM ${compiled.countSql.slice(COUNT_PREFIX.length)})`,
    params: compiled.countParams,
  };
}
