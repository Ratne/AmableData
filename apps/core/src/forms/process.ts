import type { ConnectionTestResult } from '@amable/api-types';
import type { FormField } from '@amable/forms';
import { SYSTEM_ACTOR } from '../crm/context';
import { CrmError } from '../crm/errors';
import { parseJson } from '../crm/util';
import type { Env } from '../env';
import { applyFormValidation } from './app-validation';
import { connectorOf } from './connectors/registry';
import type { ConnectorContext, ConnectorResult, ConnectorSubmission } from './connectors/types';
import { decryptSecret, decryptSubmission } from './crypto';
import { formsRuntime, tenantOp, type FormsRuntime } from './runtime';
import type { ConnectionRow, SubmissionContent } from './submissions';

/**
 * Processing of a stored submission (queue consumer, inline fallback,
 * reprocess): decrypt in the worker → `forms.applySubmission` (contact,
 * tags, `form.submitted`, one transaction) → deliver to every enabled
 * connection that has not succeeded yet, recording each attempt.
 */

export const MAX_DELIVERY_ATTEMPTS = 5;

export interface ProcessOptions {
  /** 1-based attempt of the queue message. */
  attempt: number;
  /** Last attempt: failures are final (`failed`), not `retrying`. */
  final: boolean;
  runtime?: FormsRuntime;
}

export interface ProcessOutcome {
  status: 'processed' | 'failed' | 'missing';
  contactId: string | null;
  /** Some delivery failed with a transient error and should be retried later. */
  retry: boolean;
}

function submissionUrl(env: Env, slug: string | null, formId: string, submissionId: string): string | null {
  const origin = env.APP_ORIGIN?.replace(/\/+$/, '');
  if (origin === undefined || origin === '' || slug === null) return null;
  return `${origin}/t/${encodeURIComponent(slug)}/forms/${encodeURIComponent(formId)}/submissions?submission=${encodeURIComponent(submissionId)}`;
}

async function tenantSlug(env: Env, tenantId: string): Promise<string | null> {
  try {
    const row = await env.DB.prepare(`SELECT slug FROM tenants WHERE id = ?`).bind(tenantId).first<{ slug: string }>();
    return row?.slug ?? null;
  } catch {
    return null;
  }
}

export interface DeliverInput {
  env: Env;
  runtime: FormsRuntime;
  tenantId: string;
  form: { id: string; name: string; fields: readonly FormField[] };
  submission: ConnectorSubmission;
  connection: ConnectionRow;
  attempt: number;
  submissionUrl: string | null;
  test: boolean;
}

