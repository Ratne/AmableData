import { sanitizeHtml } from '@amable/auth/security';
import {
  submitPayloadSchema,
  TRACKING_PARAMS,
  validateSubmission,
  type FormDefinition,
  type FormsGatewayOps,
  type PublicFormConfig,
  type SubmitResult,
} from '@amable/forms';
import { ulid } from 'ulid';
import { z } from 'zod';
import { GatewayError, type GatewayContext, type GatewayHandlers, type GatewayRawHandlers } from '../public/context';
import { encryptSubmission } from './crypto';
import { enqueueSubmission } from './queue';
import { formsRuntime, type FormsRuntime } from './runtime';

const formRefSchema = z.strictObject({ formId: z.string().min(1).max(64) });
const submitInputSchema = z.strictObject({ formId: z.string().min(1).max(64), payload: z.unknown() });

const SUBMIT_RATE = { name: 'forms:submit:ip', limit: 30, windowMs: 10 * 60_000 } as const;

type Output<K extends keyof FormsGatewayOps> = FormsGatewayOps[K]['output'];

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new GatewayError(
      422,
      'validation_failed',
      'invalid input',
      result.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
    );
  }
  return result.data;
}

/** The form requires Turnstile and the installation verifies it. */
function turnstileRequired(definition: FormDefinition, runtime: FormsRuntime): boolean {
  return definition.settings.turnstile_enabled && runtime.turnstile.enabled;
}

export function publicConfig(
  form: { id: string; name: string; definition: FormDefinition },
  tenantSlug: string,
  runtime: FormsRuntime,
): PublicFormConfig {
  const { allowed_domains: _allowed, ...settings } = form.definition.settings;
  void _allowed;
  return {
    id: form.id,
    name: form.name,
    tenant: tenantSlug,
    fields: form.definition.fields.map((field) =>
      field.kind === 'html' ? { ...field, html: sanitizeHtml(field.html) } : field,
    ),
    settings,
    style: form.definition.style,
    turnstile_site_key: turnstileRequired(form.definition, runtime) ? runtime.turnstileSiteKey : null,
  };
}

