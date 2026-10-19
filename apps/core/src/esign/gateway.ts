import { ESIGN_IMAGE_FIELDS } from '@amable/api-types';
import { generateNumericCode, sha256Hex } from '@amable/auth';
import { acceptLanguageList } from '@amable/booking';
import {
  ESIGN_DOCUMENT_RAW_OP,
  ESIGN_PAGE_RAW_OP,
  SIGNING_TOKEN_RE,
  type EsignGatewayOps,
  type SigningBrowserFacts,
} from '@amable/esign';
import { ulid } from 'ulid';
import { z } from 'zod';
import { GatewayError, type GatewayContext, type GatewayHandlers, type GatewayRawHandlers } from '../public/context';
import { signingDay, validateValues } from './fields';
import { esignEmail } from './messages';
import { notifyDecline } from './notify';
import type { ClientFacts, FieldValues, ImageValue } from './model';
import { hashSigningToken, otpCodeHash } from './tokens';

type Output<K extends keyof EsignGatewayOps> = EsignGatewayOps[K]['output'];

/** Decoded size cap of one signature / picture. */
export const SIGNING_IMAGE_MAX_BYTES = 400_000;

const TOKEN = z.string().regex(SIGNING_TOKEN_RE);
const short = (max: number) => z.string().max(max).optional();
const browserSchema = z
  .object({
    time_zone: short(64),
    local_time: short(40),
    languages: z.array(z.string().max(35)).max(10).optional(),
    platform: short(100),
    screen: short(40),
    viewport: short(40),
    pixel_ratio: z.number().min(0).max(20).optional(),
    color_depth: z.number().int().min(0).max(64).optional(),
    touch_points: z.number().int().min(0).max(64).optional(),
    hardware_concurrency: z.number().int().min(0).max(1024).optional(),
    device_memory: z.number().min(0).max(1024).optional(),
    cookies_enabled: z.boolean().optional(),
    do_not_track: short(10),
    webdriver: z.boolean().optional(),
    referrer: short(2048),
  })
  .strip();
const viewInput = z.strictObject({ token: TOKEN, locale: short(16) });
const actionInput = z.strictObject({ token: TOKEN, browser: browserSchema.optional() });
const verifyInput = z.strictObject({ token: TOKEN, code: z.string().regex(/^\d{6}$/), browser: browserSchema.optional() });
const declineInput = z.strictObject({ token: TOKEN, reason: z.string().max(500).optional(), browser: browserSchema.optional() });
const completeInput = z.strictObject({
  token: TOKEN,
  submit: z.strictObject({
    values: z.record(z.string().max(40), z.union([z.string().max(600_000), z.boolean()])),
    methods: z.record(z.string().max(40), z.enum(['drawn', 'typed', 'upload'])).optional(),
    consent: z.boolean(),
    consent_version: z.string().max(40),
    browser: browserSchema.optional(),
  }),
});
const pageInput = z.strictObject({ token: TOKEN, page: z.number().int().min(0).max(49) });
const documentInput = z.strictObject({ token: TOKEN });

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

/** Edge request facts + what the signing app read from the browser. */
export function clientFacts(ctx: GatewayContext, browser: SigningBrowserFacts | undefined): ClientFacts {
  return {
    ip: ctx.client.ip,
    user_agent: ctx.client.userAgent,
    country: ctx.client.country,
    meta: {
      accept_language: ctx.client.acceptLanguage,
      ...(ctx.client.visitorId === null ? {} : { visitor_id: ctx.client.visitorId }),
      ...browser,
    },
  };
}

function preferred(ctx: GatewayContext, locale?: string): string[] {
  const list = acceptLanguageList(ctx.client.acceptLanguage);
  return locale === undefined ? list : [locale, ...list];
}

function kickEngine(ctx: GatewayContext): void {
  ctx.executionCtx.waitUntil(
    ctx.env.ENGINE.get(ctx.env.ENGINE.idFromName(ctx.tenant.id))
      .kick(ctx.tenant.id)
      .catch((error: unknown) => console.error('[esign] engine kick failed', error)),
  );
}

