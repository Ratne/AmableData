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
  BACKUP_STATE_KEY,
  BACKUP_TICK_BUDGET_MS,
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
import { createR2JsonlGzipWriter, readJsonlGzip, type JsonlGzipWriter } from './jsonl-gzip';
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

async function* d1Rows(
  db: D1Database,
  table: { name: string; sql: string },
  filter: { column: string; value: string } | null,
): AsyncGenerator<BackupRow> {
  const name = quoteIdent(table.name);
  const where = filter === null ? '' : `${quoteIdent(filter.column)} = ? AND `;
  const base: BackupSqlValue[] = filter === null ? [] : [filter.value];
  const withoutRowid = /\bWITHOUT\s+ROWID\b/i.test(table.sql);
  let after = 0;
  for (;;) {
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
    for (const raw of results) {
      const row: BackupRow = {};
      for (const [column, value] of Object.entries(raw)) {
        if (column !== ROWID) row[column] = encodeD1Value(value);
      }
      after = withoutRowid ? after + 1 : Number(raw[ROWID]);
      yield row;
    }
    if (results.length < D1_PAGE) return;
  }
}

async function installationSchemaVersion(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT value FROM installation_meta WHERE key = 'schema_version'`)
    .first<{ value: string }>();
  return Number(row?.value ?? 0);
}

// --- Creating backups ------------------------------------------------------------------------

interface WriteContext {
  writer: JsonlGzipWriter;
  rows: number;
}

async function writeRow(ctx: WriteContext, line: BackupRowLine): Promise<void> {
  await ctx.writer.write(line);
  ctx.rows += 1;
}

async function writeBackup(
  deps: BackupDeps,
  prefix: string,
  kind: BackupKind,
  header: Omit<BackupHeaderLine, 'type' | 'format' | 'version' | 'kind' | 'createdAt'>,
  body: (ctx: WriteContext) => Promise<void>,
): Promise<BackupObjectInfo> {
  const at = deps.now();
  const id = backupId(at, kind, deps.rand());
  const key = backupKey(prefix, id);
  const writer = createR2JsonlGzipWriter(deps.bucket, key, {
    customMetadata: {
      format: String(BACKUP_FORMAT_VERSION),
      scope: header.scope,
      kind,
      tenantId: header.tenantId ?? '',
    },
    ...(deps.partSize === undefined ? {} : { partSize: deps.partSize }),
  });
  const ctx: WriteContext = { writer, rows: 0 };
  try {
    const line: BackupHeaderLine = {
      type: 'header',
      format: BACKUP_FORMAT,
      version: BACKUP_FORMAT_VERSION,
      kind,
      createdAt: new Date(at).toISOString(),
      ...header,
    };
    await writer.write(line);
    await body(ctx);
    await writer.write({ type: 'end', rows: ctx.rows });
    const size = await writer.close();
    const info = parseBackupKey(prefix, key, size);
    if (info === null) throw new Error('backup: unparsable key');
    return info;
  } catch (error) {
    await writer.abort();
    throw error;
  }
}

export async function createTenantBackup(
  deps: BackupDeps,
  tenant: BackupTenant,
  kind: BackupKind,
  options: { prune?: boolean } = {},
): Promise<BackupObjectInfo> {
  const stubs = TENANT_DO_NAMES.map((name) => ({ name, stub: deps.stub(tenant.id, name) }));
  const schemas: Partial<Record<BackupDbName, number>> = {
    d1: await installationSchemaVersion(deps.db),
  };
  for (const { name, stub } of stubs) schemas[name] = (await stub.backupInfo()).schemaVersion;
  const prefix = tenantBackupPrefix(tenant.id);
  const info = await writeBackup(
    deps,
    prefix,
    kind,
    { scope: 'tenant', tenantId: tenant.id, tenantSlug: tenant.slug, schemas },
    async (ctx) => {
      for (const { name, stub } of stubs) {
        let cursor: DumpCursor | null = null;
        do {
          const page: DumpPage = await stub.backupDump(cursor);
          for (const { table, row } of page.rows) await writeRow(ctx, { db: name, table, row });
          cursor = page.next;
        } while (cursor !== null);
      }
      for (const table of await d1Tables(deps.db)) {
        if (TENANT_D1_EXCLUDE.includes(table.name)) continue;
        const filter =
          table.name === 'tenants'
            ? { column: 'id', value: tenant.id }
            : /\btenant_id\b/.test(table.sql)
              ? { column: 'tenant_id', value: tenant.id }
              : null;
        if (filter === null) continue;
        for await (const row of d1Rows(deps.db, table, filter)) {
          await writeRow(ctx, { db: 'd1', table: table.name, row });
        }
      }
    },
  );
  if (options.prune ?? true) await pruneBackups(deps, prefix, [info.key]);
  return info;
}

export async function createInstallationBackup(deps: BackupDeps): Promise<BackupObjectInfo> {
  const info = await writeBackup(
    deps,
    INSTALLATION_BACKUP_PREFIX,
    'scheduled',
    {
      scope: 'installation',
      tenantId: null,
      tenantSlug: null,
      schemas: { d1: await installationSchemaVersion(deps.db) },
    },
    async (ctx) => {
      for (const table of await d1Tables(deps.db)) {
        for await (const row of d1Rows(deps.db, table, null)) {
          await writeRow(ctx, { db: 'd1', table: table.name, row });
        }
      }
    },
  );
  await pruneBackups(deps, INSTALLATION_BACKUP_PREFIX, [info.key]);
  return info;
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

export interface BackupState {
  version: 1;
  installation: number | null;
  tenants: Record<string, number>;
  /** Failed scopes are retried no earlier than this. */
  retryAt: Record<string, number>;
  leaseUntil: number | null;
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
  };
  if (object === null) return { state: empty, etag: null };
  try {
    const parsed = (await object.json()) as Partial<BackupState>;
    return {
      state: { ...empty, ...parsed, tenants: parsed.tenants ?? {}, retryAt: parsed.retryAt ?? {} },
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
 * last scheduled backup is older than BACKUP_INTERVAL_MS, oldest first, a few per
 * tick. An R2 lease (conditional put) keeps overlapping ticks from doubling work.
 */
export async function runScheduledBackups(
  deps: BackupDeps,
  options: { maxBackups?: number; budgetMs?: number } = {},
): Promise<ScheduledBackupSummary> {
  const started = deps.now();
  const maxBackups = options.maxBackups ?? BACKUP_MAX_PER_TICK;
  const budget = options.budgetMs ?? BACKUP_TICK_BUDGET_MS;
  const { state, etag } = await readState(deps);
  if (state.leaseUntil !== null && state.leaseUntil > started) {
    return { status: 'locked', done: [], failed: [] };
  }

  const { results: tenants } = await deps.db
    .prepare(`SELECT id, slug FROM tenants ORDER BY id`)
    .all<BackupTenant>();
  const due = (scope: string, last: number | null | undefined): boolean =>
    (last === null || last === undefined || started - last >= BACKUP_INTERVAL_MS) &&
    (state.retryAt[scope] ?? 0) <= started;
  const queue: { scope: string; tenant: BackupTenant | null; last: number }[] = [];
  if (due(INSTALLATION_SCOPE, state.installation)) {
    queue.push({ scope: INSTALLATION_SCOPE, tenant: null, last: state.installation ?? 0 });
  }
  for (const tenant of tenants) {
    const last = state.tenants[tenant.id];
    if (due(tenant.id, last)) queue.push({ scope: tenant.id, tenant, last: last ?? 0 });
  }
  if (queue.length === 0) return { status: 'idle', done: [], failed: [] };
  queue.sort((a, b) => a.last - b.last);

  const known = new Set(tenants.map((t) => t.id));
  for (const id of Object.keys(state.tenants)) if (!known.has(id)) delete state.tenants[id];
  for (const id of Object.keys(state.retryAt)) {
    if (id !== INSTALLATION_SCOPE && !known.has(id)) delete state.retryAt[id];
  }
  state.leaseUntil = started + BACKUP_LEASE_MS;
  if (!(await writeState(deps, state, etag))) return { status: 'locked', done: [], failed: [] };

  const done: string[] = [];
  const failed: string[] = [];
  try {
    for (const item of queue.slice(0, maxBackups)) {
      if (deps.now() - started > budget) break;
      try {
        if (item.tenant === null) {
          await createInstallationBackup(deps);
          state.installation = deps.now();
        } else {
          await createTenantBackup(deps, item.tenant, 'scheduled');
          state.tenants[item.scope] = deps.now();
        }
        delete state.retryAt[item.scope];
        done.push(item.scope);
      } catch (error) {
        console.error(
          `[backup] scheduled backup failed (${item.tenant === null ? 'installation' : item.scope}):`,
          error instanceof Error ? error.message : error,
        );
        state.retryAt[item.scope] = deps.now() + RETRY_AFTER_FAILURE_MS;
        failed.push(item.scope);
      }
      await writeState(deps, state);
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
  for (const name of TENANT_DO_NAMES) infos.set(name, await deps.stub(tenant.id, name).backupInfo());

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
