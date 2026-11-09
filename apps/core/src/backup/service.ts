import { ulid } from 'ulid';
import type { Env } from '../env';
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BACKUP_INTERVAL_MS,
  BACKUP_LEASE_MS,
  BACKUP_MAX_PER_TICK,
  BACKUP_RETENTION_MANUAL,
  BACKUP_RETENTION_SCHEDULED,
  BACKUP_SLICE_MAX_PAGES,
  BACKUP_TICK_MAX_PAGES,
  BACKUP_STAGING_PREFIX,
  BACKUP_STATE_KEY,
  BACKUP_TICK_BUDGET_MS,
  BACKUP_ABANDON_MS,
  INSTALLATION_BACKUP_PREFIX,
  TENANT_DO_NAMES,
  backupId,
  backupKey,
  parseBackupKey,
  tenantBackupPrefix,
  type BackupDbName,
  type BackupHeaderLine,
  type BackupKind,
  type BackupObjectInfo,
  type BackupRow,
  type BackupRowLine,
  type TenantDoName,
} from './format';
import { createR2JsonlGzipWriter, createR2JsonlPlainWriter, readJsonlGzip } from './jsonl-gzip';
import {
  encodeValue,
  quoteIdent,
  type BackupDbInfo,
  type BackupSqlValue,
  type DumpCursor,
  type DumpPage,
} from './sql-dump';

/** Backup RPCs implemented by TenantDb, MailDb and Engine. */
export interface BackupDoStub {
  backupInfo(): Promise<BackupDbInfo>;
  backupDump(cursor: DumpCursor | null): Promise<DumpPage>;
  backupWipe(): Promise<void>;
  backupRestore(table: string, rows: BackupRow[]): Promise<number>;
  backupRestored(): Promise<void>;
}

export interface BackupDeps {
  bucket: R2Bucket;
  db: D1Database;
  stub(tenantId: string, name: TenantDoName): BackupDoStub;
  now(): number;
  rand(): string;
  partSize?: number;
  /** Pages per staged slice (tests shrink it); default BACKUP_SLICE_MAX_PAGES. */
  slicePages?: number;
}

export interface BackupTenant {
  id: string;
  slug: string;
}

export class BackupError extends Error {
  constructor(
    readonly code: string,
    message: string = code,
  ) {
    super(message);
  }
}

export function backupDeps(env: Env): BackupDeps {
  return {
    bucket: env.FILES,
    db: env.DB,
    stub(tenantId, name) {
      if (name === 'tenant_db') return env.TENANT_DB.get(env.TENANT_DB.idFromName(tenantId));
      if (name === 'mail_db') return env.MAIL_DB.get(env.MAIL_DB.idFromName(tenantId));
      return env.ENGINE.get(env.ENGINE.idFromName(tenantId));
    },
    now: () => Date.now(),
    rand: () => ulid().slice(-12),
  };
}

// --- Listing & retention ---------------------------------------------------------------------

