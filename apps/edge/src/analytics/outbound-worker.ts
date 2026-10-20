import {
  AD_PLATFORMS,
  ADS_TOKEN_AUTH_EXPIRED,
  ADS_TOKEN_GATEWAY_OP,
  EDGE_INSTALLATION_TENANT,
  type AdPlatform,
  type AdsTokenOutput,
  type AnalyticsGatewayOps,
  type FunnelTouch,
  type GatewayClientInfo,
  type OutboundConversionJob,
  type OutboundPayload,
  type TrafficSource,
} from '@amable/api-types';
import {
  minorToMajor,
  createFakeProvider,
  createProvider,
  isProviderError,
  normalizeEmail,
  normalizePhone,
  ProviderError,
  sha256Hex,
  type AdsProvider,
  type SendConversionOptions,
} from '@amable/ads-providers';
import { z } from 'zod';
import type { Env } from '../env';
import { callCore, GatewayCallError } from '../gateway';
import type {
  AdConnectionRecord,
  AnalyticsStore,
  ConversionRecord,
  OutboundEnqueueInput,
  OutboundOutcome,
} from './store/index';
import {
  outboundGate,
  outboundKindOf,
  outboundRouteFor,
  outboundValueMinor,
  PLATFORM_CLICK_ID_KEYS,
  type OutboundSkipReason,
} from './store/outbound';

/**
 * Server-side conversions sent back to the ad platforms. `enqueueForConversion`
 * turns an attributed conversion into one queue job for the connection mapped
 * on its traffic source; `processOutboundBatch` (DO alarm) sends the due jobs
 * through the platform client, retrying transient failures with backoff.
 */

// ------------------------------------------------------------------ enqueue

/** Minimal conversion accepted from callers that do not hold a `conversion_log` row (CRM payments). */
export interface OutboundConversionInput {
  id: string;
  /** `sale`, `lead` or `event:N`. */
  event: string;
  revenue_minor: number;
  currency: string | null;
  /** Conversion time, epoch ms. */
  ts: number;
  visitor_id: string | null;
  traffic_source_id: string | null;
  tx?: string | null | undefined;
  status?: 'approved' | 'pending' | 'rejected' | undefined;
}

/** Raw PII of the converting visitor: kept in the job only while it is pending. */
export interface OutboundPii {
  email?: string | null | undefined;
  phone?: string | null | undefined;
  ip?: string | null | undefined;
  user_agent?: string | null | undefined;
}

export interface EnqueueForConversionInput {
  conversion: ConversionRecord | OutboundConversionInput;
  source: TrafficSource | null;
  pii?: OutboundPii | undefined;
  /** Click ids known by the caller; they win over the ones found on the visitor's sessions and touches. */
  clickIds?: Record<string, string> | undefined;
  /** Ad-optimization consent of the visitor. */
  consent: boolean;
  /** Uniform in [0, 1), used by the source's postback throttle. */
  rng: () => number;
}

export type EnqueueForConversionResult =
  | { status: 'no_route'; reason: 'no_source' | 'no_mapping' | 'unknown_connection' }
  | {
      /** `duplicate`: a job with the same event id already exists (whatever its status). */
      status: 'enqueued' | 'skipped' | 'duplicate';
      job_id: string;
      event_id: string;
      reason?: OutboundSkipReason;
    };

/** Platforms that need the click to settle before a conversion can be matched to it. */
export const PLATFORM_SEND_DELAY_MS: Readonly<Record<AdPlatform, number>> = {
  meta: 0,
  google: 6 * 3_600_000,
  tiktok: 0,
};

const MAX_CLICK_ID_LENGTH = 512;

/**
 * Stable id of the conversion on one connection: the same conversion reported
 * twice (postback retry, CRM sync) maps to the same job, and can still go to
 * several connections. Custom events add their number so two custom events
 * sharing a transaction id stay distinct.
 */
export function outboundEventId(
  connectionId: string,
  conversion: { id: string; tx?: string | null | undefined; event: string },
): Promise<string> {
  const kind = outboundKindOf(conversion.event);
  const tx = conversion.tx ?? '';
  return sha256Hex(
    [connectionId, tx === '' ? `cv:${conversion.id}` : `tx:${tx}`, kind === 'custom' ? conversion.event : kind].join('|'),
  );
}

