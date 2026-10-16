import type { DeliveryStatus, SubmissionStatus } from '@amable/api-types';
import type { PublicSourceFacts } from '@amable/core';
import {
  displayValue,
  type FormDefinition,
  type SubmissionMeta,
  type SubmissionValues,
} from '@amable/forms';
import type { CrmContext } from '../crm/context';
import type { SqlValue } from '../crm/db/sql';
import { CrmError, notFound } from '../crm/errors';
import { emit } from '../crm/events';
import { loadFieldDefs } from '../crm/custom-fields/repo';
import { getContactRow } from '../crm/contacts';
import { decodeCursor, paginate, parseJson } from '../crm/util';
import { getFormRow, storedDefinition } from './forms';
import { applyToContact, type SubmissionTracking } from './mapping';

export interface SubmissionRow {
  id: string;
  form_id: string;
  status: SubmissionStatus;
  ciphertext: string;
  contact_id: string | null;
  contact_created: number;
  error: string | null;
  warnings: string;
  attempts: number;
  visitor_id: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
  referrer: string | null;
  page_url: string | null;
  page_id: string | null;
  country: string | null;
  created_at: number;
  processed_at: number | null;
  deleted_at: number | null;
}

export interface DeliveryRow {
  id: string;
  submission_id: string;
  connection_id: string;
  connection_name: string;
  connection_type: string;
  status: DeliveryStatus;
  attempts: number;
  status_code: number | null;
  request: string | null;
  response: string | null;
  created_at: number;
  updated_at: number;
}

/** Decrypted content of a submission (what `ciphertext` holds). */
export interface SubmissionContent {
  values: SubmissionValues;
  tracking: Record<string, string>;
  meta: SubmissionMeta;
}

export interface StoreSubmissionInput {
  id: string;
  formId: string;
  ciphertext: string;
  visitorId: string | null;
  country: string | null;
  source: {
    utm_source: string | null;
    utm_medium: string | null;
    utm_campaign: string | null;
    utm_term: string | null;
    utm_content: string | null;
    referrer: string | null;
    page_url: string | null;
    page_id: string | null;
  };
}

const cap = (value: string | null, max: number): string | null =>
  value === null || value === '' ? null : value.slice(0, max);

