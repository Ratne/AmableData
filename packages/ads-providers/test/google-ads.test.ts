import { describe, expect, it } from 'vitest';
import { createGoogleAdsProvider, ProviderError } from '../src';
import { config, HASH, job, NOW, path, query, queueFetch } from './helpers';

const API = 'https://googleads.googleapis.com/v22';

function provider(
  replies: Parameters<typeof queueFetch>[0],
  extra: Parameters<typeof config>[1] = {},
) {
  const mock = queueFetch(replies);
  return {
    google: createGoogleAdsProvider(config(mock.fetch, { developerToken: 'dev-tok', ...extra })),
    calls: mock.calls,
  };
}

const ADS_HEADERS = {
  authorization: 'Bearer at-1',
  'developer-token': 'dev-tok',
  'content-type': 'application/json',
};

describe('google oauth', () => {
  it('builds an offline-access authorize URL', () => {
    const { google } = provider([]);
    const url = google.authorizeUrl({ redirectUri: 'https://app.test/cb', state: 's-1' });
    expect(path(url)).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(query(url)).toEqual({
      client_id: 'client-1',
      redirect_uri: 'https://app.test/cb',
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/adwords',
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state: 's-1',
    });
  });

  it('exchanges the code (form-encoded POST)', async () => {
    const { google, calls } = provider([
      {
        body: {
          access_token: 'at-1',
          refresh_token: 'rt-1',
          expires_in: 3599,
          token_type: 'Bearer',
        },
      },
    ]);
    expect(await google.exchangeCode({ code: 'c-1', redirectUri: 'https://app.test/cb' })).toEqual({
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt: NOW + 3_599_000,
    });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://oauth2.googleapis.com/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      json: {
        client_id: 'client-1',
        client_secret: 'secret-1',
        code: 'c-1',
        redirect_uri: 'https://app.test/cb',
        grant_type: 'authorization_code',
      },
    });
  });

  it('refresh keeps the original refresh token when Google omits it', async () => {
    const { google, calls } = provider([{ body: { access_token: 'at-2', expires_in: 3599 } }]);
    expect(await google.refreshToken('rt-1')).toEqual({
      accessToken: 'at-2',
      refreshToken: 'rt-1',
      expiresAt: NOW + 3_599_000,
    });
    expect(calls[0]!.json).toEqual({
      client_id: 'client-1',
      client_secret: 'secret-1',
      refresh_token: 'rt-1',
      grant_type: 'refresh_token',
    });
  });

  it('revoked refresh token (invalid_grant) → auth_expired', async () => {
    const { google } = provider([
      {
        status: 400,
        body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
      },
    ]);
    await expect(google.refreshToken('rt-1')).rejects.toMatchObject({
      kind: 'auth_expired',
      status: 400,
      platformCode: 'invalid_grant',
    });
  });

  it('misconfigured client → permanent', async () => {
    const { google } = provider([{ status: 401, body: { error: 'invalid_client' } }]);
    await expect(google.refreshToken('rt-1')).rejects.toMatchObject({
      kind: 'permanent',
      platformCode: 'invalid_client',
    });
  });
});

