import { describe, expect, it } from 'vitest';
import { createTikTokProvider, ProviderError } from '../src';
import { config, HASH, job, NOW, path, query, queueFetch } from './helpers';

const API = 'https://business-api.tiktok.com/open_api/v1.3';
const ok = (data: unknown) => ({ body: { code: 0, message: 'OK', request_id: 'req-1', data } });
const EUR_INFO = ok({
  list: [{ advertiser_id: '7001', name: 'Shop', currency: 'EUR', timezone: 'Europe/Rome' }],
});

function provider(replies: Parameters<typeof queueFetch>[0]) {
  const mock = queueFetch(replies);
  return { tiktok: createTikTokProvider(config(mock.fetch)), calls: mock.calls };
}

describe('tiktok oauth', () => {
  it('builds the authorize URL', () => {
    const { tiktok } = provider([]);
    const url = tiktok.authorizeUrl({
      redirectUri: 'https://app.test/cb',
      state: 's-1',
      scopes: ['ignored'],
    });
    expect(path(url)).toBe('https://business-api.tiktok.com/portal/auth');
    expect(query(url)).toEqual({
      app_id: 'client-1',
      state: 's-1',
      redirect_uri: 'https://app.test/cb',
    });
  });

  it('exchanges the auth code', async () => {
    const { tiktok, calls } = provider([
      ok({ access_token: 'at-1', advertiser_ids: ['7001'], scope: [1, 2] }),
    ]);
    expect(
      await tiktok.exchangeCode({ code: 'auth-1', redirectUri: 'https://app.test/cb' }),
    ).toEqual({ accessToken: 'at-1' });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `${API}/oauth2/access_token/`,
      headers: { 'content-type': 'application/json' },
      json: { app_id: 'client-1', secret: 'secret-1', auth_code: 'auth-1' },
    });
  });

  it('refresh flow returns new tokens and expiry', async () => {
    const { tiktok, calls } = provider([
      ok({
        access_token: 'at-2',
        refresh_token: 'rt-2',
        access_token_expire_in: 86400,
        refresh_token_expire_in: 31536000,
      }),
    ]);
    expect(await tiktok.refreshToken('rt-1')).toEqual({
      accessToken: 'at-2',
      refreshToken: 'rt-2',
      expiresAt: NOW + 86_400_000,
    });
    expect(calls[0]).toMatchObject({
      url: `${API}/oauth2/refresh_token/`,
      json: {
        app_id: 'client-1',
        secret: 'secret-1',
        refresh_token: 'rt-1',
        grant_type: 'refresh_token',
      },
    });
  });

  it('invalid refresh token (code in a 200 body) → auth_expired', async () => {
    const { tiktok } = provider([
      { body: { code: 40105, message: 'Access token is invalid', request_id: 'r' } },
    ]);
    await expect(tiktok.refreshToken('rt-x')).rejects.toMatchObject({
      kind: 'auth_expired',
      status: 200,
      platformCode: '40105',
    });
  });
});