function platformOfSource(source: TrafficSource): AdPlatform | null {
  if (source.conversion.platform !== null && source.conversion.platform !== undefined) return source.conversion.platform;
  return (AD_PLATFORMS as readonly string[]).includes(source.template) ? (source.template as AdPlatform) : null;
}

/** Click ids of the visitor for the platform: session click ids, then funnel touches, then the caller's. */
function collectClickIds(
  store: AnalyticsStore,
  platform: AdPlatform,
  visitorId: string | null,
  before: number,
  explicit: Record<string, string> | undefined,
): Record<string, string> {
  const keys = PLATFORM_CLICK_ID_KEYS[platform];
  const out: Record<string, string> = {};
  const put = (key: string, value: string | null | undefined): void => {
    if (keys.includes(key) && value !== null && value !== undefined && value !== '' && value.length <= MAX_CLICK_ID_LENGTH) {
      out[key] = value;
    }
  };
  if (visitorId !== null) {
    for (const ids of store.sessionClickIds(visitorId)) for (const [k, v] of Object.entries(ids)) put(k.toLowerCase(), v);
    const sources = new Map<string, TrafficSource | null>();
    for (const touch of store.listTouchesByVisitor(visitorId, 1000)) {
      if (touch.ts > before || !touch.external_click_id || !touch.traffic_source_id) continue;
      let source = sources.get(touch.traffic_source_id);
      if (source === undefined) {
        source = store.getTrafficSource(touch.traffic_source_id);
        sources.set(touch.traffic_source_id, source);
      }
      if (source === null || platformOfSource(source) !== platform) continue;
      const param = source.reserved_fields.external.url_param.toLowerCase();
      put(keys.includes(param) ? param : (keys[0] as string), touch.external_click_id);
    }
  }
  for (const [k, v] of Object.entries(explicit ?? {})) put(k.toLowerCase(), v);
  return out;
}

function piiFields(pii: OutboundPii | undefined): Pick<OutboundPayload, 'email' | 'phone' | 'ip' | 'user_agent'> {
  const out: Pick<OutboundPayload, 'email' | 'phone' | 'ip' | 'user_agent'> = {};
  const email = pii?.email ? normalizeEmail(pii.email) : null;
  if (email !== null && email.length <= 320) out.email = email;
  const phone = pii?.phone?.trim();
  if (phone && phone.length <= 32) out.phone = phone;
  const ip = pii?.ip?.trim();
  if (ip && ip.length <= 64) out.ip = ip;
  if (pii?.user_agent) out.user_agent = pii.user_agent.slice(0, 1024);
  return out;
}

function isBlacklisted(store: AnalyticsStore, pii: OutboundPii | undefined): boolean {
  const keys: Array<{ key_type: 'email' | 'phone'; key_value: string }> = [];
  const email = pii?.email ? normalizeEmail(pii.email) : null;
  if (email !== null) keys.push({ key_type: 'email', key_value: email });
  const phone = pii?.phone ? normalizePhone(pii.phone) : null;
  if (phone !== null) keys.push({ key_type: 'phone', key_value: phone.startsWith('+') ? phone : `+${phone}` });
  return keys.length > 0 && store.isBlacklisted(keys);
}

/**
 * Enqueues the conversion for the ad connection mapped on its traffic source.
 * Gated conversions (no consent, zero revenue, throttled…) are recorded as
 * `skipped` jobs without PII, so the log shows why nothing was sent and a
 * later report of the same conversion does not re-roll the throttle.
 */
