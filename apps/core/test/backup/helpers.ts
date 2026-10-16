import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { tenantMigrations, type Migration } from '@amable/db';
import { engineMigrations } from '../../src/automation/migrations';
import type { BackupRow, TenantDoName } from '../../src/backup/format';
import type { BackupDeps, BackupDoStub } from '../../src/backup/service';
import {
  createSqlBackup,
  type BackupSql,
  type BackupSqlRow,
  type BackupSqlValue,
} from '../../src/backup/sql-dump';
import { mailMigrations } from '../../src/email/db/migrations';
import type { Env } from '../../src/env';
import { createTestTenant, type TestTenant } from '../crm/helpers';

/** BackupSql over node:sqlite; records the largest parameter count seen. */
export function nodeBackupSql(db: DatabaseSync): BackupSql & { maxParams: number } {
  let depth = 0;
  const port = {
    maxParams: 0,
    query(sql: string, ...params: BackupSqlValue[]): BackupSqlRow[] {
      port.maxParams = Math.max(port.maxParams, params.length);
      const bound = params.map(
        (p): SQLInputValue => (p instanceof ArrayBuffer ? new Uint8Array(p) : p),
      );
      return db.prepare(sql).all(...bound) as BackupSqlRow[];
    },
    transaction<T>(fn: () => T): T {
      const name = `sp${depth}`;
      db.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${name}`);
      depth += 1;
      try {
        const result = fn();
        depth -= 1;
        db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${name}`);
        return result;
      } catch (error) {
        depth -= 1;
        db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`);
        throw error;
      }
    },
  };
  return port;
}

function migrate(db: DatabaseSync, migrations: readonly Migration[], metaTable: string): void {
  for (const migration of migrations) {
    for (const statement of migration.statements) db.exec(statement);
  }
  const last = migrations[migrations.length - 1]?.id ?? 0;
  db.prepare(`INSERT OR REPLACE INTO ${metaTable} (key, value) VALUES ('schema_version', ?)`).run(
    String(last),
  );
}

export interface FakeTenantDos {
  crm: TestTenant;
  mail: DatabaseSync;
  engine: DatabaseSync;
  restoredCalls: number;
}

function createTenantDos(): FakeTenantDos {
  const crm = createTestTenant();
  crm.db.run(
    `INSERT OR REPLACE INTO tenant_meta (key, value) VALUES ('schema_version', ?)`,
    String(tenantMigrations[tenantMigrations.length - 1]?.id ?? 0),
  );
  const mail = new DatabaseSync(':memory:');
  migrate(mail, mailMigrations, 'mail_meta');
  const engine = new DatabaseSync(':memory:');
  migrate(engine, engineMigrations, 'engine_meta');
  return { crm, mail, engine, restoredCalls: 0 };
}

const META: Record<TenantDoName, string> = {
  tenant_db: 'tenant_meta',
  mail_db: 'mail_meta',
  engine: 'engine_meta',
};

/** One set of node:sqlite "DOs" per tenant id, behind RPC-like stubs (structuredClone at the boundary). */
export class FakeDos {
  readonly tenants = new Map<string, FakeTenantDos>();

  get(tenantId: string): FakeTenantDos {
    let dos = this.tenants.get(tenantId);
    if (dos === undefined) {
      dos = createTenantDos();
      this.tenants.set(tenantId, dos);
    }
    return dos;
  }

  stub(tenantId: string, name: TenantDoName): BackupDoStub {
    const dos = this.get(tenantId);
    const raw = name === 'tenant_db' ? dos.crm.db.raw : name === 'mail_db' ? dos.mail : dos.engine;
    const backup = createSqlBackup(nodeBackupSql(raw), { metaTable: META[name] });
    const rpc = <T>(value: T): Promise<T> => Promise.resolve(structuredClone(value));
    return {
      backupInfo: () => rpc(backup.info()),
      backupDump: (cursor) => rpc(backup.dump(structuredClone(cursor))),
      backupWipe: () => rpc(backup.wipe()),
      backupRestore: (table: string, rows: BackupRow[]) =>
        rpc(backup.restore(table, structuredClone(rows))),
      backupRestored: () => {
        dos.restoredCalls += 1;
        return Promise.resolve();
      },
    };
  }

  /** Env namespaces exposing the backup RPCs (route tests go through backupDeps(env)). */
  namespaces(): Pick<Env, 'TENANT_DB' | 'MAIL_DB' | 'ENGINE'> {
    const make = (name: TenantDoName) => ({
      idFromName: (id: string) => id,
      get: (id: string) => this.stub(id, name),
    });
    return {
      TENANT_DB: make('tenant_db'),
      MAIL_DB: make('mail_db'),
      ENGINE: make('engine'),
    } as unknown as Pick<Env, 'TENANT_DB' | 'MAIL_DB' | 'ENGINE'>;
  }
}

interface StoredObject {
  key: string;
  bytes: Uint8Array;
  etag: string;
  uploaded: Date;
  customMetadata: Record<string, string>;
}

async function toBytes(value: unknown): Promise<Uint8Array> {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (value instanceof ReadableStream) return new Uint8Array(await new Response(value).arrayBuffer());
  throw new Error('fake R2: unsupported body');
}

/** In-memory R2 subset: put/get/head/list/delete, conditional put, multipart. */
export class FakeR2 {
  readonly objects = new Map<string, StoredObject>();
  readonly partSizes: number[][] = [];
  private seq = 0;

  private store(key: string, bytes: Uint8Array, customMetadata: Record<string, string>) {
    this.seq += 1;
    const object: StoredObject = {
      key,
      bytes,
      etag: `etag-${this.seq}`,
      uploaded: new Date(),
      customMetadata,
    };
    this.objects.set(key, object);
    return this.view(object);
  }

  private view(object: StoredObject) {
    return {
      key: object.key,
      size: object.bytes.length,
      etag: object.etag,
      uploaded: object.uploaded,
      customMetadata: object.customMetadata,
    };
  }

  async put(
    key: string,
    value: unknown,
    options: { customMetadata?: Record<string, string>; onlyIf?: { etagMatches?: string } } = {},
  ) {
    const existing = this.objects.get(key);
    const want = options.onlyIf?.etagMatches;
    if (want !== undefined && existing?.etag !== want) return null;
    return this.store(key, await toBytes(value), options.customMetadata ?? {});
  }

  get(key: string) {
    const object = this.objects.get(key);
    if (object === undefined) return Promise.resolve(null);
    const bytes = object.bytes;
    return Promise.resolve({
      ...this.view(object),
      body: new Blob([bytes]).stream(),
      json: () => Promise.resolve(JSON.parse(new TextDecoder().decode(bytes)) as unknown),
    });
  }

  head(key: string) {
    const object = this.objects.get(key);
    return Promise.resolve(object === undefined ? null : this.view(object));
  }

  list(options: { prefix?: string } = {}) {
    const objects = [...this.objects.values()]
      .filter((o) => o.key.startsWith(options.prefix ?? ''))
      .sort((a, b) => (a.key < b.key ? -1 : 1))
      .map((o) => this.view(o));
    return Promise.resolve({ objects, truncated: false, delimitedPrefixes: [] });
  }

  delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
    return Promise.resolve();
  }

  createMultipartUpload(key: string, options: { customMetadata?: Record<string, string> } = {}) {
    const parts = new Map<number, Uint8Array>();
    const sizes: number[] = [];
    this.partSizes.push(sizes);
    return Promise.resolve({
      key,
      uploadId: `upload-${key}`,
      uploadPart: async (partNumber: number, value: unknown) => {
        const bytes = await toBytes(value);
        parts.set(partNumber, bytes);
        sizes.push(bytes.length);
        return { partNumber, etag: `part-${partNumber}` };
      },
      complete: (uploaded: { partNumber: number }[]) => {
        const ordered = uploaded.map((p) => parts.get(p.partNumber) as Uint8Array);
        const total = ordered.reduce((n, b) => n + b.length, 0);
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const part of ordered) {
          bytes.set(part, offset);
          offset += part.length;
        }
        return Promise.resolve(this.store(key, bytes, options.customMetadata ?? {}));
      },
      abort: () => Promise.resolve(),
    });
  }

  asBucket(): R2Bucket {
    return this as unknown as R2Bucket;
  }
}

export function testDeps(
  bucket: FakeR2,
  dos: FakeDos,
  db: D1Database,
  clock: { now: number },
  partSize?: number,
): BackupDeps {
  let n = 0;
  return {
    bucket: bucket.asBucket(),
    db,
    stub: (tenantId, name) => dos.stub(tenantId, name),
    now: () => clock.now,
    rand: () => {
      n += 1;
      return `r${String(n).padStart(8, '0')}`;
    },
    ...(partSize === undefined ? {} : { partSize }),
  };
}
