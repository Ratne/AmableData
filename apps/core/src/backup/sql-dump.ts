import type { BackupJsonValue, BackupRow } from './format';

/**
 * Dump / restore of a SQLite database (Durable Object storage) table by table.
 * Pure over the `BackupSql` port so it runs unchanged on node:sqlite in tests.
 */

export type BackupSqlValue = string | number | null | ArrayBuffer | Uint8Array;
export type BackupSqlRow = Record<string, BackupSqlValue>;

export interface BackupSql {
  query(sql: string, ...params: BackupSqlValue[]): BackupSqlRow[];
  transaction<T>(fn: () => T): T;
}

/** DO SQLite rejects statements with more than 100 bound parameters. */
export const BACKUP_MAX_PARAMS = 90;
export const DUMP_PAGE_ROWS = 500;
/** Approximate JSON size of one dump page (RPC payloads stay small). */
export const DUMP_PAGE_BYTES = 1_000_000;

const ROWID = '__backup_rowid';

export interface DumpCursor {
  table: string;
  /** rowid of the last row returned, or row offset for WITHOUT ROWID tables. */
  after: number;
}

export interface DumpPage {
  rows: { table: string; row: BackupRow }[];
  next: DumpCursor | null;
}

export interface BackupDbInfo {
  schemaVersion: number;
  tables: string[];
}

export interface BackupTable {
  name: string;
  withoutRowid: boolean;
  columns: string[];
  pk: string[];
}

export interface SqlBackupOptions {
  /** Key/value meta table: `schema_version` is never wiped nor restored. */
  metaTable: string;
  /** Tables left out of the dump (migration bookkeeping). */
  exclude?: readonly string[];
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodeValue(value: BackupSqlValue | bigint | undefined): BackupJsonValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Uint8Array) return { $b64: toBase64(value) };
  return { $b64: toBase64(new Uint8Array(value)) };
}

export function decodeValue(value: BackupJsonValue): BackupSqlValue {
  if (value === null || typeof value === 'string' || typeof value === 'number') return value;
  return fromBase64(value.$b64);
}

