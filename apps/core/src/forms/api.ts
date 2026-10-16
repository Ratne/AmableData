import { z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  connectionParamSchema,
  connectionTestResultSchema,
  connectorInfoSchema,
  contactSubmissionDetailSchema,
  contactSubmissionParamSchema,
  contactSubmissionSchema,
  createConnectionSchema,
  createFormSchema,
  deletedResponseSchema,
  formConnectionSchema,
  formConnectionWithSecretSchema,
  formEmbedSchema,
  formIdParamSchema,
  formSchema,
  formSubmissionSchema,
  formSummarySchema,
  idParamSchema,
  listContactSubmissionsQuerySchema,
  listFormsQuerySchema,
  listSubmissionsQuerySchema,
  pageOf,
  submissionParamSchema,
  updateConnectionSchema,
  updateFormSchema,
  type ConnectorType,
  type ContactSubmission,
  type ContactSubmissionDetail,
  type ContactSubmissionEntry,
  type FormConnectionWithSecret,
  type FormDelivery,
  type FormSubmission,
} from '@amable/api-types';
import { randomToken } from '@amable/auth';
import { displayValue, type SubmissionValue } from '@amable/forms';
import type { Context } from 'hono';
import { ulid } from 'ulid';
import { callCrm, crmRoute, json, jsonBody } from '../crm/api/core';
import { maskValue } from '../crm/custom-fields/validate';
import { CrmError, invalidMany } from '../crm/errors';
import { toIso } from '../crm/util';
import { audit, getAuth, getTenant, type AppEnv } from '../middleware';
import { connectorCatalog, connectorOf } from './connectors/registry';
import { decryptSubmission, encryptSecret, secretHint } from './crypto';
import { processSubmission, testConnection } from './process';
import { formsRuntime } from './runtime';
import {
  parseWarnings,
  type ContactSubmissionDetailRow,
  type DeliveryRow,
  type SubmissionRow,
} from './submissions';

type Ctx = Context<AppEnv>;

const formsTag = ['Forms'];
const submissionsTag = ['Form submissions'];
const connectionsTag = ['Form connections'];

/** PATCH needs a step-up only when it replaces the connector secret or its config (target URL). */
async function touchesConnectionSecrets(c: Context<AppEnv>): Promise<boolean> {
  const body: unknown = await c.req.json().catch(() => null);
  return typeof body !== 'object' || body === null || 'secret' in body || 'config' in body;
}

