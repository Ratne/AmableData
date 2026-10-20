import {
  createFakeProvider,
  createProvider,
  type AdsProvider as AdPlatformClient,
  type ProviderConfig,
} from '@amable/ads-providers';
import type { AdPlatform, Integration, IntegrationProvider } from '@amable/api-types';
import {
  siteStub,
  type AdSpendRow,
  type AnalyticsNamespace,
  type IntegrationRow,
  type SearchStatRow,
} from '@amable/app-edge/analytics';
import { mapLimited } from '../concurrency';

/**
 * Ad spend (Meta Ads) and organic search (Google Search Console) integrations.
 *
 * Both sit behind interfaces: the managed offering will resolve OAuth through
 * the central apps of the control plane (no customer-side app review), the
 * self-hosted one plugs its own. This installation ships:
 * - `devIntegrations()` (ENVIRONMENT=dev): a fake OAuth round-trip and
 *   deterministic generated data — never any network;
 * - `unavailableIntegrations()` everywhere else, until the central service exists.
 * Only an opaque account reference is stored in the site DO, never a token.
 */

export interface IntegrationAccount {
  accountId: string;
  accountName: string;
}

export interface IntegrationOAuth {
  readonly available: boolean;
  readonly fake: boolean;
  startConnect(input: {
    tenantId: string;
    siteId: string;
    provider: IntegrationProvider;
    returnUrl: string;
  }): Promise<{ authorizeUrl: string }>;
  finishConnect(input: {
    tenantId: string;
    siteId: string;
    provider: IntegrationProvider;
    state: string;
    code: string;
  }): Promise<IntegrationAccount>;
}

export interface AdsProvider {
  /** Daily spend per campaign for [from, to] (UTC days, inclusive). */
  dailySpend(input: {
    account: IntegrationAccount;
    from: string;
    to: string;
    currency: string;
    /** Campaign names seen in the site's `utm_campaign` (the dev provider mirrors them). */
    knownCampaigns: readonly string[];
  }): Promise<AdSpendRow[]>;
}

export interface SearchConsoleProvider {
  /** Daily clicks / impressions / position per query and per page. */
  searchStats(input: {
    account: IntegrationAccount;
    siteUrl: string;
    from: string;
    to: string;
    knownPaths: readonly string[];
  }): Promise<SearchStatRow[]>;
}

export interface Integrations {
  oauth: IntegrationOAuth;
  ads: AdsProvider;
  search: SearchConsoleProvider;
}

// ------------------------------------------------------------- unavailable

export function unavailableIntegrations(): Integrations {
  const no = (): Promise<never> => Promise.reject(new Error('integration_unavailable'));
  return {
    oauth: { available: false, fake: false, startConnect: no, finishConnect: no },
    ads: { dailySpend: no },
    search: { searchStats: no },
  };
}

// -------------------------------------------------------------------- dev

/** Small deterministic PRNG (mulberry32) seeded from a string. */
export function seeded(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i += 1) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out.slice(0, 400);
}

const DEV_CAMPAIGNS = ['spring_sale', 'retargeting', 'brand_awareness'];
const DEV_QUERIES = ['crm for small business', 'email automation', 'best crm', 'pricing', 'how to track revenue'];