export async function listBackups(deps: BackupDeps, prefix: string): Promise<BackupObjectInfo[]> {
  const out: BackupObjectInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await deps.bucket.list({ prefix, ...(cursor === undefined ? {} : { cursor }) });
    for (const object of page.objects) {
      const info = parseBackupKey(prefix, object.key, object.size);
      if (info !== null) out.push(info);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** Keeps the newest N backups of each kind under `prefix`; returns the deleted keys. */
export async function pruneBackups(
  deps: BackupDeps,
  prefix: string,
  protect: readonly string[] = [],
): Promise<string[]> {
  const all = await listBackups(deps, prefix);
  const keep: Record<BackupKind, number> = {
    scheduled: BACKUP_RETENTION_SCHEDULED,
    manual: BACKUP_RETENTION_MANUAL,
  };
  const seen: Record<BackupKind, number> = { scheduled: 0, manual: 0 };
  const doomed: string[] = [];
  for (const backup of all) {
    seen[backup.kind] += 1;
    if (seen[backup.kind] > keep[backup.kind] && !protect.includes(backup.key)) {
      doomed.push(backup.key);
    }
  }
  if (doomed.length > 0) await deps.bucket.delete(doomed);
  return doomed;
}

// --- D1 helpers ------------------------------------------------------------------------------

/** Installation tables never copied into a tenant backup (credentials, global identities). */
const TENANT_D1_EXCLUDE = [
  'users',
  'sessions',
  'auth_challenges',
  'auth_tokens',
  'recovery_codes',
  'known_devices',
  'rate_limits',
  // Delivery logs, kept 30 days and never restored; no tenant index to page them by.
  'webhook_deliveries',
  'app_events',
];
const D1_PAGE = 500;
const ROWID = '__backup_rowid';

function encodeD1Value(value: unknown): BackupRow[string] {
  if (Array.isArray(value)) return encodeValue(Uint8Array.from(value as number[]));
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    value instanceof ArrayBuffer ||
    value instanceof Uint8Array
  ) {
    return encodeValue(value as BackupSqlValue | bigint);
  }
  return null;
}

async function d1Tables(db: D1Database): Promise<{ name: string; sql: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT name, sql FROM sqlite_master WHERE type = 'table'
         AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
       ORDER BY name`,
    )
    .all<{ name: string; sql: string | null }>();
  return results
    .filter((t) => !/^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(t.sql ?? ''))
    .map((t) => ({ name: t.name, sql: t.sql ?? '' }));
}

async function d1Page(
  db: D1Database,
  table: { name: string; sql: string },
  filter: { column: string; value: string } | null,
  after: number,
): Promise<{ rows: BackupRow[]; after: number }> {
  const name = quoteIdent(table.name);
  const where = filter === null ? '' : `${quoteIdent(filter.column)} = ? AND `;
  const base: BackupSqlValue[] = filter === null ? [] : [filter.value];
  const withoutRowid = /\bWITHOUT\s+ROWID\b/i.test(table.sql);
  const statement = withoutRowid
    ? db
        .prepare(`SELECT * FROM ${name} WHERE ${where}1 = 1 ORDER BY 1 LIMIT ? OFFSET ?`)
        .bind(...base, D1_PAGE, after)
    : db
        .prepare(
          `SELECT rowid AS ${ROWID}, * FROM ${name} WHERE ${where}rowid > ? ORDER BY rowid LIMIT ?`,
        )
        .bind(...base, after, D1_PAGE);
  const { results } = await statement.all<Record<string, unknown>>();
  const rows: BackupRow[] = [];
  let next = after;
  for (const raw of results) {
    const row: BackupRow = {};
    for (const [column, value] of Object.entries(raw)) {
      if (column !== ROWID) row[column] = encodeD1Value(value);
    }
    next = withoutRowid ? next + 1 : Number(raw[ROWID]);
    rows.push(row);
  }
  return { rows, after: next };
}

async function installationSchemaVersion(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT value FROM installation_meta WHERE key = 'schema_version'`)
    .first<{ value: string }>();
  return Number(row?.value ?? 0);
}

// --- Creating backups (staged slices) ---------------------------------------------------------

/**
 * Backups are written in slices so one scheduled backup can span cron ticks
 * without exceeding a tick's subrequest or time budget: every slice streams
 * rows into an uncompressed staging object, and once the data is exhausted one
 * finalize pass concatenates the slices through a single gzip stream into the
 * usual `<id>.jsonl.gz` (workerd's DecompressionStream rejects multi-member
 * gzip, so a suspended backup cannot keep one compressed stream open). Manual
 * backups run the same machinery in one call, without a deadline.
 */

/** Where the next slice starts: the DO streams first (tenant backups), then the D1 tables. */
type SliceCursor =
  | { phase: 'do'; index: number; cursor: DumpCursor | null }
  | { phase: 'd1'; table: string | null; after: number };

/** A backup in progress; serialized into the scheduler state while suspended. */
interface StagedBackup {
  scope: string;
  tenant: BackupTenant | null;
  id: string;
  kind: BackupKind;
  header: BackupHeaderLine;
  rows: number;
  /** Staging objects written so far (their keys are 1-based). */
  staged: number;
  /** null: data exhausted, only the finalize pass is left. */
  cursor: SliceCursor | null;
  startedAt: number;
}

function stagingKey(id: string, index: number): string {
  return `${BACKUP_STAGING_PREFIX}${id}.${String(index).padStart(4, '0')}.jsonl`;
}

