import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createR2JsonlGzipWriter, readJsonlGzip } from '../../src/backup/jsonl-gzip';
import {
  BACKUP_MAX_PARAMS,
  createSqlBackup,
  dumpPage,
  listBackupTables,
  type DumpCursor,
} from '../../src/backup/sql-dump';
import type { BackupRow } from '../../src/backup/format';
import { FakeR2, nodeBackupSql } from './helpers';

const WIDE_COLUMNS = Array.from({ length: 40 }, (_, i) => `c${i}`);

function schema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE do_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);
    CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id), note TEXT);
    CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT NOT NULL, data BLOB);
    CREATE TABLE pairs (a TEXT NOT NULL, b TEXT NOT NULL, n INTEGER, PRIMARY KEY (a, b)) WITHOUT ROWID;
    CREATE TABLE wide (id INTEGER PRIMARY KEY, ${WIDE_COLUMNS.map((c) => `${c} TEXT`).join(', ')});
    CREATE VIRTUAL TABLE docs_fts USING fts5(body);
  `);
}

function seed(db: DatabaseSync): void {
  db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', '3'), ('tenant_id', 't1')`).run();
  db.prepare(`INSERT INTO do_migrations VALUES (1, 'init', 0)`).run();
  const parent = db.prepare(`INSERT INTO parent (id, name, data) VALUES (?, ?, ?)`);
  const child = db.prepare(`INSERT INTO child (id, parent_id, note) VALUES (?, ?, ?)`);
  for (let i = 1; i <= 1234; i += 1) {
    parent.run(i, `parent ${i} "quoted" ✓`, i % 7 === 0 ? new Uint8Array([0, 255, i % 256]) : null);
    child.run(i, i, i % 3 === 0 ? null : `note ${i}`);
  }
  const pair = db.prepare(`INSERT INTO pairs (a, b, n) VALUES (?, ?, ?)`);
  for (let i = 0; i < 250; i += 1) pair.run(`a${i % 10}`, `b${i}`, i);
  const wide = db.prepare(
    `INSERT INTO wide (id, ${WIDE_COLUMNS.join(', ')}) VALUES (?, ${WIDE_COLUMNS.map(() => '?').join(', ')})`,
  );
  for (let i = 1; i <= 101; i += 1) wide.run(i, ...WIDE_COLUMNS.map((c) => `${c}-${i}`));
  db.prepare(`INSERT INTO docs_fts (body) VALUES ('hello world')`).run();
}

function fullDump(db: DatabaseSync, limits: { rows?: number; bytes?: number }) {
  const sql = nodeBackupSql(db);
  const options = { metaTable: 'meta', exclude: ['do_migrations'] };
  const lines: { table: string; row: BackupRow }[] = [];
  let pages = 0;
  let cursor: DumpCursor | null = null;
  do {
    const page = dumpPage(sql, options, cursor, limits);
    expect(page.rows.length).toBeLessThanOrEqual(limits.rows ?? 500);
    lines.push(...page.rows);
    pages += 1;
    cursor = page.next;
  } while (cursor !== null);
  return { lines, pages };
}

