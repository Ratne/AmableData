import { integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Drizzle schema for the per-tenant Durable Object SQLite database.
 * Must stay in sync with packages/db/src/migrations/tenant/ — migrations are
 * the source of truth, this schema is the typed query layer for later modules
 * (reports, exports). The CRM services in apps/core/src/crm use parameterized
 * SQL through a small synchronous port so the dynamic query builder and the
 * vitest suite (node:sqlite) share one code path.
 */

const timestamps = {
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at'),
};

export const tenantMeta = sqliteTable('tenant_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const crmLeadSources = sqliteTable('crm_lead_sources', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  category: text('category'),
  createdAt: integer('created_at').notNull(),
  deletedAt: integer('deleted_at'),
});

export const crmCompanies = sqliteTable('crm_companies', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  website: text('website'),
  email: text('email'),
  phone: text('phone'),
  phoneExtension: text('phone_extension'),
  fax: text('fax'),
  addressLine1: text('address_line1'),
  addressLine2: text('address_line2'),
  addressLocality: text('address_locality'),
  addressRegion: text('address_region'),
  addressPostalCode: text('address_postal_code'),
  addressCountryCode: text('address_country_code'),
  description: text('description'),
  ownerId: text('owner_id'),
  createdBy: text('created_by'),
  ...timestamps,
});

export const crmContacts = sqliteTable('crm_contacts', {
  id: text('id').primaryKey(),
  givenName: text('given_name'),
  middleName: text('middle_name'),
  familyName: text('family_name'),
  prefix: text('prefix'),
  suffix: text('suffix'),
  preferredName: text('preferred_name'),
  jobTitle: text('job_title'),
  companyId: text('company_id'),
  birthday: text('birthday'),
  anniversary: text('anniversary'),
  website: text('website'),
  spouseName: text('spouse_name'),
  timeZone: text('time_zone'),
  preferredLocale: text('preferred_locale'),
  ownerId: text('owner_id'),
  leadSourceId: text('lead_source_id'),
  sourceType: text('source_type').notNull(),
  utmSource: text('utm_source'),
  utmMedium: text('utm_medium'),
  utmCampaign: text('utm_campaign'),
  utmTerm: text('utm_term'),
  utmContent: text('utm_content'),
  scoreValue: integer('score_value').notNull(),
  marketableStatus: text('marketable_status').notNull(),
  socialAccounts: text('social_accounts').notNull(),
  primaryEmail: text('primary_email'),
  primaryPhone: text('primary_phone'),
  mergedIntoId: text('merged_into_id'),
  createdBy: text('created_by'),
  ...timestamps,
});

export const crmContactEmails = sqliteTable('crm_contact_emails', {
  id: text('id').primaryKey(),
  contactId: text('contact_id').notNull(),
  email: text('email').notNull(),
  emailNormalized: text('email_normalized').notNull(),
  label: text('label'),
  isPrimary: integer('is_primary').notNull(),
  position: integer('position').notNull(),
});

export const crmContactPhones = sqliteTable('crm_contact_phones', {
  id: text('id').primaryKey(),
  contactId: text('contact_id').notNull(),
  number: text('number').notNull(),
  numberDigits: text('number_digits').notNull(),
  extension: text('extension'),
  type: text('type'),
  position: integer('position').notNull(),
});

export const crmContactAddresses = sqliteTable('crm_contact_addresses', {
  id: text('id').primaryKey(),
  contactId: text('contact_id').notNull(),
  type: text('type').notNull(),
  line1: text('line1'),
  streetNumber: text('street_number'),
  line2: text('line2'),
  locality: text('locality'),
  region: text('region'),
  postalCode: text('postal_code'),
  countryCode: text('country_code'),
  position: integer('position').notNull(),
});

export const crmTagCategories = sqliteTable('crm_tag_categories', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  ...timestamps,
});

export const crmTags = sqliteTable('crm_tags', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  categoryId: text('category_id'),
  ...timestamps,
});

export const crmContactTags = sqliteTable(
  'crm_contact_tags',
  {
    contactId: text('contact_id').notNull(),
    tagId: text('tag_id').notNull(),
    appliedAt: integer('applied_at').notNull(),
    appliedBy: text('applied_by'),
  },
  (table) => [primaryKey({ columns: [table.contactId, table.tagId] })],
);