export function devIntegrations(): Integrations {
  return {
    oauth: {
      available: true,
      fake: true,
      startConnect: ({ provider, siteId, returnUrl }) => {
        const url = new URL(returnUrl);
        url.searchParams.set('integration', provider);
        url.searchParams.set('state', `dev.${provider}.${siteId}`);
        url.searchParams.set('code', 'dev-code');
        return Promise.resolve({ authorizeUrl: url.toString() });
      },
      finishConnect: ({ provider, siteId, state }) => {
        if (state !== `dev.${provider}.${siteId}`) return Promise.reject(new Error('invalid_state'));
        return Promise.resolve({
          accountId: `dev-${provider}-${siteId.slice(-6)}`,
          accountName: provider === 'meta_ads' ? 'Development ad account' : 'sc-domain:example.com (development)',
        });
      },
    },
    ads: {
      dailySpend: ({ from, to, currency, knownCampaigns }) => {
        const names = (knownCampaigns.length > 0 ? knownCampaigns : DEV_CAMPAIGNS).slice(0, 8);
        const rows: AdSpendRow[] = [];
        for (const day of daysBetween(from, to)) {
          names.forEach((name, i) => {
            const rnd = seeded(`${name}|${day}`);
            const impressions = Math.round(800 + rnd() * 4000);
            const clicks = Math.round(impressions * (0.01 + rnd() * 0.03));
            rows.push({
              day,
              campaign_id: `dev_cmp_${i + 1}`,
              campaign_name: name,
              spend_minor: Math.round(clicks * (35 + rnd() * 60)),
              currency,
              impressions,
              clicks,
            });
          });
        }
        return Promise.resolve(rows);
      },
    },
    search: {
      searchStats: ({ from, to, knownPaths }) => {
        const rows: SearchStatRow[] = [];
        const pages = (knownPaths.length > 0 ? knownPaths : ['/', '/pricing', '/blog']).slice(0, 15);
        for (const day of daysBetween(from, to)) {
          DEV_QUERIES.forEach((q) => {
            const rnd = seeded(`q|${q}|${day}`);
            const impressions = Math.round(50 + rnd() * 600);
            rows.push({
              day,
              kind: 'query',
              key: q,
              impressions,
              clicks: Math.round(impressions * (0.02 + rnd() * 0.08)),
              position: Math.round((2 + rnd() * 18) * 10) / 10,
            });
          });
          pages.forEach((p) => {
            const rnd = seeded(`p|${p}|${day}`);
            const impressions = Math.round(30 + rnd() * 400);
            rows.push({
              day,
              kind: 'page',
              key: p,
              impressions,
              clicks: Math.round(impressions * (0.02 + rnd() * 0.08)),
              position: Math.round((2 + rnd() * 18) * 10) / 10,
            });
          });
        }
        return Promise.resolve(rows);
      },
    },
  };
}

// -------------------------------------------------------------------- sync

export const INTEGRATION_SYNC_INTERVAL_MS = 20 * 3_600_000;
const FIRST_SYNC_DAYS = 90;
const RESYNC_DAYS = 3;

const utcDay = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

export function toIntegration(
  provider: IntegrationProvider,
  row: IntegrationRow | null,
  integrations: Integrations,
): Integration {
  return {
    provider,
    available: integrations.oauth.available,
    fake: integrations.oauth.fake,
    status: row?.status ?? 'disconnected',
    account_name: row?.account_name ?? null,
    connected_at: row?.connected_at == null ? null : new Date(row.connected_at).toISOString(),
    last_sync_at: row?.last_sync_at == null ? null : new Date(row.last_sync_at).toISOString(),
    last_error: row?.last_error ?? null,
  };
}

/** Pulls the recent days of one connected integration into the site DO. */
export async function syncIntegration(
  ns: AnalyticsNamespace,
  siteId: string,
  provider: IntegrationProvider,
  integrations: Integrations,
  now: number,
): Promise<IntegrationRow | null> {
  const stub = siteStub(ns, siteId);
  const row = await stub.getIntegration(provider);
  const site = await stub.getSite();
  if (row === null || row.status === 'disconnected' || row.account_id === null || site === null) return row;
  const account = { accountId: row.account_id, accountName: row.account_name ?? row.account_id };
  const from = utcDay(now - (row.last_sync_at === null ? FIRST_SYNC_DAYS : RESYNC_DAYS) * 86_400_000);
  const to = utcDay(now);
  let next: IntegrationRow;
  try {
    if (provider === 'meta_ads') {
      await stub.storeAdSpend(
        await integrations.ads.dailySpend({
          account,
          from,
          to,
          currency: site.site.currency,
          knownCampaigns: await stub.campaignNames(8),
        }),
      );
    } else {
      await stub.storeSearchStats(
        await integrations.search.searchStats({
          account,
          siteUrl: `https://${site.site.hostnames[0] ?? 'example.com'}/`,
          from,
          to,
          knownPaths: await stub.topPaths(15),
        }),
      );
    }
    next = { ...row, status: 'connected', last_sync_at: now, last_error: null };
  } catch (error) {
    next = { ...row, status: 'error', last_error: error instanceof Error ? error.message.slice(0, 200) : 'sync failed' };
  }
  await stub.saveIntegration(next);
  return next;
}

// ------------------------------------------------------------ ad platforms

/**
 * OAuth apps of the installation for the ad platforms (Wrangler secrets). A
 * platform without credentials is unavailable outside dev/test, where the
 * deterministic fake client of `@amable/ads-providers` stands in (no network) —
 * except Meta on the managed offering, which the central broker of the control
 * plane serves without any installation-side app (see `ads-broker.ts`).
 */
