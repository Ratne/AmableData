import { createR2JsonlGzipWriter } from '../backup/jsonl-gzip';
import type { Env } from '../env';
import {
  archiveObjectKey,
  MAIL_ARCHIVE_STREAMS,
  OUTBOX_RETENTION_MS,
  PAGE_MAX_ROWS,
  PART_MAX_ROWS,
  STREAM_DB,
  streamCutoffs,
  TENANT_ARCHIVE_STREAMS,
  type ArchiveCatalogEntry,
  type ArchiveDb,
  type ArchivePlanStream,
  type ArchiveRowsPage,
  type ArchiveStream,
  type PendingPartition,
  type RetentionSettings,
} from './model';
import type { ArchiveOpResult } from './store';

/**
 * Retention job, run from the 5-minute cron of the core worker. Each tenant is
 * processed once a day, a few per tick, under a wall-clock budget: the
 * Durable Objects only read and delete rows (cheap SQL), the worker does the
 * JSON + gzip and the R2 uploads. Work cut short by the budget resumes on the
 * next tick from the catalog (parts already recorded are never rewritten).
 * An R2 lease (conditional put) keeps overlapping ticks from doubling work.
 */

export const ARCHIVE_STATE_KEY = 'archive/_state.json';
export const ARCHIVE_INTERVAL_MS = 24 * 60 * 60 * 1000 - 10 * 60 * 1000;
export const ARCHIVE_TICK_BUDGET_MS = 10_000;
export const ARCHIVE_MAX_TENANTS_PER_TICK = 5;
const ARCHIVE_LEASE_MS = 10 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;
const PRUNE_BATCH = 2000;
/** Months handled per database and tick: a backlog (first run, shorter retention) drains over several ticks. */
const MAX_MONTHS_PER_RUN = 24;

export interface ArchiveDoStub {
  archive(op: string, input: unknown): Promise<ArchiveOpResult<unknown>>;
}

export interface ArchiveDeps {
  bucket: R2Bucket;
  db: D1Database;
  stub(tenantId: string, db: ArchiveDb): ArchiveDoStub;
  now(): number;
  partSize?: number;
}

export function archiveDeps(env: Env): ArchiveDeps {
  return {
    bucket: env.FILES,
    db: env.DB,
    stub: (tenantId, db) =>
      (db === 'tenant_db'
        ? env.TENANT_DB.get(env.TENANT_DB.idFromName(tenantId))
        : env.MAIL_DB.get(env.MAIL_DB.idFromName(tenantId))) as unknown as ArchiveDoStub,
    now: () => Date.now(),
  };
}

export class ArchiveJobError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Calls an archive op of a tenant database, throwing its error. */
export async function archiveCall<T>(deps: Pick<ArchiveDeps, 'stub'>, tenantId: string, db: ArchiveDb, op: string, input: unknown): Promise<T> {
  const result = await deps.stub(tenantId, db).archive(op, input);
  if (!result.ok) throw new ArchiveJobError(result.error.code, result.error.message);
  return result.value as T;
}

interface ArchiveState {
  version: 1;
  tenants: Record<string, number>;
  retryAt: Record<string, number>;
  leaseUntil: number | null;
}

async function readState(deps: ArchiveDeps): Promise<{ state: ArchiveState; etag: string | null }> {
  const empty: ArchiveState = { version: 1, tenants: {}, retryAt: {}, leaseUntil: null };
  const object = await deps.bucket.get(ARCHIVE_STATE_KEY);
  if (object === null) return { state: empty, etag: null };
  try {
    const parsed = (await object.json()) as Partial<ArchiveState>;
    return { state: { ...empty, ...parsed, tenants: parsed.tenants ?? {}, retryAt: parsed.retryAt ?? {} }, etag: object.etag };
  } catch {
    return { state: empty, etag: object.etag };
  }
}

async function writeState(deps: ArchiveDeps, state: ArchiveState, etag?: string | null): Promise<boolean> {
  const result = await deps.bucket.put(ARCHIVE_STATE_KEY, JSON.stringify(state), {
    httpMetadata: { contentType: 'application/json' },
    ...(etag === undefined || etag === null ? {} : { onlyIf: { etagMatches: etag } }),
  });
  return result !== null;
}

