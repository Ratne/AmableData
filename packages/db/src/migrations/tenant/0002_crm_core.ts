import type { Migration } from '../types';

/**
 * Core CRM schema of the tenant Durable Object.
 *
 * Conventions: ids are ULIDs (TEXT), timestamps are epoch milliseconds
 * (INTEGER), soft delete via `deleted_at`, JSON stored as TEXT. User ids
 * (owner, assignee, created_by) reference the installation D1 `users` table
 * and are therefore plain TEXT without foreign keys.
 */
export const t0002CrmCore: Migration = {
  id: 2,
  name: 'crm_core',
  statements: [
    // ------------------------------------------------------------- lookups
    `CREATE TABLE crm_lead_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT,
      created_at INTEGER NOT NULL,
      deleted_at INTEGER
    )`,
    `CREATE UNIQUE INDEX crm_lead_sources_name ON crm_lead_sources (name) WHERE deleted_at IS NULL`,

    // ----------------------------------------------------------- companies
    `CREATE TABLE crm_companies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      website TEXT,
      email TEXT,
      phone TEXT,
      phone_extension TEXT,
      fax TEXT,
      address_line1 TEXT,
      address_line2 TEXT,
      address_locality TEXT,
      address_region TEXT,
      address_postal_code TEXT,
      address_country_code TEXT,
      description TEXT,
      owner_id TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )`,
    `CREATE INDEX crm_companies_name ON crm_companies (name COLLATE NOCASE)`,
    `CREATE INDEX crm_companies_owner ON crm_companies (owner_id)`,

    // ------------------------------------------------------------ contacts
    `CREATE TABLE crm_contacts (
      id TEXT PRIMARY KEY,
      given_name TEXT,
      middle_name TEXT,
      family_name TEXT,
      prefix TEXT,
      suffix TEXT,
      preferred_name TEXT,
      job_title TEXT,
      company_id TEXT REFERENCES crm_companies (id),
      birthday TEXT,
      anniversary TEXT,
      website TEXT,
      spouse_name TEXT,
      time_zone TEXT,
      preferred_locale TEXT,
      owner_id TEXT,
      lead_source_id TEXT REFERENCES crm_lead_sources (id),
      source_type TEXT NOT NULL DEFAULT 'manual',
      utm_source TEXT,
      utm_medium TEXT,
      utm_campaign TEXT,
      utm_term TEXT,
      utm_content TEXT,
      score_value INTEGER NOT NULL DEFAULT 0,
      marketable_status TEXT NOT NULL DEFAULT 'unknown',
      social_accounts TEXT NOT NULL DEFAULT '[]',
      -- denormalized from crm_contact_emails/phones (primary entry) for search/sort
      primary_email TEXT,
      primary_phone TEXT,
      merged_into_id TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )`,
    `CREATE INDEX crm_contacts_primary_email ON crm_contacts (primary_email)`,
    `CREATE INDEX crm_contacts_family_name ON crm_contacts (family_name COLLATE NOCASE)`,
    `CREATE INDEX crm_contacts_owner ON crm_contacts (owner_id)`,
    `CREATE INDEX crm_contacts_company ON crm_contacts (company_id)`,
    `CREATE INDEX crm_contacts_updated ON crm_contacts (updated_at)`,
    `CREATE INDEX crm_contacts_created ON crm_contacts (created_at)`,

    `CREATE TABLE crm_contact_emails (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL REFERENCES crm_contacts (id),
      email TEXT NOT NULL,
      email_normalized TEXT NOT NULL,
      label TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX crm_contact_emails_contact ON crm_contact_emails (contact_id)`,
    `CREATE INDEX crm_contact_emails_normalized ON crm_contact_emails (email_normalized)`,

    `CREATE TABLE crm_contact_phones (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL REFERENCES crm_contacts (id),
      number TEXT NOT NULL,
      number_digits TEXT NOT NULL,
      extension TEXT,
      type TEXT,
      position INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX crm_contact_phones_contact ON crm_contact_phones (contact_id)`,
    `CREATE INDEX crm_contact_phones_digits ON crm_contact_phones (number_digits)`,

    `CREATE TABLE crm_contact_addresses (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL REFERENCES crm_contacts (id),
      type TEXT NOT NULL DEFAULT 'billing',
      line1 TEXT,
      line2 TEXT,
      locality TEXT,
      region TEXT,
      postal_code TEXT,
      country_code TEXT,
      position INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX crm_contact_addresses_contact ON crm_contact_addresses (contact_id)`,

    // ---------------------------------------------------------------- tags
    `CREATE TABLE crm_tag_categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )`,
    `CREATE UNIQUE INDEX crm_tag_categories_name ON crm_tag_categories (name COLLATE NOCASE) WHERE deleted_at IS NULL`,

    `CREATE TABLE crm_tags (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      category_id TEXT REFERENCES crm_tag_categories (id),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )`,
    `CREATE UNIQUE INDEX crm_tags_name ON crm_tags (name COLLATE NOCASE, IFNULL(category_id, '')) WHERE deleted_at IS NULL`,

    `CREATE TABLE crm_contact_tags (
      contact_id TEXT NOT NULL REFERENCES crm_contacts (id),
      tag_id TEXT NOT NULL REFERENCES crm_tags (id),
      applied_at INTEGER NOT NULL,
      applied_by TEXT,
      PRIMARY KEY (contact_id, tag_id)
    ) WITHOUT ROWID`,
    `CREATE INDEX crm_contact_tags_tag ON crm_contact_tags (tag_id, contact_id)`,

    // ------------------------------------------------------- custom fields
    `CREATE TABLE crm_custom_field_tabs (
      id TEXT PRIMARY KEY,
      entity TEXT NOT NULL,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      deleted_at INTEGER
    )`,
    `CREATE TABLE crm_custom_field_groups (
      id TEXT PRIMARY KEY,
      tab_id TEXT NOT NULL REFERENCES crm_custom_field_tabs (id),
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      deleted_at INTEGER
    )`,
    `CREATE TABLE crm_custom_fields (
      id TEXT PRIMARY KEY,
      entity TEXT NOT NULL,
      key TEXT NOT NULL,
      label TEXT NOT NULL,
      type TEXT NOT NULL,
      group_id TEXT REFERENCES crm_custom_field_groups (id),
      position INTEGER NOT NULL DEFAULT 0,
      options TEXT NOT NULL DEFAULT '[]',
      config TEXT NOT NULL DEFAULT '{}',
      required INTEGER NOT NULL DEFAULT 0,
      sensitive INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )`,
    `CREATE UNIQUE INDEX crm_custom_fields_key ON crm_custom_fields (entity, key) WHERE deleted_at IS NULL`,

    // One row per (entity, record, field). Scalar text-like values in value_text,
    // numeric/boolean values in value_number, multi values (JSON array) in
    // value_json with a display copy in value_text.
    `CREATE TABLE crm_custom_field_values (
      entity TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      field_id TEXT NOT NULL REFERENCES crm_custom_fields (id),
      value_text TEXT,
      value_number REAL,
      value_json TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (entity, entity_id, field_id)
    ) WITHOUT ROWID`,
    `CREATE INDEX crm_cfv_field_text ON crm_custom_field_values (field_id, value_text)`,
    `CREATE INDEX crm_cfv_field_number ON crm_custom_field_values (field_id, value_number)`,

    // --------------------------------------------------------------- notes
    `CREATE TABLE crm_notes (
      id TEXT PRIMARY KEY,
      contact_id TEXT REFERENCES crm_contacts (id),
      company_id TEXT REFERENCES crm_companies (id),
      opportunity_id TEXT,
      title TEXT,
      type TEXT NOT NULL DEFAULT 'note',
      body_json TEXT NOT NULL,
      body_text TEXT NOT NULL DEFAULT '',
      pinned INTEGER NOT NULL DEFAULT 0,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )`,
    `CREATE INDEX crm_notes_contact ON crm_notes (contact_id, created_at)`,
    `CREATE INDEX crm_notes_company ON crm_notes (company_id, created_at)`,
    `CREATE INDEX crm_notes_opportunity ON crm_notes (opportunity_id, created_at)`,

    // ------------------------------------------------- tasks & appointments
    `CREATE TABLE crm_tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description_json TEXT,
      contact_id TEXT REFERENCES crm_contacts (id),
      company_id TEXT REFERENCES crm_companies (id),
      opportunity_id TEXT,
      assigned_to TEXT,
      due_at INTEGER,
      priority TEXT NOT NULL DEFAULT 'normal',
      type TEXT NOT NULL DEFAULT 'todo',
      status TEXT NOT NULL DEFAULT 'open',
      completed_at INTEGER,
      completed_by TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )`,
    `CREATE INDEX crm_tasks_assignee_due ON crm_tasks (assigned_to, status, due_at)`,
    `CREATE INDEX crm_tasks_due ON crm_tasks (due_at)`,
    `CREATE INDEX crm_tasks_contact ON crm_tasks (contact_id)`,

    `CREATE TABLE crm_appointments (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      location TEXT,
      start_at INTEGER NOT NULL,
      end_at INTEGER NOT NULL,
      all_day INTEGER NOT NULL DEFAULT 0,
      time_zone TEXT,
      contact_id TEXT REFERENCES crm_contacts (id),
      company_id TEXT REFERENCES crm_companies (id),
      opportunity_id TEXT,
      owner_id TEXT,
      attendees TEXT NOT NULL DEFAULT '[]',
      reminder_minutes TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'scheduled',
      source TEXT NOT NULL DEFAULT 'manual',
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )`,
    `CREATE INDEX crm_appointments_range ON crm_appointments (start_at, end_at)`,
    `CREATE INDEX crm_appointments_owner ON crm_appointments (owner_id, start_at)`,
    `CREATE INDEX crm_appointments_contact ON crm_appointments (contact_id)`,

    // ------------------------------------------------ pipelines & deals
    `CREATE TABLE crm_pipelines (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )`,
    `CREATE TABLE crm_pipeline_stages (
      id TEXT PRIMARY KEY,
      pipeline_id TEXT NOT NULL REFERENCES crm_pipelines (id),
      name TEXT NOT NULL,
      probability INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL DEFAULT 'open',
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )`,
    `CREATE INDEX crm_pipeline_stages_pipeline ON crm_pipeline_stages (pipeline_id, position)`,

    `CREATE TABLE crm_opportunities (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      pipeline_id TEXT NOT NULL REFERENCES crm_pipelines (id),
      stage_id TEXT NOT NULL REFERENCES crm_pipeline_stages (id),
      status TEXT NOT NULL DEFAULT 'open',
      contact_id TEXT REFERENCES crm_contacts (id),
      company_id TEXT REFERENCES crm_companies (id),
      owner_id TEXT,
      value_minor INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'EUR',
      expected_close_date TEXT,
      lost_reason TEXT,
      next_action TEXT,
      next_action_at INTEGER,
      stage_changed_at INTEGER NOT NULL,
      closed_at INTEGER,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )`,
    `CREATE INDEX crm_opportunities_stage ON crm_opportunities (pipeline_id, stage_id)`,
    `CREATE INDEX crm_opportunities_contact ON crm_opportunities (contact_id)`,
    `CREATE INDEX crm_opportunities_owner ON crm_opportunities (owner_id)`,

    `CREATE TABLE crm_opportunity_stage_history (
      id TEXT PRIMARY KEY,
      opportunity_id TEXT NOT NULL REFERENCES crm_opportunities (id),
      from_stage_id TEXT,
      to_stage_id TEXT NOT NULL,
      changed_by TEXT,
      changed_at INTEGER NOT NULL
    )`,
    `CREATE INDEX crm_opp_history_opp ON crm_opportunity_stage_history (opportunity_id, changed_at)`,

    // ------------------------------------------ activity timeline & outbox
    `CREATE TABLE crm_activities (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      contact_id TEXT,
      company_id TEXT,
      opportunity_id TEXT,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      data TEXT NOT NULL DEFAULT '{}',
      occurred_at INTEGER NOT NULL
    )`,
    `CREATE INDEX crm_activities_contact ON crm_activities (contact_id, id)`,
    `CREATE INDEX crm_activities_company ON crm_activities (company_id, id)`,
    `CREATE INDEX crm_activities_opportunity ON crm_activities (opportunity_id, id)`,

    // Transactional outbox: written in the same transaction as the mutation,
    // drained by the automation engine (at-least-once, ordered by id).
    `CREATE TABLE crm_outbox (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      occurred_at INTEGER NOT NULL,
      dispatched_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX crm_outbox_pending ON crm_outbox (dispatched_at, id)`,

    // ------------------------------------------------------ saved searches
    `CREATE TABLE crm_saved_searches (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      entity TEXT NOT NULL,
      query TEXT NOT NULL,
      shared INTEGER NOT NULL DEFAULT 1,
      owner_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )`,

    // --------------------------------------------------------- CSV imports
    `CREATE TABLE crm_imports (
      id TEXT PRIMARY KEY,
      entity TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      mapping TEXT NOT NULL,
      options TEXT NOT NULL DEFAULT '{}',
      total_rows INTEGER NOT NULL DEFAULT 0,
      created INTEGER NOT NULL DEFAULT 0,
      updated INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      errors TEXT NOT NULL DEFAULT '[]',
      created_by TEXT,
      created_at INTEGER NOT NULL,
      finished_at INTEGER
    )`,

    // ---------------------------------------------------- idempotency keys
    `CREATE TABLE crm_idempotency_keys (
      key TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      status INTEGER,
      response TEXT,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX crm_idempotency_created ON crm_idempotency_keys (created_at)`,
  ],
};
