import type {
  AdConnection,
  AdPlatform,
  FunnelGraph,
  FunnelGraphInput,
  FunnelGraphSummary,
  FunnelGraphUpdate,
  FunnelHeatmap,
  FunnelLinks,
  FunnelStatus,
  HeatmapMetric,
  LandingPage,
  OutboundConversionJob,
  OutboundStatus,
  OutboundTarget,
  TrafficSource,
  TrafficSourceInput,
  TrafficSourceTemplateDef,
} from '@amable/api-types';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ApiError } from '../../lib/api';
import { stepUpFetch } from '../../lib/step-up';
import { analyticsKeys, tenantBase } from './api';

/*
 * Client of the funnel tracking surface under `/api/v2/t/{slug}/analytics`:
 * funnel graphs (`/funnels-v2`), their links and heatmap, traffic sources and
 * templates, ad platform connections and the outbound conversion log.
 */

/** API error keeping the JSON body (422 details, `invalid_graph` errors). */
export class ApiBodyError extends ApiError {
  constructor(
    status: number,
    code: string | null,
    readonly body: unknown,
  ) {
    super(status, code);
  }
}

/** `validation_failed` field details of an error, if any. */
export function errorDetails(error: unknown): { path: string; message: string }[] {
  if (!(error instanceof ApiBodyError)) return [];
  const body = error.body as { details?: unknown } | null;
  if (!body || !Array.isArray(body.details)) return [];
  return body.details.filter(
    (d): d is { path: string; message: string } =>
      typeof d === 'object' &&
      d !== null &&
      typeof (d as { path?: unknown }).path === 'string' &&
      typeof (d as { message?: unknown }).message === 'string',
  );
}

const enc = encodeURIComponent;
type Params = Readonly<Record<string, string | number | boolean | null | undefined>>;

function withQuery(path: string, params: Params): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `${path}?${text}` : path;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  if (init.method && init.method !== 'GET') headers.set('x-amable-csrf', '1');
  const response = await stepUpFetch(path, { ...init, headers, credentials: 'same-origin' });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    throw new ApiBodyError(
      response.status,
      typeof body?.error === 'string' ? body.error : null,
      body,
    );
  }
  return (await response.json()) as T;
}

const send = (method: string, body: unknown = {}): RequestInit => ({
  method,
  body: JSON.stringify(body),
});

export interface FunnelLinksParams {
  readonly source: string;
  readonly node?: string;
  readonly page?: string;
  readonly domain?: string;
  readonly cost?: string;
  readonly wordpress?: boolean;
}

export interface FunnelHeatmapParams {
  readonly metric: HeatmapMetric;
  readonly from?: string;
  readonly to?: string;
  readonly source?: string;
}

export interface AdConnectionsResponse {
  readonly available: AdPlatform[];
  readonly fake: boolean;
  readonly data: AdConnection[];
}

export interface OutboundQuery {
  readonly status?: OutboundStatus;
  readonly platform?: OutboundTarget;
  readonly connection_id?: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
}

export interface OutboundList {
  readonly data: OutboundConversionJob[];
  readonly stats: Record<OutboundStatus, number>;
  /** More jobs match than `limit`: only the newest are listed. */
  readonly truncated: boolean;
}

export type OutboundResendBody =
  | { readonly ids: readonly string[] }
  | Pick<OutboundQuery, 'platform' | 'connection_id' | 'from' | 'to'>;