export async function enqueueForConversion(
  store: AnalyticsStore,
  input: EnqueueForConversionInput,
): Promise<EnqueueForConversionResult> {
  const { conversion, source } = input;
  if (source === null) return { status: 'no_route', reason: 'no_source' };
  const route = outboundRouteFor(source, conversion.event);
  if (route === null) {
    const template = source.conversion.postback_url ?? '';
    if (template === '') return { status: 'no_route', reason: 'no_mapping' };
    return enqueuePostback(store, input, source, template);
  }
  const connection = store.getAdConnection(route.connection_id);
  if (connection === null || connection.platform !== route.platform) {
    return { status: 'no_route', reason: 'unknown_connection' };
  }

  const kind = outboundKindOf(conversion.event);
  const eventId = await outboundEventId(route.connection_id, conversion);
  const gate = gateConversion(store, input, source, eventId);
  if ('done' in gate) return gate.done;
  const { skip } = gate;

  const tx = conversion.tx ?? '';
  const hasValue = conversion.revenue_minor > 0 || kind === 'purchase';
  const currency = conversion.currency ?? store.getSite()?.site.currency ?? null;
  const payload: OutboundPayload = {
    event_name: route.platform_event,
    event_time: conversion.ts,
    value_minor: hasValue ? outboundValueMinor(source, conversion.revenue_minor) : null,
    currency: hasValue ? currency : null,
    order_id: tx === '' ? conversion.id : tx,
    click_ids: collectClickIds(store, route.platform, conversion.visitor_id, conversion.ts, input.clickIds),
    external_id: conversion.visitor_id,
    ...(skip === null ? piiFields(input.pii) : {}),
  };
  const delay = PLATFORM_SEND_DELAY_MS[route.platform];
  return enqueueGated(
    store,
    {
      platform: route.platform,
      connection_id: route.connection_id,
      kind,
      payload,
      event_id: eventId,
      ...(delay > 0 ? { next_attempt_at: conversion.ts + delay } : {}),
    },
    skip,
  );
}

/** An existing job for `eventId` (duplicate), else the gate verdict (`null` = send). */
function gateConversion(
  store: AnalyticsStore,
  input: EnqueueForConversionInput,
  source: TrafficSource,
  eventId: string,
): { done: EnqueueForConversionResult } | { skip: OutboundSkipReason | null } {
  const existing = store.listOutbound({ event_id: eventId, limit: 1 })[0];
  if (existing !== undefined) return { done: { status: 'duplicate', job_id: existing.id, event_id: eventId } };
  const { conversion } = input;
  return {
    skip: outboundGate(source, {
      revenue_minor: conversion.revenue_minor,
      status: conversion.status,
      consent: input.consent,
      blacklisted: isBlacklisted(store, input.pii),
      rng: input.rng,
    }),
  };
}

/** Enqueues the job; a gated one is recorded at once as `skipped`. */
function enqueueGated(
  store: AnalyticsStore,
  job: OutboundEnqueueInput & { event_id: string },
  skip: OutboundSkipReason | null,
): EnqueueForConversionResult {
  const enqueued = store.enqueueOutbound(job);
  if (!enqueued.ok) throw new Error(`outbound enqueue: ${enqueued.error.message}`);
  const { id, created } = enqueued.value;
  const eventId = job.event_id;
  if (!created) return { status: 'duplicate', job_id: id, event_id: eventId };
  if (skip !== null) {
    store.finishOutbound(id, { status: 'skipped', error: skip });
    return { status: 'skipped', job_id: id, event_id: eventId, reason: skip };
  }
  return { status: 'enqueued', job_id: id, event_id: eventId };
}

/** Funnel touch the conversion belongs to: its hit, else the visitor's last touch from the source. */
function conversionTouch(
  store: AnalyticsStore,
  conversion: ConversionRecord | OutboundConversionInput,
  sourceId: string,
): FunnelTouch | null {
  if ('hit' in conversion && conversion.hit !== '') {
    const touch = store.getTouch(conversion.hit);
    if (touch !== null) return touch;
  }
  if (conversion.visitor_id === null) return null;
  return (
    store
      .listTouchesByVisitor(conversion.visitor_id, 1000)
      .filter((t) => t.traffic_source_id === sourceId && t.ts <= conversion.ts)
      .sort((a, b) => b.ts - a.ts)[0] ?? null
  );
}

/**
 * Fills the `{token}` placeholders of a source's postback URL, URL-encoded:
 * `{external}` click id, `{campaign}`, `{payout}` (major units, revenue
 * modifier applied), `{txid}`, `{hit}` and `{data-<field name>}`. Unknown
 * tokens become empty.
 */