export const crmCustomFields = sqliteTable('crm_custom_fields', {
  id: text('id').primaryKey(),
  entity: text('entity').notNull(),
  key: text('key').notNull(),
  label: text('label').notNull(),
  type: text('type').notNull(),
  groupId: text('group_id'),
  position: integer('position').notNull(),
  options: text('options').notNull(),
  config: text('config').notNull(),
  required: integer('required').notNull(),
  sensitive: integer('sensitive').notNull(),
  ...timestamps,
});

export const crmCustomFieldValues = sqliteTable(
  'crm_custom_field_values',
  {
    entity: text('entity').notNull(),
    entityId: text('entity_id').notNull(),
    fieldId: text('field_id').notNull(),
    valueText: text('value_text'),
    valueNumber: real('value_number'),
    valueJson: text('value_json'),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.entity, table.entityId, table.fieldId] })],
);

export const crmNotes = sqliteTable('crm_notes', {
  id: text('id').primaryKey(),
  contactId: text('contact_id'),
  companyId: text('company_id'),
  opportunityId: text('opportunity_id'),
  title: text('title'),
  type: text('type').notNull(),
  bodyJson: text('body_json').notNull(),
  bodyText: text('body_text').notNull(),
  pinned: integer('pinned').notNull(),
  createdBy: text('created_by'),
  ...timestamps,
});

export const crmTasks = sqliteTable('crm_tasks', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  descriptionJson: text('description_json'),
  contactId: text('contact_id'),
  companyId: text('company_id'),
  opportunityId: text('opportunity_id'),
  assignedTo: text('assigned_to'),
  dueAt: integer('due_at'),
  priority: text('priority').notNull(),
  type: text('type').notNull(),
  status: text('status').notNull(),
  completedAt: integer('completed_at'),
  completedBy: text('completed_by'),
  createdBy: text('created_by'),
  ...timestamps,
});

export const crmAppointments = sqliteTable('crm_appointments', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description'),
  location: text('location'),
  startAt: integer('start_at').notNull(),
  endAt: integer('end_at').notNull(),
  allDay: integer('all_day').notNull(),
  timeZone: text('time_zone'),
  contactId: text('contact_id'),
  companyId: text('company_id'),
  opportunityId: text('opportunity_id'),
  ownerId: text('owner_id'),
  attendees: text('attendees').notNull(),
  reminderMinutes: text('reminder_minutes').notNull(),
  status: text('status').notNull(),
  source: text('source').notNull(),
  createdBy: text('created_by'),
  ...timestamps,
});

export const crmPipelines = sqliteTable('crm_pipelines', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  isDefault: integer('is_default').notNull(),
  position: integer('position').notNull(),
  ...timestamps,
});

export const crmPipelineStages = sqliteTable('crm_pipeline_stages', {
  id: text('id').primaryKey(),
  pipelineId: text('pipeline_id').notNull(),
  name: text('name').notNull(),
  probability: integer('probability').notNull(),
  kind: text('kind').notNull(),
  position: integer('position').notNull(),
  ...timestamps,
});

export const crmOpportunities = sqliteTable('crm_opportunities', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  pipelineId: text('pipeline_id').notNull(),
  stageId: text('stage_id').notNull(),
  status: text('status').notNull(),
  contactId: text('contact_id'),
  companyId: text('company_id'),
  ownerId: text('owner_id'),
  valueMinor: integer('value_minor').notNull(),
  currency: text('currency').notNull(),
  expectedCloseDate: text('expected_close_date'),
  lostReason: text('lost_reason'),
  nextAction: text('next_action'),
  nextActionAt: integer('next_action_at'),
  stageChangedAt: integer('stage_changed_at').notNull(),
  closedAt: integer('closed_at'),
  createdBy: text('created_by'),
  ...timestamps,
});

export const crmOpportunityStageHistory = sqliteTable('crm_opportunity_stage_history', {
  id: text('id').primaryKey(),
  opportunityId: text('opportunity_id').notNull(),
  fromStageId: text('from_stage_id'),
  toStageId: text('to_stage_id').notNull(),
  changedBy: text('changed_by'),
  changedAt: integer('changed_at').notNull(),
});

export const crmActivities = sqliteTable('crm_activities', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  contactId: text('contact_id'),
  companyId: text('company_id'),
  opportunityId: text('opportunity_id'),
  actorType: text('actor_type').notNull(),
  actorId: text('actor_id'),
  data: text('data').notNull(),
  occurredAt: integer('occurred_at').notNull(),
});

