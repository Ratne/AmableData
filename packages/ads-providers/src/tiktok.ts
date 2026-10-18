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
  normalizeStatus,
  requestJson,
  upperCurrency,
  withQuery,
  type HttpRequest,
} from './http';
import { decimalToMinor, minorToMajor } from './money';
import { hashEmail, hashPhone, sha256Hex } from './pii';
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

export const TIKTOK_DEFAULT_API_VERSION = 'v1.3';
const API_HOST = 'https://business-api.tiktok.com/open_api';
const PAGE_SIZE = 1000;
const MAX_PAGES = 200;
const INFO_BATCH = 100;

const AUTH_CODES = new Set([40001, 40102, 40104, 40105, 40106]);

/** TikTok answers HTTP 200 with a non-zero `code` on failure; HTTP errors are classified by status. */
export function parseTikTokError(status: number, body: unknown): ProviderError {
  const root = asRecord(body);
  const code = typeof root.code === 'number' ? root.code : undefined;
  const message = `tiktok: ${asString(root.message) ?? `HTTP ${String(status)}`}`;
  const opts = { status, ...(code === undefined ? {} : { platformCode: String(code) }) };
  if (code !== undefined) {
    if (AUTH_CODES.has(code)) return new ProviderError('auth_expired', message, opts);
    if (code === 40100 || code === 40200 || (code >= 50000 && code < 60000)) {
      return new ProviderError('retryable', message, opts);
    }
    if (status < 400) return new ProviderError('permanent', message, opts);
  }
  return new ProviderError(kindForStatus(status), message, opts);
}

const LEVEL: Record<AdEntityLevel, { dataLevel: string; dimension: string }> = {
  campaign: { dataLevel: 'AUCTION_CAMPAIGN', dimension: 'campaign_id' },
  adset: { dataLevel: 'AUCTION_ADGROUP', dimension: 'adgroup_id' },
  ad: { dataLevel: 'AUCTION_AD', dimension: 'ad_id' },
};

