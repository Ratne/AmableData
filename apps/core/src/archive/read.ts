import type { Activity } from '@amable/api-types';
import type { Context } from 'hono';
import { readJsonlGzip } from '../backup/jsonl-gzip';
import { CrmError } from '../crm/errors';
import { toIso } from '../crm/util';
import { mailDb } from '../email/http';
import { getTenant, tenantDb, type AppEnv } from '../middleware';
import { archivePrefix, STREAM_DB, type ArchiveCatalogEntry, type ArchiveMonthSummary, type ArchiveStream } from './model';
import type { ArchiveOpResult } from './store';

/**
 * Worker-side reads of the event archive for the REST routes. The catalog
 * comes from the verified tenant's own Durable Object and every object key is
 * checked against the tenant's prefix before R2 is touched: a route never
 * builds an R2 key from request input.
 */

type Ctx = Context<AppEnv>;

interface ArchiveRpc {
  archive(op: string, input: unknown): Promise<ArchiveOpResult<unknown>>;
}

/** Runs an archive op in the DO holding `stream` for the verified tenant. */
export async function callArchive<T>(c: Ctx, stream: ArchiveStream, op: 'catalog' | 'months', input: Record<string, unknown>): Promise<T> {
  const stub = (STREAM_DB[stream] === 'tenant_db' ? tenantDb(c) : mailDb(c)) as unknown as ArchiveRpc;
  const result = await stub.archive(op, { stream, ...input });
  if (!result.ok) throw new CrmError('bad_request', result.error.message);
  return result.value as T;
}

export function archiveCatalog(
  c: Ctx,
  stream: ArchiveStream,
  partition: string,
  filter: { month?: string; before?: string; limit?: number } = {},
): Promise<ArchiveCatalogEntry[]> {
  return callArchive<ArchiveCatalogEntry[]>(c, stream, 'catalog', { partition, ...filter });
}

export function archiveMonths(c: Ctx, stream: ArchiveStream, partition: string): Promise<ArchiveMonthSummary[]> {
  return callArchive<ArchiveMonthSummary[]>(c, stream, 'months', { partition });
}

/** Rows of one archived object of the verified tenant. */
export async function* readArchiveObject(c: Ctx, entry: ArchiveCatalogEntry): AsyncGenerator<Record<string, unknown>> {
  const tenantId = getTenant(c).tenant.id;
  if (!entry.object_key.startsWith(archivePrefix(tenantId))) {
    throw new CrmError('internal_error', 'archive object outside the workspace');
  }
  const object = await c.env.FILES.get(entry.object_key);
  if (object === null) {
    console.error(`[archive] missing object ${entry.object_key}`);
    return;
  }
  for await (const row of readJsonlGzip(object.body)) {
    if (typeof row === 'object' && row !== null) yield row as Record<string, unknown>;
  }
}

/** Catalog entries grouped by month, newest month first (parts in order). */
export function byMonth(entries: readonly ArchiveCatalogEntry[]): Array<{ month: string; parts: ArchiveCatalogEntry[] }> {
  const months = new Map<string, ArchiveCatalogEntry[]>();
  for (const entry of entries) {
    const list = months.get(entry.month) ?? [];
    list.push(entry);
    months.set(entry.month, list);
  }
  return [...months.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([month, parts]) => ({ month, parts: parts.sort((a, b) => a.part - b.part) }));
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** API shape of an archived `crm_activities` row. */
export function archivedActivity(row: Record<string, unknown>): Activity {
  return {
    id: String(row['id']),
    type: String(row['type']),
    contact_id: str(row['contact_id']),
    company_id: str(row['company_id']),
    opportunity_id: str(row['opportunity_id']),
    actor: { type: row['actor_type'] as Activity['actor']['type'], id: str(row['actor_id']) },
    data: typeof row['data'] === 'object' && row['data'] !== null ? (row['data'] as Record<string, unknown>) : {},
    occurred_at: toIso(Number(row['occurred_at'])),
  };
}
