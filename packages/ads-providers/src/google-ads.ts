import type { AdEntity, AdEntityLevel, OutboundConversionJob } from '@amable/api-types';
import { kindForStatus, ProviderError } from './errors';
import {
  asArray,
  asInt,
  asNumber,
  asRecord,
  asString,
  assertSpendQuery,
  entityName,
  formBody,
  normalizeStatus,
  requestJson,
  upperCurrency,
  withQuery,
} from './http';
import { decimalToMinor, microsToMinor, minorToMajor } from './money';
import { hashEmail, hashPhone } from './pii';
import type {
  AdAccountInfo,
  AdSpendRow,
  AdsProvider,
  OAuthTokens,
  ProviderConfig,
  SendConversionOptions,
  SendConversionResult,
  SpendQuery,
} from './types';

export const GOOGLE_ADS_DEFAULT_API_VERSION = 'v22';
export const GOOGLE_ADS_DEFAULT_SCOPES = ['https://www.googleapis.com/auth/adwords'] as const;
const ADS_HOST = 'https://googleads.googleapis.com';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const RETRYABLE_STATUSES = new Set([
  'RESOURCE_EXHAUSTED',
  'UNAVAILABLE',
  'INTERNAL',
  'DEADLINE_EXCEEDED',
  'ABORTED',
]);

function firstErrorCode(error: Record<string, unknown>): string | undefined {
  for (const detail of asArray(error.details)) {
    for (const item of asArray(asRecord(detail).errors)) {
      const codes = asRecord(asRecord(item).errorCode);
      const [key] = Object.keys(codes);
      if (key !== undefined) return `${key}.${asString(codes[key]) ?? ''}`;
    }
  }
  return undefined;
}

export function parseGoogleAdsError(status: number, body: unknown): ProviderError {
  // OAuth endpoint: `{ error: 'invalid_grant', error_description }`.
  const root = asRecord(Array.isArray(body) ? body[0] : body);
  if (typeof root.error === 'string') {
    const message = `google: ${asString(root.error_description) ?? root.error}`;
    const opts = { status, platformCode: root.error };
    if (root.error === 'invalid_grant' || root.error === 'unauthorized_client') {
      return new ProviderError('auth_expired', message, opts);
    }
    return new ProviderError(
      status >= 500 || status === 429 ? 'retryable' : 'permanent',
      message,
      opts,
    );
  }
  const error = asRecord(root.error);
  const grpcStatus = asString(error.status);
  const detailCode = firstErrorCode(error);
  const platformCode = detailCode ?? grpcStatus;
  const message = `google: ${asString(error.message) ?? `HTTP ${String(status)}`}`;
  const opts = { status, ...(platformCode === undefined ? {} : { platformCode }) };
  // Developer token and disabled-customer problems are not fixed by reconnecting the account.
  if (
    detailCode !== undefined &&
    (detailCode.includes('DEVELOPER_TOKEN') || detailCode.endsWith('.CUSTOMER_NOT_ENABLED'))
  ) {
    return new ProviderError('permanent', message, opts);
  }
  if (grpcStatus === 'UNAUTHENTICATED') return new ProviderError('auth_expired', message, opts);
  if (grpcStatus !== undefined && RETRYABLE_STATUSES.has(grpcStatus))
    return new ProviderError('retryable', message, opts);
  return new ProviderError(kindForStatus(status), message, opts);
}

