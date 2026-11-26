import {
  createMetaProvider,
  createTikTokProvider,
  isProviderError,
  META_DEFAULT_API_VERSION,
  type AdsProvider,
  type SendConversionOptions,
} from '@amable/ads-providers';
import type { FacebookCapiConfig, OutboundConversionJob, TiktokEventsConfig } from '@amable/api-types';
import type { FormField } from '@amable/forms';
import type { ZodType } from 'zod';
import { zodConfig } from './merge';
import { failure, type Connector, type ConnectorResult } from './types';

export type ConversionPlatform = 'meta' | 'tiktok';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** One server-side conversion, platform neutral; PII in clear (the provider normalizes and hashes it). */
export interface AdConversion {
  readonly platform: ConversionPlatform;
  /** Shared with the browser pixel for deduplication. */
  readonly eventId: string;
  readonly eventName: string;
  /** Epoch ms. */
  readonly eventTime: number;
  readonly email: string | null;
  readonly phone: string | null;
  /** `fbclid`/`fbc`/`fbp` for Meta, `ttclid`/`ttp` for TikTok. */
  readonly clickIds: Readonly<Record<string, string>>;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly pageUrl: string | null;
  readonly externalId: string | null;
  readonly valueMinor?: number;
  readonly currency?: string;
  readonly orderId?: string;
}

export interface ConversionTarget {
  readonly platform: ConversionPlatform;
  /** Access token generated in the platform's Events Manager. */
  readonly token: string;
  readonly config: FacebookCapiConfig | TiktokEventsConfig;
  readonly fetch: Fetch;
  readonly now: () => number;
}

const CLICK_ID_KEYS: Readonly<Record<ConversionPlatform, readonly string[]>> = {
  meta: ['fbclid', 'fbc', 'fbp'],
  tiktok: ['ttclid', 'ttp'],
};

function pixelOf(target: Pick<ConversionTarget, 'platform' | 'config'>): string {
  return target.platform === 'meta'
    ? (target.config as FacebookCapiConfig).pixel_id
    : (target.config as TiktokEventsConfig).pixel_code;
}

function providerOf(target: ConversionTarget): AdsProvider {
  // No OAuth app: the pasted Events Manager token is used as is (no appsecret_proof).
  const fetchUrl = ((input: RequestInfo | URL, init?: RequestInit) =>
    target.fetch(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init)) as typeof fetch;
  const config = { clientId: '', clientSecret: '', fetch: fetchUrl, now: target.now };
  return target.platform === 'meta' ? createMetaProvider(config) : createTikTokProvider(config);
}

/** Only the click ids the platform matches on, without empty values. */
function clickIdsFor(platform: ConversionPlatform, sources: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of CLICK_ID_KEYS[platform]) {
    const value = sources[key];
    if (value !== undefined && value !== '') out[key] = value;
  }
  return out;
}