export function postbackUrl(
  template: string,
  source: TrafficSource,
  conversion: ConversionRecord | OutboundConversionInput,
  touch: FunnelTouch | null,
  currency: string | null,
): string {
  const payoutMinor = outboundValueMinor(source, conversion.revenue_minor);
  const tx = conversion.tx ?? '';
  const value = (token: string): string => {
    switch (token) {
      case 'external':
        return touch?.external_click_id ?? '';
      case 'campaign':
        return touch?.campaign ?? '';
      case 'payout':
        return String(currency === null ? payoutMinor / 100 : minorToMajor(payoutMinor, currency));
      case 'txid':
        return tx === '' ? conversion.id : tx;
      case 'hit':
        return touch?.id ?? ('hit' in conversion ? conversion.hit : '');
    }
    if (!token.startsWith('data-')) return '';
    const name = token.slice(5).toLowerCase();
    const field = source.fields.find((f) => f.name.toLowerCase() === name || f.url_param.toLowerCase() === name);
    return field === undefined ? '' : (touch?.fields?.[field.slot] ?? '');
  };
  return template.replace(/\{([A-Za-z0-9_.-]+)\}/g, (_, token: string) => encodeURIComponent(value(token)));
}

/** Same queue and gates as the platform route, for the source's own postback URL. */
async function enqueuePostback(
  store: AnalyticsStore,
  input: EnqueueForConversionInput,
  source: TrafficSource,
  template: string,
): Promise<EnqueueForConversionResult> {
  const { conversion } = input;
  const eventId = await outboundEventId(`postback:${source.id}`, conversion);
  const gate = gateConversion(store, input, source, eventId);
  if ('done' in gate) return gate.done;
  const { skip } = gate;
  const currency = conversion.currency ?? store.getSite()?.site.currency ?? null;
  const touch = conversionTouch(store, conversion, source.id);
  const tx = conversion.tx ?? '';
  return enqueueGated(
    store,
    {
      platform: 'postback',
      connection_id: source.id,
      kind: outboundKindOf(conversion.event),
      payload: {
        event_name: conversion.event,
        event_time: conversion.ts,
        value_minor: outboundValueMinor(source, conversion.revenue_minor),
        currency,
        order_id: tx === '' ? conversion.id : tx,
        click_ids: {},
        external_id: conversion.visitor_id,
        url: postbackUrl(template, source, conversion, touch, currency).slice(0, 4096),
      },
      event_id: eventId,
    },
    skip,
  );
}

const optionalText = (max: number) => z.string().max(max).nullable().optional();

/** RPC body: a stored conversion by id, or an inline one (CRM payment). */
export const conversionOutboundRequestSchema = z
  .object({
    conversion_id: z.string().min(1).max(128).optional(),
    conversion: z
      .object({
        id: z.string().min(1).max(128),
        event: z.string().regex(/^(?:sale|lead|event:\d{1,3})$/),
        revenue_minor: z.number().int(),
        currency: z
          .string()
          .regex(/^[A-Z]{3}$/)
          .nullable(),
        ts: z.number().int(),
        visitor_id: z.string().min(1).max(128).nullable(),
        traffic_source_id: z.string().min(1).max(64).nullable(),
        tx: optionalText(255),
        status: z.enum(['approved', 'pending', 'rejected']).optional(),
      })
      .optional(),
    pii: z
      .object({
        email: optionalText(320),
        phone: optionalText(64),
        ip: optionalText(64),
        user_agent: optionalText(4096),
      })
      .optional(),
    click_ids: z.record(z.string().max(32), z.string().max(MAX_CLICK_ID_LENGTH)).optional(),
    consent: z.boolean(),
  })
  .refine((r) => (r.conversion_id === undefined) !== (r.conversion === undefined), {
    message: 'exactly one of conversion_id and conversion',
  });
export type ConversionOutboundRequest = z.input<typeof conversionOutboundRequestSchema>;

// ------------------------------------------------------------------- worker

/** Delay before the next attempt, indexed by the attempts already made − 1. */
export const OUTBOUND_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 12 * 3_600_000] as const;
/** The first attempt plus one retry after each backoff delay. */
export const OUTBOUND_MAX_ATTEMPTS = OUTBOUND_BACKOFF_MS.length + 1;
export const OUTBOUND_BATCH_SIZE = 50;

export function outboundRetryDelay(attempts: number): number {
  const i = Math.min(Math.max(attempts, 1), OUTBOUND_BACKOFF_MS.length) - 1;
  return OUTBOUND_BACKOFF_MS[i] as number;
}