describe('google accounts and entities', () => {
  it('lists accessible customers, skipping managers and unusable accounts', async () => {
    const { google, calls } = provider(
      [
        { body: { resourceNames: ['customers/111', 'customers/222', 'customers/333'] } },
        {
          body: [
            {
              results: [
                {
                  customer: {
                    resourceName: 'customers/111',
                    id: '111',
                    descriptiveName: 'Shop',
                    currencyCode: 'EUR',
                    timeZone: 'Europe/Rome',
                    manager: false,
                  },
                },
              ],
            },
          ],
        },
        {
          body: [{ results: [{ customer: { id: '222', descriptiveName: 'MCC', manager: true } }] }],
        },
        {
          status: 403,
          body: {
            error: {
              code: 403,
              status: 'PERMISSION_DENIED',
              message: 'not enabled',
              details: [
                { errors: [{ errorCode: { authorizationError: 'CUSTOMER_NOT_ENABLED' } }] },
              ],
            },
          },
        },
      ],
      { loginCustomerId: '999-000-1111' },
    );
    expect(await google.listAccounts('at-1')).toEqual([
      { account_id: '111', name: 'Shop', currency: 'EUR', timezone: 'Europe/Rome' },
    ]);
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: `${API}/customers:listAccessibleCustomers`,
      headers: { ...ADS_HEADERS, 'login-customer-id': '9990001111' },
    });
    expect(calls[1]).toMatchObject({
      method: 'POST',
      url: `${API}/customers/111/googleAds:searchStream`,
      json: {
        query:
          'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager FROM customer',
      },
    });
  });

  it('an expired token while listing customers aborts the listing', async () => {
    const { google } = provider([
      { body: { resourceNames: ['customers/111', 'customers/444'] } },
      {
        body: [
          {
            results: [
              {
                customer: {
                  id: '111',
                  descriptiveName: 'Shop',
                  currencyCode: 'usd',
                  timeZone: 'America/New_York',
                },
              },
            ],
          },
        ],
      },
      {
        status: 401,
        body: { error: { code: 401, status: 'UNAUTHENTICATED', message: 'expired' } },
      },
    ]);
    await expect(google.listAccounts('at-1')).rejects.toMatchObject({
      kind: 'auth_expired',
      status: 401,
    });
  });

  it('normalizes campaigns, ad groups and ads from searchStream batches', async () => {
    const { google, calls } = provider([
      { body: [{ results: [{ customer: { currencyCode: 'EUR' } }] }] },
      {
        body: [
          {
            results: [
              {
                campaign: { id: '1', name: 'Search', status: 'ENABLED' },
                campaignBudget: { amountMicros: '25000000' },
              },
            ],
          },
          { results: [{ campaign: { id: '2', name: 'PMax', status: 'PAUSED' } }] },
        ],
      },
      {
        body: [
          {
            results: [
              { adGroup: { id: '10', name: 'AG', status: 'ENABLED' }, campaign: { id: '1' } },
            ],
          },
        ],
      },
      {
        body: [
          {
            results: [
              { adGroupAd: { ad: { id: '100' }, status: 'PAUSED' }, adGroup: { id: '10' } },
            ],
          },
        ],
      },
    ]);
    expect(await google.listEntities('at-1', '123-456-7890')).toEqual([
      {
        platform: 'google',
        level: 'campaign',
        external_id: '1',
        parent_external_id: null,
        name: 'Search',
        status: 'active',
        budget_minor: 2500,
      },
      {
        platform: 'google',
        level: 'campaign',
        external_id: '2',
        parent_external_id: null,
        name: 'PMax',
        status: 'paused',
        budget_minor: null,
      },
      {
        platform: 'google',
        level: 'adset',
        external_id: '10',
        parent_external_id: '1',
        name: 'AG',
        status: 'active',
        budget_minor: null,
      },
      {
        platform: 'google',
        level: 'ad',
        external_id: '100',
        parent_external_id: '10',
        name: 'Ad 100',
        status: 'paused',
      },
    ]);
    expect(calls.every((c) => c.url === `${API}/customers/1234567890/googleAds:searchStream`)).toBe(
      true,
    );
    expect(calls.map((c) => (c.json as { query: string }).query)).toEqual([
      'SELECT customer.currency_code FROM customer',
      "SELECT campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros FROM campaign WHERE campaign.status != 'REMOVED'",
      "SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id FROM ad_group WHERE ad_group.status != 'REMOVED'",
      "SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.status, ad_group.id FROM ad_group_ad WHERE ad_group_ad.status != 'REMOVED'",
    ]);
    expect(calls[0]!.headers).toEqual(ADS_HEADERS);
  });

  it('requires a developer token', async () => {
    const { google, calls } = provider([], { developerToken: '' });
    await expect(google.listAccounts('at-1')).rejects.toMatchObject({
      kind: 'permanent',
      platformCode: 'missing_developer_token',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('google spend', () => {
  it('converts cost micros and conversion value to minor units', async () => {
    const { google, calls } = provider([
      {
        body: [
          {
            results: [
              {
                customer: { currencyCode: 'EUR' },
                campaign: { id: '1' },
                segments: { date: '2026-10-14' },
                metrics: {
                  costMicros: '12345678',
                  impressions: '900',
                  clicks: '31',
                  conversions: 2.5,
                  conversionsValue: 199.995,
                },
              },
            ],
          },
        ],
      },
    ]);
    const rows = await google.fetchSpend('at-1', '1234567890', {
      from: '2026-10-08',
      to: '2026-10-14',
      granularity: 'day',
      level: 'campaign',
    });
    expect(rows).toEqual([
      {
        platform: 'google',
        entity_external_id: '1',
        day: '2026-10-14',
        spend_minor: 1235,
        currency: 'EUR',
        clicks: 31,
        impressions: 900,
        reported_conversions: 2.5,
        reported_revenue_minor: 20000,
      },
    ]);
    expect(calls[0]!.json).toEqual({
      query:
        'SELECT campaign.id, segments.date, customer.currency_code, metrics.cost_micros, metrics.impressions, metrics.clicks, ' +
        "metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date BETWEEN '2026-10-08' AND '2026-10-14'",
    });
  });

  it('hourly segments at ad group and ad level', async () => {
    const { google, calls } = provider([
      {
        body: [
          {
            results: [
              {
                customer: { currencyCode: 'JPY' },
                adGroup: { id: '10' },
                segments: { date: '2026-10-15', hour: 7 },
                metrics: { costMicros: '1500000000' },
              },
            ],
          },
        ],
      },
      { body: [] },
    ]);
    const rows = await google.fetchSpend('at-1', '1', {
      from: '2026-10-15',
      to: '2026-10-15',
      granularity: 'hour',
      level: 'adset',
    });
    expect(rows).toMatchObject([
      {
        entity_external_id: '10',
        hour: 7,
        spend_minor: 1500,
        currency: 'JPY',
        reported_conversions: 0,
      },
    ]);
    expect((calls[0]!.json as { query: string }).query).toContain(
      'SELECT ad_group.id, segments.date, segments.hour,',
    );
    expect((calls[0]!.json as { query: string }).query).toContain('FROM ad_group WHERE');
    await google.fetchSpend('at-1', '1', {
      from: '2026-10-15',
      to: '2026-10-15',
      granularity: 'day',
      level: 'ad',
    });
    expect((calls[1]!.json as { query: string }).query).toMatch(
      /^SELECT ad_group_ad\.ad\.id, segments\.date, customer/,
    );
  });

  it('never interpolates malformed dates into GAQL', async () => {
    const { google, calls } = provider([]);
    await expect(
      google.fetchSpend('at-1', '1', {
        from: "2026-10-01' OR 1=1 --",
        to: '2026-10-02',
        granularity: 'day',
        level: 'campaign',
      }),
    ).rejects.toMatchObject({ kind: 'permanent', platformCode: 'invalid_range' });
    expect(calls).toHaveLength(0);
  });
});

describe('google offline click conversions', () => {
  it('uploads gclid + enhanced conversions with gmail-canonical hashed PII', async () => {
    const { google, calls } = provider([{ body: { results: [{ gclid: 'G-1' }], jobId: '777' } }]);
    const result = await google.sendConversion(
      'at-1',
      job({
        click_ids: { gclid: 'G-1', fbclid: 'x' },
        email: 'John.Smith+ads@Gmail.com',
        phone: '555 123 4567',
      }),
      { customerId: '123-456-7890', conversionAction: '42', defaultCallingCode: '1' },
    );
    expect(result).toEqual({ ok: true, platformResponseId: '777' });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `${API}/customers/1234567890:uploadClickConversions`,
      headers: ADS_HEADERS,
    });
    expect(calls[0]!.json).toEqual({
      conversions: [
        {
          conversionAction: 'customers/1234567890/conversionActions/42',
          conversionDateTime: '2026-10-15 09:30:15+00:00',
          gclid: 'G-1',
          userIdentifiers: [
            { hashedEmail: HASH.johnsmithGmail },
            { hashedPhoneNumber: HASH.phoneUsPlus },
          ],
          conversionValue: 49.99,
          currencyCode: 'EUR',
          orderId: 'ord-7',
          consent: { adUserData: 'GRANTED' },
        },
      ],
      partialFailure: true,
    });
  });

  it('uses wbraid/gbraid when there is no gclid and the event id as order id fallback', async () => {
    const { google, calls } = provider([{ body: { results: [{}] } }]);
    await google.sendConversion(
      'at-1',
      job({ click_ids: { wbraid: 'W-1' }, order_id: null, value_minor: null }),
      { customerId: '1234567890', conversionAction: 'customers/1234567890/conversionActions/9' },
    );
    expect(calls[0]!.json).toEqual({
      conversions: [
        {
          conversionAction: 'customers/1234567890/conversionActions/9',
          conversionDateTime: '2026-10-15 09:30:15+00:00',
          wbraid: 'W-1',
          orderId: 'evt-abc',
          consent: { adUserData: 'GRANTED' },
        },
      ],
      partialFailure: true,
    });
  });

  it('partial failure in a 200 response → permanent with the platform code', async () => {
    const { google } = provider([
      {
        body: {
          partialFailureError: {
            code: 3,
            message: 'The click is too old',
            details: [{ errors: [{ errorCode: { conversionUploadError: 'EXPIRED_EVENT' } }] }],
          },
          results: [{}],
        },
      },
    ]);
    await expect(
      google.sendConversion('at-1', job({ click_ids: { gclid: 'G' } }), {
        customerId: '1',
        conversionAction: '2',
      }),
    ).rejects.toMatchObject({
      kind: 'permanent',
      status: 200,
      platformCode: 'conversionUploadError.EXPIRED_EVENT',
    });
  });

  it('refuses jobs without destination or match keys', async () => {
    const { google, calls } = provider([]);
    await expect(
      google.sendConversion('at-1', job({ click_ids: { gclid: 'G' } }), { customerId: '1' }),
    ).rejects.toMatchObject({
      platformCode: 'missing_conversion_action',
    });
    await expect(
      google.sendConversion('at-1', job(), { customerId: '1', conversionAction: '2' }),
    ).rejects.toMatchObject({
      platformCode: 'no_match_keys',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('google error mapping', () => {
  const err = (status: number, grpc: string, detail?: Record<string, string>) => ({
    status,
    body: [
      {
        error: {
          code: status,
          status: grpc,
          message: grpc,
          ...(detail ? { details: [{ errors: [{ errorCode: detail }] }] } : {}),
        },
      },
    ],
  });
  const cases: [ReturnType<typeof err>, string, string][] = [
    [err(401, 'UNAUTHENTICATED'), 'auth_expired', 'UNAUTHENTICATED'],
    [
      err(403, 'PERMISSION_DENIED', { authorizationError: 'USER_PERMISSION_DENIED' }),
      'auth_expired',
      'authorizationError.USER_PERMISSION_DENIED',
    ],
    [
      err(403, 'PERMISSION_DENIED', { authorizationError: 'DEVELOPER_TOKEN_NOT_APPROVED' }),
      'permanent',
      'authorizationError.DEVELOPER_TOKEN_NOT_APPROVED',
    ],
    [
      err(429, 'RESOURCE_EXHAUSTED', { quotaError: 'RESOURCE_EXHAUSTED' }),
      'retryable',
      'quotaError.RESOURCE_EXHAUSTED',
    ],
    [err(500, 'INTERNAL'), 'retryable', 'INTERNAL'],
    [err(503, 'UNAVAILABLE'), 'retryable', 'UNAVAILABLE'],
    [
      err(400, 'INVALID_ARGUMENT', { queryError: 'UNRECOGNIZED_FIELD' }),
      'permanent',
      'queryError.UNRECOGNIZED_FIELD',
    ],
  ];
  for (const [reply, kind, platformCode] of cases) {
    it(`${String(reply.status)} ${platformCode} → ${kind}`, async () => {
      const { google } = provider([reply]);
      const error = await google.listEntities('at-1', '1').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({ kind, status: reply.status, platformCode });
    });
  }
});