function edgeOrigin(c: Ctx): string {
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

/** Decrypts in the worker: the DO only ever holds the ciphertext. */
async function serializeSubmission(
  c: Ctx,
  submission: SubmissionRow,
  deliveries: DeliveryRow[],
): Promise<FormSubmission> {
  const tenantId = getTenant(c).tenant.id;
  let values: Record<string, unknown> = {};
  let tracking: Record<string, string> = {};
  let error = submission.error;
  if (submission.ciphertext !== '') {
    try {
      const content = await decryptSubmission(c.get('services').secretBox, tenantId, submission.id, submission.ciphertext);
      values = content.values;
      tracking = content.tracking;
    } catch {
      error = error ?? 'submission could not be decrypted';
    }
  }
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
function requireContactsRead(c: Ctx): void {
  if (!getTenant(c).can('contacts:read')) throw new CrmError('forbidden', 'contacts:read is required');
}

function serializeContactSubmission(row: ContactSubmissionDetailRow['meta']): ContactSubmission {
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
async function serializeContactSubmissionDetail(
  c: Ctx,
  found: ContactSubmissionDetailRow,
): Promise<ContactSubmissionDetail> {
  const { submission, fields } = found;
  let values: Record<string, unknown> = {};
  let tracking: Record<string, string> = {};
  let error = submission.error;
  if (submission.ciphertext !== '') {
    try {
      const content = await decryptSubmission(
        c.get('services').secretBox,
        getTenant(c).tenant.id,
        submission.id,
        submission.ciphertext,
      );
      values = content.values;
      tracking = content.tracking;
    } catch {
      error = error ?? 'submission could not be decrypted';
    }
  }
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

function configIssues(type: ConnectorType, raw: unknown): Record<string, unknown> {
  const connector = connectorOf(type);
  if (connector === null) throw new CrmError('bad_request', `unknown connector ${type}`);
  const parsed = connector.parseConfig(raw);
  if (!parsed.success) {
    throw invalidMany(parsed.issues.map((i) => ({ path: `config.${i.path}`, message: i.message })));
  }
  return parsed.data as Record<string, unknown>;
}

/** Forms REST v2 routes (relative to `/api/v2/t/{slug}`). */
export function registerFormsRoutes(router: OpenAPIHono<AppEnv>): void {
  // ------------------------------------------------------------ catalog
  router.openapi(
    crmRoute('forms:read', {
      method: 'get',
      path: '/formConnectorTypes',
      tags: connectionsTag,
      summary: 'Connector types a form connection can use on this installation',
      responses: { 200: json(z.object({ data: z.array(connectorInfoSchema) }), 'Connector catalog') },
    }),
    async (c) => c.json({ data: connectorCatalog(await formsRuntime(c.env)) }, 200),
  );

  // -------------------------------------------------------------- forms
  router.openapi(
    crmRoute('forms:read', {
      method: 'get',
      path: '/forms',
      tags: formsTag,
      summary: 'List forms (archived ones only with status=archived)',
      request: { query: listFormsQuerySchema },
      responses: { 200: json(pageOf(formSummarySchema), 'Forms') },
    }),
    async (c) => c.json(await callCrm(c, 'forms.list', c.req.valid('query')), 200),
  );
  router.openapi(
    crmRoute('forms:write', {
      method: 'post',
      path: '/forms',
      tags: formsTag,
      summary: 'Create a form (without a definition: a starter form)',
      request: { body: jsonBody(createFormSchema) },
      responses: { 201: json(formSchema, 'The form') },
    }),
    async (c) => {
      const locale = getAuth(c).user.locale === 'it' ? 'it' : 'en';
      const form = await callCrm(c, 'forms.create', { ...c.req.valid('json'), locale });
      await audit(c, 'forms.form_created', { target: form.id });
      return c.json(form, 201);
    },
  );
  router.openapi(
    crmRoute('forms:read', {
      method: 'get',
      path: '/forms/{formId}',
      tags: formsTag,
      summary: 'Get a form with its definition',
      request: { params: formIdParamSchema },
      responses: { 200: json(formSchema, 'The form') },
    }),
    async (c) => c.json(await callCrm(c, 'forms.get', { id: c.req.valid('param').formId }), 200),
  );
  router.openapi(
    crmRoute('forms:write', {
      method: 'patch',
      path: '/forms/{formId}',
      tags: formsTag,
      summary: 'Update name, status or definition',
      request: { params: formIdParamSchema, body: jsonBody(updateFormSchema) },
      responses: { 200: json(formSchema, 'The form') },
    }),
    async (c) =>
      c.json(await callCrm(c, 'forms.update', { id: c.req.valid('param').formId, data: c.req.valid('json') }), 200),
  );
  router.openapi(
    crmRoute('forms:write', {
      method: 'delete',
      path: '/forms/{formId}',
      tags: formsTag,
      summary: 'Delete a form (and its connections); submissions are kept',
      request: { params: formIdParamSchema },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) => {
      const { formId } = c.req.valid('param');
      const result = await callCrm(c, 'forms.delete', { id: formId });
      await audit(c, 'forms.form_deleted', { target: formId });
      return c.json(result, 200);
    },
  );
  router.openapi(
    crmRoute('forms:write', {
      method: 'post',
      path: '/forms/{formId}/duplicate',
      tags: formsTag,
      summary: 'Copy a form (inactive, without connections)',
      request: {
        params: formIdParamSchema,
        body: { required: false, content: { 'application/json': { schema: z.strictObject({ name: z.string().trim().min(1).max(200).optional() }) } } },
      },
      responses: { 201: json(formSchema, 'The copy') },
    }),
    async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
      const name = typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim().slice(0, 200) : undefined;
      const form = await callCrm(c, 'forms.duplicate', {
        id: c.req.valid('param').formId,
        ...(name === undefined ? {} : { name }),
      });
      return c.json(form, 201);
    },
  );
  for (const [action, op] of [
    ['archive', 'forms.archive'],
    ['restore', 'forms.restore'],
  ] as const) {
    router.openapi(
      crmRoute('forms:write', {
        method: 'post',
        path: `/forms/{formId}/${action}`,
        tags: formsTag,
        summary: action === 'archive' ? 'Archive a form (stops accepting submissions)' : 'Restore an archived form',
        request: { params: formIdParamSchema },
        responses: { 200: json(formSchema, 'The form') },
      }),
      async (c) => c.json(await callCrm(c, op, { id: c.req.valid('param').formId }), 200),
    );
  }
  router.openapi(
    crmRoute('forms:read', {
      method: 'get',
      path: '/forms/{formId}/embed',
      tags: formsTag,
      summary: 'Embed snippet and hosted page link',
      request: { params: formIdParamSchema },
      responses: { 200: json(formEmbedSchema, 'Embed facts') },
    }),
    async (c) => {
      const form = await callCrm(c, 'forms.get', { id: c.req.valid('param').formId });
      const slug = getTenant(c).tenant.slug;
      const edge = edgeOrigin(c);
      const settings = form.definition['settings'] as { hosted_enabled?: unknown } | undefined;
      return c.json(
        {
          form_id: form.id,
          tenant: slug,
          script_url: `${edge}/forms.js`,
          config_url: `${edge}/f/${slug}/${form.id}/config`,
          hosted_url: `${edge}/f/${slug}/${form.id}`,
          hosted_enabled: settings?.hosted_enabled !== false,
          snippet: `<div data-amable-form="${form.id}" data-amable-tenant="${slug}"></div>\n<script async src="${edge}/forms.js"></script>`,
        },
        200,
      );
    },
  );

  // -------------------------------------------------------- submissions
  router.openapi(
    crmRoute('forms:submissions_read', {
      method: 'get',
      path: '/forms/{formId}/submissions',
      tags: submissionsTag,
      summary: 'List submissions with their decrypted values (newest first)',
      request: { params: formIdParamSchema, query: listSubmissionsQuerySchema },
      responses: { 200: json(pageOf(formSubmissionSchema), 'Submissions') },
    }),
    async (c) => {
      const page = await callCrm(c, 'forms.listSubmissions', {
        formId: c.req.valid('param').formId,
        ...c.req.valid('query'),
      });
      const data = await Promise.all(page.rows.map((r) => serializeSubmission(c, r.submission, r.deliveries)));
      return c.json({ data, next_cursor: page.next_cursor }, 200);
    },
  );
  router.openapi(
    crmRoute('forms:submissions_read', {
      method: 'get',
      path: '/forms/{formId}/submissions/{submissionId}',
      tags: submissionsTag,
      summary: 'Get a decrypted submission with its delivery log',
      request: { params: submissionParamSchema },
      responses: { 200: json(formSubmissionSchema, 'The submission') },
    }),
    async (c) => {
      const { formId, submissionId } = c.req.valid('param');
      const found = await callCrm(c, 'forms.getSubmission', { formId, id: submissionId });
      return c.json(await serializeSubmission(c, found.submission, found.deliveries), 200);
    },
  );
  router.openapi(
    crmRoute('forms:read', {
      method: 'get',
      path: '/contacts/{id}/submissions',
      tags: submissionsTag,
      summary: "A contact's form submissions across every form (metadata only, newest first)",
      description:
        'Form name, page, status and dates; values stay encrypted (read one with `GET /contacts/{id}/submissions/{submissionId}`). Cursor-paginated. Also requires `contacts:read`.',
      request: { params: idParamSchema, query: listContactSubmissionsQuerySchema },
      responses: { 200: json(pageOf(contactSubmissionSchema), 'A page of submissions, newest first') },
    }),
    async (c) => {
      requireContactsRead(c);
      const page = await callCrm(c, 'forms.contactSubmissions', {
        id: c.req.valid('param').id,
        ...c.req.valid('query'),
      });
      return c.json({ data: page.rows.map(serializeContactSubmission), next_cursor: page.next_cursor }, 200);
    },
  );
  router.openapi(
    crmRoute('forms:submissions_read', {
      method: 'get',
      path: '/contacts/{id}/submissions/{submissionId}',
      tags: submissionsTag,
      summary: 'One decrypted submission of a contact',
      description:
        'Values in form field order, rendered as text. Sensitive values (fields flagged sensitive, or mapped to a sensitive custom field) are masked unless the caller has `contacts:read_sensitive`. Also requires `contacts:read`.',
      request: { params: contactSubmissionParamSchema },
      responses: { 200: json(contactSubmissionDetailSchema, 'The submission') },
    }),
    async (c) => {
      requireContactsRead(c);
      const found = await callCrm(c, 'forms.contactSubmission', c.req.valid('param'));
      return c.json(await serializeContactSubmissionDetail(c, found), 200);
    },
  );
  router.openapi(
    crmRoute('forms:write', {
      method: 'delete',
      path: '/forms/{formId}/submissions/{submissionId}',
      tags: submissionsTag,
      summary: 'Erase a submission (encrypted values are wiped; the CRM contact is kept)',
      request: { params: submissionParamSchema },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) => {
      const { formId, submissionId } = c.req.valid('param');
      const result = await callCrm(c, 'forms.deleteSubmission', { formId, id: submissionId });
      await audit(c, 'forms.submission_deleted', { target: submissionId, details: { form_id: formId } });
      return c.json(result, 200);
    },
  );
  router.openapi(
    crmRoute('forms:write', {
      method: 'post',
      path: '/forms/{formId}/submissions/{submissionId}/reprocess',
      tags: submissionsTag,
      summary: 'Process again: apply to the CRM if it failed, retry deliveries that did not succeed',
      request: { params: submissionParamSchema },
      responses: { 200: json(formSubmissionSchema, 'The submission') },
    }),
    async (c) => {
      const { formId, submissionId } = c.req.valid('param');
      await callCrm(c, 'forms.getSubmission', { formId, id: submissionId });
      await processSubmission(c.env, getTenant(c).tenant.id, submissionId, { attempt: 1, final: true });
      await audit(c, 'forms.submission_reprocessed', { target: submissionId, details: { form_id: formId } });
      const found = await callCrm(c, 'forms.getSubmission', { formId, id: submissionId });
      return c.json(await serializeSubmission(c, found.submission, found.deliveries), 200);
    },
  );

  // -------------------------------------------------------- connections
  router.openapi(
    crmRoute('forms:read', {
      method: 'get',
      path: '/forms/{formId}/connections',
      tags: connectionsTag,
      summary: 'List the connections of a form (secrets are never returned)',
      request: { params: formIdParamSchema },
      responses: { 200: json(z.object({ data: z.array(formConnectionSchema) }), 'Connections') },
    }),
    async (c) => c.json({ data: await callCrm(c, 'forms.listConnections', { formId: c.req.valid('param').formId }) }, 200),
  );
  router.openapi(
    crmRoute('forms:connections_manage', {
      method: 'post',
      path: '/forms/{formId}/connections',
      tags: connectionsTag,
      summary: 'Create a connection (a webhook signing secret is returned once)',
      request: { params: formIdParamSchema, body: jsonBody(createConnectionSchema) },
      responses: { 201: json(formConnectionWithSecretSchema, 'The connection') },
    }, { stepUp: true }),
    async (c) => {
      const { formId } = c.req.valid('param');
      const body = c.req.valid('json');
      const connector = connectorOf(body.type);
      if (connector === null) throw new CrmError('bad_request', `unknown connector ${body.type}`);
      const id = ulid();
      const tenantId = getTenant(c).tenant.id;
      const box = c.get('services').secretBox;
      let secret: string | null = null;
      if (connector.secret === 'generated') secret = `whsec_${randomToken(24)}`;
      if (body.type === 'docuseal') secret = body.secret;
      const connection = await callCrm(c, 'forms.createConnection', {
        id,
        formId,
        type: body.type,
        name: body.name,
        enabled: body.enabled ?? true,
        config: configIssues(body.type, body.config),
        secretCiphertext: secret === null ? null : await encryptSecret(box, tenantId, id, secret),
        secretHint: secret === null ? null : secretHint(secret),
      });
      await audit(c, 'forms.connection_created', { target: id, details: { form_id: formId, type: body.type } });
      const response: FormConnectionWithSecret = {
        ...connection,
        signing_secret: connector.secret === 'generated' ? secret : null,
      };
      return c.json(response, 201);
    },
  );
  router.openapi(
    crmRoute('forms:connections_manage', {
      method: 'patch',
      path: '/forms/{formId}/connections/{connectionId}',
      tags: connectionsTag,
      summary: 'Update a connection (config is replaced and validated against its type)',
      request: { params: connectionParamSchema, body: jsonBody(updateConnectionSchema) },
      responses: { 200: json(formConnectionSchema, 'The connection') },
    }, { stepUp: touchesConnectionSecrets }),
    async (c) => {
      const { formId, connectionId } = c.req.valid('param');
      const body = c.req.valid('json');
      const current = await callCrm(c, 'forms.getConnection', { formId, id: connectionId });
      const connector = connectorOf(current.type);
      if (body.secret !== undefined && connector?.secret !== 'api_key') {
        throw new CrmError('validation_failed', 'this connection has no API key', [
          { path: 'secret', message: 'not supported by this connector' },
        ]);
      }
      const tenantId = getTenant(c).tenant.id;
      const connection = await callCrm(c, 'forms.updateConnection', {
        formId,
        id: connectionId,
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
        ...(body.config === undefined ? {} : { config: configIssues(current.type, body.config) }),
        ...(body.secret === undefined
          ? {}
          : {
              secretCiphertext: await encryptSecret(c.get('services').secretBox, tenantId, connectionId, body.secret),
              secretHint: secretHint(body.secret),
            }),
      });
      await audit(c, 'forms.connection_updated', {
        target: connectionId,
        details: { form_id: formId, secret_changed: body.secret !== undefined },
      });
      return c.json(connection, 200);
    },
  );
  router.openapi(
    crmRoute('forms:connections_manage', {
      method: 'delete',
      path: '/forms/{formId}/connections/{connectionId}',
      tags: connectionsTag,
      summary: 'Delete a connection',
      request: { params: connectionParamSchema },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) => {
      const { formId, connectionId } = c.req.valid('param');
      const result = await callCrm(c, 'forms.deleteConnection', { formId, id: connectionId });
      await audit(c, 'forms.connection_deleted', { target: connectionId, details: { form_id: formId } });
      return c.json(result, 200);
    },
  );
  router.openapi(
    crmRoute('forms:connections_manage', {
      method: 'post',
      path: '/forms/{formId}/connections/{connectionId}/rotateSecret',
      tags: connectionsTag,
      summary: 'Generate a new webhook signing secret (returned once; the old one stops working)',
      request: { params: connectionParamSchema },
      responses: { 200: json(formConnectionWithSecretSchema, 'The connection') },
    }, { stepUp: true }),
    async (c) => {
      const { formId, connectionId } = c.req.valid('param');
      const current = await callCrm(c, 'forms.getConnection', { formId, id: connectionId });
      if (connectorOf(current.type)?.secret !== 'generated') {
        throw new CrmError('bad_request', 'this connection has no signing secret');
      }
      const secret = `whsec_${randomToken(24)}`;
      const connection = await callCrm(c, 'forms.updateConnection', {
        formId,
        id: connectionId,
        secretCiphertext: await encryptSecret(c.get('services').secretBox, getTenant(c).tenant.id, connectionId, secret),
        secretHint: secretHint(secret),
      });
      await audit(c, 'forms.connection_secret_rotated', { target: connectionId, details: { form_id: formId } });
      return c.json({ ...connection, signing_secret: secret }, 200);
    },
  );
  router.openapi(
    crmRoute('forms:connections_manage', {
      method: 'post',
      path: '/forms/{formId}/connections/{connectionId}/test',
      tags: connectionsTag,
      summary: 'Deliver a sample submission through the connection',
      request: { params: connectionParamSchema },
      responses: { 200: json(connectionTestResultSchema, 'Test result') },
    }),
    async (c) => {
      const { formId, connectionId } = c.req.valid('param');
      const form = await callCrm(c, 'forms.get', { id: formId });
      const connection = await callCrm(c, 'forms.connectionForWorker', { formId, id: connectionId });
      const fields = (form.definition['fields'] ?? []) as Parameters<typeof testConnection>[0]['form']['fields'];
      const result = await testConnection({
        env: c.env,
        runtime: await formsRuntime(c.env),
        tenantId: getTenant(c).tenant.id,
        form: { id: form.id, name: form.name, fields },
        connection,
      });
      await audit(c, 'forms.connection_tested', { target: connectionId, details: { form_id: formId, status: result.status } });
      return c.json(result, 200);
    },
  );
}