function referencedTables(createSql: string): string[] {
  const out: string[] = [];
  for (const match of createSql.matchAll(/REFERENCES\s+["`[]?([A-Za-z0-9_]+)/gi)) {
    if (match[1] !== undefined) out.push(match[1]);
  }
  return out;
}

/** Parents before children (FK order), ties alphabetical; cycles keep alphabetical order. */
function topoOrder(tables: Map<string, string[]>): string[] {
  const names = [...tables.keys()].sort();
  const done = new Set<string>();
  const out: string[] = [];
  let progress = true;
  while (out.length < names.length && progress) {
    progress = false;
    for (const name of names) {
      if (done.has(name)) continue;
      const deps = (tables.get(name) ?? []).filter((d) => d !== name && tables.has(d));
      if (deps.every((d) => done.has(d))) {
        done.add(name);
        out.push(name);
        progress = true;
      }
    }
  }
  for (const name of names) if (!done.has(name)) out.push(name);
  return out;
}

/** User tables in dump order, without internal (`_cf_*`, `sqlite_*`, local runtime `__miniflare*`), virtual and shadow tables. */
export function listBackupTables(sql: BackupSql, exclude: readonly string[] = []): BackupTable[] {
  const master = sql.query(
    `SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name`,
  ) as { name: string; sql: string | null }[];
  const virtual = master
    .filter((t) => /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(t.sql ?? ''))
    .map((t) => t.name);
  const kept = master.filter(
    (t) =>
      !t.name.startsWith('_cf_') &&
      !t.name.startsWith('sqlite_') &&
      !t.name.startsWith('__miniflare') &&
      !exclude.includes(t.name) &&
      !virtual.includes(t.name) &&
      !virtual.some((v) => t.name.startsWith(`${v}_`)),
  );
  const createSql = new Map(kept.map((t) => [t.name, t.sql ?? '']));
  const order = topoOrder(new Map(kept.map((t) => [t.name, referencedTables(t.sql ?? '')])));
  return order.map((name) => {
    const info = sql.query(`PRAGMA table_info(${quoteIdent(name)})`) as {
      name: string;
      pk: number;
    }[];
    return {
      name,
      withoutRowid: /\bWITHOUT\s+ROWID\b/i.test(createSql.get(name) ?? ''),
      columns: info.map((c) => c.name),
      pk: info
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name),
    };
  });
}

export function readSchemaVersion(sql: BackupSql, metaTable: string): number {
  const row = sql.query(
    `SELECT value FROM ${quoteIdent(metaTable)} WHERE key = 'schema_version'`,
  )[0];
  const value = Number(row?.['value'] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

export function dumpInfo(sql: BackupSql, options: SqlBackupOptions): BackupDbInfo {
  return {
    schemaVersion: readSchemaVersion(sql, options.metaTable),
    tables: listBackupTables(sql, options.exclude).map((t) => t.name),
  };
}

/** One page of rows starting at `cursor` (null = beginning); pages by rowid keyset or offset. */
export function dumpPage(
  sql: BackupSql,
  options: SqlBackupOptions,
  cursor: DumpCursor | null,
  limits: { rows?: number; bytes?: number } = {},
): DumpPage {
  const maxRows = limits.rows ?? DUMP_PAGE_ROWS;
  const maxBytes = limits.bytes ?? DUMP_PAGE_BYTES;
  const tables = listBackupTables(sql, options.exclude);
  let index = cursor === null ? 0 : tables.findIndex((t) => t.name === cursor.table);
  if (index < 0) throw new Error(`backup: unknown table in cursor`);
  let after = cursor?.after ?? 0;
  const rows: DumpPage['rows'] = [];
  let bytes = 0;
  while (index < tables.length) {
    const table = tables[index] as BackupTable;
    const want = maxRows - rows.length;
    const name = quoteIdent(table.name);
    const batch = table.withoutRowid
      ? sql.query(
          `SELECT * FROM ${name} ORDER BY ${table.pk.map(quoteIdent).join(', ') || '1'} LIMIT ? OFFSET ?`,
          want,
          after,
        )
      : sql.query(
          `SELECT rowid AS ${ROWID}, * FROM ${name} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
          after,
          want,
        );
    let taken = 0;
    for (const raw of batch) {
      const row: BackupRow = {};
      for (const column of table.columns) row[column] = encodeValue(raw[column]);
      rows.push({ table: table.name, row });
      taken += 1;
      after = table.withoutRowid ? after + 1 : Number(raw[ROWID]);
      bytes += JSON.stringify(row).length;
      if (bytes >= maxBytes) break;
    }
    const tableDone = taken === batch.length && batch.length < want;
    if (rows.length >= maxRows || bytes >= maxBytes) {
      if (tableDone) {
        const nextTable = tables[index + 1];
        return { rows, next: nextTable === undefined ? null : { table: nextTable.name, after: 0 } };
      }
      return { rows, next: { table: table.name, after } };
    }
    index += 1;
    after = 0;
  }
  return { rows, next: null };
}

/** Deletes every row of every dumped table (children first), keeping `schema_version`. */
export function wipeForRestore(sql: BackupSql, options: SqlBackupOptions): void {
  const tables = listBackupTables(sql, options.exclude).reverse();
  sql.transaction(() => {
    sql.query(`PRAGMA defer_foreign_keys = ON`);
    for (const table of tables) {
      if (table.name === options.metaTable) {
        sql.query(`DELETE FROM ${quoteIdent(table.name)} WHERE key <> 'schema_version'`);
      } else {
        sql.query(`DELETE FROM ${quoteIdent(table.name)}`);
      }
    }
  });
}

/** Inserts backup rows into `table` in statements of at most BACKUP_MAX_PARAMS parameters. */
export function restoreRows(
  sql: BackupSql,
  options: SqlBackupOptions,
  tableName: string,
  rows: readonly BackupRow[],
): number {
  const table = listBackupTables(sql, options.exclude).find((t) => t.name === tableName);
  if (table === undefined) throw new Error(`backup: table ${tableName} does not exist`);
  const isMeta = table.name === options.metaTable;
  const groups = new Map<string, BackupRow[]>();
  for (const row of rows) {
    if (isMeta && row['key'] === 'schema_version') continue;
    const columns = Object.keys(row);
    for (const column of columns) {
      if (!table.columns.includes(column)) {
        throw new Error(`backup: column ${column} does not exist in ${table.name}`);
      }
    }
    const signature = columns.join('\u0000');
    const group = groups.get(signature);
    if (group === undefined) groups.set(signature, [row]);
    else group.push(row);
  }
  let written = 0;
  sql.transaction(() => {
    sql.query(`PRAGMA defer_foreign_keys = ON`);
    for (const [signature, group] of groups) {
      const columns = signature === '' ? [] : signature.split('\u0000');
      if (columns.length === 0) continue;
      if (columns.length > BACKUP_MAX_PARAMS) {
        throw new Error(`backup: ${table.name} has too many columns`);
      }
      const perStatement = Math.max(1, Math.floor(BACKUP_MAX_PARAMS / columns.length));
      const tuple = `(${columns.map(() => '?').join(', ')})`;
      const head = `INSERT ${isMeta ? 'OR REPLACE ' : ''}INTO ${quoteIdent(table.name)} (${columns
        .map(quoteIdent)
        .join(', ')}) VALUES `;
      for (let i = 0; i < group.length; i += perStatement) {
        const slice = group.slice(i, i + perStatement);
        const params: BackupSqlValue[] = [];
        for (const row of slice) {
          for (const column of columns) params.push(decodeValue(row[column] ?? null));
        }
        sql.query(head + slice.map(() => tuple).join(', '), ...params);
        written += slice.length;
      }
    }
  });
  return written;
}

/** The backup RPC surface shared by TenantDb, MailDb and Engine. */
export interface SqlBackup {
  info(): BackupDbInfo;
  dump(cursor: DumpCursor | null): DumpPage;
  wipe(): void;
  restore(table: string, rows: readonly BackupRow[]): number;
}

export function createSqlBackup(sql: BackupSql, options: SqlBackupOptions): SqlBackup {
  const resolved: SqlBackupOptions = {
    ...options,
    exclude: options.exclude ?? ['do_migrations'],
  };
  return {
    info: () => dumpInfo(sql, resolved),
    dump: (cursor) => dumpPage(sql, resolved, cursor),
    wipe: () => wipeForRestore(sql, resolved),
    restore: (table, rows) => restoreRows(sql, resolved, table, rows),
  };
}

/** BackupSql over the SQLite storage of a Durable Object. */
export function backupSqlFromStorage(storage: DurableObjectStorage): BackupSql {
  let depth = 0;
  return {
    query(query: string, ...params: BackupSqlValue[]): BackupSqlRow[] {
      const bound = params.map((p) =>
        p instanceof Uint8Array
          ? (p.buffer.slice(p.byteOffset, p.byteOffset + p.byteLength) as ArrayBuffer)
          : p,
      );
      return storage.sql.exec(query, ...bound).toArray() as BackupSqlRow[];
    },
    transaction<T>(fn: () => T): T {
      if (depth > 0) return fn();
      depth += 1;
      try {
        return storage.transactionSync(fn);
      } finally {
        depth -= 1;
      }
    },
  };
}