function hostOf(url: string | null | undefined): string | null {
  if (url === null || url === undefined || url === '') return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Allowed-domain check on the host page; the hosted page of the form itself is always allowed. */
function domainAllowed(
  allowed: readonly string[],
  pageUrl: string,
  referer: string | null,
  hostedPath: string,
): boolean {
  if (allowed.length === 0) return true;
  const source = pageUrl !== '' ? pageUrl : (referer ?? '');
  try {
    if (new URL(source).pathname.startsWith(hostedPath)) return true;
  } catch {
    return false;
  }
  const host = hostOf(source);
  if (host === null) return false;
  return allowed.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

async function loadPublic(ctx: GatewayContext, formId: string) {
  return ctx.crm('forms.public', { id: formId });
}

async function config(ctx: GatewayContext, input: unknown): Promise<Output<'forms.config'>> {
  const { formId } = parse(formRefSchema, input);
  const form = await loadPublic(ctx, formId);
  return publicConfig(form, ctx.tenant.slug, await formsRuntime(ctx.env));
}

async function hosted(ctx: GatewayContext, input: unknown): Promise<Output<'forms.hosted'>> {
  const { formId } = parse(formRefSchema, input);
  const form = await loadPublic(ctx, formId);
  if (!form.definition.settings.hosted_enabled) throw new GatewayError(404, 'not_found', 'form not found');
  return { config: publicConfig(form, ctx.tenant.slug, await formsRuntime(ctx.env)), tenantName: ctx.tenant.name };
}

function successOf(definition: FormDefinition, submissionId: string): SubmitResult {
  return {
    ok: true,
    submission_id: submissionId,
    success_mode: definition.settings.success_mode,
    success_message: definition.settings.success_message,
    redirect_url: definition.settings.success_mode === 'redirect' ? definition.settings.redirect_url : '',
  };
}

/**
 * Public submit: validate (Turnstile, allowed domains, fields), encrypt in the
 * worker, store a pending row, then queue the processing. Plaintext values
 * never reach the TenantDb.
 */
async function submit(ctx: GatewayContext, input: unknown): Promise<Output<'forms.submit'>> {
  const { formId, payload: rawPayload } = parse(submitInputSchema, input);
  const payload = parse(submitPayloadSchema, rawPayload);
  const runtime = await formsRuntime(ctx.env);
  const form = await loadPublic(ctx, formId);
  const definition = form.definition;
  const submissionId = ulid(runtime.now());

  // Bots filling the honeypot get a normal answer and nothing is stored.
  if (payload.hp !== '') return successOf(definition, submissionId);

  if (ctx.client.ip !== null) {
    const limit = await runtime.limiter.consume(SUBMIT_RATE, `${ctx.tenant.id}:${ctx.client.ip}`);
    if (!limit.allowed) throw new GatewayError(429, 'rate_limited', 'too many submissions, retry later');
  }
  if (turnstileRequired(definition, runtime)) {
    const ok = await runtime.turnstile.verify(payload.turnstile_token || undefined, ctx.client.ip);
    if (!ok) throw new GatewayError(403, 'turnstile_failed', 'bot verification failed');
  }
  const hostedPath = `/f/${ctx.tenant.slug}/${form.id}`;
  if (!domainAllowed(definition.settings.allowed_domains, payload.meta.page_url, ctx.client.referer, hostedPath)) {
    throw new GatewayError(403, 'domain_not_allowed', 'this form cannot be submitted from this website');
  }
  const validation = validateSubmission(definition, payload.values);
  if (!validation.ok) {
    throw new GatewayError(
      422,
      'validation_failed',
      'some fields are not valid',
      Object.entries(validation.errors).map(([path, message]) => ({ path, message })),
    );
  }

  const tracking: Record<string, string> = {};
  for (const key of TRACKING_PARAMS) {
    const value = payload.tracking[key];
    if (value !== undefined && value !== '') tracking[key] = value;
  }
  const meta = {
    ...payload.meta,
    visitor_id: payload.meta.visitor_id !== '' ? payload.meta.visitor_id : (ctx.client.visitorId ?? ''),
    referrer: payload.meta.referrer !== '' ? payload.meta.referrer : (ctx.client.referer ?? ''),
  };
  const ciphertext = await encryptSubmission(runtime.secretBox, ctx.tenant.id, submissionId, {
    values: validation.values,
    tracking,
    meta,
  });
  const nullable = (value: string | undefined): string | null => (value === undefined || value === '' ? null : value);
  await ctx.crm('forms.storeSubmission', {
    id: submissionId,
    formId: form.id,
    ciphertext,
    visitorId: nullable(meta.visitor_id),
    country: ctx.client.country,
    source: {
      utm_source: nullable(tracking['utm_source']),
      utm_medium: nullable(tracking['utm_medium']),
      utm_campaign: nullable(tracking['utm_campaign']),
      utm_term: nullable(tracking['utm_term']),
      utm_content: nullable(tracking['utm_content']),
      referrer: nullable(meta.first_referrer !== '' ? meta.first_referrer : meta.referrer),
      page_url: nullable(meta.page_url),
      page_id: nullable(meta.page_id),
    },
  });
  await enqueueSubmission(ctx.env, ctx.executionCtx, { tenantId: ctx.tenant.id, submissionId });
  return successOf(definition, submissionId);
}

/** Public ops reachable from the edge worker (see `FormsGatewayOps` in @amable/forms). */
export const formsGatewayHandlers: GatewayHandlers = {
  'forms.config': config,
  'forms.hosted': hosted,
  'forms.submit': submit,
};
export const formsGatewayRawHandlers: GatewayRawHandlers = {};