/** Platform client + access token of a connection. Tokens live in the core, never in the edge. */
export interface ResolvedProvider {
  provider: AdsProvider;
  token: string;
  /** Merged over the options derived from the connection metadata. */
  options?: SendConversionOptions | undefined;
}

/**
 * Credentials of a connection, or null when they are unavailable right now
 * (the job is retried). Throwing a `ProviderError` of kind `auth_expired`
 * fails the job and flags the connection.
 */
export type ProviderResolver = (connectionId: string) => Promise<ResolvedProvider | null> | ResolvedProvider | null;

export interface OutboundRunResult {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
}

const MAX_ERROR_LENGTH = 500;

function metaString(metadata: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = metadata[key];
    if (typeof v === 'string' && v !== '') return v;
  }
  return undefined;
}

/** Send options read from the connection metadata (`pixel_id`, `pixel_code`, `customer_id`, `test_event_code`…). */
export function connectionSendOptions(connection: AdConnectionRecord, job: OutboundConversionJob): SendConversionOptions {
  const md = connection.metadata;
  const pick: Record<string, string | undefined> = {
    testEventCode: metaString(md, 'test_event_code'),
    defaultCallingCode: metaString(md, 'default_calling_code'),
  };
  switch (connection.platform) {
    case 'meta':
      pick.pixelId = metaString(md, 'pixel_id', 'dataset_id');
      break;
    case 'google':
      pick.customerId = metaString(md, 'customer_id') ?? connection.account_id;
      pick.conversionAction = job.payload.event_name;
      break;
    case 'tiktok':
      pick.pixelCode = metaString(md, 'pixel_code', 'event_source_id');
      break;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(pick)) if (v !== undefined) out[k] = v;
  return out as SendConversionOptions;
}

