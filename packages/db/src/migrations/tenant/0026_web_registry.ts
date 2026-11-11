import type { Migration } from '../types';

/**
 * Web registry: contact data split off the analytics events reaches the
 * workspace here (the site DOs hold hashes only).
 *
 * - `crm_identity_hashes`: SHA-256 of normalized emails / E.164 phones → the
 *   contact, so a site's hashed identity resolves without clear data.
 * - `crm_web_fields`: contact fields last written by the web registry, with the
 *   value and the event time of that write: a newer web value replaces an older
 *   web value still in place, never a value typed by a person.
 * - `crm_registry_applied`: registrations already applied (event id), pruned
 *   after the queue's replay horizon.
 */
export const t0026WebRegistry: Migration = {
  id: 26,
  name: 'web_registry',
  statements: [
    `CREATE TABLE crm_identity_hashes (
      kind TEXT NOT NULL,
      hash TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (kind, hash)
    )`,
    `CREATE INDEX crm_identity_hashes_contact ON crm_identity_hashes (contact_id)`,
    `CREATE TABLE crm_web_fields (
      contact_id TEXT NOT NULL,
      field TEXT NOT NULL,
      ts INTEGER NOT NULL,
      value TEXT,
      PRIMARY KEY (contact_id, field)
    )`,
    `CREATE TABLE crm_registry_applied (
      eid TEXT PRIMARY KEY,
      contact_id TEXT,
      applied_at INTEGER NOT NULL
    )`,
    `CREATE INDEX crm_registry_applied_at ON crm_registry_applied (applied_at)`,
  ],
};
