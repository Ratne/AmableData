import type {
  AppConnectorConfig,
  ConnectorType,
  ContactSubmission,
  ContactSubmissionDetail,
  ContactSubmissionEntry,
  FormDelivery,
  FormSubmission,
} from '@amable/api-types';
import { displayValue, type SubmissionValue } from '@amable/forms';
import type { Context } from 'hono';
import { maskValue } from '../../crm/custom-fields/validate';
import { CrmError, invalidMany } from '../../crm/errors';
import { toIso } from '../../crm/util';
import type { Env } from '../../env';
import { getTenant, type AppEnv } from '../../middleware';
import { appConnectorIssues } from '../connectors/app';
import { connectorOf } from '../connectors/registry';
import type { Connector } from '../connectors/types';
import { decryptSubmission, secretHint } from '../crypto';
import {
  parseWarnings,
  type ContactSubmissionDetailRow,
  type DeliveryRow,
  type SubmissionRow,
} from '../submissions';

export type Ctx = Context<AppEnv>;

export const formsTag = ['Forms'];

export const submissionsTag = ['Form submissions'];

export const connectionsTag = ['Form connections'];

/** PATCH needs a step-up only when it replaces the connector secret or its config (target URL). */
export async function touchesConnectionSecrets(c: Context<AppEnv>): Promise<boolean> {
  const body: unknown = await c.req.json().catch(() => null);
  return typeof body !== 'object' || body === null || 'secret' in body || 'config' in body;
}

export function edgeOrigin(c: Ctx): string {
  return (c.env.EDGE_ORIGIN ?? 'http://localhost:8788').replace(/\/+$/, '');
}

function serializeDelivery(row: DeliveryRow): FormDelivery {
  return {
    id: row.id,
    connection_id: row.connection_id,
    connection_name: row.connection_name,
    connection_type: row.connection_type,
    status: row.status,
    attempts: row.attempts,
    status_code: row.status_code,
    request: row.request,
    response: row.response,
    updated_at: toIso(row.updated_at),
  };
}

/** Decrypts in the worker: the DO only ever holds the ciphertext. A failure becomes the submission error. */
async function openSubmission(
  c: Ctx,
  submission: { id: string; ciphertext: string; error: string | null },
): Promise<{
  values: Record<string, unknown>;
  tracking: Record<string, string>;
  error: string | null;
}> {
  if (submission.ciphertext === '') return { values: {}, tracking: {}, error: submission.error };
  try {
    const content = await decryptSubmission(
      c.get('services').secretBox,
      getTenant(c).tenant.id,
      submission.id,
      submission.ciphertext,
    );
    return { values: content.values, tracking: content.tracking, error: submission.error };
  } catch {
    return {
      values: {},
      tracking: {},
      error: submission.error ?? 'submission could not be decrypted',
    };
  }
}

export async function serializeSubmission(
  c: Ctx,
  submission: SubmissionRow,
  deliveries: DeliveryRow[],
): Promise<FormSubmission> {
  const { values, tracking, error } = await openSubmission(c, submission);
  return {
    id: submission.id,
    form_id: submission.form_id,
    status: submission.status,
    contact_id: submission.contact_id,
    contact_created: submission.contact_created === 1,
    error,
    warnings: parseWarnings(submission),
    attempts: submission.attempts,
    values,
    tracking,
    source: {
      utm_source: submission.utm_source,
      utm_medium: submission.utm_medium,
      utm_campaign: submission.utm_campaign,
      utm_term: submission.utm_term,
      utm_content: submission.utm_content,
      referrer: submission.referrer,
      page_url: submission.page_url,
      page_id: submission.page_id,
      country: submission.country,
      visitor_id: submission.visitor_id,
    },
    created_at: toIso(submission.created_at),
    processed_at: toIso(submission.processed_at),
    deliveries: deliveries.map(serializeDelivery),
  };
}

/** The contact routes are read through the forms permissions; the contact itself must be readable too. */
export function requireContactsRead(c: Ctx): void {
  if (!getTenant(c).can('contacts:read'))
    throw new CrmError('forbidden', 'contacts:read is required');
}

export function serializeContactSubmission(
  row: ContactSubmissionDetailRow['meta'],
): ContactSubmission {
  return {
    id: row.id,
    form_id: row.form_id,
    form_name: row.form_name ?? row.form_id,
    form_deleted: row.form_name === null || row.form_deleted_at !== null,
    status: row.status,
    contact_created: row.contact_created === 1,
    page_url: row.page_url,
    page_id: row.page_id,
    page_title: row.page_title,
    created_at: toIso(row.created_at),
    processed_at: toIso(row.processed_at),
  };
}

function isSubmissionValue(value: unknown): value is SubmissionValue {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    (Array.isArray(value) && value.every((v) => typeof v === 'string'))
  );
}

/** Decrypts in the worker and masks the sensitive values for callers without `contacts:read_sensitive`. */
export async function serializeContactSubmissionDetail(
  c: Ctx,
  found: ContactSubmissionDetailRow,
): Promise<ContactSubmissionDetail> {
  const { submission, fields } = found;
  const { values, tracking, error } = await openSubmission(c, submission);
  const mask = !getTenant(c).can('contacts:read_sensitive');
  const sensitive = new Set(found.sensitiveKeys);
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const keys = [
    ...fields.map((f) => f.key).filter((key) => key in values),
    ...Object.keys(values).filter((key) => !byKey.has(key)),
  ];
  const entries: ContactSubmissionEntry[] = [];
  for (const key of keys) {
    const value = values[key];
    if (!isSubmissionValue(value)) continue;
    const field = byKey.get(key);
    const masked = mask && sensitive.has(key);
    entries.push({
      key,
      label: field?.label || key,
      value: masked
        ? (maskValue(value) ?? '')
        : typeof value === 'boolean'
          ? value
          : displayValue(field, value),
      masked,
    });
  }
  return {
    ...serializeContactSubmission(found.meta),
    error,
    warnings: parseWarnings(submission),
    entries,
    tracking,
    source: {
      utm_source: submission.utm_source,
      utm_medium: submission.utm_medium,
      utm_campaign: submission.utm_campaign,
      utm_term: submission.utm_term,
      utm_content: submission.utm_content,
      referrer: submission.referrer,
      page_url: submission.page_url,
      page_id: submission.page_id,
      country: submission.country,
      visitor_id: submission.visitor_id,
    },
  };
}

export async function configIssues(
  env: Env,
  tenantId: string,
  type: ConnectorType,
  raw: unknown,
): Promise<Record<string, unknown>> {
  const connector = connectorOf(type);
  if (connector === null) throw new CrmError('bad_request', `unknown connector ${type}`);
  const parsed = connector.parseConfig(raw);
  if (!parsed.success) {
    throw invalidMany(parsed.issues.map((i) => ({ path: `config.${i.path}`, message: i.message })));
  }
  if (type === 'app') {
    const issues = await appConnectorIssues(env, tenantId, parsed.data as AppConnectorConfig);
    if (issues.length > 0) throw invalidMany(issues);
  }
  return parsed.data as Record<string, unknown>;
}

export function checkedSecretHint(connector: Connector<unknown> | null, secret: string): string {
  const checked = connector?.checkSecret?.(secret);
  if (checked === undefined) return secretHint(secret);
  if (!checked.ok)
    throw new CrmError('validation_failed', checked.message, [
      { path: 'secret', message: checked.message },
    ]);
  return checked.hint;
}