/** Stores a pending submission of an active form (the worker already validated and encrypted it). */
export function storeSubmission(ctx: CrmContext, input: StoreSubmissionInput): { id: string } {
  const form = ctx.db.all<{ id: string }>(
    `SELECT id FROM form_forms WHERE id = ? AND deleted_at IS NULL AND archived_at IS NULL AND status = 'active'`,
    input.formId,
  )[0];
  if (form === undefined) throw new CrmError('not_found', 'form not found');
  const now = ctx.now();
  const s = input.source;
  ctx.db.run(
    `INSERT INTO form_submissions
       (id, form_id, status, ciphertext, visitor_id, utm_source, utm_medium, utm_campaign, utm_term,
        utm_content, referrer, page_url, page_id, country, created_at)
     VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.id,
    input.formId,
    input.ciphertext,
    cap(input.visitorId, 64),
    cap(s.utm_source, 255),
    cap(s.utm_medium, 255),
    cap(s.utm_campaign, 255),
    cap(s.utm_term, 255),
    cap(s.utm_content, 255),
    cap(s.referrer, 2048),
    cap(s.page_url, 2048),
    cap(s.page_id, 64),
    cap(input.country, 2),
    now,
  );
  ctx.db.run(
    `UPDATE form_forms SET submission_count = submission_count + 1, last_submission_at = ? WHERE id = ?`,
    now,
    input.formId,
  );
  return { id: input.id };
}

function submissionRow(ctx: CrmContext, id: string, formId?: string): SubmissionRow {
  const row = ctx.db.all<SubmissionRow>(
    `SELECT * FROM form_submissions WHERE id = ? AND deleted_at IS NULL ${formId === undefined ? '' : 'AND form_id = ?'}`,
    ...(formId === undefined ? [id] : [id, formId]),
  )[0];
  if (row === undefined) throw notFound('submission', id);
  return row;
}

export function deliveriesOf(ctx: CrmContext, submissionIds: string[]): Map<string, DeliveryRow[]> {
  const out = new Map<string, DeliveryRow[]>(submissionIds.map((id) => [id, []]));
  if (submissionIds.length === 0) return out;
  for (let i = 0; i < submissionIds.length; i += 90) {
    const chunk = submissionIds.slice(i, i + 90);
    const rows = ctx.db.all<DeliveryRow>(
      `SELECT d.*, c.name AS connection_name, c.type AS connection_type
       FROM form_deliveries d JOIN form_connections c ON c.id = d.connection_id
       WHERE d.submission_id IN (${chunk.map(() => '?').join(', ')}) ORDER BY d.created_at, d.id`,
      ...chunk,
    );
    for (const row of rows) out.get(row.submission_id)?.push(row);
  }
  return out;
}

export interface ConnectionRow {
  id: string;
  form_id: string;
  type: string;
  name: string;
  enabled: number;
  config: string;
  secret_ciphertext: string | null;
  secret_hint: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface LoadedSubmission {
  submission: SubmissionRow;
  form: { id: string; name: string; definition: FormDefinition };
  connections: ConnectionRow[];
  deliveries: DeliveryRow[];
}

/** Everything the worker needs to process a submission (ciphertexts included). */
export function loadSubmission(ctx: CrmContext, input: { id: string }): LoadedSubmission {
  const submission = submissionRow(ctx, input.id);
  const formRow = ctx.db.all<{ id: string; name: string; definition: string }>(
    `SELECT id, name, definition FROM form_forms WHERE id = ?`,
    submission.form_id,
  )[0];
  if (formRow === undefined) throw notFound('form', submission.form_id);
  const connections = ctx.db.all<ConnectionRow>(
    `SELECT * FROM form_connections WHERE form_id = ? AND deleted_at IS NULL ORDER BY created_at, id`,
    submission.form_id,
  );
  return {
    submission,
    form: { id: formRow.id, name: formRow.name, definition: storedDefinition(formRow) },
    connections,
    deliveries: deliveriesOf(ctx, [submission.id]).get(submission.id) ?? [],
  };
}

const EVENT_FIELD_MAX = 200;
const EVENT_FIELDS_LIMIT = 50;

/** Field key → display value for the event: truncated, sensitive fields (or mapped to sensitive custom fields) omitted. */
function eventFields(ctx: CrmContext, definition: FormDefinition, values: SubmissionValues): Record<string, string> {
  const sensitiveCustom = new Set(
    loadFieldDefs(ctx, 'contact')
      .filter((d) => d.sensitive)
      .map((d) => `custom.${d.key}`),
  );
  const out: Record<string, string> = {};
  for (const field of definition.fields) {
    const value = values[field.key];
    if (value === undefined || field.sensitive) continue;
    if (field.map_to !== null && sensitiveCustom.has(field.map_to)) continue;
    if (Object.keys(out).length >= EVENT_FIELDS_LIMIT) break;
    out[field.key] = displayValue(field, value).slice(0, EVENT_FIELD_MAX);
  }
  return out;
}

export interface ApplySubmissionResult {
  contactId: string | null;
  contactCreated: boolean;
  alreadyProcessed: boolean;
}

/**
 * The CRM half of processing, in one transaction: create/update the contact,
 * apply tags, emit `form.submitted`, mark the submission processed.
 */
export function applySubmission(
  ctx: CrmContext,
  input: { id: string } & SubmissionContent,
): ApplySubmissionResult {
  const row = submissionRow(ctx, input.id);
  if (row.status === 'processed') {
    return { contactId: row.contact_id, contactCreated: row.contact_created === 1, alreadyProcessed: true };
  }
  const formRow = ctx.db.all<{ definition: string }>(`SELECT definition FROM form_forms WHERE id = ?`, row.form_id)[0];
  if (formRow === undefined) throw notFound('form', row.form_id);
  const definition = storedDefinition(formRow);
  const tracking: SubmissionTracking = {
    ...pickUtm(input.tracking),
    ...pickUtm({
      utm_source: row.utm_source,
      utm_medium: row.utm_medium,
      utm_campaign: row.utm_campaign,
      utm_term: row.utm_term,
      utm_content: row.utm_content,
    }),
  };
  const result = applyToContact(ctx, definition, input.values, tracking);
  const source: PublicSourceFacts = {
    utmSource: row.utm_source,
    utmMedium: row.utm_medium,
    utmCampaign: row.utm_campaign,
    utmTerm: row.utm_term,
    utmContent: row.utm_content,
    referrer: row.referrer,
    pageUrl: row.page_url,
    pageId: row.page_id,
  };
  emit(
    ctx,
    'form.submitted',
    {
      formId: row.form_id,
      submissionId: row.id,
      contactId: result.contactId,
      contactCreated: result.created,
      fields: eventFields(ctx, definition, input.values),
      source,
      visitorId: row.visitor_id,
    },
  );
  ctx.db.run(
    `UPDATE form_submissions
     SET status = 'processed', contact_id = ?, contact_created = ?, warnings = ?, error = NULL,
         attempts = attempts + 1, processed_at = ?
     WHERE id = ?`,
    result.contactId,
    result.created ? 1 : 0,
    JSON.stringify(result.warnings),
    ctx.now(),
    row.id,
  );
  return { contactId: result.contactId, contactCreated: result.created, alreadyProcessed: false };
}

function pickUtm(values: Record<string, string | null | undefined>): SubmissionTracking {
  const out: SubmissionTracking = {};
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const) {
    const value = values[key];
    if (typeof value === 'string' && value !== '') out[key] = value;
  }
  return out;
}

export function failSubmission(ctx: CrmContext, input: { id: string; error: string }): { id: string } {
  const row = submissionRow(ctx, input.id);
  if (row.status !== 'processed') {
    ctx.db.run(
      `UPDATE form_submissions SET status = 'failed', error = ?, attempts = attempts + 1 WHERE id = ?`,
      input.error.slice(0, 1000),
      row.id,
    );
  }
  return { id: row.id };
}

export interface SubmissionPage {
  rows: Array<{ submission: SubmissionRow; deliveries: DeliveryRow[] }>;
  next_cursor: string | null;
}

export function listSubmissions(
  ctx: CrmContext,
  input: { formId: string; limit: number; cursor?: string; status?: SubmissionStatus; contact_id?: string },
): SubmissionPage {
  getFormRow(ctx, input.formId);
  const where = ['form_id = ?', 'deleted_at IS NULL'];
  const params: SqlValue[] = [input.formId];
  if (input.status !== undefined) {
    where.push('status = ?');
    params.push(input.status);
  }
  if (input.contact_id !== undefined) {
    where.push('contact_id = ?');
    params.push(input.contact_id);
  }
  if (input.cursor !== undefined) {
    const cursor = decodeCursor(input.cursor);
    where.push('(created_at < ? OR (created_at = ? AND id < ?))');
    params.push(Number(cursor.v), Number(cursor.v), cursor.id);
  }
  const rows = ctx.db.all<SubmissionRow>(
    `SELECT * FROM form_submissions WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
    ...params,
    input.limit + 1,
  );
  const page = paginate(rows, input.limit, (row) => ({ v: row.created_at, id: row.id }));
  const deliveries = deliveriesOf(
    ctx,
    page.rows.map((r) => r.id),
  );
  return {
    rows: page.rows.map((submission) => ({ submission, deliveries: deliveries.get(submission.id) ?? [] })),
    next_cursor: page.nextCursor,
  };
}

