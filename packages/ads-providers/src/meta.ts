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
import { hashEmail, hashPhone, hmacSha256Hex, sha256Hex } from './pii';
import type {
  AdAccountInfo,
  AdSpendRow,
  AdsProvider,
  ProviderConfig,
  SendConversionOptions,
  SendConversionResult,
  SpendQuery,
} from './types';

export const META_DEFAULT_API_VERSION = 'v23.0';
/** `pages_*` are prerequisites Meta's app review sets for `ads_management`. */
export const META_DEFAULT_SCOPES = [
  'ads_read',
  'ads_management',
  'business_management',
  'pages_show_list',
  'pages_read_engagement',
] as const;
const GRAPH_HOST = 'https://graph.facebook.com';
const PAGE_LIMIT = '500';
const MAX_PAGES = 200;

const AUTH_CODES = new Set([102, 190]);
const RETRYABLE_CODES = new Set([1, 2, 4, 17, 32, 341, 613]);
/** Action types read as "purchase" for reported conversions, by priority. */
const PURCHASE_ACTION_TYPES = ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase'];

export function parseMetaError(status: number, body: unknown): ProviderError {
  const error = asRecord(asRecord(body).error);
  const code = typeof error.code === 'number' ? error.code : Number(asString(error.code) ?? NaN);
  const message = `meta: ${asString(error.message) ?? `HTTP ${String(status)}`}`;
  const platformCode = Number.isFinite(code) ? String(code) : undefined;
  const opts = { status, ...(platformCode === undefined ? {} : { platformCode }) };
  if (AUTH_CODES.has(code)) return new ProviderError('auth_expired', message, opts);
  if (
    RETRYABLE_CODES.has(code) ||
    (code >= 80000 && code <= 80014) ||
    error.is_transient === true
  ) {
    return new ProviderError('retryable', message, opts);
  }
  return new ProviderError(kindForStatus(status), message, opts);
}

function actId(accountId: string): string {
  return accountId.startsWith('act_') ? accountId : `act_${accountId}`;
}

function pickAction(list: unknown): string | undefined {
  const rows = asArray(list).map(asRecord);
  for (const type of PURCHASE_ACTION_TYPES) {
    const row = rows.find((r) => r.action_type === type);
    if (row !== undefined) return asString(row.value);
  }
  return undefined;
}

const ID_FIELD: Record<AdEntityLevel, string> = {
  campaign: 'campaign_id',
  adset: 'adset_id',
  ad: 'ad_id',
};