export interface AdPlatformSecretsEnv {
  ENVIRONMENT?: string;
  META_APP_ID?: string;
  META_APP_SECRET?: string;
  GOOGLE_ADS_CLIENT_ID?: string;
  GOOGLE_ADS_CLIENT_SECRET?: string;
  GOOGLE_ADS_DEVELOPER_TOKEN?: string;
  /** Optional manager (MCC) account, digits. */
  GOOGLE_ADS_LOGIN_CUSTOMER_ID?: string;
  TIKTOK_APP_ID?: string;
  TIKTOK_APP_SECRET?: string;
}

/**
 * How an ad platform is wired on this installation: deterministic fake
 * (dev/test), own OAuth app (Wrangler secrets), central broker of the control
 * plane (managed offering, no secrets needed), or not available at all. An own
 * app always takes precedence over the broker.
 */
export type AdPlatformMode = 'fake' | 'own' | 'broker' | 'unavailable';

export interface AdPlatformClients {
  readonly fake: boolean;
  /** Client of a platform, or null when the installation has no app for it. */
  client(platform: AdPlatform): AdPlatformClient | null;
  mode(platform: AdPlatform): AdPlatformMode;
}

const trimmed = (v: string | undefined): string => v?.trim() ?? '';

export function adPlatformCredentials(
  env: AdPlatformSecretsEnv,
  platform: AdPlatform,
): Omit<ProviderConfig, 'fetch' | 'now'> | null {
  const pair = (clientId: string | undefined, clientSecret: string | undefined) =>
    trimmed(clientId) !== '' && trimmed(clientSecret) !== ''
      ? { clientId: trimmed(clientId), clientSecret: trimmed(clientSecret) }
      : null;
  switch (platform) {
    case 'meta':
      return pair(env.META_APP_ID, env.META_APP_SECRET);
    case 'tiktok':
      return pair(env.TIKTOK_APP_ID, env.TIKTOK_APP_SECRET);
    case 'google': {
      const base = pair(env.GOOGLE_ADS_CLIENT_ID, env.GOOGLE_ADS_CLIENT_SECRET);
      const developerToken = trimmed(env.GOOGLE_ADS_DEVELOPER_TOKEN);
      if (base === null || developerToken === '') return null;
      const loginCustomerId = trimmed(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID).replace(/-/g, '');
      return { ...base, developerToken, ...(loginCustomerId === '' ? {} : { loginCustomerId }) };
    }
  }
}

export function adPlatformClientsFor(
  env: AdPlatformSecretsEnv,
  deps: { fetch?: typeof fetch; now?: () => number; brokered?: (platform: AdPlatform) => boolean } = {},
): AdPlatformClients {
  if (env.ENVIRONMENT === 'dev' || env.ENVIRONMENT === 'test') {
    return { fake: true, client: (platform) => createFakeProvider(platform, 'dev'), mode: () => 'fake' };
  }
  const fetchFn = deps.fetch ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? Date.now;
  const mode = (platform: AdPlatform): AdPlatformMode => {
    if (adPlatformCredentials(env, platform) !== null) return 'own';
    if (deps.brokered?.(platform) === true) return 'broker';
    return 'unavailable';
  };
  return {
    fake: false,
    mode,
    client(platform) {
      switch (mode(platform)) {
        case 'own': {
          const credentials = adPlatformCredentials(env, platform);
          return credentials === null ? null : createProvider(platform, { ...credentials, fetch: fetchFn, now });
        }
        // API-only client: the brokered token is enough for Graph calls (no
        // appsecret_proof without a secret) and the OAuth methods are never
        // used — connect and refresh go through the central broker instead.
        case 'broker':
          return createProvider(platform, { clientId: '', clientSecret: '', fetch: fetchFn, now });
        default:
          return null;
      }
    },
  };
}

/** Sites synced at once; a site's own integrations run one after the other. */
const SYNC_SITE_CONCURRENCY = 4;

/** Daily sync of every connected integration of the given sites (cron). */
export async function syncDueIntegrations(
  ns: AnalyticsNamespace,
  siteIds: readonly string[],
  integrations: Integrations,
  now: number,
): Promise<number> {
  if (!integrations.oauth.available) return 0;
  const perSite = await mapLimited(siteIds, SYNC_SITE_CONCURRENCY, async (siteId) => {
    let synced = 0;
    for (const row of await siteStub(ns, siteId).listIntegrations()) {
      if (row.status === 'disconnected') continue;
      if (row.last_sync_at !== null && now - row.last_sync_at < INTEGRATION_SYNC_INTERVAL_MS) continue;
      await syncIntegration(ns, siteId, row.provider, integrations, now);
      synced += 1;
    }
    return synced;
  });
  return perSite.reduce((sum, n) => sum + n, 0);
}