function customerDigits(id: string): string {
  const digits = id.replace(/^customers\//, '').replace(/-/g, '');
  if (!/^\d+$/.test(digits)) {
    throw new ProviderError('permanent', `google: invalid customer id ${id}`, {
      platformCode: 'invalid_customer',
    });
  }
  return digits;
}

function conversionDateTime(epochMs: number): string {
  const iso = new Date(epochMs).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}+00:00`;
}

interface LevelQuery {
  readonly from: string;
  readonly id: string;
  readonly idPath: (row: Record<string, unknown>) => unknown;
}

const LEVEL: Record<AdEntityLevel, LevelQuery> = {
  campaign: { from: 'campaign', id: 'campaign.id', idPath: (r) => asRecord(r.campaign).id },
  adset: { from: 'ad_group', id: 'ad_group.id', idPath: (r) => asRecord(r.adGroup).id },
  ad: {
    from: 'ad_group_ad',
    id: 'ad_group_ad.ad.id',
    idPath: (r) => asRecord(asRecord(r.adGroupAd).ad).id,
  },
};

/** Google Ads API (REST, GAQL via searchStream) + offline click conversions client. */
export function createGoogleAdsProvider(config: ProviderConfig): AdsProvider {
  const version = config.apiVersion ?? GOOGLE_ADS_DEFAULT_API_VERSION;
  const base = `${ADS_HOST}/${version}`;

  function headers(token: string): Record<string, string> {
    if (config.developerToken === undefined || config.developerToken === '') {
      throw new ProviderError('permanent', 'google: developer token not configured', {
        platformCode: 'missing_developer_token',
      });
    }
    return {
      authorization: `Bearer ${token}`,
      'developer-token': config.developerToken,
      'content-type': 'application/json',
      ...(config.loginCustomerId
        ? { 'login-customer-id': config.loginCustomerId.replace(/-/g, '') }
        : {}),
    };
  }

  async function search(
    token: string,
    customerId: string,
    query: string,
  ): Promise<Record<string, unknown>[]> {
    const res = await requestJson(
      config,
      {
        method: 'POST',
        url: `${base}/customers/${customerDigits(customerId)}/googleAds:searchStream`,
        headers: headers(token),
        body: JSON.stringify({ query }),
      },
      parseGoogleAdsError,
    );
    // searchStream returns every batch at once as a JSON array.
    return asArray(res).flatMap((batch) => asArray(asRecord(batch).results).map(asRecord));
  }

  async function tokenRequest(params: Record<string, string>): Promise<OAuthTokens> {
    const res = asRecord(
      await requestJson(
        config,
        {
          method: 'POST',
          url: TOKEN_URL,
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: formBody({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            ...params,
          }),
        },
        parseGoogleAdsError,
      ),
    );
    const accessToken = asString(res.access_token);
    if (accessToken === undefined)
      throw new ProviderError('permanent', 'google: token response without access_token');
    const refreshToken = asString(res.refresh_token);
    const expiresIn = asNumber(res.expires_in);
    return {
      accessToken,
      ...(refreshToken === undefined ? {} : { refreshToken }),
      ...(expiresIn === null ? {} : { expiresAt: config.now() + expiresIn * 1000 }),
    };
  }

  async function customerCurrency(token: string, customerId: string): Promise<string> {
    const [row] = await search(token, customerId, 'SELECT customer.currency_code FROM customer');
    return upperCurrency(asRecord(row?.customer).currencyCode);
  }

  return {
    platform: 'google',

    authorizeUrl({ redirectUri, state, scopes }) {
      return withQuery('https://accounts.google.com/o/oauth2/v2/auth', {
        client_id: config.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: (scopes ?? GOOGLE_ADS_DEFAULT_SCOPES).join(' '),
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
        state,
      });
    },

    exchangeCode({ code, redirectUri }) {
      return tokenRequest({ code, redirect_uri: redirectUri, grant_type: 'authorization_code' });
    },

    async refreshToken(refreshToken) {
      const tokens = await tokenRequest({
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      });
      // Google omits the refresh token on refresh: the original one stays valid.
      return tokens.refreshToken === undefined ? { ...tokens, refreshToken } : tokens;
    },

    async listAccounts(token): Promise<AdAccountInfo[]> {
      const res = asRecord(
        await requestJson(
          config,
          {
            method: 'GET',
            url: `${base}/customers:listAccessibleCustomers`,
            headers: headers(token),
          },
          parseGoogleAdsError,
        ),
      );
      const out: AdAccountInfo[] = [];
      for (const resourceName of asArray(res.resourceNames)) {
        const id = asString(resourceName)?.replace(/^customers\//, '');
        if (id === undefined) continue;
        let rows: Record<string, unknown>[];
        try {
          rows = await search(
            token,
            id,
            'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager FROM customer',
          );
        } catch (error) {
          // Accessible but unusable customers (disabled, not enabled for this token) are skipped.
          if (error instanceof ProviderError && error.kind === 'permanent') continue;
          throw error;
        }
        const customer = asRecord(rows[0]?.customer);
        if (customer.manager === true) continue;
        out.push({
          account_id: asString(customer.id) ?? id,
          name: entityName(customer.descriptiveName, id),
          currency: upperCurrency(customer.currencyCode),
          timezone: asString(customer.timeZone) ?? 'UTC',
        });
      }
      return out;
    },

    async listEntities(token, accountId): Promise<AdEntity[]> {
      const currency = await customerCurrency(token, accountId);
      const campaigns = await search(
        token,
        accountId,
        "SELECT campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros FROM campaign WHERE campaign.status != 'REMOVED'",
      );
      const adGroups = await search(
        token,
        accountId,
        "SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id FROM ad_group WHERE ad_group.status != 'REMOVED'",
      );
      const ads = await search(
        token,
        accountId,
        "SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.status, ad_group.id FROM ad_group_ad WHERE ad_group_ad.status != 'REMOVED'",
      );
      const out: AdEntity[] = [];
      for (const row of campaigns) {
        const c = asRecord(row.campaign);
        const id = asString(c.id);
        if (id === undefined) continue;
        const micros = asString(asRecord(row.campaignBudget).amountMicros);
        out.push({
          platform: 'google',
          level: 'campaign',
          external_id: id,
          parent_external_id: null,
          name: entityName(c.name, id),
          status: normalizeStatus(c.status),
          budget_minor: micros === undefined ? null : microsToMinor(micros, currency),
        });
      }
      for (const row of adGroups) {
        const g = asRecord(row.adGroup);
        const id = asString(g.id);
        if (id === undefined) continue;
        out.push({
          platform: 'google',
          level: 'adset',
          external_id: id,
          parent_external_id: asString(asRecord(row.campaign).id) ?? null,
          name: entityName(g.name, id),
          status: normalizeStatus(g.status),
          budget_minor: null,
        });
      }
      for (const row of ads) {
        const groupAd = asRecord(row.adGroupAd);
        const ad = asRecord(groupAd.ad);
        const id = asString(ad.id);
        if (id === undefined) continue;
        out.push({
          platform: 'google',
          level: 'ad',
          external_id: id,
          parent_external_id: asString(asRecord(row.adGroup).id) ?? null,
          name: entityName(ad.name, `Ad ${id}`),
          status: normalizeStatus(groupAd.status),
        });
      }
      return out;
    },

    async fetchSpend(token, accountId, query: SpendQuery): Promise<AdSpendRow[]> {
      assertSpendQuery(query);
      const level = LEVEL[query.level];
      const hourly = query.granularity === 'hour';
      const gaql =
        `SELECT ${level.id}, segments.date${hourly ? ', segments.hour' : ''}, customer.currency_code, ` +
        'metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value ' +
        `FROM ${level.from} WHERE segments.date BETWEEN '${query.from}' AND '${query.to}'`;
      const rows = await search(token, accountId, gaql);
      const out: AdSpendRow[] = [];
      for (const row of rows) {
        const id = asString(level.idPath(row));
        const segments = asRecord(row.segments);
        const day = asString(segments.date);
        if (id === undefined || day === undefined) continue;
        const metrics = asRecord(row.metrics);
        const currency = upperCurrency(asRecord(row.customer).currencyCode);
        const spendRow: AdSpendRow = {
          platform: 'google',
          entity_external_id: id,
          day,
          spend_minor: Math.max(0, microsToMinor(asString(metrics.costMicros) ?? '0', currency)),
          currency,
          clicks: asInt(metrics.clicks),
          impressions: asInt(metrics.impressions),
          reported_conversions: asNumber(metrics.conversions) ?? 0,
          reported_revenue_minor: Math.max(
            0,
            decimalToMinor(asNumber(metrics.conversionsValue) ?? 0, currency),
          ),
        };
        if (hourly) {
          const hour = asInt(segments.hour);
          if (hour === null) continue;
          out.push({ ...spendRow, hour });
        } else {
          out.push(spendRow);
        }
      }
      return out;
    },

    async sendConversion(
      token,
      job: OutboundConversionJob,
      opts: SendConversionOptions,
    ): Promise<SendConversionResult> {
      if (!opts.customerId || !opts.conversionAction) {
        throw new ProviderError('permanent', 'google: missing customerId or conversionAction', {
          platformCode: 'missing_conversion_action',
        });
      }
      const customerId = customerDigits(opts.customerId);
      const conversionAction = opts.conversionAction.startsWith('customers/')
        ? opts.conversionAction
        : `customers/${customerId}/conversionActions/${opts.conversionAction}`;
      const p = job.payload;

      const conversion: Record<string, unknown> = {
        conversionAction,
        conversionDateTime: conversionDateTime(p.event_time),
      };
      const clickKey = (['gclid', 'gbraid', 'wbraid'] as const).find((key) => p.click_ids[key]);
      if (clickKey !== undefined) conversion[clickKey] = p.click_ids[clickKey];

      const identifiers: Record<string, string>[] = [];
      const email = p.email ? await hashEmail(p.email, { canonicalizeGmail: true }) : null;
      if (email !== null) identifiers.push({ hashedEmail: email });
      const phone = p.phone
        ? await hashPhone(p.phone, {
            withPlus: true,
            ...(opts.defaultCallingCode === undefined
              ? {}
              : { defaultCallingCode: opts.defaultCallingCode }),
          })
        : null;
      if (phone !== null) identifiers.push({ hashedPhoneNumber: phone });
      if (identifiers.length > 0) conversion.userIdentifiers = identifiers;
      if (clickKey === undefined && identifiers.length === 0) {
        throw new ProviderError('permanent', 'google: no click id nor user identifiers', {
          platformCode: 'no_match_keys',
        });
      }

      if (p.value_minor != null && p.currency) {
        conversion.conversionValue = minorToMajor(p.value_minor, p.currency);
        conversion.currencyCode = p.currency;
      }
      conversion.orderId = p.order_id || job.event_id;
      // Jobs are only enqueued for visitors who granted ad-optimization consent.
      conversion.consent = { adUserData: 'GRANTED' };

      const res = asRecord(
        await requestJson(
          config,
          {
            method: 'POST',
            url: `${base}/customers/${customerId}:uploadClickConversions`,
            headers: headers(token),
            body: JSON.stringify({ conversions: [conversion], partialFailure: true }),
          },
          parseGoogleAdsError,
        ),
      );
      const partial = asRecord(res.partialFailureError);
      if (Object.keys(partial).length > 0) {
        const code = firstErrorCode(partial);
        throw new ProviderError(
          'permanent',
          `google: ${asString(partial.message) ?? 'conversion rejected'}`,
          {
            status: 200,
            platformCode: code ?? 'partial_failure',
          },
        );
      }
      const jobId = asString(res.jobId);
      return { ok: true, ...(jobId === undefined ? {} : { platformResponseId: jobId }) };
    },
  };
}