export function getSubmission(
  ctx: CrmContext,
  input: { formId: string; id: string },
): { submission: SubmissionRow; deliveries: DeliveryRow[] } {
  const submission = submissionRow(ctx, input.id, input.formId);
  return { submission, deliveries: deliveriesOf(ctx, [submission.id]).get(submission.id) ?? [] };
}

interface ContactSubmissionRow {
  id: string;
  form_id: string;
  form_name: string | null;
  form_deleted_at: number | null;
  status: SubmissionStatus;
  contact_created: number;
  page_url: string | null;
  page_id: string | null;
  page_title: string | null;
  created_at: number;
  processed_at: number | null;
}

const CONTACT_SUBMISSION_COLUMNS = `s.id, s.form_id, f.name AS form_name, f.deleted_at AS form_deleted_at, s.status,
  s.contact_created, s.page_url, s.page_id, p.title AS page_title, s.created_at, s.processed_at`;
const CONTACT_SUBMISSION_JOINS = `LEFT JOIN form_forms f ON f.id = s.form_id
  LEFT JOIN page_pages p ON p.id = s.page_id AND p.deleted_at IS NULL`;

/**
 * Submissions linked to a contact across every form, newest first, keyset
 * paginated on the `form_submissions_contact_created` index. Metadata only:
 * the ciphertext never leaves the DO here.
 */
