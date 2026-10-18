import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createFakeProvider, ProviderError, type FakeAdsProvider } from '@amable/ads-providers';
import type { AdPlatform, TrafficSource, TrafficSourceInput } from '@amable/api-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  enqueueForConversion,
  OUTBOUND_BACKOFF_MS,
  OUTBOUND_MAX_ATTEMPTS,
  outboundEventId,
  processOutboundBatch,
  type OutboundConversionInput,
  type ProviderResolver,
} from '../src/analytics/outbound-worker';
import type { AnalyticsStore } from '../src/analytics/store/index';
import type { Env } from '../src/env';
import { ANALYTICS_DO_RPC_METHODS, createStore, ev, siteInit, T0, type Clock } from './helpers';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const { AnalyticsDO } = await import('../src/analytics/do');

const PLATFORM_EVENT: Record<AdPlatform, string> = {
  meta: 'Purchase',
  google: '987654321',
  tiktok: 'CompletePayment',
};
const EXTERNAL_PARAM: Record<AdPlatform, string> = { meta: 'fbclid', google: 'gclid', tiktok: 'ttclid' };

function sourceInput(platform: AdPlatform, overrides: Partial<TrafficSourceInput> = {}): TrafficSourceInput {
  return {
    name: `${platform} ads`,
    template: platform,
    reserved_fields: {
      campaign: { url_param: 'cid', source_token: '' },
      external: { url_param: EXTERNAL_PARAM[platform], source_token: '', append: false },
    },
    conversion: {
      ad_connection_id: `conn_${platform}`,
      platform,
      mapping: [
        { event: 'sale', platform_event: PLATFORM_EVENT[platform] },
        { event: 'lead', platform_event: platform === 'google' ? '111' : 'Lead' },
      ],
    },
    ...overrides,
  };
}

interface Setup {
  store: AnalyticsStore;
  clock: Clock;
  source: (platform: AdPlatform, overrides?: Partial<TrafficSourceInput>) => TrafficSource;
}

function setup(): Setup {
  const clock: Clock = { now: T0 };
  const { store } = createStore(clock);
  store.initSite(siteInit());
  for (const platform of ['meta', 'google', 'tiktok'] as const) {
    store.upsertAdConnection({
      id: `conn_${platform}`,
      platform,
      account_id: platform === 'google' ? '123-456-7890' : `acc_${platform}`,
      metadata: platform === 'meta' ? { pixel_id: 'px_1' } : platform === 'tiktok' ? { pixel_code: 'TT1' } : {},
    });
  }
  return {
    store,
    clock,
    source(platform, overrides) {
      const r = store.createTrafficSource(sourceInput(platform, overrides));
      if (!r.ok) throw new Error(r.error.message);
      return r.value;
    },
  };
}

function conversion(source: TrafficSource | null, overrides: Partial<OutboundConversionInput> = {}): OutboundConversionInput {
  return {
    id: 'cv_1',
    event: 'sale',
    revenue_minor: 4900,
    currency: 'EUR',
    ts: T0,
    visitor_id: 'visitor-1',
    traffic_source_id: source?.id ?? null,
    tx: 'order-1',
    ...overrides,
  };
}

const never = (): number => 0.99;

function fakeResolver(providers: Partial<Record<string, FakeAdsProvider>>): ProviderResolver & { calls: string[] } {
  const calls: string[] = [];
  const resolver = (connectionId: string) => {
    calls.push(connectionId);
    const provider = providers[connectionId];
    return provider === undefined ? null : { provider, token: `tok_${connectionId}` };
  };
  return Object.assign(resolver, { calls });
}