export interface TenantArchiveReport {
  complete: boolean;
  archivedRows: number;
  objects: number;
  prunedRows: number;
  outboxRows: number;
}

type Deadline = () => boolean;

/** Writes the remaining parts of one partition; false when the budget ran out first. */
async function archivePartition(
  deps: ArchiveDeps,
  tenantId: string,
  plan: ArchivePlanStream,
  pending: PendingPartition,
  report: TenantArchiveReport,
  expired: Deadline,
): Promise<boolean> {
  const db = STREAM_DB[plan.stream];
  let part = pending.part;
  let after = pending.after;
  for (;;) {
    if (expired()) return false;
    const key = archiveObjectKey(tenantId, plan.stream, plan.month, pending.partition, part);
    const writer = createR2JsonlGzipWriter(deps.bucket, key, {
      customMetadata: { tenant: tenantId, stream: plan.stream, month: plan.month, part: String(part) },
      ...(deps.partSize === undefined ? {} : { partSize: deps.partSize }),
    });
    let rows = 0;
    let more = true;
    let cursor = after;
    try {
      while (more && rows < PART_MAX_ROWS) {
        if (expired()) {
          await writer.abort();
          return false;
        }
        const page = await archiveCall<ArchiveRowsPage>(deps, tenantId, db, 'rows', {
          stream: plan.stream,
          month: plan.month,
          partition: pending.partition,
          after: cursor,
          limit: Math.min(PAGE_MAX_ROWS, PART_MAX_ROWS - rows),
        });
        for (const row of page.rows) await writer.write(row);
        rows += page.rows.length;
        cursor = page.last;
        more = page.more;
      }
    } catch (error) {
      await writer.abort();
      throw error;
    }
    const bytes = await writer.close();
    const entry: Omit<ArchiveCatalogEntry, 'created_at'> = {
      stream: plan.stream,
      month: plan.month,
      partition: pending.partition,
      part,
      object_key: key,
      rows,
      bytes,
      last_cursor: cursor,
      final: !more,
    };
    await archiveCall(deps, tenantId, db, 'record', entry);
    report.archivedRows += rows;
    report.objects += 1;
    if (!more) return true;
    part += 1;
    after = cursor;
  }
}

/** Archives then prunes one database's months past the cutoffs; false when the budget ran out. */
async function archiveDatabase(
  deps: ArchiveDeps,
  tenantId: string,
  db: ArchiveDb,
  cutoffs: Partial<Record<ArchiveStream, number>>,
  report: TenantArchiveReport,
  expired: Deadline,
): Promise<boolean> {
  const streams = db === 'tenant_db' ? TENANT_ARCHIVE_STREAMS : MAIL_ARCHIVE_STREAMS;
  const own = Object.fromEntries(streams.flatMap((s) => (cutoffs[s] === undefined ? [] : [[s, cutoffs[s]]])));
  if (Object.keys(own).length === 0) return true;
  for (let round = 0; round < MAX_MONTHS_PER_RUN; round += 1) {
    const plans = await archiveCall<ArchivePlanStream[]>(deps, tenantId, db, 'plan', { cutoffs: own });
    if (plans.length === 0) return true;
    for (const plan of plans) {
      for (const pending of plan.pending) {
        if (!(await archivePartition(deps, tenantId, plan, pending, report, expired))) return false;
      }
      for (;;) {
        if (expired()) return false;
        const pruned = await archiveCall<{ deleted: number; done: boolean }>(deps, tenantId, db, 'prune', {
          stream: plan.stream,
          month: plan.month,
          cutoff: own[plan.stream],
          limit: PRUNE_BATCH,
        });
        report.prunedRows += pruned.deleted;
        if (pruned.done) break;
      }
    }
  }
  return false;
}