export const crmOutbox = sqliteTable('crm_outbox', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  payload: text('payload').notNull(),
  actorType: text('actor_type').notNull(),
  actorId: text('actor_id'),
  occurredAt: integer('occurred_at').notNull(),
  dispatchedAt: integer('dispatched_at'),
  attempts: integer('attempts').notNull(),
});

export const crmSavedSearches = sqliteTable('crm_saved_searches', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  entity: text('entity').notNull(),
  query: text('query').notNull(),
  shared: integer('shared').notNull(),
  ownerId: text('owner_id'),
  ...timestamps,
});

export const crmSearchDocuments = sqliteTable('crm_search_documents', {
  docId: integer('doc_id').primaryKey(),
  entity: text('entity').notNull(),
  entityId: text('entity_id').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  normalized: text('normalized').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const esignTemplates = sqliteTable('esign_templates', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  status: text('status').notNull(),
  sourceR2Key: text('source_r2_key'),
  sourceFilename: text('source_filename'),
  sourceSize: integer('source_size'),
  sourceSha256: text('source_sha256'),
  pages: text('pages').notNull(),
  parties: text('parties').notNull(),
  signingOrder: text('signing_order').notNull(),
  fields: text('fields').notNull(),
  settings: text('settings').notNull(),
  createdBy: text('created_by'),
  ...timestamps,
});

export const esignRequests = sqliteTable('esign_requests', {
  id: text('id').primaryKey(),
  templateId: text('template_id').notNull(),
  name: text('name').notNull(),
  status: text('status').notNull(),
  signingOrder: text('signing_order').notNull(),
  parties: text('parties').notNull(),
  fields: text('fields').notNull(),
  pages: text('pages').notNull(),
  settings: text('settings').notNull(),
  sourceR2Key: text('source_r2_key').notNull(),
  sourceSha256: text('source_sha256').notNull(),
  completedR2Key: text('completed_r2_key'),
  completedSha256: text('completed_sha256'),
  finalizeDueAt: integer('finalize_due_at'),
  finalizeAttempts: integer('finalize_attempts').notNull(),
  finalizeError: text('finalize_error'),
  origin: text('origin').notNull(),
  originRef: text('origin_ref'),
  message: text('message').notNull(),
  locale: text('locale').notNull(),
  createdBy: text('created_by'),
  expiresAt: integer('expires_at'),
  completedAt: integer('completed_at'),
  declinedAt: integer('declined_at'),
  voidedAt: integer('voided_at'),
  voidReason: text('void_reason'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const esignSigners = sqliteTable('esign_signers', {
  id: text('id').primaryKey(),
  requestId: text('request_id').notNull(),
  partyId: text('party_id').notNull(),
  partyName: text('party_name').notNull(),
  position: integer('position').notNull(),
  contactId: text('contact_id'),
  email: text('email').notNull(),
  name: text('name').notNull(),
  status: text('status').notNull(),
  tokenNonce: text('token_nonce').notNull(),
  tokenHash: text('token_hash'),
  fieldValues: text('field_values').notNull(),
  otpHash: text('otp_hash'),
  otpExpiresAt: integer('otp_expires_at'),
  otpAttempts: integer('otp_attempts').notNull(),
  otpSends: text('otp_sends').notNull(),
  otpVerifiedAt: integer('otp_verified_at'),
  consentAt: integer('consent_at'),
  notifyDueAt: integer('notify_due_at'),
  nextReminderAt: integer('next_reminder_at'),
  remindersSent: integer('reminders_sent').notNull(),
  sentAt: integer('sent_at'),
  openedAt: integer('opened_at'),
  completedAt: integer('completed_at'),
  declinedAt: integer('declined_at'),
  declineReason: text('decline_reason'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const esignEvents = sqliteTable('esign_events', {
  id: text('id').primaryKey(),
  requestId: text('request_id').notNull(),
  signerId: text('signer_id'),
  type: text('type').notNull(),
  actorType: text('actor_type').notNull(),
  actorId: text('actor_id'),
  ip: text('ip'),
  userAgent: text('user_agent'),
  country: text('country'),
  meta: text('meta').notNull(),
  occurredAt: integer('occurred_at').notNull(),
});
