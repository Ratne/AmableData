export type { Migration } from './migrations/types';
export { latestSchemaVersion } from './migrations/types';
export { nonAdditiveStatements, type AllowedNonAdditive, type NonAdditiveStatement } from './migrations/additive';
export { installationMigrations } from './migrations/installation/index';
export { tenantMigrations } from './migrations/tenant/index';

export {
  runMigrations,
  MigrationOrderError,
  MigrationLockTimeoutError,
} from './runner/runner';
export type { MigrationStore, RunMigrationsOptions } from './runner/runner';
export { createD1MigrationStore } from './runner/d1';
export type { D1MigrationStoreOptions } from './runner/d1';
export { createDoSqliteMigrationStore } from './runner/do-sqlite';
export type { DoSqliteMigrationStoreOptions } from './runner/do-sqlite';

export * as installationSchema from './schema/installation';
export * as tenantSchema from './schema/tenant';
