import { docusealConfigSchema, type DocusealConfig } from '@amable/api-types';
import { safeFetch, SsrfBlockedError } from '@amable/auth/security';
import { mergeContext, renderTags, zodConfig } from './merge';
import { failure, httpResult, type Connector, type ConnectorContext, type ConnectorResult } from './types';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function docusealApiBase(config: Pick<DocusealConfig, 'region' | 'base_url'>): string {
  if (config.region === 'eu') return 'https://api.docuseal.eu';
  if (config.region === 'custom') return config.base_url.replace(/\/+$/, '');
  return 'https://api.docuseal.com';
}

async function call(
  ctx: ConnectorContext<DocusealConfig>,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string }> {
  const response = await safeFetch(
    `${docusealApiBase(ctx.connection.config)}${path}`,
    {
      method,
      headers: {
        'x-auth-token': ctx.connection.secret ?? '',
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    { fetchFn: (input, init) => ctx.runtime.fetch(input, init), timeoutMs: 15_000, maxBytes: 256 * 1024 },
  );
  return { status: response.status, text: new TextDecoder().decode(response.body) };
}

/** Body of the signing invitation; DocuSeal variables (`{{submitter.link}}`) are left for DocuSeal. */
export function signingMessage(template: string, context: Record<string, string>): string {
  const rendered = renderTags(template, context);
  if (rendered.trim() === '' || /\{\{\s*submitter\.link\s*\}\}/.test(rendered)) return rendered;
  return `${rendered.trim()}\n\n{{submitter.link}}`;
}

/**
 * Creates a signature request from a DocuSeal template for the submitter
 * (email from a form field), prefilled with form values. DocuSeal has no
 * idempotency keys: retries first look up a submitter with our external id.
 */
export const docusealConnector: Connector<DocusealConfig> = {
  type: 'docuseal',
  secret: 'api_key',
  oauthProvider: null,
  available: () => true,
  parseConfig: zodConfig(docusealConfigSchema),
  async run(ctx): Promise<ConnectorResult> {
    const config = ctx.connection.config;
    if (ctx.connection.secret === null) return failure('API key missing', false);
    const context = mergeContext(ctx);
    const email = (context[config.email_source] ?? '').trim();
    if (!EMAIL_RE.test(email)) {
      return { ...failure(email === '' ? 'signer email missing' : `invalid signer email`, false), statusCode: 422 };
    }
    const externalId = `${ctx.submission.id}:${ctx.connection.id}`;
    try {
      if (ctx.attempt > 1) {
        const lookup = await call(ctx, 'GET', `/submitters?external_id=${encodeURIComponent(externalId)}&limit=1`);
        if (lookup.status === 200 && /"submission_id"/.test(lookup.text)) {
          return { status: 'success', retryable: false, statusCode: 200, request: 'GET /submitters', response: 'already created by a previous attempt' };
        }
      }
      const name =
        (config.name_source === '' ? '' : (context[config.name_source] ?? '')) ||
        ctx.form.fields
          .filter((f) => f.map_to === 'given_name' || f.map_to === 'family_name')
          .map((f) => context[f.key] ?? '')
          .filter((v) => v !== '')
          .join(' ');
      const values: Record<string, string> = {};
      for (const item of config.prefill) {
        const value = context[item.source] ?? '';
        if (value !== '') values[item.field] = value;
      }
      const message = signingMessage(config.message, context);
      const payload = {
        template_id: config.template_id,
        send_email: config.send_email,
        ...(config.subject !== '' || message !== ''
          ? { message: { subject: renderTags(config.subject, context).slice(0, 250), body: message } }
          : {}),
        submitters: [
          {
            email,
            external_id: externalId,
            ...(config.role === '' ? {} : { role: config.role }),
            ...(name === '' ? {} : { name }),
            ...(Object.keys(values).length === 0 ? {} : { values }),
          },
        ],
      };
      const result = await call(ctx, 'POST', '/submissions', payload);
      return httpResult(result.status, `POST /submissions (template ${String(config.template_id)})`, result.text);
    } catch (error) {
      if (error instanceof SsrfBlockedError) return failure(`blocked URL: ${error.message}`, false);
      return failure(`request failed: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  },
};
