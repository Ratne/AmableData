import type { CrmContext } from './context';
import { invalid } from './errors';

const TABLES = {
  contact: 'crm_contacts',
  company: 'crm_companies',
  opportunity: 'crm_opportunities',
  lead_source: 'crm_lead_sources',
  tag: 'crm_tags',
  tag_category: 'crm_tag_categories',
  pipeline: 'crm_pipelines',
} as const;

/** Throws a 422 on `path` when a referenced record is missing or soft-deleted. */
export function assertRef(
  ctx: CrmContext,
  kind: keyof typeof TABLES,
  id: string | null | undefined,
  path: string,
): void {
  if (id === null || id === undefined) return;
  const rows = ctx.db.all(`SELECT 1 FROM ${TABLES[kind]} WHERE id = ? AND deleted_at IS NULL`, id);
  if (rows.length === 0) throw invalid(path, `${kind.replace('_', ' ')} ${id} not found`);
}