async function purgeOutboxes(deps: ArchiveDeps, tenantId: string, now: number, report: TenantArchiveReport, expired: Deadline): Promise<boolean> {
  for (const db of ['tenant_db', 'mail_db'] as const) {
    for (;;) {
      if (expired()) return false;
      const { deleted } = await archiveCall<{ deleted: number }>(deps, tenantId, db, 'purgeOutbox', {
        before: now - OUTBOX_RETENTION_MS,
        limit: PRUNE_BATCH,
      });
      report.outboxRows += deleted;
      if (deleted < PRUNE_BATCH) break;
    }
  }
  return true;
}

/** Full retention pass of one tenant (both databases) until done or `deadline`. */
export async function archiveTenant(deps: ArchiveDeps, tenantId: string, deadline: number): Promise<TenantArchiveReport> {
  const report: TenantArchiveReport = { complete: false, archivedRows: 0, objects: 0, prunedRows: 0, outboxRows: 0 };
  const expired: Deadline = () => deps.now() >= deadline;
  const now = deps.now();
  const settings = await archiveCall<RetentionSettings>(deps, tenantId, 'tenant_db', 'settings.get', {});
  const cutoffs = streamCutoffs(settings, now);
  if (!(await purgeOutboxes(deps, tenantId, now, report, expired))) return report;
  for (const db of ['tenant_db', 'mail_db'] as const) {
    if (!(await archiveDatabase(deps, tenantId, db, cutoffs, report, expired))) return report;
  }
  report.complete = true;
  return report;
}

export interface ScheduledArchiveSummary {
  status: 'locked' | 'idle' | 'ran';
  done: string[];
  partial: string[];
  failed: string[];
}

/**
 * Called by the cron: tenants whose last complete pass is older than a day,
 * oldest first, until the tick budget is spent. A tenant cut short keeps its
 * old timestamp and comes first on the next tick.
 */
export async function runScheduledArchive(
  deps: ArchiveDeps,
  options: { budgetMs?: number; maxTenants?: number } = {},
): Promise<ScheduledArchiveSummary> {
  const started = deps.now();
  const deadline = started + (options.budgetMs ?? ARCHIVE_TICK_BUDGET_MS);
  const { state, etag } = await readState(deps);
  if (state.leaseUntil !== null && state.leaseUntil > started) return { status: 'locked', done: [], partial: [], failed: [] };

  const { results: tenants } = await deps.db.prepare(`SELECT id FROM tenants ORDER BY id`).all<{ id: string }>();
  const known = new Set(tenants.map((t) => t.id));
  for (const id of Object.keys(state.tenants)) if (!known.has(id)) delete state.tenants[id];
  for (const id of Object.keys(state.retryAt)) if (!known.has(id)) delete state.retryAt[id];
  const due = tenants
    .map((t) => ({ id: t.id, last: state.tenants[t.id] ?? 0 }))
    .filter((t) => started - t.last >= ARCHIVE_INTERVAL_MS && (state.retryAt[t.id] ?? 0) <= started)
    .sort((a, b) => a.last - b.last)
    .slice(0, options.maxTenants ?? ARCHIVE_MAX_TENANTS_PER_TICK);
  if (due.length === 0) return { status: 'idle', done: [], partial: [], failed: [] };

  state.leaseUntil = started + ARCHIVE_LEASE_MS;
  if (!(await writeState(deps, state, etag))) return { status: 'locked', done: [], partial: [], failed: [] };
  const summary: ScheduledArchiveSummary = { status: 'ran', done: [], partial: [], failed: [] };
  try {
    for (const tenant of due) {
      if (deps.now() >= deadline) break;
      try {
        const report = await archiveTenant(deps, tenant.id, deadline);
        if (report.complete) {
          state.tenants[tenant.id] = deps.now();
          summary.done.push(tenant.id);
        } else {
          summary.partial.push(tenant.id);
        }
        delete state.retryAt[tenant.id];
      } catch (error) {
        console.error(`[archive] retention of ${tenant.id} failed:`, error instanceof Error ? error.message : error);
        state.retryAt[tenant.id] = deps.now() + RETRY_AFTER_FAILURE_MS;
        summary.failed.push(tenant.id);
      }
    }
  } finally {
    state.leaseUntil = null;
    await writeState(deps, state);
  }
  return summary;
}
