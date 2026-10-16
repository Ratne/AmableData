import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { installationMigrations } from '../src/migrations/installation/index';
import { tenantMigrations } from '../src/migrations/tenant/index';
import { latestSchemaVersion, type Migration } from '../src/migrations/types';
import {
  MigrationLockTimeoutError,
  MigrationOrderError,
  runMigrations,
} from '../src/runner/runner';
import { createNodeSqliteMigrationStore } from './node-sqlite-store';

const m1: Migration = {
  id: 1,
  name: 'init',
  statements: [
    `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    `CREATE TABLE items (id TEXT PRIMARY KEY, label TEXT NOT NULL)`,
  ],
};

const m2: Migration = {
  id: 2,
  name: 'add-archive-flag',
  statements: [`ALTER TABLE items ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`],
};

function countApplied(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM d1_migrations').get() as { n: number };
  return row.n;
}

function metaSchemaVersion(db: DatabaseSync): string {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as {
    value: string;
  };
  return row.value;
}

describe('runMigrations', () => {
  it('applies all migrations on a fresh database and reports the schema version', async () => {
    const db = new DatabaseSync(':memory:');
    const store = createNodeSqliteMigrationStore(db, { metaTable: 'meta' });

    const version = await runMigrations(store, [m1]);

    expect(version).toBe(1);
    expect(countApplied(db)).toBe(1);
    expect(metaSchemaVersion(db)).toBe('1');
    // The schema is actually usable.
    db.prepare(`INSERT INTO items (id, label) VALUES (?, ?)`).run('a', 'first');
  });

  it('is idempotent: a second boot with no pending migrations applies nothing', async () => {
    const db = new DatabaseSync(':memory:');
    const store = createNodeSqliteMigrationStore(db, { metaTable: 'meta' });

    await runMigrations(store, [m1]);
    const appliedAtBefore = (
      db.prepare('SELECT applied_at FROM d1_migrations WHERE id = 1').get() as {
        applied_at: number;
      }
    ).applied_at;

    const version = await runMigrations(store, [m1]);

    expect(version).toBe(1);
    expect(countApplied(db)).toBe(1);
    const appliedAtAfter = (
      db.prepare('SELECT applied_at FROM d1_migrations WHERE id = 1').get() as {
        applied_at: number;
      }
    ).applied_at;
    expect(appliedAtAfter).toBe(appliedAtBefore);
  });

  it('upgrades an existing database by applying only the new migration', async () => {
    const db = new DatabaseSync(':memory:');
    const store = createNodeSqliteMigrationStore(db, { metaTable: 'meta' });

    // Boot 1: fresh install on version 1.
    await runMigrations(store, [m1]);
    db.prepare(`INSERT INTO items (id, label) VALUES (?, ?)`).run('a', 'kept across upgrades');

    // Boot 2: new release ships migration 2.
    const version = await runMigrations(store, [m1, m2]);

    expect(version).toBe(2);
    expect(countApplied(db)).toBe(2);
    expect(metaSchemaVersion(db)).toBe('2');
    // Existing data survived and the new column is live.
    const row = db.prepare('SELECT label, archived FROM items WHERE id = ?').get('a') as {
      label: string;
      archived: number;
    };
    expect(row).toEqual({ label: 'kept across upgrades', archived: 0 });
  });

  it('leaves a database that is ahead of the running code untouched', async () => {
    const db = new DatabaseSync(':memory:');
    const store = createNodeSqliteMigrationStore(db, { metaTable: 'meta' });
    await runMigrations(store, [m1, m2]);

    // Older code (mid-rollout) only knows migration 1.
    const version = await runMigrations(store, [m1]);

    expect(version).toBe(2);
    expect(countApplied(db)).toBe(2);
  });

  it('rejects duplicate migration ids', async () => {
    const db = new DatabaseSync(':memory:');
    const store = createNodeSqliteMigrationStore(db);

    await expect(runMigrations(store, [m1, { ...m2, id: 1 }])).rejects.toBeInstanceOf(
      MigrationOrderError,
    );
  });

  it('times out when another instance holds the lock and never finishes', async () => {
    const db = new DatabaseSync(':memory:');
    const storeA = createNodeSqliteMigrationStore(db);
    const storeB = createNodeSqliteMigrationStore(db);

    await storeA.ensureReady();
    expect(await storeA.acquireLock(60_000)).toBe(true);

    await expect(
      runMigrations(storeB, [m1], { waitTimeoutMs: 200, pollIntervalMs: 20 }),
    ).rejects.toBeInstanceOf(MigrationLockTimeoutError);
  });

  it('waits for the instance holding the lock and returns once migrations are applied', async () => {
    const db = new DatabaseSync(':memory:');
    const storeA = createNodeSqliteMigrationStore(db, { metaTable: 'meta' });
    const storeB = createNodeSqliteMigrationStore(db, { metaTable: 'meta' });

    await storeA.ensureReady();
    expect(await storeA.acquireLock(60_000)).toBe(true);

    const waiting = runMigrations(storeB, [m1], { waitTimeoutMs: 5_000, pollIntervalMs: 20 });
    // Instance A finishes its work while B is polling.
    await storeA.apply(m1);
    await storeA.releaseLock();

    expect(await waiting).toBe(1);
    expect(countApplied(db)).toBe(1);
  });

  it('applies the real installation migrations cleanly', async () => {
    const db = new DatabaseSync(':memory:');
    const store = createNodeSqliteMigrationStore(db, { metaTable: 'installation_meta' });

    const version = await runMigrations(store, installationMigrations);

    const latest = latestSchemaVersion(installationMigrations);
    expect(version).toBe(latest);
    const row = db
      .prepare(`SELECT value FROM installation_meta WHERE key = 'schema_version'`)
      .get() as { value: string };
    expect(row.value).toBe(String(latest));
    // Spot-check the schema.
    db.prepare(`INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
      'u1',
      'admin@example.com',
      Date.now(),
      Date.now(),
    );
    db.prepare(`INSERT INTO tenants (id, slug, name, created_at) VALUES (?, ?, ?, ?)`).run(
      't1',
      'demo',
      'Demo',
      Date.now(),
    );
    db.prepare(
      `INSERT INTO memberships (user_id, tenant_id, role, created_at) VALUES (?, ?, ?, ?)`,
    ).run('u1', 't1', 'owner', Date.now());
  });

  it('applies the real tenant migrations cleanly', async () => {
    const db = new DatabaseSync(':memory:');
    const store = createNodeSqliteMigrationStore(db, {
      migrationsTable: 'do_migrations',
      metaTable: 'tenant_meta',
    });

    const version = await runMigrations(store, tenantMigrations);

    const latest = latestSchemaVersion(tenantMigrations);
    expect(version).toBe(latest);
    const row = db.prepare(`SELECT value FROM tenant_meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(row.value).toBe(String(latest));
  });
});