/** Meta Marketing API (Graph) + Conversions API client. */
export function createMetaProvider(config: ProviderConfig): AdsProvider {
  const version = config.apiVersion ?? META_DEFAULT_API_VERSION;
  const base = `${GRAPH_HOST}/${version}`;

  const call = (req: HttpRequest) => requestJson(config, req, parseMetaError);

  /**
   * `appsecret_proof` of a call, or null without a client secret: brokered
   * tokens (central app owned by the control plane) reach the installation
   * without the app secret, so the central app must not require the proof.
   */
  async function appsecretProof(token: string): Promise<string | null> {
    return config.clientSecret === '' ? null : hmacSha256Hex(config.clientSecret, token);
  }

  async function graphGet(
    token: string,
    path: string,
    params: Record<string, string>,
  ): Promise<unknown> {
    const proof = await appsecretProof(token);
    return call({
      method: 'GET',
      url: withQuery(`${base}/${path}`, proof === null ? params : { ...params, appsecret_proof: proof }),
      headers: { authorization: `Bearer ${token}` },
    });
  }

  /** Follows `paging.next` (absolute Graph URLs only). */
  async function graphList(
    token: string,
    path: string,
    params: Record<string, string>,
  ): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    let page = asRecord(await graphGet(token, path, { ...params, limit: PAGE_LIMIT }));
    for (let i = 0; i < MAX_PAGES; i++) {
      out.push(...asArray(page.data).map(asRecord));
      const next = asString(asRecord(page.paging).next);
      if (next === undefined || !next.startsWith(`${GRAPH_HOST}/`)) break;
      page = asRecord(
        await call({ method: 'GET', url: next, headers: { authorization: `Bearer ${token}` } }),
      );
    }
    return out;
  }

  async function exchangeForLongLived(token: string) {
    const res = asRecord(
      await call({
        method: 'GET',
        url: withQuery(`${base}/oauth/access_token`, {
          grant_type: 'fb_exchange_token',
          client_id: config.clientId,
          client_secret: config.clientSecret,
          fb_exchange_token: token,
        }),
      }),
    );
    const accessToken = asString(res.access_token);
    if (accessToken === undefined)
      throw new ProviderError('permanent', 'meta: token response without access_token');
    const expiresIn = asNumber(res.expires_in);
    // No refresh tokens on Meta: a still-valid long-lived token is re-exchanged for a fresh one.
    return {
      accessToken,
      refreshToken: accessToken,
      ...(expiresIn === null ? {} : { expiresAt: config.now() + expiresIn * 1000 }),
    };
  }

  return {
    platform: 'meta',

    authorizeUrl({ redirectUri, state, scopes }) {
      return withQuery(`https://www.facebook.com/${version}/dialog/oauth`, {
        client_id: config.clientId,
        redirect_uri: redirectUri,
        state,
        response_type: 'code',
        scope: (scopes ?? META_DEFAULT_SCOPES).join(','),
      });
    },

    async exchangeCode({ code, redirectUri }) {
      const res = asRecord(
        await call({
          method: 'GET',
          url: withQuery(`${base}/oauth/access_token`, {
            client_id: config.clientId,
            client_secret: config.clientSecret,
            redirect_uri: redirectUri,
            code,
          }),
        }),
      );
      const shortLived = asString(res.access_token);
      if (shortLived === undefined)
        throw new ProviderError('permanent', 'meta: token response without access_token');
      return exchangeForLongLived(shortLived);
    },

    refreshToken(refreshToken) {
      return exchangeForLongLived(refreshToken);
    },

    async listAccounts(token): Promise<AdAccountInfo[]> {
      const rows = await graphList(token, 'me/adaccounts', {
        fields: 'account_id,name,currency,timezone_name',
      });
      return rows.map((row) => {
        const id = asString(row.account_id) ?? (asString(row.id) ?? '').replace(/^act_/, '');
        return {
          account_id: id,
          name: entityName(row.name, id),
          currency: upperCurrency(row.currency),
          timezone: asString(row.timezone_name) ?? 'UTC',
        };
      });
    },

    async listEntities(token, accountId): Promise<AdEntity[]> {
      const act = actId(accountId);
      const budgetFields = 'daily_budget,lifetime_budget';
      const [campaigns, adsets, ads] = [
        await graphList(token, `${act}/campaigns`, {
          fields: `id,name,effective_status,${budgetFields}`,
        }),
        await graphList(token, `${act}/adsets`, {
          fields: `id,name,campaign_id,effective_status,${budgetFields}`,
        }),
        await graphList(token, `${act}/ads`, { fields: 'id,name,adset_id,effective_status' }),
      ];
      const budget = (row: Record<string, unknown>) =>
        asInt(row.daily_budget) ?? asInt(row.lifetime_budget);
      const entity = (
        level: AdEntityLevel,
        row: Record<string, unknown>,
        parent: unknown,
      ): AdEntity => {
        const id = asString(row.id) ?? '';
        return {
          platform: 'meta',
          level,
          external_id: id,
          parent_external_id: asString(parent) ?? null,
          name: entityName(row.name, id),
          status: normalizeStatus(row.effective_status),
          ...(level === 'ad' ? {} : { budget_minor: budget(row) }),
        };
      };
      return [
        ...campaigns.map((row) => entity('campaign', row, null)),
        ...adsets.map((row) => entity('adset', row, row.campaign_id)),
        ...ads.map((row) => entity('ad', row, row.adset_id)),
      ].filter((e) => e.external_id !== '');
    },

    async fetchSpend(token, accountId, query: SpendQuery): Promise<AdSpendRow[]> {
      assertSpendQuery(query);
      const idField = ID_FIELD[query.level];
      const rows = await graphList(token, `${actId(accountId)}/insights`, {
        level: query.level,
        fields: `${idField},date_start,spend,impressions,clicks,actions,action_values,account_currency`,
        time_range: JSON.stringify({ since: query.from, until: query.to }),
        time_increment: '1',
        ...(query.granularity === 'hour'
          ? { breakdowns: 'hourly_stats_aggregated_by_advertiser_time_zone' }
          : {}),
      });
      const out: AdSpendRow[] = [];
      for (const row of rows) {
        const id = asString(row[idField]);
        const day = asString(row.date_start);
        if (id === undefined || day === undefined) continue;
        const currency = upperCurrency(row.account_currency);
        const revenue = pickAction(row.action_values);
        const spendRow: AdSpendRow = {
          platform: 'meta',
          entity_external_id: id,
          day,
          spend_minor: Math.max(0, decimalToMinor(asString(row.spend), currency)),
          currency,
          clicks: asInt(row.clicks),
          impressions: asInt(row.impressions),
          reported_conversions: asNumber(pickAction(row.actions)) ?? 0,
          reported_revenue_minor:
            revenue === undefined ? 0 : Math.max(0, decimalToMinor(revenue, currency)),
        };
        if (query.granularity === 'hour') {
          const hour = Number(
            (asString(row.hourly_stats_aggregated_by_advertiser_time_zone) ?? '').slice(0, 2),
          );
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
      const datasetId = opts.datasetId ?? opts.pixelId;
      if (datasetId === undefined || datasetId === '') {
        throw new ProviderError('permanent', 'meta: missing dataset/pixel id', {
          platformCode: 'missing_dataset',
        });
      }
      const p = job.payload;
      const userData: Record<string, unknown> = {};
      const em = p.email ? await hashEmail(p.email) : null;
      if (em !== null) userData.em = [em];
      const ph = p.phone
        ? await hashPhone(
            p.phone,
            opts.defaultCallingCode === undefined
              ? {}
              : { defaultCallingCode: opts.defaultCallingCode },
          )
        : null;
      if (ph !== null) userData.ph = [ph];
      if (p.external_id)
        userData.external_id = [await sha256Hex(p.external_id.trim().toLowerCase())];
      if (p.ip) userData.client_ip_address = p.ip;
      if (p.user_agent) userData.client_user_agent = p.user_agent;
      const fbc =
        p.click_ids.fbc ??
        (p.click_ids.fbclid ? `fb.1.${String(p.event_time)}.${p.click_ids.fbclid}` : undefined);
      if (fbc !== undefined) userData.fbc = fbc;
      if (p.click_ids.fbp) userData.fbp = p.click_ids.fbp;
      if (Object.keys(userData).length === 0) {
        throw new ProviderError('permanent', 'meta: no user data to match the event', {
          platformCode: 'no_match_keys',
        });
      }

      const customData: Record<string, unknown> = {};
      if (p.value_minor != null && p.currency) {
        customData.value = minorToMajor(p.value_minor, p.currency);
        customData.currency = p.currency;
      }
      if (p.order_id) customData.order_id = p.order_id;

      const event: Record<string, unknown> = {
        event_name: p.event_name,
        event_time: Math.floor(p.event_time / 1000),
        event_id: job.event_id,
        action_source: 'website',
        user_data: userData,
      };
      if (p.page_url) event.event_source_url = p.page_url;
      if (Object.keys(customData).length > 0) event.custom_data = customData;

      const proof = await appsecretProof(token);
      const res = asRecord(
        await call({
          method: 'POST',
          url: withQuery(
            `${base}/${encodeURIComponent(datasetId)}/events`,
            proof === null ? {} : { appsecret_proof: proof },
          ),
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            data: [event],
            ...(opts.testEventCode === undefined ? {} : { test_event_code: opts.testEventCode }),
          }),
        }),
      );
      const traceId = asString(res.fbtrace_id);
      return { ok: true, ...(traceId === undefined ? {} : { platformResponseId: traceId }) };
    },
  };
}