async function session(ctx: GatewayContext, token: string, locale?: string) {
  return ctx.crm('esign.signer.view', { tokenHash: await hashSigningToken(token), tenantName: ctx.tenant.name, preferred: preferred(ctx, locale) });
}

const DATA_URL_RE = /^data:(image\/png|image\/jpeg);base64,([A-Za-z0-9+/=]+)$/;

function decodeImage(value: string): { bytes: Uint8Array<ArrayBuffer>; type: 'image/png' | 'image/jpeg' } | null {
  const match = DATA_URL_RE.exec(value);
  if (match === null) return null;
  let binary: string;
  try {
    binary = atob(match[2]!);
  } catch {
    return null;
  }
  if (binary.length === 0 || binary.length > SIGNING_IMAGE_MAX_BYTES) return null;
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (png) return { bytes, type: 'image/png' };
  if (jpeg) return { bytes, type: 'image/jpeg' };
  return null;
}

async function complete(ctx: GatewayContext, input: unknown): Promise<Output<'esign.complete'>> {
  const { token, submit } = parse(completeInput, input);
  if (!submit.consent) {
    throw new GatewayError(422, 'consent_required', 'consent to sign electronically is required', [{ path: 'consent', message: 'required' }]);
  }
  const tokenHash = await hashSigningToken(token);
  const { requestId, signerId, fields } = await ctx.crm('esign.signer.fields', { tokenHash });

  const values: FieldValues = {};
  const uploads: Array<{ key: string; bytes: Uint8Array<ArrayBuffer>; type: string }> = [];
  const errors: Array<{ path: string; message: string }> = [];
  for (const field of fields) {
    const raw = submit.values[field.id];
    if (raw === undefined || raw === '') continue;
    if (!ESIGN_IMAGE_FIELDS.has(field.type)) {
      values[field.id] = raw;
      continue;
    }
    const image = typeof raw === 'string' ? decodeImage(raw) : null;
    if (image === null) {
      errors.push({ path: `values.${field.id}`, message: 'expected a PNG or JPEG image (max 400 KB)' });
      continue;
    }
    const sha256 = await sha256Hex(image.bytes);
    const key = `tenants/${ctx.tenant.id}/esign/requests/${requestId}/signers/${signerId}/${field.id}-${ulid()}.${image.type === 'image/png' ? 'png' : 'jpg'}`;
    const value: ImageValue = { key, sha256, content_type: image.type, method: submit.methods?.[field.id] ?? 'drawn' };
    values[field.id] = value;
    uploads.push({ key, bytes: image.bytes, type: image.type });
  }
  const checked = validateValues(fields, values, signingDay(Date.now(), submit.browser?.time_zone));
  errors.push(...checked.errors);
  if (errors.length > 0) throw new GatewayError(422, 'validation_failed', 'some fields are missing or invalid', errors);

  await Promise.all(uploads.map((u) => ctx.env.FILES.put(u.key, u.bytes, { httpMetadata: { contentType: u.type } })));
  try {
    const result = await ctx.crm('esign.signer.complete', {
      tokenHash,
      values,
      consentVersion: submit.consent_version,
      tenantName: ctx.tenant.name,
      preferred: preferred(ctx),
      client: clientFacts(ctx, submit.browser),
    });
    kickEngine(ctx);
    return result.view;
  } catch (error) {
    await Promise.all(uploads.map((u) => ctx.env.FILES.delete(u.key).catch(() => undefined)));
    throw error;
  }
}