async function deleteStaging(deps: BackupDeps, id: string): Promise<void> {
  const page = await deps.bucket.list({ prefix: `${BACKUP_STAGING_PREFIX}${id}.` });
  if (page.objects.length > 0) await deps.bucket.delete(page.objects.map((object) => object.key));
}

async function newStagedBackup(
  deps: BackupDeps,
  tenant: BackupTenant | null,
  kind: BackupKind,
): Promise<StagedBackup> {
  const at = deps.now();
  const schemas: Partial<Record<BackupDbName, number>> = {
    d1: await installationSchemaVersion(deps.db),
  };
  if (tenant !== null) {
    for (const name of TENANT_DO_NAMES) {
      schemas[name] = (await deps.stub(tenant.id, name).backupInfo()).schemaVersion;
    }
  }
  return {
    scope: tenant === null ? INSTALLATION_SCOPE : tenant.id,
    tenant,
    id: backupId(at, kind, deps.rand()),
    kind,
    header: {
      type: 'header',
      format: BACKUP_FORMAT,
      version: BACKUP_FORMAT_VERSION,
      scope: tenant === null ? 'installation' : 'tenant',
      kind,
      tenantId: tenant?.id ?? null,
      tenantSlug: tenant?.slug ?? null,
      createdAt: new Date(at).toISOString(),
      schemas,
    },
    rows: 0,
    staged: 0,
    cursor:
      tenant === null
        ? { phase: 'd1', table: null, after: 0 }
        : { phase: 'do', index: 0, cursor: null },
    startedAt: at,
  };
}

/** D1 filter of a table in a tenant backup; null = the table is not part of it. */
function tenantD1Filter(
  tenant: BackupTenant,
  table: { name: string; sql: string },
): { column: string; value: string } | null {
  if (TENANT_D1_EXCLUDE.includes(table.name)) return null;
  if (table.name === 'tenants') return { column: 'id', value: tenant.id };
  return /\btenant_id\b/.test(table.sql) ? { column: 'tenant_id', value: tenant.id } : null;
}

/**
 * One staging object: rows from the cursor on, until the data ends or
 * `shouldPause`. The job advances only after the object is stored, so a failed
 * or crashed slice is simply rewritten onto the same key.
 */
async function writeSlice(
  deps: BackupDeps,
  job: StagedBackup,
  shouldPause: () => boolean,
): Promise<void> {
  const writer = createR2JsonlPlainWriter(
    deps.bucket,
    stagingKey(job.id, job.staged + 1),
    deps.partSize === undefined ? {} : { partSize: deps.partSize },
  );
  let cursor = job.cursor;
  let rowsAdded = 0;
  try {
    if (job.staged === 0) await writer.write(job.header);
    let pause = false;
    while (!pause && cursor !== null && cursor.phase === 'do') {
      const tenant = job.tenant;
      const name = TENANT_DO_NAMES[cursor.index];
      if (tenant === null || name === undefined) throw new Error('backup: bad do-phase cursor');
      const page = await deps.stub(tenant.id, name).backupDump(cursor.cursor);
      for (const { table, row } of page.rows) {
        const line: BackupRowLine = { db: name, table, row };
        await writer.write(line);
        rowsAdded += 1;
      }
      cursor =
        page.next !== null
          ? { phase: 'do', index: cursor.index, cursor: page.next }
          : cursor.index + 1 < TENANT_DO_NAMES.length
            ? { phase: 'do', index: cursor.index + 1, cursor: null }
            : { phase: 'd1', table: null, after: 0 };
      pause = shouldPause();
    }
    if (!pause && cursor !== null && cursor.phase === 'd1') {
      const start = cursor;
      let suspended: SliceCursor | null = null;
      outer: for (const table of await d1Tables(deps.db)) {
        if (start.table !== null && table.name < start.table) continue;
        const filter = job.tenant === null ? null : tenantD1Filter(job.tenant, table);
        if (job.tenant !== null && filter === null) continue;
        let after = start.table === table.name ? start.after : 0;
        for (;;) {
          const page = await d1Page(deps.db, table, filter, after);
          for (const row of page.rows) {
            const line: BackupRowLine = { db: 'd1', table: table.name, row };
            await writer.write(line);
            rowsAdded += 1;
          }
          after = page.after;
          // Table finished: move on without pausing, or the slice could suspend
          // on an unchanged cursor (the resume would re-read the same empty
          // page) and never advance.
          if (page.rows.length < D1_PAGE) break;
          if (shouldPause()) {
            // Resuming re-reads from `after`: the cursor advanced with this page.
            suspended = { phase: 'd1', table: table.name, after };
            break outer;
          }
        }
      }
      cursor = suspended;
    }
  } catch (error) {
    await writer.abort();
    throw error;
  }
  await writer.close();
  job.cursor = cursor;
  job.rows += rowsAdded;
  job.staged += 1;
}

