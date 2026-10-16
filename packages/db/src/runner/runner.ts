import type { Migration } from '../migrations/types';

/**
 * Storage abstraction the migration runner operates on.
 *
 * Implementations exist for:
 * - installation D1 (`createD1MigrationStore`) — locking via a lease row, atomicity via `batch()`;
 * - Durable Object SQLite (`createDoSqliteMigrationStore`) — the DO execution model already
 *   serializes access, atomicity via `transactionSync()`;
 * - node:sqlite (tests only).
 */
export interface MigrationStore {
  /** Create the runner bookkeeping tables (applied-migrations + lock). Idempotent. */
  ensureReady(): Promise<void>;
  /** Ids of migrations that are already applied. */
  appliedIds(): Promise<ReadonlySet<number>>;
  /**
   * Apply one migration atomically: all its statements plus the bookkeeping row
   * (and the schema_version meta upsert, when the store is configured with a meta table).
   */
  apply(migration: Migration): Promise<void>;
  /**
   * Advisory lock so concurrent boots don't apply migrations twice.
   * Returns true when acquired. The lease must expire on its own so a crashed
   * instance can never deadlock the fleet.
   */
  acquireLock(leaseMs: number): Promise<boolean>;
  releaseLock(): Promise<void>;
}

export interface RunMigrationsOptions {
  /** Lease duration for the advisory lock (ms). Default 30_000. */
  readonly lockLeaseMs?: number;
  /** How long to wait for another instance that holds the lock (ms). Default 15_000. */
  readonly waitTimeoutMs?: number;
  /** Poll interval while waiting on another instance (ms). Default 250. */
  readonly pollIntervalMs?: number;
  /** Optional logger, e.g. console.log in dev. */
  readonly log?: (message: string) => void;
}

export class MigrationOrderError extends Error {
  override readonly name = 'MigrationOrderError';
}

export class MigrationLockTimeoutError extends Error {
  override readonly name = 'MigrationLockTimeoutError';
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Validates ids are unique, positive integers, and returns the list sorted by id. */
export function sortAndValidate(migrations: readonly Migration[]): readonly Migration[] {
  const sorted = [...migrations].sort((a, b) => a.id - b.id);
  let previous = 0;
  for (const migration of sorted) {
    if (!Number.isInteger(migration.id) || migration.id <= 0) {
      throw new MigrationOrderError(
        `Migration "${migration.name}" has invalid id ${migration.id}: ids must be positive integers`,
      );
    }
    if (migration.id === previous) {
      throw new MigrationOrderError(`Duplicate migration id ${migration.id}`);
    }
    previous = migration.id;
  }
  return sorted;
}

function schemaVersionOf(applied: ReadonlySet<number>): number {
  let max = 0;
  for (const id of applied) {
    if (id > max) max = id;
  }
  return max;
}

/**
 * Applies every pending migration in order and returns the resulting schema version
 * (the highest applied migration id).
 *
 * Designed to run at every boot:
 * - when nothing is pending it costs a single SELECT;
 * - concurrent boots coordinate through the store's advisory lock;
 * - a database that is already ahead of the running code (mid-rollout fleet) is
 *   left untouched and its version is reported as-is.
 */
export async function runMigrations(
  store: MigrationStore,
  migrations: readonly Migration[],
  options: RunMigrationsOptions = {},
): Promise<number> {
  const lockLeaseMs = options.lockLeaseMs ?? 30_000;
  const waitTimeoutMs = options.waitTimeoutMs ?? 15_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const log = options.log ?? (() => undefined);

  const ordered = sortAndValidate(migrations);
  await store.ensureReady();

  const pendingOf = (applied: ReadonlySet<number>): readonly Migration[] =>
    ordered.filter((m) => !applied.has(m.id));

  let applied = await store.appliedIds();
  if (pendingOf(applied).length === 0) {
    return schemaVersionOf(applied);
  }

  const deadline = Date.now() + waitTimeoutMs;
  for (;;) {
    if (await store.acquireLock(lockLeaseMs)) {
      try {
        // Re-read inside the lock: another instance may have just finished.
        applied = await store.appliedIds();
        for (const migration of pendingOf(applied)) {
          log(`applying migration ${migration.id} (${migration.name})`);
          await store.apply(migration);
        }
      } finally {
        await store.releaseLock();
      }
      return schemaVersionOf(await store.appliedIds());
    }

    // Someone else is migrating: wait for them instead of racing.
    if (Date.now() >= deadline) {
      throw new MigrationLockTimeoutError(
        `Timed out after ${waitTimeoutMs}ms waiting for another instance to finish migrating`,
      );
    }
    await sleep(pollIntervalMs);
    applied = await store.appliedIds();
    if (pendingOf(applied).length === 0) {
      return schemaVersionOf(applied);
    }
  }
}
