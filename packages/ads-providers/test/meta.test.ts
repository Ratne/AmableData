import { describe, expect, it } from 'vitest';
import { createMetaProvider, ProviderError, sha256Hex } from '../src';
import { config, HASH, job, NOW, path, query, queueFetch } from './helpers';

const G = 'https://graph.facebook.com/v23.0';
// HMAC-SHA256('tok-1', key 'meta-secret')
const PROOF = 'df3caf35d81805843ee1d2c062d321822e93cdcb2e4a26b4af1edd3ff67a4dcd';

function provider(replies: Parameters<typeof queueFetch>[0]) {
  const mock = queueFetch(replies);
  return {
    meta: createMetaProvider(config(mock.fetch, { clientSecret: 'meta-secret' })),
    calls: mock.calls,
  };
}

describe('meta oauth', () => {
  it('builds the authorize URL', () => {
    const { meta } = provider([]);
    const url = meta.authorizeUrl({ redirectUri: 'https://app.test/cb', state: 's-1' });
    expect(path(url)).toBe('https://www.facebook.com/v23.0/dialog/oauth');
    expect(query(url)).toEqual({
      client_id: 'client-1',
      redirect_uri: 'https://app.test/cb',
      state: 's-1',
      response_type: 'code',
      scope: 'ads_read,ads_management,business_management,pages_show_list,pages_read_engagement',
    });
    expect(
      query(meta.authorizeUrl({ redirectUri: 'https://x/cb', state: 's', scopes: ['ads_read'] }))
        .scope,
    ).toBe('ads_read');
  });

  it('exchanges the code and upgrades to a long-lived token', async () => {
    const { meta, calls } = provider([
      { body: { access_token: 'short', token_type: 'bearer', expires_in: 3600 } },
      { body: { access_token: 'long', token_type: 'bearer', expires_in: 5_184_000 } },
    ]);
    const tokens = await meta.exchangeCode({ code: 'c-1', redirectUri: 'https://app.test/cb' });
    expect(tokens).toEqual({
      accessToken: 'long',
      refreshToken: 'long',
      expiresAt: NOW + 5_184_000_000,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.method).toBe('GET');
    expect(path(calls[0]!.url)).toBe(`${G}/oauth/access_token`);
    expect(query(calls[0]!.url)).toEqual({
      client_id: 'client-1',
      client_secret: 'meta-secret',
      redirect_uri: 'https://app.test/cb',
      code: 'c-1',
    });
    expect(query(calls[1]!.url)).toEqual({
      grant_type: 'fb_exchange_token',
      client_id: 'client-1',
      client_secret: 'meta-secret',
      fb_exchange_token: 'short',
    });
  });

  it('refreshes by re-exchanging the current token', async () => {
    const { meta, calls } = provider([{ body: { access_token: 'long-2', expires_in: 100 } }]);
    expect(await meta.refreshToken('long-1')).toEqual({
      accessToken: 'long-2',
      refreshToken: 'long-2',
      expiresAt: NOW + 100_000,
    });
    expect(query(calls[0]!.url).fb_exchange_token).toBe('long-1');
  });

  it('expired token on refresh → auth_expired', async () => {
    const { meta } = provider([
      {
        status: 400,
        body: {
          error: { message: 'Error validating access token', type: 'OAuthException', code: 190 },
        },
      },
    ]);
    await expect(meta.refreshToken('dead')).rejects.toMatchObject({
      kind: 'auth_expired',
      status: 400,
      platformCode: '190',
    });
  });
});

describe('meta accounts and entities', () => {
  it('lists ad accounts following paging.next', async () => {
    const { meta, calls } = provider([
      {
        body: {
          data: [
            {
              id: 'act_1',
              account_id: '1',
              name: 'One',
              currency: 'eur',
              timezone_name: 'Europe/Rome',
            },
          ],
          paging: { next: `${G}/me/adaccounts?after=CUR1&limit=500` },
        },
      },
      {
        body: {
          data: [
            {
              id: 'act_2',
              account_id: '2',
              name: 'Two',
              currency: 'USD',
              timezone_name: 'America/New_York',
            },
          ],
        },
      },
    ]);
    expect(await meta.listAccounts('tok-1')).toEqual([
      { account_id: '1', name: 'One', currency: 'EUR', timezone: 'Europe/Rome' },
      { account_id: '2', name: 'Two', currency: 'USD', timezone: 'America/New_York' },
    ]);
    expect(path(calls[0]!.url)).toBe(`${G}/me/adaccounts`);
    expect(query(calls[0]!.url)).toEqual({
      fields: 'account_id,name,currency,timezone_name',
      limit: '500',
      appsecret_proof: PROOF,
    });
    expect(calls[0]!.headers.authorization).toBe('Bearer tok-1');
    expect(calls[1]!.url).toBe(`${G}/me/adaccounts?after=CUR1&limit=500`);
    expect(calls[1]!.headers.authorization).toBe('Bearer tok-1');
  });

  it('does not follow paging.next outside the Graph host', async () => {
    const { meta, calls } = provider([
      { body: { data: [], paging: { next: 'https://evil.test/steal' } } },
    ]);
    expect(await meta.listAccounts('tok-1')).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('normalizes campaigns, ad sets and ads with pagination', async () => {
    const { meta, calls } = provider([
      {
        body: {
          data: [{ id: 'c1', name: 'Camp', effective_status: 'ACTIVE', daily_budget: '5000' }],
          paging: { next: `${G}/act_9/campaigns?after=X` },
        },
      },
      {
        body: {
          data: [
            { id: 'c2', name: 'Camp 2', effective_status: 'PAUSED', lifetime_budget: '120000' },
          ],
        },
      },
      {
        body: {
          data: [{ id: 's1', name: 'Set', campaign_id: 'c1', effective_status: 'CAMPAIGN_PAUSED' }],
        },
      },
      { body: { data: [{ id: 'a1', name: '', adset_id: 's1', effective_status: 'DELETED' }] } },
    ]);
    const entities = await meta.listEntities('tok-1', '9');
    expect(entities).toEqual([
      {
        platform: 'meta',
        level: 'campaign',
        external_id: 'c1',
        parent_external_id: null,
        name: 'Camp',
        status: 'active',
        budget_minor: 5000,
      },
      {
        platform: 'meta',
        level: 'campaign',
        external_id: 'c2',
        parent_external_id: null,
        name: 'Camp 2',
        status: 'paused',
        budget_minor: 120000,
      },
      {
        platform: 'meta',
        level: 'adset',
        external_id: 's1',
        parent_external_id: 'c1',
        name: 'Set',
        status: 'paused',
        budget_minor: null,
      },
      {
        platform: 'meta',
        level: 'ad',
        external_id: 'a1',
        parent_external_id: 's1',
        name: 'a1',
        status: 'deleted',
      },
    ]);
    expect(calls.map((c) => path(c.url))).toEqual([
      `${G}/act_9/campaigns`,
      `${G}/act_9/campaigns`,
      `${G}/act_9/adsets`,
      `${G}/act_9/ads`,
    ]);
    expect(query(calls[0]!.url).fields).toBe(
      'id,name,effective_status,daily_budget,lifetime_budget',
    );
    expect(query(calls[2]!.url).fields).toBe(
      'id,name,campaign_id,effective_status,daily_budget,lifetime_budget',
    );
    expect(query(calls[3]!.url).fields).toBe('id,name,adset_id,effective_status');
  });
});

describe('meta spend', () => {
  it('reads daily insights with reported purchases in minor units', async () => {
    const { meta, calls } = provider([
      {
        body: {
          data: [
            {
              campaign_id: 'c1',
              date_start: '2026-10-14',
              spend: '123.456',
              impressions: '1000',
              clicks: '42',
              account_currency: 'EUR',
              actions: [
                { action_type: 'link_click', value: '42' },
                { action_type: 'purchase', value: '3' },
              ],
              action_values: [{ action_type: 'purchase', value: '299.70' }],
            },
            { campaign_id: 'c2', date_start: '2026-10-14', spend: '0', account_currency: 'EUR' },
          ],
        },
      },
    ]);
    const rows = await meta.fetchSpend('tok-1', 'act_9', {
      from: '2026-10-14',
      to: '2026-10-15',
      granularity: 'day',
      level: 'campaign',
    });
    expect(rows).toEqual([
      {
        platform: 'meta',
        entity_external_id: 'c1',
        day: '2026-10-14',
        spend_minor: 12346,
        currency: 'EUR',
        clicks: 42,
        impressions: 1000,
        reported_conversions: 3,
        reported_revenue_minor: 29970,
      },
      {
        platform: 'meta',
        entity_external_id: 'c2',
        day: '2026-10-14',
        spend_minor: 0,
        currency: 'EUR',
        clicks: null,
        impressions: null,
        reported_conversions: 0,
        reported_revenue_minor: 0,
      },
    ]);
    expect(path(calls[0]!.url)).toBe(`${G}/act_9/insights`);
    expect(query(calls[0]!.url)).toEqual({
      level: 'campaign',
      fields:
        'campaign_id,date_start,spend,impressions,clicks,actions,action_values,account_currency',
      time_range: '{"since":"2026-10-14","until":"2026-10-15"}',
      time_increment: '1',
      limit: '500',
      appsecret_proof: PROOF,
    });
  });

  it('hourly breakdown at ad level', async () => {
    const { meta, calls } = provider([
      {
        body: {
          data: [
            {
              ad_id: 'a1',
              date_start: '2026-10-15',
              spend: '1.5',
              account_currency: 'JPY',
              hourly_stats_aggregated_by_advertiser_time_zone: '13:00:00 - 13:59:59',
            },
          ],
        },
      },
    ]);
    const rows = await meta.fetchSpend('tok-1', '9', {
      from: '2026-10-15',
      to: '2026-10-15',
      granularity: 'hour',
      level: 'ad',
    });
    expect(rows).toMatchObject([
      { entity_external_id: 'a1', day: '2026-10-15', hour: 13, spend_minor: 2, currency: 'JPY' },
    ]);
    expect(query(calls[0]!.url).breakdowns).toBe('hourly_stats_aggregated_by_advertiser_time_zone');
    expect(query(calls[0]!.url).level).toBe('ad');
  });

  it('rejects malformed ranges without calling the API', async () => {
    const { meta, calls } = provider([]);
    await expect(
      meta.fetchSpend('tok-1', '9', {
        from: '2026-10-16',
        to: '2026-10-15',
        granularity: 'day',
        level: 'campaign',
      }),
    ).rejects.toMatchObject({ kind: 'permanent', platformCode: 'invalid_range' });
    expect(calls).toHaveLength(0);
  });
});

describe('meta conversions api', () => {
  it('sends the event with dedup id, fbc, hashed PII and request context', async () => {
    const { meta, calls } = provider([
      { body: { events_received: 1, messages: [], fbtrace_id: 'trace-1' } },
    ]);
    const result = await meta.sendConversion(
      'tok-1',
      job({
        click_ids: { fbclid: 'IwAR123', fbp: 'fb.1.1700000000000.42' },
        email: ' Test@Example.com ',
        phone: '+1 555 123 4567',
        ip: '203.0.113.7',
        user_agent: 'Mozilla/5.0',
        page_url: 'https://shop.test/thanks',
        external_id: 'USER-42',
      }),
      { pixelId: 'px-1', testEventCode: 'TEST1' },
    );
    expect(result).toEqual({ ok: true, platformResponseId: 'trace-1' });
    const call = calls[0]!;
    expect(call.method).toBe('POST');
    expect(path(call.url)).toBe(`${G}/px-1/events`);
    expect(query(call.url)).toEqual({ appsecret_proof: PROOF });
    expect(call.headers).toMatchObject({
      authorization: 'Bearer tok-1',
      'content-type': 'application/json',
    });
    const eventTimeMs = Date.UTC(2026, 9, 15, 9, 30, 15);
    expect(call.json).toEqual({
      data: [
        {
          event_name: 'Purchase',
          event_time: eventTimeMs / 1000,
          event_id: 'evt-abc',
          action_source: 'website',
          event_source_url: 'https://shop.test/thanks',
          user_data: {
            em: [HASH.testExample],
            ph: [HASH.phoneUs],
            external_id: [HASH.user42],
            client_ip_address: '203.0.113.7',
            client_user_agent: 'Mozilla/5.0',
            fbc: `fb.1.${String(eventTimeMs)}.IwAR123`,
            fbp: 'fb.1.1700000000000.42',
          },
          custom_data: { value: 49.99, currency: 'EUR', order_id: 'ord-7' },
        },
      ],
      test_event_code: 'TEST1',
    });
  });

  it('keeps a ready-made fbc and does not apply gmail canonicalization', async () => {
    const { meta, calls } = provider([{ body: { events_received: 1 } }]);
    await meta.sendConversion(
      'tok-1',
      job({
        click_ids: { fbc: 'fb.1.111.abc', fbclid: 'ignored' },
        email: 'John.Smith@gmail.com',
        value_minor: null,
      }),
      { datasetId: 'ds-1' },
    );
    const event = (calls[0]!.json as { data: Record<string, unknown>[] }).data[0]!;
    expect(event.user_data).toEqual({
      em: [await sha256Hex('john.smith@gmail.com')],
      fbc: 'fb.1.111.abc',
    });
    expect(event.custom_data).toEqual({ order_id: 'ord-7' });
    expect(path(calls[0]!.url)).toBe(`${G}/ds-1/events`);
  });

  it('refuses jobs without dataset or match keys', async () => {
    const { meta, calls } = provider([]);
    await expect(meta.sendConversion('tok-1', job({ email: 'a@b.co' }), {})).rejects.toMatchObject({
      kind: 'permanent',
      platformCode: 'missing_dataset',
    });
    await expect(meta.sendConversion('tok-1', job(), { pixelId: 'px' })).rejects.toMatchObject({
      kind: 'permanent',
      platformCode: 'no_match_keys',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('meta without app secret (brokered tokens)', () => {
  it('omits appsecret_proof on Graph reads and conversions', async () => {
    const mock = queueFetch([{ body: { data: [] } }, { body: { events_received: 1 } }]);
    const meta = createMetaProvider(config(mock.fetch, { clientSecret: '' }));
    await meta.listAccounts('tok-1');
    expect(query(mock.calls[0]!.url)).toEqual({
      fields: 'account_id,name,currency,timezone_name',
      limit: '500',
    });
    await meta.sendConversion('tok-1', job({ email: 'a@b.co' }), { pixelId: 'px-1' });
    expect(query(mock.calls[1]!.url)).toEqual({});
    expect(mock.calls[1]!.headers.authorization).toBe('Bearer tok-1');
  });
});

describe('meta error mapping', () => {
  const cases: [number, unknown, string][] = [
    [400, { error: { code: 190, message: 'expired' } }, 'auth_expired'],
    [400, { error: { code: 102, message: 'session' } }, 'auth_expired'],
    [401, { error: { code: 999 } }, 'auth_expired'],
    [403, null, 'auth_expired'],
    [400, { error: { code: 17, message: 'user request limit' } }, 'retryable'],
    [400, { error: { code: 80004, message: 'too many calls' } }, 'retryable'],
    [400, { error: { code: 100, message: 'bad param', is_transient: true } }, 'retryable'],
    [429, null, 'retryable'],
    [500, { error: { code: 1 } }, 'retryable'],
    [503, 'not json', 'retryable'],
    [400, { error: { code: 100, message: 'Invalid parameter' } }, 'permanent'],
    [404, null, 'permanent'],
  ];
  for (const [status, body, kind] of cases) {
    it(`${String(status)} ${JSON.stringify(body)} → ${kind}`, async () => {
      const { meta } = provider([{ status, body }]);
      const error = await meta.listAccounts('tok-1').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({ kind, status });
    });
  }

  it('network failure → retryable', async () => {
    const { meta } = provider([new TypeError('fetch failed')]);
    await expect(meta.listAccounts('tok-1')).rejects.toMatchObject({
      kind: 'retryable',
      platformCode: 'network',
    });
  });
});