/** Concatenates the staging objects through one gzip stream into the final backup object. */
async function finalizeStaged(deps: BackupDeps, job: StagedBackup): Promise<BackupObjectInfo> {
  const prefix =
    job.tenant === null ? INSTALLATION_BACKUP_PREFIX : tenantBackupPrefix(job.tenant.id);
  const key = backupKey(prefix, job.id);
  const writer = createR2JsonlGzipWriter(deps.bucket, key, {
    customMetadata: {
      format: String(BACKUP_FORMAT_VERSION),
      scope: job.header.scope,
      kind: job.kind,
      tenantId: job.header.tenantId ?? '',
    },
    ...(deps.partSize === undefined ? {} : { partSize: deps.partSize }),
  });
  try {
    for (let index = 1; index <= job.staged; index += 1) {
      const object = await deps.bucket.get(stagingKey(job.id, index));
      if (object === null) throw new Error(`backup: staging slice ${String(index)} is missing`);
      await writer.writeRaw(object.body);
    }
    await writer.write({ type: 'end', rows: job.rows });
  } catch (error) {
    await writer.abort();
    throw error;
  }
  const size = await writer.close();
  const info = parseBackupKey(prefix, key, size);
  if (info === null) throw new Error('backup: unparsable key');
  await deleteStaging(deps, job.id);
  return info;
}

/**
 * Runs slices (stopping at `deadline` when given) and finalizes; 'suspended'
 * means out of budget, with all progress stored in `job` and its staging
 * objects. `onSlice` persists the job after every stored slice.
 */
async function runStaged(
  deps: BackupDeps,
  job: StagedBackup,
  deadline: number | null,
  onSlice?: () => Promise<void>,
  tick?: { pages: number; maxPages: number },
): Promise<BackupObjectInfo | 'suspended'> {
  const slicePages = deps.slicePages ?? BACKUP_SLICE_MAX_PAGES;
  const outOfBudget = (): boolean =>
    (deadline !== null && deps.now() >= deadline) ||
    (tick !== undefined && tick.pages >= tick.maxPages);
  while (job.cursor !== null) {
    if (outOfBudget()) return 'suspended';
    let pages = 0;
    await writeSlice(deps, job, () => {
      pages += 1;
      if (tick !== undefined) tick.pages += 1;
      return pages >= slicePages || outOfBudget();
    });
    await onSlice?.();
  }
  if (outOfBudget()) return 'suspended';
  return finalizeStaged(deps, job);
}

export async function createTenantBackup(
  deps: BackupDeps,
  tenant: BackupTenant,
  kind: BackupKind,
  options: { prune?: boolean } = {},
): Promise<BackupObjectInfo> {
  const job = await newStagedBackup(deps, tenant, kind);
  try {
    const info = (await runStaged(deps, job, null)) as BackupObjectInfo;
    if (options.prune ?? true) await pruneBackups(deps, tenantBackupPrefix(tenant.id), [info.key]);
    return info;
  } catch (error) {
    await deleteStaging(deps, job.id);
    throw error;
  }
}

/** Opens a tenant backup by id; null when it does not exist under that tenant. */
export async function getTenantBackup(
  deps: BackupDeps,
  tenantId: string,
  id: string,
): Promise<R2ObjectBody | null> {
  return deps.bucket.get(backupKey(tenantBackupPrefix(tenantId), id));
}

// --- Scheduler -------------------------------------------------------------------------------

interface BackupState {
  version: 1;
  installation: number | null;
  tenants: Record<string, number>;
  /** Failed scopes are retried no earlier than this. */
  retryAt: Record<string, number>;
  leaseUntil: number | null;
  /** A suspended scheduled backup; it resumes before anything new starts. */
  inProgress: StagedBackup | null;
}