export function listContactSubmissions(
  ctx: CrmContext,
  input: { id: string; limit: number; cursor?: string },
): { rows: ContactSubmissionRow[]; next_cursor: string | null } {
  getContactRow(ctx, input.id);
  const where = ['s.contact_id = ?', 's.deleted_at IS NULL'];
  const params: SqlValue[] = [input.id];
  if (input.cursor !== undefined) {
    const cursor = decodeCursor(input.cursor);
    where.push('(s.created_at < ? OR (s.created_at = ? AND s.id < ?))');
    params.push(Number(cursor.v), Number(cursor.v), cursor.id);
  }
  const rows = ctx.db.all<ContactSubmissionRow>(
    `SELECT ${CONTACT_SUBMISSION_COLUMNS} FROM form_submissions s ${CONTACT_SUBMISSION_JOINS}
     WHERE ${where.join(' AND ')} ORDER BY s.created_at DESC, s.id DESC LIMIT ?`,
    ...params,
    input.limit + 1,
  );
  const page = paginate(rows, input.limit, (row) => ({ v: row.created_at, id: row.id }));
  return { rows: page.rows, next_cursor: page.nextCursor };
}

export interface ContactSubmissionDetailRow {
  meta: ContactSubmissionRow;
  submission: SubmissionRow;
  fields: FormDefinition['fields'];
  /** Field keys whose values are sensitive (flagged on the form, or mapped to a sensitive custom field). */
  sensitiveKeys: string[];
}

/** One submission of the contact (ciphertext included, decrypted by the worker). */
export function getContactSubmission(
  ctx: CrmContext,
  input: { id: string; submissionId: string },
): ContactSubmissionDetailRow {
  getContactRow(ctx, input.id);
  const meta = ctx.db.all<ContactSubmissionRow & { definition: string | null }>(
    `SELECT ${CONTACT_SUBMISSION_COLUMNS}, f.definition FROM form_submissions s ${CONTACT_SUBMISSION_JOINS}
     WHERE s.id = ? AND s.contact_id = ? AND s.deleted_at IS NULL`,
    input.submissionId,
    input.id,
  )[0];
  if (meta === undefined) throw notFound('submission', input.submissionId);
  const { definition, ...rest } = meta;
  const fields = definition === null ? [] : storedDefinition({ definition }).fields;
  const sensitiveCustom = new Set(
    loadFieldDefs(ctx, 'contact')
      .filter((d) => d.sensitive)
      .map((d) => `custom.${d.key}`),
  );
  return {
    meta: rest,
    submission: submissionRow(ctx, input.submissionId),
    fields,
    sensitiveKeys: fields
      .filter((f) => f.sensitive || (f.map_to !== null && sensitiveCustom.has(f.map_to)))
      .map((f) => f.key),
  };
}

/** Erases the encrypted values (the row stays as a tombstone for counts and deliveries). */
export function deleteSubmission(
  ctx: CrmContext,
  input: { formId: string; id: string },
): { id: string; deleted: true } {
  const row = submissionRow(ctx, input.id, input.formId);
  ctx.db.run(
    `UPDATE form_submissions SET deleted_at = ?, ciphertext = '', page_url = NULL, referrer = NULL WHERE id = ?`,
    ctx.now(),
    row.id,
  );
  ctx.db.run(`UPDATE form_deliveries SET request = NULL, response = NULL WHERE submission_id = ?`, row.id);
  return { id: row.id, deleted: true };
}

export interface RecordDeliveryInput {
  submissionId: string;
  connectionId: string;
  status: DeliveryStatus;
  statusCode: number | null;
  request: string | null;
  response: string | null;
}

/** Upserts the delivery of a submission to a connection, counting attempts. */
export function recordDelivery(ctx: CrmContext, input: RecordDeliveryInput): { attempts: number } {
  const now = ctx.now();
  const existing = ctx.db.all<{ id: string; attempts: number }>(
    `SELECT id, attempts FROM form_deliveries WHERE submission_id = ? AND connection_id = ?`,
    input.submissionId,
    input.connectionId,
  )[0];
  const request = input.request === null ? null : input.request.slice(0, 2000);
  const response = input.response === null ? null : input.response.slice(0, 2000);
  if (existing === undefined) {
    ctx.db.run(
      `INSERT INTO form_deliveries
         (id, submission_id, connection_id, status, attempts, status_code, request, response, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      ctx.newId(),
      input.submissionId,
      input.connectionId,
      input.status,
      input.statusCode,
      request,
      response,
      now,
      now,
    );
    return { attempts: 1 };
  }
  ctx.db.run(
    `UPDATE form_deliveries SET status = ?, attempts = attempts + 1, status_code = ?, request = ?, response = ?, updated_at = ?
     WHERE id = ?`,
    input.status,
    input.statusCode,
    request,
    response,
    now,
    existing.id,
  );
  return { attempts: existing.attempts + 1 };
}

export function parseWarnings(row: Pick<SubmissionRow, 'warnings'>): string[] {
  return parseJson<string[]>(row.warnings, []);
}
