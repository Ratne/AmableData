/**
 * A single versioned schema migration.
 *
 * Migrations are plain data (no code execution) so they can run identically
 * against the installation D1 database and against the SQLite storage of a
 * Durable Object. Statements execute in order inside one transaction.
 */
export interface Migration {
  /** Unique, strictly increasing positive integer. Defines apply order. */
  readonly id: number;
  /** Short human-readable name, e.g. "init". */
  readonly name: string;
  /** SQL statements executed in order, atomically with the bookkeeping row. */
  readonly statements: readonly string[];
}

/** Highest migration id in a list — the schema version a fully migrated DB reports. */
export function latestSchemaVersion(migrations: readonly Migration[]): number {
  return migrations.reduce((max, m) => (m.id > max ? m.id : max), 0);
}