const INSTALLATION_SCOPE = '_installation';
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;

async function readState(deps: BackupDeps): Promise<{ state: BackupState; etag: string | null }> {
  const object = await deps.bucket.get(BACKUP_STATE_KEY);
  const empty: BackupState = {
    version: 1,
    installation: null,
    tenants: {},
    retryAt: {},
    leaseUntil: null,
    inProgress: null,
  };
  if (object === null) return { state: empty, etag: null };
  try {
    const parsed = (await object.json()) as Partial<BackupState>;
    return {
      state: {
        ...empty,
        ...parsed,
        tenants: parsed.tenants ?? {},
        retryAt: parsed.retryAt ?? {},
        inProgress: parsed.inProgress ?? null,
      },
      etag: object.etag,
    };
  } catch {
    return { state: empty, etag: object.etag };
  }
}

async function writeState(
  deps: BackupDeps,
  state: BackupState,
  etag?: string | null,
): Promise<boolean> {
  const result = await deps.bucket.put(BACKUP_STATE_KEY, JSON.stringify(state), {
    httpMetadata: { contentType: 'application/json' },
    ...(etag === undefined || etag === null ? {} : { onlyIf: { etagMatches: etag } }),
  });
  return result !== null;
}

export interface ScheduledBackupSummary {
  status: 'locked' | 'idle' | 'ran';
  done: string[];
  failed: string[];
}

/**
 * Called by every cron tick: backs up the installation D1 and each tenant whose
 * last scheduled backup is older than BACKUP_INTERVAL_MS, oldest first, a few
 * per tick. A backup that outgrows the tick budget suspends into staged slices
 * and resumes on the next ticks before anything new starts. An R2 lease
 * (conditional put) keeps overlapping ticks from doubling work.
 */