/** Runs one connector; config or secret problems become a non-retryable failure. */
export async function deliver(input: DeliverInput): Promise<ConnectorResult> {
  const connector = connectorOf(input.connection.type);
  if (connector === null) {
    return { status: 'failed', retryable: false, statusCode: null, request: null, response: `unknown connector ${input.connection.type}` };
  }
  if (!connector.available(input.runtime)) {
    return { status: 'skipped', retryable: false, statusCode: null, request: null, response: 'connector not available on this installation' };
  }
  const parsed = connector.parseConfig(parseJson<unknown>(input.connection.config, {}));
  if (!parsed.success) {
    const first = parsed.issues[0];
    return { status: 'failed', retryable: false, statusCode: null, request: null, response: `invalid configuration: ${first?.path ?? ''} ${first?.message ?? ''}`.trim() };
  }
  let secret: string | null = null;
  if (input.connection.secret_ciphertext !== null) {
    try {
      secret = await decryptSecret(input.runtime.secretBox, input.tenantId, input.connection.id, input.connection.secret_ciphertext);
    } catch {
      return { status: 'failed', retryable: false, statusCode: null, request: null, response: 'secret could not be decrypted' };
    }
  }
  const ctx: ConnectorContext<unknown> = {
    env: input.env,
    tenantId: input.tenantId,
    form: input.form,
    submission: input.submission,
    connection: { id: input.connection.id, name: input.connection.name, config: parsed.data, secret },
    attempt: input.attempt,
    runtime: input.runtime,
    submissionUrl: input.submissionUrl,
    test: input.test,
  };
  try {
    return await connector.run(ctx);
  } catch (error) {
    return { status: 'failed', retryable: true, statusCode: null, request: null, response: `connector error: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function processSubmission(
  env: Env,
  tenantId: string,
  submissionId: string,
  options: ProcessOptions,
): Promise<ProcessOutcome> {
  const runtime = options.runtime ?? (await formsRuntime(env));
  let loaded;
  try {
    loaded = await tenantOp(env, tenantId, SYSTEM_ACTOR, 'forms.loadSubmission', { id: submissionId });
  } catch (error) {
    if (error instanceof CrmError && error.code === 'not_found') return { status: 'missing', contactId: null, retry: false };
    throw error;
  }
  const { submission, form } = loaded;

  let content: SubmissionContent;
  try {
    content = await decryptSubmission(runtime.secretBox, tenantId, submission.id, submission.ciphertext);
  } catch {
    await tenantOp(env, tenantId, SYSTEM_ACTOR, 'forms.failSubmission', { id: submission.id, error: 'submission could not be decrypted' });
    return { status: 'failed', contactId: null, retry: false };
  }

  let contactId = submission.contact_id;
  if (submission.status !== 'processed') {
    try {
      const applied = await tenantOp(env, tenantId, SYSTEM_ACTOR, 'forms.applySubmission', { id: submission.id, ...content });
      contactId = applied.contactId;
      if (contactId !== null) await applyFormValidation(env, tenantId, contactId, form.definition, content.values);
    } catch (error) {
      if (!(error instanceof CrmError)) throw error;
      const detail = error.details?.map((d) => `${d.path}: ${d.message}`).join('; ');
      await tenantOp(env, tenantId, SYSTEM_ACTOR, 'forms.failSubmission', {
        id: submission.id,
        error: detail === undefined || detail === '' ? error.message : detail,
      });
      return { status: 'failed', contactId: null, retry: false };
    }
  }

  const done = new Set(
    loaded.deliveries.filter((d) => d.status === 'success' || d.status === 'skipped').map((d) => d.connection_id),
  );
  const attemptsOf = new Map(loaded.deliveries.map((d) => [d.connection_id, d.attempts]));
  const pending = loaded.connections.filter((c) => c.enabled === 1 && !done.has(c.id));
  const slug = pending.length > 0 ? await tenantSlug(env, tenantId) : null;
  const connectorSubmission: ConnectorSubmission = {
    id: submission.id,
    submittedAt: new Date(submission.created_at).toISOString(),
    contactId,
    values: content.values,
    tracking: content.tracking,
    meta: content.meta,
  };
  let retry = false;
  for (const connection of pending) {
    const attempt = (attemptsOf.get(connection.id) ?? 0) + 1;
    const result = await deliver({
      env,
      runtime,
      tenantId,
      form: { id: form.id, name: form.name, fields: form.definition.fields },
      submission: connectorSubmission,
      connection,
      attempt,
      submissionUrl: submissionUrl(env, slug, form.id, submission.id),
      test: false,
    });
    const willRetry = result.status === 'failed' && result.retryable && !options.final && attempt < MAX_DELIVERY_ATTEMPTS;
    if (willRetry) retry = true;
    await tenantOp(env, tenantId, SYSTEM_ACTOR, 'forms.recordDelivery', {
      submissionId: submission.id,
      connectionId: connection.id,
      status: willRetry ? 'retrying' : result.status,
      statusCode: result.statusCode,
      request: result.request,
      response: result.response,
    });
  }
  return { status: 'processed', contactId, retry };
}

/** Sample submission used by "test connection". */
export function sampleSubmission(fields: readonly FormField[], now: number): ConnectorSubmission {
  const values: Record<string, string | number | boolean | string[]> = {};
  for (const field of fields) {
    switch (field.kind) {
      case 'email':
        values[field.key] = 'test@example.com';
        break;
      case 'phone':
        values[field.key] = '+39 333 000 0000';
        break;
      case 'number':
      case 'rating':
        values[field.key] = 1;
        break;
      case 'checkbox':
      case 'consent':
        values[field.key] = true;
        break;
      case 'date':
        values[field.key] = new Date(now).toISOString().slice(0, 10);
        break;
      case 'select':
      case 'radio':
        values[field.key] = field.options[0]?.value ?? 'test';
        break;
      case 'multicheck':
        values[field.key] = field.options.slice(0, 1).map((o) => o.value);
        break;
      case 'heading':
      case 'html':
      case 'page_break':
        break;
      default:
        values[field.key] = field.map_to === 'given_name' ? 'Test' : field.map_to === 'family_name' ? 'User' : 'Test value';
    }
  }
  return {
    id: 'test',
    submittedAt: new Date(now).toISOString(),
    contactId: null,
    values,
    tracking: { utm_source: 'test' },
    meta: {
      page_url: 'https://example.com/contact',
      referrer: '',
      landing_url: '',
      first_referrer: '',
      page_id: '',
      visitor_id: '',
      locale: 'en',
      time_zone: 'UTC',
      viewport: '',
    },
  };
}

export async function testConnection(input: {
  env: Env;
  runtime: FormsRuntime;
  tenantId: string;
  form: { id: string; name: string; fields: readonly FormField[] };
  connection: ConnectionRow;
}): Promise<ConnectionTestResult> {
  const result = await deliver({
    ...input,
    submission: sampleSubmission(input.form.fields, input.runtime.now()),
    attempt: 1,
    submissionUrl: null,
    test: true,
  });
  return { status: result.status, status_code: result.statusCode, request: result.request, response: result.response };
}