describe('tiktok accounts and entities', () => {
  it('lists authorized advertisers with their info', async () => {
    const { tiktok, calls } = provider([
      ok({
        list: [
          { advertiser_id: '7001', advertiser_name: 'Shop' },
          { advertiser_id: '7002', advertiser_name: 'B' },
        ],
      }),
      ok({
        list: [
          { advertiser_id: '7001', name: 'Shop', currency: 'EUR', timezone: 'Europe/Rome' },
          { advertiser_id: '7002', name: 'B', currency: 'usd', timezone: 'Etc/GMT' },
        ],
      }),
    ]);
    expect(await tiktok.listAccounts('at-1')).toEqual([
      { account_id: '7001', name: 'Shop', currency: 'EUR', timezone: 'Europe/Rome' },
      { account_id: '7002', name: 'B', currency: 'USD', timezone: 'Etc/GMT' },
    ]);
    expect(calls[0]!.method).toBe('GET');
    expect(path(calls[0]!.url)).toBe(`${API}/oauth2/advertiser/get/`);
    expect(query(calls[0]!.url)).toEqual({ app_id: 'client-1', secret: 'secret-1' });
    expect(calls[0]!.headers['access-token']).toBe('at-1');
    expect(path(calls[1]!.url)).toBe(`${API}/advertiser/info/`);
    expect(query(calls[1]!.url)).toEqual({
      advertiser_ids: '["7001","7002"]',
      fields: '["advertiser_id","name","currency","timezone"]',
    });
  });

  it('uses the given advertiser ids instead of oauth2/advertiser/get', async () => {
    const mock = queueFetch([EUR_INFO]);
    const tiktok = createTikTokProvider(config(mock.fetch, { clientId: '', clientSecret: '' }));
    expect(await tiktok.listAccounts('at-1', { accountIds: ['7001'] })).toEqual([
      { account_id: '7001', name: 'Shop', currency: 'EUR', timezone: 'Europe/Rome' },
    ]);
    expect(mock.calls).toHaveLength(1);
    expect(path(mock.calls[0]!.url)).toBe(`${API}/advertiser/info/`);
  });

  it('refuses to list advertisers without app secret nor ids', async () => {
    const mock = queueFetch([]);
    const tiktok = createTikTokProvider(config(mock.fetch, { clientId: '', clientSecret: '' }));
    await expect(tiktok.listAccounts('at-1')).rejects.toMatchObject({
      kind: 'permanent',
      platformCode: 'missing_advertiser_ids',
    });
    expect(mock.calls).toHaveLength(0);
  });

  it('paginates entities with page/page_size until total_page', async () => {
    const { tiktok, calls } = provider([
      EUR_INFO,
      ok({
        list: [
          { campaign_id: 'c1', campaign_name: 'Camp', operation_status: 'ENABLE', budget: 50.5 },
        ],
        page_info: { page: 1, page_size: 1000, total_number: 2, total_page: 2 },
      }),
      ok({
        list: [
          { campaign_id: 'c2', campaign_name: 'Camp 2', operation_status: 'DISABLE', budget: 0 },
        ],
        page_info: { page: 2, page_size: 1000, total_number: 2, total_page: 2 },
      }),
      ok({
        list: [
          {
            adgroup_id: 'g1',
            adgroup_name: 'Group',
            campaign_id: 'c1',
            operation_status: 'ENABLE',
            budget: 20,
          },
        ],
        page_info: { total_page: 1 },
      }),
      ok({
        list: [{ ad_id: 'a1', ad_name: 'Ad', adgroup_id: 'g1', operation_status: 'DELETE' }],
        page_info: { total_page: 1 },
      }),
    ]);
    expect(await tiktok.listEntities('at-1', '7001')).toEqual([
      {
        platform: 'tiktok',
        level: 'campaign',
        external_id: 'c1',
        parent_external_id: null,
        name: 'Camp',
        status: 'active',
        budget_minor: 5050,
      },
      {
        platform: 'tiktok',
        level: 'campaign',
        external_id: 'c2',
        parent_external_id: null,
        name: 'Camp 2',
        status: 'paused',
        budget_minor: null,
      },
      {
        platform: 'tiktok',
        level: 'adset',
        external_id: 'g1',
        parent_external_id: 'c1',
        name: 'Group',
        status: 'active',
        budget_minor: 2000,
      },
      {
        platform: 'tiktok',
        level: 'ad',
        external_id: 'a1',
        parent_external_id: 'g1',
        name: 'Ad',
        status: 'deleted',
      },
    ]);
    expect(calls.map((c) => path(c.url))).toEqual([
      `${API}/advertiser/info/`,
      `${API}/campaign/get/`,
      `${API}/campaign/get/`,
      `${API}/adgroup/get/`,
      `${API}/ad/get/`,
    ]);
    expect(query(calls[1]!.url)).toEqual({
      advertiser_id: '7001',
      fields: '["campaign_id","campaign_name","operation_status","budget"]',
      page: '1',
      page_size: '1000',
    });
    expect(query(calls[2]!.url).page).toBe('2');
  });
});

describe('tiktok spend', () => {
  it('reads the integrated report with derived reported revenue', async () => {
    const { tiktok, calls } = provider([
      EUR_INFO,
      ok({
        list: [
          {
            dimensions: { campaign_id: 'c1', stat_time_day: '2026-10-14 00:00:00' },
            metrics: {
              spend: '80.00',
              impressions: '5000',
              clicks: '120',
              conversion: '4',
              complete_payment_roas: '2.5',
            },
          },
        ],
        page_info: { total_page: 1 },
      }),
    ]);
    const rows = await tiktok.fetchSpend('at-1', '7001', {
      from: '2026-10-14',
      to: '2026-10-14',
      granularity: 'day',
      level: 'campaign',
    });
    expect(rows).toEqual([
      {
        platform: 'tiktok',
        entity_external_id: 'c1',
        day: '2026-10-14',
        spend_minor: 8000,
        currency: 'EUR',
        clicks: 120,
        impressions: 5000,
        reported_conversions: 4,
        reported_revenue_minor: 20000,
      },
    ]);
    expect(path(calls[1]!.url)).toBe(`${API}/report/integrated/get/`);
    expect(query(calls[1]!.url)).toEqual({
      advertiser_id: '7001',
      report_type: 'BASIC',
      data_level: 'AUCTION_CAMPAIGN',
      dimensions: '["campaign_id","stat_time_day"]',
      metrics: '["spend","impressions","clicks","conversion","complete_payment_roas"]',
      start_date: '2026-10-14',
      end_date: '2026-10-14',
      page: '1',
      page_size: '1000',
    });
  });

  it('hourly rows at ad group level', async () => {
    const { tiktok, calls } = provider([
      EUR_INFO,
      ok({
        list: [
          {
            dimensions: { adgroup_id: 'g1', stat_time_hour: '2026-10-15 21:00:00' },
            metrics: { spend: '1.234' },
          },
        ],
        page_info: { total_page: 1 },
      }),
    ]);
    const rows = await tiktok.fetchSpend('at-1', '7001', {
      from: '2026-10-15',
      to: '2026-10-15',
      granularity: 'hour',
      level: 'adset',
    });
    expect(rows).toMatchObject([
      {
        entity_external_id: 'g1',
        day: '2026-10-15',
        hour: 21,
        spend_minor: 123,
        reported_revenue_minor: 0,
      },
    ]);
    expect(query(calls[1]!.url)).toMatchObject({
      data_level: 'AUCTION_ADGROUP',
      dimensions: '["adgroup_id","stat_time_hour"]',
    });
  });
});