export async function runScheduledBackups(
  deps: BackupDeps,
  options: { maxBackups?: number; budgetMs?: number; maxPages?: number } = {},
): Promise<ScheduledBackupSummary> {
  const started = deps.now();
  // Shared by every slice of the tick: the cron invocation also runs the other jobs.
  const tick = { pages: 0, maxPages: options.maxPages ?? BACKUP_TICK_MAX_PAGES };
  const maxBackups = options.maxBackups ?? BACKUP_MAX_PER_TICK;
  const budget = options.budgetMs ?? BACKUP_TICK_BUDGET_MS;
  const deadline = started + budget;
  const { state, etag } = await readState(deps);
  if (state.leaseUntil !== null && state.leaseUntil > started) {
    return { status: 'locked', done: [], failed: [] };
  }

  const { results: tenants } = await deps.db
    .prepare(`SELECT id, slug FROM tenants ORDER BY id`)
    .all<BackupTenant>();
  const known = new Set(tenants.map((t) => t.id));

  // In-progress work that can no longer complete safely is abandoned: too old,
  // written against another schema version, or its tenant is gone.
  if (state.inProgress !== null) {
    const job = state.inProgress;
    const orphaned = job.scope !== INSTALLATION_SCOPE && !known.has(job.scope);
    const drifted = job.header.schemas.d1 !== (await installationSchemaVersion(deps.db));
    if (started - job.startedAt >= BACKUP_ABANDON_MS || drifted || orphaned) {
      await deleteStaging(deps, job.id);
      state.inProgress = null;
    }
  }

  const due = (scope: string, last: number | null | undefined): boolean =>
    (last === null || last === undefined || started - last >= BACKUP_INTERVAL_MS) &&
    (state.retryAt[scope] ?? 0) <= started;
  const queue: { scope: string; tenant: BackupTenant | null; last: number }[] = [];
  if (
    state.inProgress?.scope !== INSTALLATION_SCOPE &&
    due(INSTALLATION_SCOPE, state.installation)
  ) {
    queue.push({ scope: INSTALLATION_SCOPE, tenant: null, last: state.installation ?? 0 });
  }
  for (const tenant of tenants) {
    if (state.inProgress?.scope === tenant.id) continue;
    const last = state.tenants[tenant.id];
    if (due(tenant.id, last)) queue.push({ scope: tenant.id, tenant, last: last ?? 0 });
  }
  const resume =
    state.inProgress !== null && (state.retryAt[state.inProgress.scope] ?? 0) <= started
      ? state.inProgress
      : null;
  if (resume === null && queue.length === 0) return { status: 'idle', done: [], failed: [] };
  queue.sort((a, b) => a.last - b.last);

  for (const id of Object.keys(state.tenants)) if (!known.has(id)) delete state.tenants[id];
  for (const id of Object.keys(state.retryAt)) {
    if (id !== INSTALLATION_SCOPE && !known.has(id)) delete state.retryAt[id];
  }
  state.leaseUntil = started + BACKUP_LEASE_MS;
  if (!(await writeState(deps, state, etag))) return { status: 'locked', done: [], failed: [] };

  const done: string[] = [];
  const failed: string[] = [];
  /** Runs one job to completion or suspension; true = completed. */
  const runJob = async (job: StagedBackup): Promise<boolean> => {
    state.inProgress = job;
    try {
      const out = await runStaged(
        deps,
        job,
        deadline,
        () => writeState(deps, state).then(() => undefined),
        tick,
      );
      if (out === 'suspended') return false;
      state.inProgress = null;
      if (job.scope === INSTALLATION_SCOPE) state.installation = deps.now();
      else state.tenants[job.scope] = deps.now();
      delete state.retryAt[job.scope];
      done.push(job.scope);
      const prefix =
        job.tenant === null ? INSTALLATION_BACKUP_PREFIX : tenantBackupPrefix(job.tenant.id);
      await pruneBackups(deps, prefix, [out.key]);
      return true;
    } catch (error) {
      console.error(
        `[backup] scheduled backup failed (${job.scope === INSTALLATION_SCOPE ? 'installation' : job.scope}):`,
        error instanceof Error ? error.message : error,
      );
      // The job stays in progress: the retry resumes from the last stored slice.
      state.retryAt[job.scope] = deps.now() + RETRY_AFTER_FAILURE_MS;
      failed.push(job.scope);
      return false;
    }
  };

  try {
    if (resume !== null) {
      await runJob(resume);
      await writeState(deps, state);
    }
    if (state.inProgress === null) {
      for (const item of queue.slice(0, Math.max(0, maxBackups - done.length))) {
        if (deps.now() - started > budget || tick.pages >= tick.maxPages) break;
        const completed = await runJob(await newStagedBackup(deps, item.tenant, 'scheduled'));
        await writeState(deps, state);
        if (!completed) break; // suspended or failed: the slot is taken, stop starting new ones
      }
    }
  } finally {
    state.leaseUntil = null;
    await writeState(deps, state);
  }
  return { status: 'ran', done, failed };
}

// --- Restore ---------------------------------------------------------------------------------

export interface RestoreSummary {
  rows: Record<TenantDoName, number>;
  skippedD1Rows: number;
  safetyBackupId: string;
}

const RESTORE_BATCH_ROWS = 200;
const RESTORE_BATCH_CHARS = 512 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTenantDo(db: unknown): db is TenantDoName {
  return (TENANT_DO_NAMES as readonly unknown[]).includes(db);
}

function asRowLine(line: unknown): BackupRowLine {
  if (
    !isRecord(line) ||
    typeof line['table'] !== 'string' ||
    !isRecord(line['row']) ||
    !(isTenantDo(line['db']) || line['db'] === 'd1')
  ) {
    throw new BackupError('backup_invalid', 'malformed row line');
  }
  return line as unknown as BackupRowLine;
}

async function* backupLines(object: R2ObjectBody): AsyncGenerator<unknown> {
  yield* readJsonlGzip(object.body);
}

/**
 * Full pass over a tenant backup: header, schema versions equal to the live
 * DOs, every table known, end line present with the right row count.
 */