/** Value of the field mapped to a contact attribute, falling back to the first field of that kind. */
function mappedValue(
  fields: readonly FormField[],
  values: Readonly<Record<string, unknown>>,
  target: 'email' | 'phone',
): string | null {
  const field = fields.find((f) => f.map_to === target) ?? fields.find((f) => f.kind === target);
  const value = field === undefined ? undefined : values[field.key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function describe(target: ConversionTarget, conversion: AdConversion): string {
  const where = target.platform === 'meta' ? `Meta CAPI dataset ${pixelOf(target)}` : `TikTok pixel ${pixelOf(target)}`;
  const test = target.config.test_event_code === '' ? '' : ' (test event)';
  return `${where}: ${conversion.eventName} event_id=${conversion.eventId}${test}`;
}

export async function sendAdConversion(target: ConversionTarget, conversion: AdConversion): Promise<ConnectorResult> {
  const request = describe(target, conversion);
  const job: OutboundConversionJob = {
    id: conversion.eventId,
    platform: conversion.platform,
    connection_id: '',
    kind: conversion.valueMinor === undefined ? 'lead' : 'purchase',
    status: 'pending',
    attempts: 0,
    event_id: conversion.eventId,
    created_at: target.now(),
    payload: {
      event_name: conversion.eventName,
      event_time: conversion.eventTime,
      click_ids: clickIdsFor(conversion.platform, conversion.clickIds),
      email: conversion.email,
      phone: conversion.phone,
      ip: conversion.ip,
      user_agent: conversion.userAgent,
      page_url: conversion.pageUrl,
      external_id: target.config.send_external_id ? conversion.externalId : null,
      ...(conversion.valueMinor === undefined
        ? {}
        : { value_minor: conversion.valueMinor, currency: conversion.currency ?? null, order_id: conversion.orderId ?? null }),
    },
  };
  const options: SendConversionOptions = {
    ...(target.platform === 'meta' ? { pixelId: pixelOf(target) } : { pixelCode: pixelOf(target) }),
    ...(target.config.test_event_code === '' ? {} : { testEventCode: target.config.test_event_code }),
    ...(target.config.default_calling_code === '' ? {} : { defaultCallingCode: target.config.default_calling_code }),
  };
  try {
    const result = await providerOf(target).sendConversion(target.token, job, options);
    return {
      status: 'success',
      retryable: false,
      statusCode: 200,
      request,
      response: result.platformResponseId === undefined ? 'accepted' : `accepted (${result.platformResponseId})`,
    };
  } catch (error) {
    if (!isProviderError(error)) throw error;
    return { ...failure(error.message, error.kind === 'retryable', request), statusCode: error.status ?? null };
  }
}

const TIKTOK_AUTH_CODES = new Set([40001, 40102, 40104, 40105, 40106]);

/**
 * Checks token and pixel without recording an event. Meta: the pixel read
 * needs more than an Events Manager token, so a POST without `data` is the
 * fallback (Meta then complains only about `data`). TikTok: an empty `data`
 * fails on the payload only once token and pixel are accepted.
 */
export async function verifyAdCredentials(target: ConversionTarget): Promise<ConnectorResult> {
  const pixel = encodeURIComponent(pixelOf(target));
  try {
    if (target.platform === 'meta') {
      const base = `https://graph.facebook.com/${META_DEFAULT_API_VERSION}/${pixel}`;
      const auth = { authorization: `Bearer ${target.token}` };
      const read = await target.fetch(`${base}?fields=name`, { headers: auth });
      if (read.ok) return { status: 'success', retryable: false, statusCode: 200, request: `GET /${pixel}`, response: 'pixel readable with this token' };
      const post = await target.fetch(`${base}/events`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: '{}',
      });
      const text = await post.text();
      const error = (JSON.parse(text || '{}') as { error?: { code?: number; message?: string } }).error;
      const valid = error?.code === 100 && /\bdata\b/i.test(error.message ?? '');
      return valid
        ? { status: 'success', retryable: false, statusCode: 200, request: `POST /${pixel}/events (no events)`, response: 'token can send events to this pixel' }
        : { ...failure(`Meta: ${error?.message ?? text.slice(0, 300)}`, false, `POST /${pixel}/events`), statusCode: post.status };
    }
    const res = await target.fetch('https://business-api.tiktok.com/open_api/v1.3/event/track/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'access-token': target.token },
      body: JSON.stringify({ event_source: 'web', event_source_id: pixelOf(target), data: [] }),
    });
    const text = await res.text();
    const body = JSON.parse(text || '{}') as { code?: number; message?: string };
    const request = 'POST /event/track/ (no events)';
    if (!res.ok || typeof body.code !== 'number') return { ...failure(`TikTok: ${text.slice(0, 300)}`, res.status >= 500, request), statusCode: res.status };
    const message = body.message ?? '';
    if (TIKTOK_AUTH_CODES.has(body.code)) return { ...failure(`TikTok: invalid access token (${message})`, false, request), statusCode: 401 };
    if (/event_source_id|pixel/i.test(message)) return { ...failure(`TikTok: invalid pixel code (${message})`, false, request), statusCode: 400 };
    return { status: 'success', retryable: false, statusCode: 200, request, response: 'token can send events to this pixel' };
  } catch (error) {
    return failure(`verification failed: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

/** Form connector sending each submission as a server-side conversion (`Lead` by default). */
export function adConversionConnector<C extends FacebookCapiConfig | TiktokEventsConfig>(
  type: 'facebook_capi' | 'tiktok_events',
  platform: ConversionPlatform,
  schema: ZodType<C>,
): Connector<C> {
  return {
    type,
    secret: 'api_key',
    oauthProvider: null,
    available: () => true,
    parseConfig: zodConfig(schema),
    async run(ctx): Promise<ConnectorResult> {
      if (ctx.connection.secret === null) return failure('access token missing', false);
      const target: ConversionTarget = {
        platform,
        token: ctx.connection.secret,
        config: ctx.connection.config,
        fetch: (input, init) => ctx.runtime.fetch(input, init),
        now: () => ctx.runtime.now(),
      };
      // Without a test events code a test run would record a real conversion.
      if (ctx.test && ctx.connection.config.test_event_code === '') return verifyAdCredentials(target);
      const { submission, form } = ctx;
      const meta = submission.meta;
      return sendAdConversion(target, {
        platform,
        eventId: submission.id,
        eventName: ctx.connection.config.event_name,
        eventTime: Date.parse(submission.submittedAt),
        email: mappedValue(form.fields, submission.values, 'email'),
        phone: mappedValue(form.fields, submission.values, 'phone'),
        clickIds: { ...submission.tracking, fbp: meta.fbp, fbc: meta.fbc, ttp: meta.ttp },
        ip: meta.ip === '' ? null : meta.ip,
        userAgent: meta.user_agent === '' ? null : meta.user_agent,
        pageUrl: meta.page_url === '' ? null : meta.page_url,
        externalId: submission.id,
      });
    },
  };
}