describe('enqueueForConversion', () => {
  it('maps the event to the platform of the source connection', async () => {
    const { store, source } = setup();
    for (const platform of ['meta', 'google', 'tiktok'] as const) {
      const s = source(platform);
      const r = await enqueueForConversion(store, {
        conversion: conversion(s, { id: `cv_${platform}` }),
        source: s,
        pii: { email: ' Jane@Example.com ', phone: '+39 333 1234567', ip: '203.0.113.9', user_agent: 'UA/1' },
        consent: true,
        rng: never,
      });
      expect(r.status).toBe('enqueued');
      if (r.status !== 'enqueued') continue;
      const job = store.getOutbound(r.job_id);
      expect(job).toMatchObject({
        platform,
        connection_id: `conn_${platform}`,
        kind: 'purchase',
        status: 'pending',
        event_id: r.event_id,
        payload: {
          event_name: PLATFORM_EVENT[platform],
          event_time: T0,
          value_minor: 4900,
          currency: 'EUR',
          order_id: 'order-1',
          email: 'jane@example.com',
          phone: '+39 333 1234567',
          ip: '203.0.113.9',
          user_agent: 'UA/1',
          external_id: 'visitor-1',
        },
      });
      // Google uploads wait for the click to settle.
      expect(job?.next_attempt_at).toBe(platform === 'google' ? T0 + 6 * 3_600_000 : T0);
    }
  });

  it('collects click ids from sessions, touches and the caller, platform keys only', async () => {
    const { store, source } = setup();
    const g = source('google');
    store.ingest([ev({ clickIds: { gclid: 'G-session', fbclid: 'F-session' } })], []);
    store.recordTouch({
      id: 'hit_1',
      ts: T0 - 1000,
      visitor_id: 'visitor-1',
      session_id: 'session-1',
      funnel_id: 'fg_1',
      node_id: 'n1',
      traffic_source_id: g.id,
      kind: 'view',
      external_click_id: 'G-touch',
    });
    const r = await enqueueForConversion(store, {
      conversion: conversion(g),
      source: g,
      clickIds: { wbraid: 'W-explicit', ttclid: 'ignored' },
      consent: true,
      rng: never,
    });
    expect(r.status).toBe('enqueued');
    const job = r.status === 'enqueued' ? store.getOutbound(r.job_id) : null;
    expect(job?.payload.click_ids).toEqual({ gclid: 'G-touch', wbraid: 'W-explicit' });
  });

  it('applies the outgoing revenue modifier and leaves lead values empty', async () => {
    const { store, source } = setup();
    const s = source('meta', { revenue_modifier_pct: -25 });
    const sale = await enqueueForConversion(store, { conversion: conversion(s), source: s, consent: true, rng: never });
    const lead = await enqueueForConversion(store, {
      conversion: conversion(s, { id: 'cv_lead', event: 'lead', revenue_minor: 0, tx: null }),
      source: s,
      consent: true,
      rng: never,
    });
    const saleJob = sale.status === 'enqueued' ? store.getOutbound(sale.job_id) : null;
    const leadJob = lead.status === 'enqueued' ? store.getOutbound(lead.job_id) : null;
    expect(saleJob?.payload).toMatchObject({ value_minor: 3675, currency: 'EUR' });
    expect(leadJob).toMatchObject({ kind: 'lead', payload: { event_name: 'Lead', value_minor: null, order_id: 'cv_lead' } });
  });

  it('dedups on the stable event id, per connection', async () => {
    const { store, source } = setup();
    const s = source('meta');
    const first = await enqueueForConversion(store, { conversion: conversion(s), source: s, consent: true, rng: never });
    // Same transaction reported again under another conversion id (CRM sync after the postback).
    const again = await enqueueForConversion(store, {
      conversion: conversion(s, { id: 'cv_other' }),
      source: s,
      consent: true,
      rng: never,
    });
    expect(first.status).toBe('enqueued');
    expect(again).toMatchObject({ status: 'duplicate', event_id: first.status === 'enqueued' ? first.event_id : '' });
    expect(store.listOutbound()).toHaveLength(1);
    expect(await outboundEventId('conn_meta', { id: 'x', tx: 'order-1', event: 'sale' })).toBe(
      first.status === 'enqueued' ? first.event_id : '',
    );
    expect(await outboundEventId('conn_other', { id: 'x', tx: 'order-1', event: 'sale' })).not.toBe(
      first.status === 'enqueued' ? first.event_id : '',
    );
  });

  it('gates on consent, zero revenue, throttle and blacklist with skipped jobs without PII', async () => {
    const { store, source } = setup();
    const pii = { email: 'jane@example.com', ip: '203.0.113.9' };
    const plain = source('meta');
    const noConsent = await enqueueForConversion(store, { conversion: conversion(plain), source: plain, pii, consent: false, rng: never });
    expect(noConsent).toMatchObject({ status: 'skipped', reason: 'no_consent' });
    const skippedJob = noConsent.status === 'skipped' ? store.getOutbound(noConsent.job_id) : null;
    expect(skippedJob).toMatchObject({ status: 'skipped', last_error: 'no_consent' });
    expect(skippedJob?.payload.email).toBeUndefined();
    expect(skippedJob?.payload.ip).toBeUndefined();

    const zero = source('tiktok', { skip_zero_revenue_postbacks: true });
    expect(
      await enqueueForConversion(store, {
        conversion: conversion(zero, { id: 'cv_zero', tx: 'z', revenue_minor: 0 }),
        source: zero,
        consent: true,
        rng: never,
      }),
    ).toMatchObject({ status: 'skipped', reason: 'zero_revenue' });

    const throttled = source('google', { postback_throttle_pct: 30 });
    const rolls = [0.1, 0.5];
    const rng = vi.fn(() => rolls.shift() ?? 0);
    expect(
      await enqueueForConversion(store, { conversion: conversion(throttled, { tx: 't1' }), source: throttled, consent: true, rng }),
    ).toMatchObject({ status: 'skipped', reason: 'throttled' });
    expect(
      await enqueueForConversion(store, { conversion: conversion(throttled, { tx: 't2' }), source: throttled, consent: true, rng }),
    ).toMatchObject({ status: 'enqueued' });
    // Throttle is not re-rolled when the same conversion is reported again.
    expect(
      await enqueueForConversion(store, { conversion: conversion(throttled, { tx: 't1' }), source: throttled, consent: true, rng }),
    ).toMatchObject({ status: 'duplicate' });
    expect(rng).toHaveBeenCalledTimes(2);

    store.addToBlacklist([{ key_type: 'email', key_value: 'blocked@example.com' }]);
    expect(
      await enqueueForConversion(store, {
        conversion: conversion(plain, { tx: 'b1' }),
        source: plain,
        pii: { email: 'Blocked@example.com' },
        consent: true,
        rng: never,
      }),
    ).toMatchObject({ status: 'skipped', reason: 'blacklisted' });

    expect(
      await enqueueForConversion(store, {
        conversion: conversion(plain, { tx: 'r1', status: 'rejected' }),
        source: plain,
        consent: true,
        rng: never,
      }),
    ).toMatchObject({ status: 'skipped', reason: 'not_approved' });
  });

  it('does nothing without source, mapping or a known connection', async () => {
    const { store, source } = setup();
    expect(await enqueueForConversion(store, { conversion: conversion(null), source: null, consent: true, rng: never })).toEqual({
      status: 'no_route',
      reason: 'no_source',
    });
    const s = source('meta');
    expect(
      await enqueueForConversion(store, { conversion: conversion(s, { event: 'event:3' }), source: s, consent: true, rng: never }),
    ).toEqual({ status: 'no_route', reason: 'no_mapping' });
    const orphan = source('meta', {
      conversion: { ad_connection_id: 'conn_missing', platform: 'meta', mapping: [{ event: 'sale', platform_event: 'Purchase' }] },
    });
    expect(
      await enqueueForConversion(store, { conversion: conversion(orphan), source: orphan, consent: true, rng: never }),
    ).toEqual({ status: 'no_route', reason: 'unknown_connection' });
    expect(store.listOutbound()).toEqual([]);
  });

  it('enqueues a stored postback conversion through the store RPC', async () => {
    const { store, source } = setup();
    const s = source('meta');
    store.recordTouch({
      id: 'hit_9',
      ts: T0 - 5000,
      visitor_id: 'visitor-9',
      session_id: 'session-9',
      funnel_id: 'fg_1',
      node_id: 'n1',
      traffic_source_id: s.id,
      kind: 'view',
      external_click_id: 'FB-1',
    });
    const cv = store.recordConversionFromPostback({ hit: 'hit_9', tx: 'pb-1', revenue_minor: 1200, currency: 'EUR' });
    if (!cv.ok) throw new Error('conversion');
    const r = await store.enqueueConversionOutbound({ conversion_id: cv.value.id, consent: true });
    expect(r).toMatchObject({ ok: true, value: { status: 'enqueued' } });
    const job = r.ok && r.value.status === 'enqueued' ? store.getOutbound(r.value.job_id) : null;
    expect(job?.payload).toMatchObject({ event_name: 'Purchase', order_id: 'pb-1', click_ids: { fbclid: 'FB-1' }, external_id: 'visitor-9' });
    expect(await store.enqueueConversionOutbound({ conversion_id: 'cv_missing', consent: true })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(await store.enqueueConversionOutbound({ consent: true })).toMatchObject({
      ok: false,
      error: { code: 'validation_failed' },
    });
  });
});

describe('traffic source postback URL', () => {
  function postbackSource(s: Setup, overrides: Partial<TrafficSourceInput> = {}): TrafficSource {
    const r = s.store.createTrafficSource({
      name: 'Network',
      template: 'custom',
      reserved_fields: {
        campaign: { url_param: 'cid', source_token: '' },
        external: { url_param: 'clickid', source_token: '', append: false },
      },
      fields: [{ slot: 'c1', name: 'Sub', url_param: 'sub', source_token: '' }],
      conversion: {
        postback_url: 'https://net.example/pb?click={external}&c={campaign}&p={payout}&tx={txid}&h={hit}&s={data-sub}&x={nope}',
        mapping: [],
      },
      revenue_modifier_pct: -10,
      ...overrides,
    });
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  }

  it('fills the tokens from the conversion touch and sends a GET, retrying server errors', async () => {
    const s = setup();
    const src = postbackSource(s);
    s.store.recordTouch({
      id: 'hit_pb',
      ts: T0 - 5000,
      visitor_id: 'visitor-1',
      session_id: 'session-1',
      funnel_id: 'fg_1',
      node_id: 'n1',
      traffic_source_id: src.id,
      kind: 'view',
      campaign: 'spring sale',
      external_click_id: 'CLK-1',
      fields: { c1: 'a&b' },
    });
    const cv = s.store.recordConversionFromPostback({ hit: 'hit_pb', tx: 'pb-7', revenue_minor: 5000, currency: 'EUR' });
    if (!cv.ok) throw new Error('conversion');
    const r = await s.store.enqueueConversionOutbound({ conversion_id: cv.value.id, consent: true });
    expect(r).toMatchObject({ ok: true, value: { status: 'enqueued' } });
    const jobId = r.ok && r.value.status === 'enqueued' ? r.value.job_id : '';
    const job = s.store.getOutbound(jobId);
    expect(job).toMatchObject({ platform: 'postback', connection_id: src.id, status: 'pending' });
    expect(job?.payload.url).toBe('https://net.example/pb?click=CLK-1&c=spring%20sale&p=45&tx=pb-7&h=hit_pb&s=a%26b&x=');

    const calls: string[] = [];
    const statuses = [503, 200];
    const fetcher = (async (url: string) => {
      calls.push(url);
      return new Response('ok', { status: statuses.shift() ?? 200 });
    }) as unknown as typeof fetch;
    const resolver = fakeResolver({});
    expect(await processOutboundBatch(s.store, resolver, T0, undefined, fetcher)).toMatchObject({ retried: 1 });
    expect(s.store.getOutbound(jobId)).toMatchObject({ status: 'pending', last_error: 'http_503' });
    expect(await processOutboundBatch(s.store, resolver, T0 + OUTBOUND_BACKOFF_MS[0], undefined, fetcher)).toMatchObject({
      sent: 1,
    });
    expect(s.store.getOutbound(jobId)?.status).toBe('sent');
    expect(calls).toHaveLength(2);
    expect(resolver.calls).toEqual([]);
  });

  it('applies the source gates, dedups, and fails on client errors', async () => {
    const s = setup();
    const src = postbackSource(s, { skip_zero_revenue_postbacks: true });
    const zero = await enqueueForConversion(s.store, {
      conversion: conversion(src, { id: 'cv_zero', tx: 'zero', revenue_minor: 0 }),
      source: src,
      consent: true,
      rng: never,
    });
    expect(zero).toMatchObject({ status: 'skipped', reason: 'zero_revenue' });
    const input = { conversion: conversion(src), source: src, consent: true, rng: never };
    const first = await enqueueForConversion(s.store, input);
    expect(first.status).toBe('enqueued');
    expect((await enqueueForConversion(s.store, input)).status).toBe('duplicate');
    const fetcher = (async () => new Response('no', { status: 404 })) as unknown as typeof fetch;
    await processOutboundBatch(s.store, fakeResolver({}), T0, undefined, fetcher);
    expect(first.status === 'enqueued' ? s.store.getOutbound(first.job_id) : null).toMatchObject({
      status: 'failed',
      last_error: 'http_404',
    });
  });
});

describe('processOutboundBatch', () => {
  async function enqueued(s: Setup, platform: AdPlatform, tx = 'order-1'): Promise<string> {
    const src = s.store.listTrafficSources().find((t) => t.conversion.platform === platform) ?? s.source(platform);
    const r = await enqueueForConversion(s.store, {
      conversion: conversion(src, { tx }),
      source: src,
      pii: { email: 'jane@example.com', phone: '+393331234567', ip: '203.0.113.9', user_agent: 'UA/1' },
      consent: true,
      rng: never,
    });
    if (r.status !== 'enqueued') throw new Error(r.status);
    return r.job_id;
  }

  it('sends with connection options and drops the PII once sent', async () => {
    const s = setup();
    const metaId = await enqueued(s, 'meta');
    const googleId = await enqueued(s, 'google');
    const meta = createFakeProvider('meta');
    const google = createFakeProvider('google');
    const resolver = fakeResolver({ conn_meta: meta, conn_google: google });

    expect(await processOutboundBatch(s.store, resolver, T0)).toEqual({ claimed: 1, sent: 1, retried: 0, failed: 0 });
    expect(meta.sent[0]).toMatchObject({ accessToken: 'tok_conn_meta', options: { pixelId: 'px_1' } });
    expect(meta.sent[0]?.job.payload.email).toBe('jane@example.com');
    const sent = s.store.getOutbound(metaId);
    expect(sent).toMatchObject({ status: 'sent', attempts: 1, sent_at: T0 });
    expect(sent?.payload).not.toHaveProperty('email');
    expect(sent?.payload).not.toHaveProperty('phone');
    expect(sent?.payload).not.toHaveProperty('ip');
    expect(sent?.payload).not.toHaveProperty('user_agent');
    expect(sent?.payload).toMatchObject({ event_name: 'Purchase', order_id: 'order-1' });

    // Google is delayed 6h, then goes out with the conversion action of the mapping.
    const later = T0 + 6 * 3_600_000;
    expect(await processOutboundBatch(s.store, resolver, later)).toMatchObject({ claimed: 1, sent: 1 });
    expect(google.sent[0]?.options).toEqual({ customerId: '123-456-7890', conversionAction: '987654321' });
    expect(s.store.getOutbound(googleId)?.status).toBe('sent');
  });

  it('retries retryable errors with exponential backoff, then fails after the max attempts', async () => {
    const s = setup();
    const id = await enqueued(s, 'meta');
    const meta = createFakeProvider('meta');
    const resolver = fakeResolver({ conn_meta: meta });
    let now = T0;
    for (let attempt = 1; attempt < OUTBOUND_MAX_ATTEMPTS; attempt++) {
      meta.failNext(new ProviderError('retryable', 'rate limited', { status: 429 }));
      expect(await processOutboundBatch(s.store, resolver, now)).toMatchObject({ claimed: 1, retried: 1 });
      const job = s.store.getOutbound(id);
      expect(job).toMatchObject({ status: 'pending', attempts: attempt });
      expect(job?.next_attempt_at).toBe(now + (OUTBOUND_BACKOFF_MS[attempt - 1] as number));
      expect(job?.last_error).toContain('rate limited');
      // Not due before the backoff elapses.
      expect(await processOutboundBatch(s.store, resolver, now + 1)).toMatchObject({ claimed: 0 });
      now = job?.next_attempt_at ?? now;
    }
    meta.failNext(new ProviderError('retryable', 'still down', { status: 503 }));
    expect(await processOutboundBatch(s.store, resolver, now)).toMatchObject({ claimed: 1, failed: 1 });
    const failed = s.store.getOutbound(id);
    expect(failed).toMatchObject({ status: 'failed', attempts: OUTBOUND_MAX_ATTEMPTS });
    expect(failed?.payload).not.toHaveProperty('email');
    expect(meta.sent).toHaveLength(0);
  });

  it('stops on permanent errors', async () => {
    const s = setup();
    const id = await enqueued(s, 'tiktok');
    const tiktok = createFakeProvider('tiktok');
    tiktok.failNext(new ProviderError('permanent', 'invalid event', { status: 400, platformCode: '40002' }));
    expect(await processOutboundBatch(s.store, fakeResolver({ conn_tiktok: tiktok }), T0)).toMatchObject({ failed: 1 });
    expect(s.store.getOutbound(id)).toMatchObject({
      status: 'failed',
      attempts: 1,
      last_error: 'permanent (40002): invalid event',
    });
  });

  it('auth_expired fails the job and flags the connection', async () => {
    const s = setup();
    const first = await enqueued(s, 'meta', 'o1');
    const second = await enqueued(s, 'meta', 'o2');
    const meta = createFakeProvider('meta');
    meta.failNext(new ProviderError('auth_expired', 'token revoked', { status: 401 }));
    const resolver = fakeResolver({ conn_meta: meta });
    expect(await processOutboundBatch(s.store, resolver, T0)).toMatchObject({ claimed: 2, failed: 1, retried: 1 });
    expect(s.store.getOutbound(first)).toMatchObject({ status: 'failed' });
    expect(s.store.getAdConnection('conn_meta')).toMatchObject({ status: 'auth_expired', last_error: expect.stringContaining('token revoked') });
    // The connection flag holds back the rest of the queue until reconnection.
    expect(s.store.getOutbound(second)).toMatchObject({ status: 'pending', last_error: 'connection_auth_expired' });

    const resolverExpired: ProviderResolver = () => {
      throw new ProviderError('auth_expired', 'refresh revoked');
    };
    s.store.upsertAdConnection({ id: 'conn_meta', platform: 'meta', account_id: 'acc_meta', status: 'active' });
    expect(await processOutboundBatch(s.store, resolverExpired, T0 + OUTBOUND_BACKOFF_MS[0])).toMatchObject({ failed: 1 });
    expect(s.store.getAdConnection('conn_meta')?.status).toBe('auth_expired');
  });

  it('retries when credentials are unavailable and resolves each connection once per batch', async () => {
    const s = setup();
    const a = await enqueued(s, 'meta', 'o1');
    await enqueued(s, 'meta', 'o2');
    const resolver = fakeResolver({});
    expect(await processOutboundBatch(s.store, resolver, T0)).toMatchObject({ claimed: 2, retried: 2 });
    expect(resolver.calls).toEqual(['conn_meta']);
    expect(s.store.getOutbound(a)).toMatchObject({ status: 'pending', last_error: 'credentials_unavailable' });
  });
});

describe('resend', () => {
  it('bulk resend re-enqueues only the failed jobs, with a fresh attempt budget', async () => {
    const { store, source } = setup();
    const s = source('meta');
    const ids: string[] = [];
    for (const tx of ['a', 'b', 'c']) {
      const r = await enqueueForConversion(store, { conversion: conversion(s, { tx }), source: s, consent: true, rng: never });
      if (r.status === 'enqueued') ids.push(r.job_id);
    }
    const skipped = await enqueueForConversion(store, { conversion: conversion(s, { tx: 'd' }), source: s, consent: false, rng: never });
    const [a, b, c] = ids as [string, string, string];
    store.claimOutboundBatch(T0, 10);
    store.finishOutbound(a, { status: 'failed', error: 'boom' });
    store.finishOutbound(b, { status: 'failed', error: 'boom' });
    store.finishOutbound(c, { status: 'sent' });
    expect(store.outboundStats()).toEqual({ pending: 0, sent: 1, failed: 2, skipped: 1 });

    expect(store.resendFailedOutbound({ platform: 'meta' })).toEqual({ ok: true, value: { requeued: 2 } });
    expect(store.getOutbound(a)).toMatchObject({ status: 'pending', attempts: 0, last_error: null, next_attempt_at: T0 });
    expect(store.getOutbound(c)?.status).toBe('sent');
    expect(skipped.status === 'skipped' ? store.getOutbound(skipped.job_id)?.status : null).toBe('skipped');
    expect(store.listOutbound({ status: 'pending' }).map((j) => j.id).sort()).toEqual([a, b].sort());
    expect(store.resendFailedOutbound({ platform: 'other' as 'meta' })).toMatchObject({ ok: false });
  });

  it('single resend ignores jobs that are not failed', async () => {
    const { store, source } = setup();
    const s = source('meta');
    const r = await enqueueForConversion(store, { conversion: conversion(s), source: s, consent: true, rng: never });
    const id = r.status === 'enqueued' ? r.job_id : '';
    expect(store.resendOutbound([id])).toEqual({ requeued: 0 });
    store.finishOutbound(id, { status: 'failed', error: 'x' });
    expect(store.resendOutbound([id, 'ob_missing'])).toEqual({ requeued: 1 });
    expect(store.getOutbound(id)).toMatchObject({ status: 'pending', attempts: 0 });
  });
});

// ------------------------------------------------------------------ DO alarm

/** DurableObjectStorage subset used by AnalyticsDO, over node:sqlite. */
function fakeDoStorage() {
  const db = new DatabaseSync(':memory:');
  const kv = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    get alarm() {
      return alarm;
    },
    kv,
    sql: {
      exec(query: string, ...params: unknown[]) {
        const rows = db.prepare(query).all(...(params as SQLInputValue[]));
        return { toArray: () => rows };
      },
    },
    transactionSync<T>(fn: () => T): T {
      db.exec('BEGIN');
      try {
        const r = fn();
        db.exec('COMMIT');
        return r;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    getAlarm: () => Promise.resolve(alarm),
    setAlarm: (t: number) => {
      alarm = t;
      return Promise.resolve();
    },
    get: <T>(key: string) => Promise.resolve(kv.get(key) as T | undefined),
    put: (key: string, value: unknown) => {
      kv.set(key, value);
      return Promise.resolve();
    },
  };
}

describe('AnalyticsDO outbound', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('exposes the outbound RPCs', () => {
    for (const name of ['enqueueConversionOutbound', 'resendOutbound', 'resendFailedOutbound', 'processOutbound', 'outboundStats']) {
      expect(ANALYTICS_DO_RPC_METHODS.has(name)).toBe(true);
    }
    expect(ANALYTICS_DO_RPC_METHODS.has('outboundResolver')).toBe(false);
  });

  it('the alarm sends the due batch and reschedules for the next job and the daily work', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const storage = fakeDoStorage();
    let ready: Promise<unknown> = Promise.resolve();
    const ctx = {
      storage,
      getWebSockets: () => [],
      blockConcurrencyWhile: (fn: () => Promise<unknown>) => {
        ready = fn();
        return ready;
      },
    };
    const meta = createFakeProvider('meta');
    class TestDO extends AnalyticsDO {
      protected override outboundResolver(): ProviderResolver {
        return () => ({ provider: meta, token: 'tok' });
      }
    }
    const env = { ENVIRONMENT: 'test' } as unknown as Env;
    const dobj = new TestDO(ctx as unknown as DurableObjectState, env);
    await ready;

    await dobj.initSite(siteInit());
    expect(storage.alarm).toBe(T0 + 86_400_000);
    dobj.upsertAdConnection({ id: 'conn_meta', platform: 'meta', account_id: 'acc', metadata: { pixel_id: 'px_9' } });
    const src = dobj.createTrafficSource(sourceInput('meta'));
    if (!src.ok) throw new Error(src.error.message);
    const r = await dobj.enqueueConversionOutbound({
      conversion: conversion(src.value),
      pii: { email: 'jane@example.com' },
      consent: true,
    });
    expect(r).toMatchObject({ ok: true, value: { status: 'enqueued' } });
    // Enqueue brings the daily alarm forward.
    expect(storage.alarm).toBe(T0 + 1000);

    vi.setSystemTime(T0 + 1000);
    await dobj.alarm();
    expect(meta.sent).toHaveLength(1);
    expect(meta.sent[0]?.options).toMatchObject({ pixelId: 'px_9' });
    expect(dobj.listOutbound()[0]).toMatchObject({ status: 'sent' });
    expect(dobj.listOutbound()[0]?.payload).not.toHaveProperty('email');
    expect(dobj.outboundStats()).toMatchObject({ sent: 1 });
    // Daily work ran on this first alarm; the next one is a day later (no pending job).
    expect(storage.kv.get('daily_work_at')).toBe(T0 + 1000 + 86_400_000);
    expect(storage.alarm).toBe(T0 + 1000 + 86_400_000);

    // A retry is scheduled at its backoff, without re-running the daily work.
    meta.failNext(new ProviderError('retryable', 'busy'));
    await dobj.enqueueConversionOutbound({ conversion: conversion(src.value, { tx: 'order-2' }), consent: true });
    vi.setSystemTime(T0 + 2000);
    await dobj.alarm();
    expect(storage.kv.get('daily_work_at')).toBe(T0 + 1000 + 86_400_000);
    expect(storage.alarm).toBe(T0 + 2000 + (OUTBOUND_BACKOFF_MS[0] as number));
    expect(await dobj.processOutbound(T0 + 2000 + (OUTBOUND_BACKOFF_MS[0] as number))).toMatchObject({ sent: 1 });
    expect(meta.sent).toHaveLength(2);
  });
});