export async function validateTenantBackup(
  deps: BackupDeps,
  tenant: BackupTenant,
  id: string,
): Promise<{ header: BackupHeaderLine; rows: number }> {
  const object = await getTenantBackup(deps, tenant.id, id);
  if (object === null) throw new BackupError('backup_not_found');
  const infos = new Map<TenantDoName, BackupDbInfo>();
  for (const name of TENANT_DO_NAMES)
    infos.set(name, await deps.stub(tenant.id, name).backupInfo());

  let header: BackupHeaderLine | null = null;
  let rows = 0;
  let ended = false;
  try {
    for await (const line of backupLines(object)) {
      if (ended) throw new BackupError('backup_invalid', 'data after end line');
      if (header === null) {
        if (
          !isRecord(line) ||
          line['type'] !== 'header' ||
          line['format'] !== BACKUP_FORMAT ||
          line['version'] !== BACKUP_FORMAT_VERSION
        ) {
          throw new BackupError('backup_invalid', 'missing or unsupported header');
        }
        header = line as unknown as BackupHeaderLine;
        if (header.scope !== 'tenant' || header.tenantId !== tenant.id) {
          throw new BackupError('backup_wrong_tenant');
        }
        for (const [name, info] of infos) {
          if (header.schemas[name] !== info.schemaVersion) {
            throw new BackupError('backup_schema_mismatch', `${name} schema differs`);
          }
        }
        continue;
      }
      if (isRecord(line) && line['type'] === 'end') {
        if (line['rows'] !== rows) throw new BackupError('backup_invalid', 'row count mismatch');
        ended = true;
        continue;
      }
      const row = asRowLine(line);
      if (row.db !== 'd1' && !(infos.get(row.db)?.tables ?? []).includes(row.table)) {
        throw new BackupError('backup_invalid', `unknown table ${row.db}.${row.table}`);
      }
      rows += 1;
    }
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError('backup_invalid', error instanceof Error ? error.message : 'unreadable');
  }
  if (header === null || !ended) throw new BackupError('backup_invalid', 'truncated file');
  return { header, rows };
}

/**
 * Replaces the three tenant DOs with the content of a backup: validates the whole
 * file first, takes a safety backup of the current state, wipes, then reloads in
 * batches. D1 rows (members, keys, audit) are kept as they are live installation data.
 */
export async function restoreTenantBackup(
  deps: BackupDeps,
  tenant: BackupTenant,
  id: string,
): Promise<RestoreSummary> {
  await validateTenantBackup(deps, tenant, id);
  const safety = await createTenantBackup(deps, tenant, 'manual', { prune: false });

  const object = await getTenantBackup(deps, tenant.id, id);
  if (object === null) throw new BackupError('backup_not_found');
  const stubs = new Map(TENANT_DO_NAMES.map((name) => [name, deps.stub(tenant.id, name)]));
  for (const stub of stubs.values()) await stub.backupWipe();

  const counts: Record<TenantDoName, number> = { tenant_db: 0, mail_db: 0, engine: 0 };
  let skippedD1Rows = 0;
  let batch: { db: TenantDoName; table: string; rows: BackupRow[]; chars: number } | null = null;
  const flush = async (): Promise<void> => {
    if (batch === null || batch.rows.length === 0) return;
    const current = batch;
    batch = null;
    counts[current.db] += await (stubs.get(current.db) as BackupDoStub).backupRestore(
      current.table,
      current.rows,
    );
  };
  let first = true;
  for await (const line of backupLines(object)) {
    if (first) {
      first = false;
      continue;
    }
    if (isRecord(line) && line['type'] === 'end') break;
    const row = asRowLine(line);
    if (row.db === 'd1') {
      skippedD1Rows += 1;
      continue;
    }
    if (batch !== null && (batch.db !== row.db || batch.table !== row.table)) await flush();
    const open: { db: TenantDoName; table: string; rows: BackupRow[]; chars: number } = batch ?? {
      db: row.db,
      table: row.table,
      rows: [],
      chars: 0,
    };
    batch = open;
    open.rows.push(row.row);
    open.chars += JSON.stringify(row.row).length;
    if (open.rows.length >= RESTORE_BATCH_ROWS || open.chars >= RESTORE_BATCH_CHARS) await flush();
  }
  await flush();
  for (const stub of stubs.values()) await stub.backupRestored();
  await pruneBackups(deps, tenantBackupPrefix(tenant.id), [
    safety.key,
    backupKey(tenantBackupPrefix(tenant.id), id),
  ]);
  return { rows: counts, skippedD1Rows, safetyBackupId: safety.id };
}