function errorText(error: unknown): string {
  const text = isProviderError(error)
    ? `${error.kind}${error.platformCode === undefined ? '' : ` (${error.platformCode})`}: ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);
  return text.slice(0, MAX_ERROR_LENGTH);
}

export const POSTBACK_TIMEOUT_MS = 10_000;

/** GET of a postback job's URL: `sent` on 2xx, retried on 408/429/5xx and network errors. */
async function sendPostback(job: OutboundConversionJob, fetcher: typeof fetch): Promise<'sent' | { retry: boolean; error: string }> {
  const url = job.payload.url ?? '';
  if (!/^https?:\/\//i.test(url)) return { retry: false, error: 'invalid_postback_url' };
  try {
    const res = await fetcher(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(POSTBACK_TIMEOUT_MS) });
    await res.body?.cancel();
    if (res.ok) return 'sent';
    return { retry: res.status === 408 || res.status === 429 || res.status >= 500, error: `http_${res.status}` };
  } catch (error) {
    return { retry: true, error: errorText(error) };
  }
}

/** Claims the due jobs and sends them; every job ends sent, back in the queue with backoff, or failed. */
export async function processOutboundBatch(
  store: AnalyticsStore,
  resolver: ProviderResolver,
  now: number,
  limit: number = OUTBOUND_BATCH_SIZE,
  fetcher: typeof fetch = fetch,
): Promise<OutboundRunResult> {
  const jobs = store.claimOutboundBatch(now, limit);
  const result: OutboundRunResult = { claimed: jobs.length, sent: 0, retried: 0, failed: 0 };
  const resolved = new Map<string, Promise<ResolvedProvider | null>>();

  const settle = (job: OutboundConversionJob, outcome: OutboundOutcome): void => {
    store.finishOutbound(job.id, outcome);
    if (outcome.status === 'sent') result.sent += 1;
    else if (outcome.status === 'retry') result.retried += 1;
    else result.failed += 1;
  };
  const retryOrFail = (job: OutboundConversionJob, error: string): void => {
    if (job.attempts >= OUTBOUND_MAX_ATTEMPTS) settle(job, { status: 'failed', error });
    else settle(job, { status: 'retry', error, next_attempt_at: now + outboundRetryDelay(job.attempts) });
  };
  const markAuthExpired = (connection: AdConnectionRecord, error: string): void => {
    store.upsertAdConnection({
      id: connection.id,
      platform: connection.platform,
      account_id: connection.account_id,
      status: 'auth_expired',
      last_error: error,
    });
  };

  for (const job of jobs) {
    if (job.platform === 'postback') {
      const sent = await sendPostback(job, fetcher);
      if (sent === 'sent') settle(job, { status: 'sent' });
      else if (sent.retry) retryOrFail(job, sent.error);
      else settle(job, { status: 'failed', error: sent.error });
      continue;
    }
    const connection = store.getAdConnection(job.connection_id);
    if (connection === null) {
      settle(job, { status: 'failed', error: 'connection_not_found' });
      continue;
    }
    if (connection.status === 'disconnected') {
      settle(job, { status: 'failed', error: 'connection_disconnected' });
      continue;
    }
    if (connection.status === 'auth_expired') {
      retryOrFail(job, 'connection_auth_expired');
      continue;
    }
    let client: ResolvedProvider | null;
    try {
      let pending = resolved.get(connection.id);
      if (pending === undefined) {
        pending = Promise.resolve(resolver(connection.id));
        resolved.set(connection.id, pending);
      }
      client = await pending;
    } catch (error) {
      if (isProviderError(error) && error.kind === 'auth_expired') {
        markAuthExpired(connection, errorText(error));
        settle(job, { status: 'failed', error: errorText(error) });
      } else {
        retryOrFail(job, `credentials_unavailable: ${errorText(error)}`.slice(0, MAX_ERROR_LENGTH));
      }
      continue;
    }
    if (client === null) {
      retryOrFail(job, 'credentials_unavailable');
      continue;
    }
    if (client.provider.platform !== job.platform) {
      settle(job, { status: 'failed', error: 'platform_mismatch' });
      continue;
    }
    try {
      await client.provider.sendConversion(client.token, job, {
        ...connectionSendOptions(connection, job),
        ...client.options,
      });
      settle(job, { status: 'sent' });
    } catch (error) {
      const text = errorText(error);
      if (!isProviderError(error) || error.kind === 'retryable') {
        retryOrFail(job, text);
      } else if (error.kind === 'auth_expired') {
        markAuthExpired(connection, text);
        settle(job, { status: 'failed', error: text });
      } else {
        settle(job, { status: 'failed', error: text });
      }
    }
  }
  return result;
}

// ----------------------------------------------------- credentials from core

const NO_CLIENT: GatewayClientInfo = {
  ip: null,
  userAgent: null,
  country: null,
  visitorId: null,
  referer: null,
  acceptLanguage: null,
};

/**
 * Resolver asking the core over the signed service-binding gateway. The DO
 * only knows the tenant id, so the call targets the installation tenant and
 * carries `tenant_id` in the input.
 */
export function coreProviderResolver(
  env: Env,
  site: { tenantId: string; siteId: string },
  deps: { fetch?: typeof fetch; now?: () => number } = {},
): ProviderResolver {
  return async (connectionId) => {
    let value: AdsTokenOutput;
    try {
      value = (
        await callCore<AnalyticsGatewayOps, typeof ADS_TOKEN_GATEWAY_OP>(
          env,
          ADS_TOKEN_GATEWAY_OP,
          EDGE_INSTALLATION_TENANT,
          NO_CLIENT,
          { tenant_id: site.tenantId, site_id: site.siteId, connection_id: connectionId },
        )
      ).value;
    } catch (error) {
      if (error instanceof GatewayCallError && error.body.code === ADS_TOKEN_AUTH_EXPIRED) {
        throw new ProviderError('auth_expired', error.body.message);
      }
      return null;
    }
    if (value === null) return null;
    if (env.ENVIRONMENT === 'dev') {
      return { provider: createFakeProvider(value.platform), token: value.access_token };
    }
    const provider = createProvider(value.platform, {
      clientId: '',
      clientSecret: '',
      ...(value.developer_token ? { developerToken: value.developer_token } : {}),
      ...(value.login_customer_id ? { loginCustomerId: value.login_customer_id } : {}),
      ...(value.api_version ? { apiVersion: value.api_version } : {}),
      fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
      now: deps.now ?? Date.now,
    });
    return { provider, token: value.access_token };
  };
}