describe('sql dump', () => {
  it('lists user tables in foreign key order, skipping internal, virtual and shadow tables', () => {
    const db = new DatabaseSync(':memory:');
    schema(db);
    const names = listBackupTables(nodeBackupSql(db), ['do_migrations']).map((t) => t.name);
    expect(names).toEqual(['meta', 'pairs', 'parent', 'wide', 'child']);
  });

  it('pages tables of more than 100 rows by rowid and offset without losing or repeating rows', () => {
    const db = new DatabaseSync(':memory:');
    schema(db);
    seed(db);
    const { lines, pages } = fullDump(db, { rows: 100 });
    const count = (table: string) => lines.filter((l) => l.table === table).length;
    expect(count('parent')).toBe(1234);
    expect(count('child')).toBe(1234);
    expect(count('pairs')).toBe(250);
    expect(count('wide')).toBe(101);
    expect(count('meta')).toBe(2);
    expect(count('do_migrations')).toBe(0);
    expect(count('docs_fts')).toBe(0);
    expect(pages).toBeGreaterThan(28);
    const parentIds = lines.filter((l) => l.table === 'parent').map((l) => l.row['id']);
    expect(new Set(parentIds).size).toBe(1234);
    const pairKeys = lines.filter((l) => l.table === 'pairs').map((l) => `${String(l.row['a'])}|${String(l.row['b'])}`);
    expect(new Set(pairKeys).size).toBe(250);
    expect(lines.find((l) => l.table === 'parent' && l.row['id'] === 7)?.row['data']).toEqual({
      $b64: 'AP8H',
    });
  });

  it('also cuts pages by size', () => {
    const db = new DatabaseSync(':memory:');
    schema(db);
    seed(db);
    const { lines, pages } = fullDump(db, { rows: 500, bytes: 4_000 });
    expect(lines.length).toBe(2 + 250 + 1234 + 1234 + 101);
    expect(pages).toBeGreaterThan(40);
  });

  it('restores into a fresh database in statements of at most 90 parameters', () => {
    const source = new DatabaseSync(':memory:');
    schema(source);
    seed(source);
    const { lines } = fullDump(source, { rows: 100 });

    const target = new DatabaseSync(':memory:');
    schema(target);
    target.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', '3')`).run();
    const port = nodeBackupSql(target);
    const backup = createSqlBackup(port, { metaTable: 'meta' });
    for (let i = 0; i < lines.length; ) {
      const table = lines[i]?.table as string;
      const batch: BackupRow[] = [];
      while (i < lines.length && lines[i]?.table === table && batch.length < 200) {
        batch.push((lines[i] as { row: BackupRow }).row);
        i += 1;
      }
      backup.restore(table, batch);
    }
    expect(port.maxParams).toBeLessThanOrEqual(BACKUP_MAX_PARAMS);
    expect(port.maxParams).toBeGreaterThan(40);
    for (const table of ['parent', 'child', 'pairs', 'wide', 'meta']) {
      const order = table === 'pairs' ? 'a, b' : table === 'meta' ? 'key' : 'id';
      expect(target.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all()).toEqual(
        source.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all(),
      );
    }
  });

  it('wipes everything but the schema version and rejects unknown tables or columns', () => {
    const db = new DatabaseSync(':memory:');
    schema(db);
    seed(db);
    const backup = createSqlBackup(nodeBackupSql(db), { metaTable: 'meta' });
    backup.wipe();
    expect(db.prepare(`SELECT key FROM meta`).all()).toEqual([{ key: 'schema_version' }]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM parent`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM do_migrations`).get()).toEqual({ n: 1 });
    expect(() => backup.restore('sqlite_master', [{ name: 'x' }])).toThrow(/does not exist/);
    expect(() => backup.restore('parent', [{ id: 1, 'name"; DROP TABLE parent; --': 'x' }])).toThrow(
      /column/,
    );
    backup.restore('meta', [{ key: 'schema_version', value: '999' }]);
    expect(db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get()).toEqual({
      value: '3',
    });
  });
});

describe('gzip jsonl on R2', () => {
  it('round-trips through a single put', async () => {
    const r2 = new FakeR2();
    const writer = createR2JsonlGzipWriter(r2.asBucket(), 'backups/x.jsonl.gz', {
      customMetadata: { kind: 'manual' },
    });
    const lines = Array.from({ length: 1000 }, (_, i) => ({ i, text: `línea ${i}\nwith newline` }));
    for (const line of lines) await writer.write(line);
    const size = await writer.close();
    const stored = r2.objects.get('backups/x.jsonl.gz');
    expect(stored?.bytes.length).toBe(size);
    expect(stored?.bytes.subarray(0, 2)).toEqual(new Uint8Array([0x1f, 0x8b]));
    expect(stored?.customMetadata).toEqual({ kind: 'manual' });
    expect(r2.partSizes).toEqual([]);
    const object = await r2.get('backups/x.jsonl.gz');
    const read: unknown[] = [];
    for await (const line of readJsonlGzip(object?.body as ReadableStream<Uint8Array>)) read.push(line);
    expect(read).toEqual(lines);
  });

  it('switches to equal-size multipart parts for large output', async () => {
    const r2 = new FakeR2();
    const writer = createR2JsonlGzipWriter(r2.asBucket(), 'backups/big.jsonl.gz', {
      partSize: 4096,
    });
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed.toString(36);
    };
    const lines = Array.from({ length: 3000 }, (_, i) => ({ i, noise: random() + random() }));
    for (const line of lines) await writer.write(line);
    await writer.close();
    const sizes = r2.partSizes[0] ?? [];
    expect(sizes.length).toBeGreaterThan(2);
    expect(sizes.slice(0, -1).every((s) => s === 4096)).toBe(true);
    const object = await r2.get('backups/big.jsonl.gz');
    const read: unknown[] = [];
    for await (const line of readJsonlGzip(object?.body as ReadableStream<Uint8Array>)) read.push(line);
    expect(read).toEqual(lines);
  });
});