describe('tiktok events api', () => {
  it('tracks the event with ttclid, event id and hashed PII', async () => {
    const { tiktok, calls } = provider([
      { body: { code: 0, message: 'OK', request_id: 'req-9', data: {} } },
    ]);
    const result = await tiktok.sendConversion(
      'at-1',
      job({
        event_name: 'CompletePayment',
        click_ids: { ttclid: 'TT-1', ttp: 'ttp-cookie' },
        email: 'John.Smith@Example.com',
        phone: '+39 333 1234567',
        ip: '198.51.100.1',
        user_agent: 'UA',
        page_url: 'https://shop.test/ok',
        external_id: 'user-42',
      }),
      { pixelCode: 'PX-TT' },
    );
    expect(result).toEqual({ ok: true, platformResponseId: 'req-9' });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `${API}/event/track/`,
      headers: { 'access-token': 'at-1', 'content-type': 'application/json' },
    });
    expect(calls[0]!.json).toEqual({
      event_source: 'web',
      event_source_id: 'PX-TT',
      data: [
        {
          event: 'CompletePayment',
          event_time: Date.UTC(2026, 9, 15, 9, 30, 15) / 1000,
          event_id: 'evt-abc',
          user: {
            ttclid: 'TT-1',
            ttp: 'ttp-cookie',
            email: HASH.johnDotSmithExample,
            phone: HASH.phoneItPlus,
            external_id: HASH.user42,
            ip: '198.51.100.1',
            user_agent: 'UA',
          },
          properties: { value: 49.99, currency: 'EUR', order_id: 'ord-7' },
          page: { url: 'https://shop.test/ok' },
        },
      ],
    });
  });

  it('a non-zero code in a 200 response is classified', async () => {
    const { tiktok } = provider([
      { body: { code: 40002, message: 'Invalid pixel', request_id: 'r' } },
    ]);
    await expect(
      tiktok.sendConversion('at-1', job({ click_ids: { ttclid: 'T' } }), { pixelCode: 'PX' }),
    ).rejects.toMatchObject({
      kind: 'permanent',
      platformCode: '40002',
    });
  });

  it('refuses jobs without pixel code or match keys', async () => {
    const { tiktok, calls } = provider([]);
    await expect(
      tiktok.sendConversion('at-1', job({ click_ids: { ttclid: 'T' } }), {}),
    ).rejects.toMatchObject({
      platformCode: 'missing_pixel',
    });
    await expect(tiktok.sendConversion('at-1', job(), { pixelCode: 'PX' })).rejects.toMatchObject({
      platformCode: 'no_match_keys',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('tiktok error mapping', () => {
  const cases: [number, unknown, string][] = [
    [200, { code: 40104, message: 'token expired' }, 'auth_expired'],
    [200, { code: 40001, message: 'no permission' }, 'auth_expired'],
    [200, { code: 40100, message: 'too many requests' }, 'retryable'],
    [200, { code: 50002, message: 'internal' }, 'retryable'],
    [200, { code: 40002, message: 'param' }, 'permanent'],
    [401, null, 'auth_expired'],
    [429, null, 'retryable'],
    [502, null, 'retryable'],
    [400, { code: 40002, message: 'param' }, 'permanent'],
  ];
  for (const [status, body, kind] of cases) {
    it(`${String(status)} ${JSON.stringify(body)} → ${kind}`, async () => {
      const { tiktok } = provider([{ status, body }]);
      const error = await tiktok.listAccounts('at-1').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({ kind, status });
    });
  }
});