/** TikTok Business (Marketing) API + Events API client. */
export function createTikTokProvider(config: ProviderConfig): AdsProvider {
  const version = config.apiVersion ?? TIKTOK_DEFAULT_API_VERSION;
  const base = `${API_HOST}/${version}`;

  async function call(req: HttpRequest): Promise<Record<string, unknown>> {
    const res = asRecord(await requestJson(config, req, parseTikTokError));
    if (res.code !== 0) throw parseTikTokError(200, res);
    return asRecord(res.data);
  }

  const get = (token: string, path: string, params: Record<string, string>) =>
    call({
      method: 'GET',
      url: withQuery(`${base}/${path}`, params),
      headers: { 'access-token': token },
    });

  async function paged(token: string, path: string, params: Record<string, string>) {
    const out: Record<string, unknown>[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await get(token, path, {
        ...params,
        page: String(page),
        page_size: String(PAGE_SIZE),
      });
      out.push(...asArray(data.list).map(asRecord));
      const totalPages = asInt(asRecord(data.page_info).total_page) ?? 1;
      if (page >= totalPages) break;
    }
    return out;
  }

  async function advertiserInfo(token: string, ids: string[]): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    for (let i = 0; i < ids.length; i += INFO_BATCH) {
      const data = await get(token, 'advertiser/info/', {
        advertiser_ids: JSON.stringify(ids.slice(i, i + INFO_BATCH)),
        fields: JSON.stringify(['advertiser_id', 'name', 'currency', 'timezone']),
      });
      out.push(...asArray(data.list).map(asRecord));
    }
    return out;
  }

  async function currencyOf(token: string, accountId: string): Promise<string> {
    const [info] = await advertiserInfo(token, [accountId]);
    return upperCurrency(info?.currency);
  }

  function tokens(data: Record<string, unknown>): OAuthTokens {
    const accessToken = asString(data.access_token);
    if (accessToken === undefined)
      throw new ProviderError('permanent', 'tiktok: token response without access_token');
    const refreshToken = asString(data.refresh_token);
    const expiresIn = asNumber(data.access_token_expire_in) ?? asNumber(data.expires_in);
    return {
      accessToken,
      ...(refreshToken === undefined ? {} : { refreshToken }),
      ...(expiresIn === null ? {} : { expiresAt: config.now() + expiresIn * 1000 }),
    };
  }

  const postJson = (path: string, body: unknown, token?: string): HttpRequest => ({
    method: 'POST',
    url: `${base}/${path}`,
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { 'access-token': token }),
    },
    body: JSON.stringify(body),
  });

  return {
    platform: 'tiktok',

    authorizeUrl({ redirectUri, state }) {
      // Scopes are configured on the TikTok app, not per request.
      return withQuery('https://business-api.tiktok.com/portal/auth', {
        app_id: config.clientId,
        state,
        redirect_uri: redirectUri,
      });
    },

    async exchangeCode({ code }) {
      return tokens(
        await call(
          postJson('oauth2/access_token/', {
            app_id: config.clientId,
            secret: config.clientSecret,
            auth_code: code,
          }),
        ),
      );
    },

    async refreshToken(refreshToken) {
      const result = tokens(
        await call(
          postJson('oauth2/refresh_token/', {
            app_id: config.clientId,
            secret: config.clientSecret,
            refresh_token: refreshToken,
            grant_type: 'refresh_token',
          }),
        ),
      );
      return result.refreshToken === undefined ? { ...result, refreshToken } : result;
    },

    async listAccounts(token): Promise<AdAccountInfo[]> {
      const data = await get(token, 'oauth2/advertiser/get/', {
        app_id: config.clientId,
        secret: config.clientSecret,
      });
      const ids = asArray(data.list)
        .map((row) => asString(asRecord(row).advertiser_id))
        .filter((id): id is string => id !== undefined);
      const infos = await advertiserInfo(token, ids);
      return infos.map((info) => {
        const id = asString(info.advertiser_id) ?? '';
        return {
          account_id: id,
          name: entityName(info.name, id),
          currency: upperCurrency(info.currency),
          timezone: asString(info.timezone) ?? 'UTC',
        };
      });
    },

    async listEntities(token, accountId): Promise<AdEntity[]> {
      const currency = await currencyOf(token, accountId);
      const common = { advertiser_id: accountId };
      const campaigns = await paged(token, 'campaign/get/', {
        ...common,
        fields: JSON.stringify(['campaign_id', 'campaign_name', 'operation_status', 'budget']),
      });
      const adGroups = await paged(token, 'adgroup/get/', {
        ...common,
        fields: JSON.stringify([
          'adgroup_id',
          'adgroup_name',
          'campaign_id',
          'operation_status',
          'budget',
        ]),
      });
      const ads = await paged(token, 'ad/get/', {
        ...common,
        fields: JSON.stringify(['ad_id', 'ad_name', 'adgroup_id', 'operation_status']),
      });
      const budget = (raw: unknown) => {
        const value = asNumber(raw);
        return value === null || value === 0 ? null : decimalToMinor(value, currency);
      };
      const out: AdEntity[] = [];
      for (const row of campaigns) {
        const id = asString(row.campaign_id);
        if (id === undefined) continue;
        out.push({
          platform: 'tiktok',
          level: 'campaign',
          external_id: id,
          parent_external_id: null,
          name: entityName(row.campaign_name, id),
          status: normalizeStatus(row.operation_status),
          budget_minor: budget(row.budget),
        });
      }
      for (const row of adGroups) {
        const id = asString(row.adgroup_id);
        if (id === undefined) continue;
        out.push({
          platform: 'tiktok',
          level: 'adset',
          external_id: id,
          parent_external_id: asString(row.campaign_id) ?? null,
          name: entityName(row.adgroup_name, id),
          status: normalizeStatus(row.operation_status),
          budget_minor: budget(row.budget),
        });
      }
      for (const row of ads) {
        const id = asString(row.ad_id);
        if (id === undefined) continue;
        out.push({
          platform: 'tiktok',
          level: 'ad',
          external_id: id,
          parent_external_id: asString(row.adgroup_id) ?? null,
          name: entityName(row.ad_name, id),
          status: normalizeStatus(row.operation_status),
        });
      }
      return out;
    },

    async fetchSpend(token, accountId, query: SpendQuery): Promise<AdSpendRow[]> {
      assertSpendQuery(query);
      const currency = await currencyOf(token, accountId);
      const level = LEVEL[query.level];
      const timeDimension = query.granularity === 'hour' ? 'stat_time_hour' : 'stat_time_day';
      const rows = await paged(token, 'report/integrated/get/', {
        advertiser_id: accountId,
        report_type: 'BASIC',
        data_level: level.dataLevel,
        dimensions: JSON.stringify([level.dimension, timeDimension]),
        metrics: JSON.stringify([
          'spend',
          'impressions',
          'clicks',
          'conversion',
          'complete_payment_roas',
        ]),
        start_date: query.from,
        end_date: query.to,
      });
      const out: AdSpendRow[] = [];
      for (const row of rows) {
        const dims = asRecord(row.dimensions);
        const metrics = asRecord(row.metrics);
        const id = asString(dims[level.dimension]);
        const stamp = asString(dims[timeDimension]);
        if (id === undefined || stamp === undefined) continue;
        const spend = Math.max(0, decimalToMinor(asString(metrics.spend), currency));
        const roas = asNumber(metrics.complete_payment_roas) ?? 0;
        const spendRow: AdSpendRow = {
          platform: 'tiktok',
          entity_external_id: id,
          day: stamp.slice(0, 10),
          spend_minor: spend,
          currency,
          clicks: asInt(metrics.clicks),
          impressions: asInt(metrics.impressions),
          reported_conversions: asNumber(metrics.conversion) ?? 0,
          // The report exposes payment ROAS, not the value: value = spend × ROAS.
          reported_revenue_minor: Math.round(spend * roas),
        };
        if (query.granularity === 'hour') {
          const hour = Number(stamp.slice(11, 13));
          if (!Number.isInteger(hour)) continue;
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
      if (!opts.pixelCode) {
        throw new ProviderError('permanent', 'tiktok: missing pixel code', {
          platformCode: 'missing_pixel',
        });
      }
      const p = job.payload;
      const user: Record<string, unknown> = {};
      if (p.click_ids.ttclid) user.ttclid = p.click_ids.ttclid;
      if (p.click_ids.ttp) user.ttp = p.click_ids.ttp;
      const email = p.email ? await hashEmail(p.email) : null;
      if (email !== null) user.email = email;
      const phone = p.phone
        ? await hashPhone(p.phone, {
            withPlus: true,
            ...(opts.defaultCallingCode === undefined
              ? {}
              : { defaultCallingCode: opts.defaultCallingCode }),
          })
        : null;
      if (phone !== null) user.phone = phone;
      if (p.external_id) user.external_id = await sha256Hex(p.external_id.trim().toLowerCase());
      if (p.ip) user.ip = p.ip;
      if (p.user_agent) user.user_agent = p.user_agent;
      if (Object.keys(user).length === 0) {
        throw new ProviderError('permanent', 'tiktok: no user data to match the event', {
          platformCode: 'no_match_keys',
        });
      }

      const properties: Record<string, unknown> = {};
      if (p.value_minor != null && p.currency) {
        properties.value = minorToMajor(p.value_minor, p.currency);
        properties.currency = p.currency;
      }
      if (p.order_id) properties.order_id = p.order_id;

      const event: Record<string, unknown> = {
        event: p.event_name,
        event_time: Math.floor(p.event_time / 1000),
        event_id: job.event_id,
        user,
      };
      if (Object.keys(properties).length > 0) event.properties = properties;
      if (p.page_url) event.page = { url: p.page_url };

      const res = asRecord(
        await requestJson(
          config,
          postJson(
            'event/track/',
            {
              event_source: 'web',
              event_source_id: opts.pixelCode,
              ...(opts.testEventCode === undefined ? {} : { test_event_code: opts.testEventCode }),
              data: [event],
            },
            token,
          ),
          parseTikTokError,
        ),
      );
      if (res.code !== 0) throw parseTikTokError(200, res);
      const requestId = asString(res.request_id);
      return { ok: true, ...(requestId === undefined ? {} : { platformResponseId: requestId }) };
    },
  };
}
