import type { Migration } from '../types';

/**
 * Storage of marketplace apps inside the tenant:
 * - `app_data`: key/value per app (settings, cursors); `secret` values arrive
 *   encrypted by the core worker and are only returned to the app's own token;
 * - `app_entity_data`: values an app attaches to a contact, company, opportunity
 *   or order (namespaced by app), exported, merged and erased with the record;
 * - custom fields declared by an app are owned by it (`owner_app_id`) and cannot
 *   be deleted while it is installed.
 */
export const t0011Apps: Migration = {
  id: 11,
  name: 'apps',
  statements: [
    `CREATE TABLE app_data (
      app_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      secret INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (app_id, key)
    )`,
    `CREATE TABLE app_entity_data (
      app_id TEXT NOT NULL,
      entity TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (app_id, entity, entity_id, key)
    )`,
    `CREATE INDEX app_entity_data_record ON app_entity_data (entity, entity_id)`,
    `ALTER TABLE crm_custom_fields ADD COLUMN owner_app_id TEXT`,
  ],
};