export function funnelsApi(tenant: string) {
  const base = tenantBase(tenant);
  const sited = (siteId: string, path: string, params: Params = {}) =>
    withQuery(`${base}/${path}`, { site_id: siteId, ...params });
  const graph = (id: string) => `funnels-v2/${enc(id)}`;
  const source = (id: string) => `traffic-sources/${enc(id)}`;
  return {
    funnels: {
      list: (siteId: string, status?: FunnelStatus) =>
        request<{ data: FunnelGraphSummary[] }>(sited(siteId, 'funnels-v2', { status })),
      get: (siteId: string, id: string) => request<FunnelGraph>(sited(siteId, graph(id))),
      create: (siteId: string, input: FunnelGraphInput) =>
        request<FunnelGraph>(sited(siteId, 'funnels-v2'), send('POST', input)),
      save: (siteId: string, id: string, input: FunnelGraphUpdate) =>
        request<FunnelGraph>(sited(siteId, graph(id)), send('PUT', input)),
      archive: (siteId: string, id: string) =>
        request<FunnelGraph>(sited(siteId, `${graph(id)}/archive`), send('POST')),
      restore: (siteId: string, id: string) =>
        request<FunnelGraph>(sited(siteId, `${graph(id)}/restore`), send('POST')),
      duplicate: (siteId: string, id: string, name?: string) =>
        request<FunnelGraph>(
          sited(siteId, `${graph(id)}/duplicate`),
          send('POST', name ? { name } : {}),
        ),
      links: (siteId: string, id: string, params: FunnelLinksParams) =>
        request<FunnelLinks>(
          sited(siteId, `${graph(id)}/links`, {
            ...params,
            wordpress: params.wordpress ? 'true' : undefined,
          }),
        ),
      heatmap: (siteId: string, id: string, params: FunnelHeatmapParams) =>
        request<FunnelHeatmap>(sited(siteId, `${graph(id)}/heatmap`, { ...params })),
    },
    sources: {
      templates: () =>
        request<{ data: TrafficSourceTemplateDef[] }>(`${base}/traffic-sources/templates`),
      list: (siteId: string, status?: TrafficSource['status']) =>
        request<{ data: TrafficSource[] }>(sited(siteId, 'traffic-sources', { status })),
      get: (siteId: string, id: string) => request<TrafficSource>(sited(siteId, source(id))),
      create: (siteId: string, input: TrafficSourceInput) =>
        request<TrafficSource>(sited(siteId, 'traffic-sources'), send('POST', input)),
      update: (siteId: string, id: string, input: TrafficSourceInput) =>
        request<TrafficSource>(sited(siteId, source(id)), send('PUT', input)),
      archive: (siteId: string, id: string) =>
        request<TrafficSource>(sited(siteId, `${source(id)}/archive`), send('POST')),
      restore: (siteId: string, id: string) =>
        request<TrafficSource>(sited(siteId, `${source(id)}/restore`), send('POST')),
    },
    ads: {
      connections: (siteId: string) =>
        request<AdConnectionsResponse>(sited(siteId, 'ads/connections')),
      connect: (siteId: string, platform: AdPlatform) =>
        request<{ authorize_url: string; state: string }>(
          sited(siteId, `ads/connections/${platform}/connect`),
          send('POST'),
        ),
      callback: (siteId: string, platform: AdPlatform, input: { state: string; code: string }) =>
        request<{ data: AdConnection[] }>(
          sited(siteId, `ads/connections/${platform}/callback`),
          send('POST', input),
        ),
      disconnect: (siteId: string, id: string) =>
        request<{ id: string; deleted: true }>(sited(siteId, `ads/connections/${enc(id)}`), {
          method: 'DELETE',
        }),
      settings: (
        siteId: string,
        id: string,
        input: { pixel_id?: string | null; test_event_code?: string | null },
      ) =>
        request<AdConnection>(sited(siteId, `ads/connections/${enc(id)}`), send('PATCH', input)),
      backfill: (siteId: string, id: string, range: { from: string; to: string }) =>
        request<{ connection_id: string; from: string; to: string; rows: number }>(
          sited(siteId, `ads/connections/${enc(id)}/backfill`),
          send('POST', range),
        ),
    },
    outbound: {
      list: (siteId: string, query: OutboundQuery = {}) =>
        request<OutboundList>(sited(siteId, 'outbound', { ...query })),
      resend: (siteId: string, id: string) =>
        request<{ requeued: number }>(sited(siteId, `outbound/${enc(id)}/resend`), send('POST')),
      resendMany: (siteId: string, body: OutboundResendBody) =>
        request<{ requeued: number }>(sited(siteId, 'outbound/resend'), send('POST', body)),
    },
    /** Pages of the AmableCRM page builder (`/api/v2/t/{slug}/pages`). */
    pages: () =>
      request<{ data: LandingPage[] }>(
        withQuery(`/api/v2/t/${enc(tenant)}/pages`, { limit: 100 }),
      ),
  };
}

export type FunnelsApi = ReturnType<typeof funnelsApi>;

// ---------------------------------------------------------------- ads OAuth

/** Site + platform of an ad OAuth flow, kept across the redirect (the provider only returns `state`). */
export interface PendingAdsOAuth {
  readonly site_id: string;
  readonly platform: AdPlatform;
}

const oauthKey = (state: string) => `amable.analytics.ads-oauth.${state}`;

export function rememberAdsOAuth(state: string, pending: PendingAdsOAuth): void {
  try {
    sessionStorage.setItem(oauthKey(state), JSON.stringify(pending));
  } catch {
    // Storage disabled: the redirect page reports the flow as expired.
  }
}

