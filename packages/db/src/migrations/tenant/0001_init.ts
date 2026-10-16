import type { Migration } from '../types';

/**
 * Tenant Durable Object SQLite schema — placeholder for the foundations phase.
 * The core-crm phase will add contacts, companies, tags, custom fields, etc.
 * as new migrations appended to `tenantMigrations`.
 */
export const t0001Init: Migration = {
  id: 1,
  name: 'init',
  statements: [
    `CREATE TABLE tenant_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
  ],
};
