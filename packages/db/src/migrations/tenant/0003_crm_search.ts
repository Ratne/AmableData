import type { Migration } from '../types';

/**
 * Search documents of the tenant DO.
 *
 * `crm_search_documents` holds one denormalized row per searchable record
 * (contact, company, note; orders later), maintained by the CRM services in
 * the same transaction as the mutation. The FTS5 index over it
 * (`crm_search_fts`, external content) is created at DO boot by the search
 * module rather than here: if FTS5 is ever unavailable the DO falls back to the
 * trigram table below + LIKE on `normalized`, without breaking migrations.
 */
export const t0003CrmSearch: Migration = {
  id: 3,
  name: 'crm_search',
  statements: [
    `CREATE TABLE crm_search_documents (
      doc_id INTEGER PRIMARY KEY,
      entity TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      normalized TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE UNIQUE INDEX crm_search_documents_entity ON crm_search_documents (entity, entity_id)`,
    `CREATE TABLE crm_search_trigrams (
      gram TEXT NOT NULL,
      doc_id INTEGER NOT NULL,
      PRIMARY KEY (gram, doc_id)
    ) WITHOUT ROWID`,
    `CREATE INDEX crm_search_trigrams_doc ON crm_search_trigrams (doc_id)`,
  ],
};