/** One-time read of a pending flow. */
export function takeAdsOAuth(state: string): PendingAdsOAuth | null {
  try {
    const raw = sessionStorage.getItem(oauthKey(state));
    sessionStorage.removeItem(oauthKey(state));
    if (raw === null) return null;
    const value = JSON.parse(raw) as Partial<PendingAdsOAuth>;
    return typeof value.site_id === 'string' && typeof value.platform === 'string'
      ? { site_id: value.site_id, platform: value.platform }
      : null;
  } catch {
    return null;
  }
}

/** Workspace slug encoded in an ad OAuth `state` (`<slug>.<random>`). */
export function slugFromAdsState(state: string): string | null {
  const dot = state.indexOf('.');
  const slug = dot > 0 ? state.slice(0, dot) : '';
  return /^[a-z0-9][a-z0-9-]{0,62}$/i.test(slug) ? slug : null;
}

// ------------------------------------------------------------------ query keys

export const funnelKeys = {
  graphs: (tenant: string, siteId: string) => analyticsKeys.site(tenant, siteId, 'funnels-v2'),
  graph: (tenant: string, siteId: string, id: string) =>
    analyticsKeys.site(tenant, siteId, 'funnels-v2', 'graph', id),
  sources: (tenant: string, siteId: string) =>
    analyticsKeys.site(tenant, siteId, 'traffic-sources'),
  ads: (tenant: string, siteId: string) => analyticsKeys.site(tenant, siteId, 'ads-connections'),
  outbound: (tenant: string, siteId: string) => analyticsKeys.site(tenant, siteId, 'outbound'),
};

// ----------------------------------------------------------------------- hooks

export function useFunnelGraphs(tenant: string, siteId: string | null, status: FunnelStatus) {
  return useQuery({
    queryKey: [...funnelKeys.graphs(tenant, siteId ?? ''), 'list', status],
    queryFn: () => funnelsApi(tenant).funnels.list(siteId ?? '', status),
    enabled: siteId !== null,
    retry: false,
  });
}

export function useFunnelGraph(tenant: string, siteId: string | null, id: string) {
  return useQuery({
    queryKey: funnelKeys.graph(tenant, siteId ?? '', id),
    queryFn: () => funnelsApi(tenant).funnels.get(siteId ?? '', id),
    enabled: siteId !== null,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function useFunnelLinks(
  tenant: string,
  siteId: string,
  funnelId: string,
  version: number,
  params: FunnelLinksParams | null,
) {
  return useQuery({
    queryKey: [...funnelKeys.graph(tenant, siteId, funnelId), 'links', version, params],
    queryFn: () => funnelsApi(tenant).funnels.links(siteId, funnelId, params!),
    enabled: params !== null,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useFunnelHeatmap(
  tenant: string,
  siteId: string,
  funnelId: string,
  version: number,
  params: FunnelHeatmapParams | null,
) {
  return useQuery({
    queryKey: [...funnelKeys.graph(tenant, siteId, funnelId), 'heatmap', version, params],
    queryFn: () => funnelsApi(tenant).funnels.heatmap(siteId, funnelId, params!),
    enabled: params !== null,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
  });
}

export function useTrafficSources(
  tenant: string,
  siteId: string | null,
  status?: TrafficSource['status'],
) {
  return useQuery({
    queryKey: [...funnelKeys.sources(tenant, siteId ?? ''), 'list', status ?? 'all'],
    queryFn: () => funnelsApi(tenant).sources.list(siteId ?? '', status),
    enabled: siteId !== null,
    select: (result) => result.data,
    retry: false,
  });
}

export function useTrafficSourceTemplates(tenant: string) {
  return useQuery({
    queryKey: ['analytics', tenant, 'traffic-source-templates'],
    queryFn: () => funnelsApi(tenant).sources.templates(),
    select: (result) => result.data,
    staleTime: Infinity,
    retry: false,
  });
}

export function useAdConnections(tenant: string, siteId: string | null) {
  return useQuery({
    queryKey: funnelKeys.ads(tenant, siteId ?? ''),
    queryFn: () => funnelsApi(tenant).ads.connections(siteId ?? ''),
    enabled: siteId !== null,
    retry: false,
  });
}

export function useOutbound(tenant: string, siteId: string, query: OutboundQuery) {
  return useQuery({
    queryKey: [...funnelKeys.outbound(tenant, siteId), query],
    queryFn: () => funnelsApi(tenant).outbound.list(siteId, query),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
    retry: false,
  });
}

/** AmableCRM pages offered by the builder; an empty list when the pages API is not readable. */
export function useAmablePages(tenant: string) {
  return useQuery({
    queryKey: ['analytics', tenant, 'amable-pages'],
    queryFn: async () => {
      try {
        return (await funnelsApi(tenant).pages()).data;
      } catch (error) {
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return [];
        throw error;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}