export const esignGatewayHandlers: GatewayHandlers = {
  async 'esign.view'(ctx, input): Promise<Output<'esign.view'>> {
    const { token, locale } = parse(viewInput, input);
    return (await session(ctx, token, locale)).view;
  },

  async 'esign.open'(ctx, input): Promise<Output<'esign.open'>> {
    const { token, browser } = parse(actionInput, input);
    const result = await ctx.crm('esign.signer.view', {
      tokenHash: await hashSigningToken(token),
      tenantName: ctx.tenant.name,
      preferred: preferred(ctx),
      open: { client: clientFacts(ctx, browser) },
    });
    return result.view;
  },

  async 'esign.otpSend'(ctx, input): Promise<Output<'esign.otpSend'>> {
    const { token, browser } = parse(actionInput, input);
    const { signer } = await session(ctx, token);
    const code = generateNumericCode(6);
    const issued = await ctx.crm('esign.signer.otpIssue', {
      tokenHash: await hashSigningToken(token),
      codeHash: await otpCodeHash(ctx.env, signer.id, code),
      preferred: preferred(ctx),
      client: clientFacts(ctx, browser),
    });
    if (!issued.ok) return { sent: false, retry_after: issued.retryAfter };
    await ctx.env.EMAIL_SEND.send(
      esignEmail({
        id: `esign-otp-${signer.id}-${ulid()}`,
        tenantId: ctx.tenant.id,
        senderName: ctx.tenant.name,
        kind: 'otp',
        mail: {
          contactId: issued.signer.contact_id,
          email: signer.email,
          partyName: signer.party_name,
          requestName: signer.request_name,
          requestId: signer.request_id,
          message: '',
          subject: '',
          locale: issued.signer.locale,
          expiresAt: null,
        },
        url: '',
        code,
        now: Date.now(),
      }),
    );
    return { sent: true, retry_after: issued.retryAfter };
  },

  async 'esign.otpVerify'(ctx, input): Promise<Output<'esign.otpVerify'>> {
    const { token, code, browser } = parse(verifyInput, input);
    const { signer } = await session(ctx, token);
    return ctx.crm('esign.signer.otpVerify', {
      tokenHash: await hashSigningToken(token),
      codeHash: await otpCodeHash(ctx.env, signer.id, code),
      client: clientFacts(ctx, browser),
    });
  },

  'esign.complete': complete,

  async 'esign.decline'(ctx, input): Promise<Output<'esign.decline'>> {
    const { token, reason, browser } = parse(declineInput, input);
    const result = await ctx.crm('esign.signer.decline', {
      tokenHash: await hashSigningToken(token),
      reason,
      tenantName: ctx.tenant.name,
      preferred: preferred(ctx),
      client: clientFacts(ctx, browser),
    });
    kickEngine(ctx);
    ctx.executionCtx.waitUntil(notifyDecline(ctx.env, ctx.tenant, result.notice));
    return result.view;
  },
};

async function fileResponse(ctx: GatewayContext, file: { key: string; content_type: string; filename: string }, cache: string, disposition: string) {
  const object = await ctx.env.FILES.get(file.key);
  if (object === null) return new Response('Not found', { status: 404 });
  return new Response(object.body, {
    headers: {
      'content-type': file.content_type,
      'content-length': String(object.size),
      'cache-control': cache,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'content-disposition': `${disposition}; filename="${file.filename.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    },
  });
}

function notFoundResponse(error: unknown): Response {
  if (error instanceof GatewayError) return new Response(error.message, { status: error.status });
  throw error;
}

export const esignGatewayRawHandlers: GatewayRawHandlers = {
  async [ESIGN_PAGE_RAW_OP](ctx, input) {
    const { token, page } = parse(pageInput, input);
    try {
      const file = await ctx.crm('esign.signer.file', { tokenHash: await hashSigningToken(token), page });
      return await fileResponse(ctx, file, 'private, max-age=3600', 'inline');
    } catch (error) {
      return notFoundResponse(error);
    }
  },
  async [ESIGN_DOCUMENT_RAW_OP](ctx, input) {
    const { token } = parse(documentInput, input);
    try {
      const file = await ctx.crm('esign.signer.file', { tokenHash: await hashSigningToken(token), client: clientFacts(ctx, undefined) });
      return await fileResponse(ctx, file, 'private, no-store', 'attachment');
    } catch (error) {
      return notFoundResponse(error);
    }
  },
};
