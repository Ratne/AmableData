import { webhookConfigSchema, type WebhookConfig } from '@amable/api-types';
import { WEBHOOK_SIGNATURE_HEADER, signWebhook } from '@amable/auth';
import { ResponseTooLargeError, safeFetch, SsrfBlockedError } from '@amable/auth/security';
import { mergeContext, renderTags, zodConfig } from './merge';
import { failure, httpResult, type Connector, type ConnectorContext } from './types';

/** Headers the user cannot set (transport, signature, identity). */
const FORBIDDEN_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'cookie',
  'amable-signature',
  'idempotency-key',
  'user-agent',
]);

export const WEBHOOK_EVENT = 'form.submitted';

/** JSON body sent when the connection has no field map. */
export function webhookPayload(ctx: ConnectorContext<WebhookConfig>): Record<string, unknown> {
  const { form, submission } = ctx;
  const fields: Record<string, string> = {};
  const context = mergeContext(ctx);
  for (const field of form.fields) {
    if (submission.values[field.key] !== undefined) fields[field.key] = context[field.key] ?? '';
  }
  return {
    event: WEBHOOK_EVENT,
    id: `${submission.id}:${ctx.connection.id}`,
    test: ctx.test,
    form: { id: form.id, name: form.name },
    submission: {
      id: submission.id,
      submitted_at: submission.submittedAt,
      contact_id: submission.contactId,
      values: submission.values,
      fields,
      tracking: submission.tracking,
      page_url: submission.meta.page_url || null,
      referrer: submission.meta.referrer || null,
      visitor_id: submission.meta.visitor_id || null,
    },
  };
}

/**
 * Renders a JSON body template: the template is parsed first and merge tags
 * are replaced inside string values only, so submitted text can never change
 * the JSON structure.
 */
export function renderBodyTemplate(template: string, context: Readonly<Record<string, string>>): string {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return renderTags(value, context);
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
    }
    return value;
  };
  return JSON.stringify(walk(JSON.parse(template)));
}

function body(ctx: ConnectorContext<WebhookConfig>): { text: string; contentType: string } {
  const config = ctx.connection.config;
  const template = config.body_template?.trim() ?? '';
  if (config.format === 'json' && template !== '') {
    return { text: renderBodyTemplate(template, mergeContext(ctx)), contentType: 'application/json' };
  }
  if (config.field_map.length === 0 && config.format === 'json') {
    return { text: JSON.stringify(webhookPayload(ctx)), contentType: 'application/json' };
  }
  const context = mergeContext(ctx);
  const flat: Record<string, string> =
    config.field_map.length === 0
      ? context
      : Object.fromEntries(config.field_map.map((m) => [m.target, context[m.source] ?? '']));
  return config.format === 'form'
    ? { text: new URLSearchParams(flat).toString(), contentType: 'application/x-www-form-urlencoded' }
    : { text: JSON.stringify(flat), contentType: 'application/json' };
}

/**
 * Signed outgoing webhook: `Amable-Signature: t=<unix>,v1=<hmac>` over
 * `${t}.${body}` with the connection's secret (verify with `verifyWebhook`),
 * `Idempotency-Key` stable across retries, SSRF-safe fetch.
 */
export const webhookConnector: Connector<WebhookConfig> = {
  type: 'webhook',
  secret: 'generated',
  oauthProvider: null,
  available: () => true,
  parseConfig: zodConfig(webhookConfigSchema),
  async run(ctx) {
    const config = ctx.connection.config;
    if (ctx.connection.secret === null) return failure('signing secret missing', false);
    const { text, contentType } = body(ctx);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(config.headers)) {
      if (!FORBIDDEN_HEADERS.has(name.toLowerCase())) headers[name] = value;
    }
    headers['content-type'] = contentType;
    headers['user-agent'] = 'amable-forms/1';
    headers['idempotency-key'] = `${ctx.submission.id}:${ctx.connection.id}`;
    headers[WEBHOOK_SIGNATURE_HEADER] = await signWebhook(ctx.connection.secret, text, ctx.runtime.now());
    const request = `${config.method} ${config.url} (${String(text.length)} bytes, ${contentType})`;
    try {
      const response = await safeFetch(
        config.url,
        { method: config.method, headers, body: text },
        { fetchFn: (input, init) => ctx.runtime.fetch(input, init), timeoutMs: 10_000, maxBytes: 64 * 1024 },
      );
      return httpResult(response.status, request, new TextDecoder().decode(response.body));
    } catch (error) {
      if (error instanceof SsrfBlockedError) return failure(`blocked URL: ${error.message}`, false, request);
      if (error instanceof ResponseTooLargeError) return failure('response too large', false, request);
      return failure(`request failed: ${error instanceof Error ? error.message : String(error)}`, true, request);
    }
  },
};
