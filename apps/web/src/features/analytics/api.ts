import type {
  AdsReport,
  Alert,
  AnalyticsBreakdown,
  AnalyticsBreakdownDimension,
  AnalyticsFilter,
  AnalyticsInsights,
  AnalyticsInterval,
  AnalyticsOverview,
  AnalyticsPurchases,
  AnalyticsRealtime,
  AnalyticsTimeseries,
  AttributionDimension,
  AttributionModel,
  AttributionReport,
  BotsReport,
  ContactJourney,
  CrawlerSnippets,
  CreateAlertInput,
  CreateFunnelInput,
  CreateSiteInput,
  Funnel,
  FunnelResult,
  InstallCheck,
  Integration,
  IntegrationProvider,
  PredictionModelInfo,
  PublicShareInfo,
  SearchConsoleReport,
  Segment,
  Share,
  Site,
  SiteKey,
  SiteKeyScope,
  SiteSnippet,
  SiteWithSecret,
  UpdateAlertInput,
  UpdateFunnelInput,
  UpdateSiteInput,
  VisitorProfile,
  VisitorsList,
} from '@amable/api-types';
import type { MessageKey } from '@amable/i18n';
import { toast } from '@amable/ui';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import { useI18n } from '../../i18n';
import { ApiError, apiFetch } from '../../lib/api';

/*
 * Client of the analytics REST surface (`/api/v2/t/{slug}/analytics`) and of
 * the public share endpoints (`/api/public/analytics/{token}`), with the
 * react-query hooks of every page. Reports take an `AnalyticsSource` so the
 * same components render inside a workspace and on a public share link.
 */

export type AnalyticsSource =
  | { readonly kind: 'tenant'; readonly tenant: string; readonly siteId: string }
  | { readonly kind: 'public'; readonly token: string };

/** Range + filters of a report query. */
export interface AnalyticsQuery {
  readonly from: string;
  readonly to: string;
  readonly timezone?: string;
  readonly filters: readonly AnalyticsFilter[];
}

type Params = Readonly<Record<string, string | number | boolean | null | undefined>>;

const enc = encodeURIComponent;

export function tenantBase(tenant: string): string {
  return `/api/v2/t/${enc(tenant)}/analytics`;
}

function sourceBase(source: AnalyticsSource): string {
  return source.kind === 'tenant'
    ? tenantBase(source.tenant)
    : `/api/public/analytics/${enc(source.token)}`;
}

export function sourceKey(source: AnalyticsSource): string {
  return source.kind === 'tenant' ? `${source.tenant}:${source.siteId}` : `public:${source.token}`;
}

function filterValue(filter: AnalyticsFilter): string {
  if (filter.op === 'is_not') return `!${filter.value}`;
  if (filter.op === 'contains') return `~${filter.value}`;
  return filter.value;
}

function buildSearch(params: Params, query?: AnalyticsQuery): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  if (query) {
    search.set('from', query.from);
    search.set('to', query.to);
    if (query.timezone) search.set('timezone', query.timezone);
    for (const filter of query.filters)
      search.append(`filter_${filter.dimension}`, filterValue(filter));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export function reportUrl(
  source: AnalyticsSource,
  path: string,
  params: Params = {},
  query?: AnalyticsQuery,
): string {
  const scoped = source.kind === 'tenant' ? { site_id: source.siteId, ...params } : params;
  return `${sourceBase(source)}/${path}${buildSearch(scoped, query)}`;
}

/** WebSocket URL of the realtime feed (same origin, ws/wss from the page). */
export function realtimeSocketUrl(source: AnalyticsSource): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}${reportUrl(source, 'realtime/ws')}`;
}

function siteUrl(tenant: string, siteId: string, path: string, params: Params = {}): string {
  return `${tenantBase(tenant)}/${path}${buildSearch({ site_id: siteId, ...params })}`;
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });
const post = (body: unknown = {}): RequestInit => ({ method: 'POST', ...json(body) });
const patch = (body: unknown): RequestInit => ({ method: 'PATCH', ...json(body) });
const del: RequestInit = { method: 'DELETE' };

// ------------------------------------------------------------------ query keys

export const analyticsKeys = {
  root: (scope: string) => ['analytics', scope] as const,
  sites: (tenant: string) => ['analytics', tenant, 'sites'] as const,
  report: (source: AnalyticsSource, name: string, ...rest: unknown[]) =>
    [
      'analytics',
      source.kind === 'tenant' ? source.tenant : `public:${source.token}`,
      'report',
      sourceKey(source),
      name,
      ...rest,
    ] as const,
  site: (tenant: string, siteId: string, name: string, ...rest: unknown[]) =>
    ['analytics', tenant, 'site', siteId, name, ...rest] as const,
  journey: (tenant: string, contactId: string) =>
    ['analytics', tenant, 'journey', contactId] as const,
};

// ------------------------------------------------------------------ error text

export function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

type Translate = (key: MessageKey, vars?: Readonly<Record<string, string | number>>) => string;

export function analyticsErrorMessage(t: Translate, error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return t('analytics.error.session');
    if (error.status === 403) return t('analytics.error.forbidden');
    if (error.status === 404) return t('analytics.error.notFound');
    if (error.status === 422) return t('analytics.error.validation');
    if (error.status === 503 || error.code === 'analytics_unavailable')
      return t('analytics.error.unavailable');
  }
  return t('analytics.error.generic');
}

// --------------------------------------------------------------------- reports

const REPORT_STALE_MS = 30_000;

export function useSites(tenant: string) {
  return useQuery({
    queryKey: analyticsKeys.sites(tenant),
    queryFn: () => apiFetch<{ data: Site[] }>(`${tenantBase(tenant)}/sites`),
    select: (result) => result.data,
    staleTime: 60_000,
    retry: false,
  });
}

function useReport<T>(
  source: AnalyticsSource | null,
  name: string,
  url: (source: AnalyticsSource) => string,
  keyParts: unknown[],
  options: { refetchInterval?: number | false; enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: source
      ? analyticsKeys.report(source, name, ...keyParts)
      : ['analytics', 'none', name],
    queryFn: () => apiFetch<T>(url(source!)),
    enabled: source !== null && options.enabled !== false,
    staleTime: REPORT_STALE_MS,
    placeholderData: keepPreviousData,
    refetchInterval: options.refetchInterval,
    retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
  });
}

export function useOverview(source: AnalyticsSource | null, query: AnalyticsQuery, enabled = true) {
  return useReport<AnalyticsOverview>(
    source,
    'overview',
    (s) => reportUrl(s, 'overview', {}, query),
    [query],
    { enabled },
  );
}

export function useTimeseries(
  source: AnalyticsSource | null,
  query: AnalyticsQuery,
  interval: AnalyticsInterval,
) {
  return useReport<AnalyticsTimeseries>(
    source,
    'timeseries',
    (s) => reportUrl(s, 'timeseries', { interval }, query),
    [query, interval],
  );
}

export function useBreakdown(
  source: AnalyticsSource | null,
  query: AnalyticsQuery,
  dimension: AnalyticsBreakdownDimension,
  options: { model?: AttributionModel; limit?: number; enabled?: boolean } = {},
) {
  const limit = options.limit ?? 10;
  return useReport<AnalyticsBreakdown>(
    source,
    'breakdown',
    (s) => reportUrl(s, `breakdown/${dimension}`, { limit, model: options.model }, query),
    [dimension, query, options.model, limit],
    { enabled: options.enabled },
  );
}

export function useAttribution(
  source: AnalyticsSource | null,
  query: AnalyticsQuery,
  dimension: AttributionDimension,
) {
  return useReport<AttributionReport>(
    source?.kind === 'tenant' ? source : null,
    'attribution',
    (s) => reportUrl(s, 'attribution', { dimension, limit: 8 }, query),
    [dimension, query],
  );
}

export function usePurchases(source: AnalyticsSource | null, query: AnalyticsQuery) {
  return useReport<AnalyticsPurchases>(
    source?.kind === 'tenant' ? source : null,
    'purchases',
    (s) => reportUrl(s, 'purchases', { limit: 200 }, query),
    [query],
  );
}

export function useRealtimeSnapshot(
  source: AnalyticsSource | null,
  options: { refetchInterval?: number | false; enabled?: boolean } = {},
) {
  return useReport<AnalyticsRealtime>(
    source,
    'realtime',
    (s) => reportUrl(s, 'realtime'),
    [],
    options,
  );
}

export function useInsights(
  source: AnalyticsSource | null,
  query: AnalyticsQuery,
  interval: 'week' | 'month',
) {
  return useReport<AnalyticsInsights>(
    source,
    'insights',
    (s) => reportUrl(s, 'insights', { interval }, query),
    [query, interval],
  );
}

export function useBots(source: AnalyticsSource | null, query: AnalyticsQuery) {
  return useReport<BotsReport>(
    source?.kind === 'tenant' ? source : null,
    'bots',
    (s) => reportUrl(s, 'bots', {}, query),
    [query],
  );
}

export function useAdsReport(
  source: AnalyticsSource | null,
  query: AnalyticsQuery,
  enabled: boolean,
) {
  return useReport<AdsReport>(
    source,
    'ads',
    (s) => reportUrl(s, 'ads', {}, { ...query, filters: [] }),
    [query.from, query.to],
    {
      enabled,
    },
  );
}

export function useSearchConsoleReport(
  source: AnalyticsSource | null,
  query: AnalyticsQuery,
  enabled: boolean,
) {
  return useReport<SearchConsoleReport>(
    source,
    'search-console',
    (s) => reportUrl(s, 'search-console', {}, { ...query, filters: [] }),
    [query.from, query.to],
    { enabled },
  );
}

// -------------------------------------------------------------------- visitors

export interface VisitorsParams {
  readonly q?: string;
  readonly identified?: 'true' | 'false';
  readonly customers?: 'true' | 'false';
  readonly sort: 'last_seen' | 'revenue' | 'score' | 'sessions';
}

export function useVisitors(
  source: AnalyticsSource | null,
  query: AnalyticsQuery,
  params: VisitorsParams,
) {
  return useInfiniteQuery({
    queryKey: source
      ? analyticsKeys.report(source, 'visitors', query, params)
      : ['analytics', 'none', 'visitors'],
    queryFn: ({ pageParam }) =>
      apiFetch<VisitorsList>(
        reportUrl(
          source!,
          'visitors',
          { ...params, limit: 50, cursor: pageParam ?? undefined },
          query,
        ),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    enabled: source?.kind === 'tenant',
    staleTime: REPORT_STALE_MS,
    retry: false,
  });
}

export function useVisitorProfile(tenant: string, siteId: string | null, visitorId: string) {
  return useQuery({
    queryKey: analyticsKeys.site(tenant, siteId ?? '', 'visitor', visitorId),
    queryFn: () =>
      apiFetch<VisitorProfile>(siteUrl(tenant, siteId ?? '', `visitors/${enc(visitorId)}`)),
    enabled: siteId !== null,
    retry: false,
  });
}

export function useContactJourney(tenant: string, contactId: string, limit = 100) {
  return useQuery({
    queryKey: analyticsKeys.journey(tenant, contactId),
    queryFn: () =>
      apiFetch<ContactJourney>(
        `${tenantBase(tenant)}/contacts/${enc(contactId)}/journey${buildSearch({ limit })}`,
      ),
    staleTime: 60_000,
    retry: false,
  });
}

// ---------------------------------------------------------- per-site resources

function useSiteResource<T>(
  tenant: string,
  siteId: string | null,
  name: string,
  path: string,
  options: { enabled?: boolean; params?: Params } = {},
) {
  return useQuery({
    queryKey: analyticsKeys.site(tenant, siteId ?? '', name, options.params ?? {}),
    queryFn: () => apiFetch<T>(siteUrl(tenant, siteId ?? '', path, options.params)),
    enabled: siteId !== null && options.enabled !== false,
    staleTime: 30_000,
    retry: false,
  });
}

export const useFunnels = (tenant: string, siteId: string | null) =>
  useSiteResource<{ data: Funnel[] }>(tenant, siteId, 'funnels', 'funnels');

export function useFunnelResult(
  tenant: string,
  siteId: string | null,
  funnelId: string | null,
  query: AnalyticsQuery,
) {
  return useQuery({
    queryKey: analyticsKeys.site(tenant, siteId ?? '', 'funnels', 'result', funnelId, query),
    queryFn: () =>
      apiFetch<FunnelResult>(
        `${tenantBase(tenant)}/funnels/${enc(funnelId ?? '')}/results${buildSearch({ site_id: siteId }, query)}`,
      ),
    enabled: siteId !== null && funnelId !== null,
    placeholderData: keepPreviousData,
    staleTime: REPORT_STALE_MS,
    retry: false,
  });
}

export const useSegments = (tenant: string, siteId: string | null) =>
  useSiteResource<{ data: Segment[] }>(tenant, siteId, 'segments', 'segments');
export const useAlerts = (tenant: string, siteId: string | null) =>
  useSiteResource<{ data: Alert[] }>(tenant, siteId, 'alerts', 'alerts');
export const useShares = (tenant: string, siteId: string | null) =>
  useSiteResource<{ data: Share[] }>(tenant, siteId, 'shares', 'shares');
export const useIntegrations = (tenant: string, siteId: string | null) =>
  useSiteResource<{ data: Integration[] }>(tenant, siteId, 'integrations', 'integrations');
export const usePrediction = (tenant: string, siteId: string | null) =>
  useSiteResource<PredictionModelInfo>(tenant, siteId, 'prediction', 'prediction');

function useSiteSub<T>(tenant: string, siteId: string | null, name: string) {
  return useQuery({
    queryKey: analyticsKeys.site(tenant, siteId ?? '', name),
    queryFn: () => apiFetch<T>(`${tenantBase(tenant)}/sites/${enc(siteId ?? '')}/${name}`),
    enabled: siteId !== null,
    retry: false,
  });
}

export const useSnippet = (tenant: string, siteId: string | null) =>
  useSiteSub<SiteSnippet>(tenant, siteId, 'snippet');
export const useInstallCheck = (tenant: string, siteId: string | null) =>
  useSiteSub<InstallCheck>(tenant, siteId, 'install-check');
export const useCrawlerSnippets = (tenant: string, siteId: string | null) =>
  useSiteSub<CrawlerSnippets>(tenant, siteId, 'crawler-snippets');
export const useSiteKeys = (tenant: string, siteId: string | null) =>
  useSiteSub<{ data: SiteKey[] }>(tenant, siteId, 'keys');

export function usePublicShareInfo(token: string) {
  return useQuery({
    queryKey: ['analytics', `public:${token}`, 'info'],
    queryFn: () => apiFetch<PublicShareInfo>(`/api/public/analytics/${enc(token)}`),
    retry: false,
    staleTime: 5 * 60_000,
  });
}

// ------------------------------------------------------------------- mutations

/** Calls of the configuration endpoints (sites, keys, funnels, …). */
export function analyticsApi(tenant: string) {
  const base = tenantBase(tenant);
  const sited = (siteId: string, path: string) =>
    `${base}/${path}${buildSearch({ site_id: siteId })}`;
  return {
    sites: {
      create: (input: Partial<CreateSiteInput> & Pick<CreateSiteInput, 'name' | 'hostnames'>) =>
        apiFetch<SiteWithSecret>(`${base}/sites`, post(input)),
      update: (id: string, input: UpdateSiteInput) =>
        apiFetch<Site>(`${base}/sites/${enc(id)}`, patch(input)),
      remove: (id: string) => apiFetch<unknown>(`${base}/sites/${enc(id)}`, del),
      rollSecret: (id: string) =>
        apiFetch<{ secret: string }>(`${base}/sites/${enc(id)}/secret`, post()),
      createKey: (id: string, input: { name: string; scopes: SiteKeyScope[] }) =>
        apiFetch<{ key: SiteKey; secret: string }>(`${base}/sites/${enc(id)}/keys`, post(input)),
      revokeKey: (id: string, keyId: string) =>
        apiFetch<unknown>(`${base}/sites/${enc(id)}/keys/${enc(keyId)}`, del),
    },
    funnels: {
      create: (siteId: string, input: CreateFunnelInput) =>
        apiFetch<Funnel>(sited(siteId, 'funnels'), post(input)),
      update: (siteId: string, id: string, input: UpdateFunnelInput) =>
        apiFetch<Funnel>(sited(siteId, `funnels/${enc(id)}`), patch(input)),
      remove: (siteId: string, id: string) =>
        apiFetch<unknown>(sited(siteId, `funnels/${enc(id)}`), del),
    },
    segments: {
      create: (siteId: string, input: { name: string; filters: AnalyticsFilter[] }) =>
        apiFetch<Segment>(sited(siteId, 'segments'), post(input)),
      remove: (siteId: string, id: string) =>
        apiFetch<unknown>(sited(siteId, `segments/${enc(id)}`), del),
    },
    alerts: {
      create: (
        siteId: string,
        input: Partial<CreateAlertInput> & Pick<CreateAlertInput, 'name' | 'goal'>,
      ) =>
        apiFetch<{ alert: Alert; webhook_secret: string | null }>(
          sited(siteId, 'alerts'),
          post(input),
        ),
      update: (siteId: string, id: string, input: UpdateAlertInput) =>
        apiFetch<{ alert: Alert; webhook_secret: string | null }>(
          sited(siteId, `alerts/${enc(id)}`),
          patch(input),
        ),
      remove: (siteId: string, id: string) =>
        apiFetch<unknown>(sited(siteId, `alerts/${enc(id)}`), del),
      test: (siteId: string, id: string) =>
        apiFetch<{ queued: true }>(sited(siteId, `alerts/${enc(id)}/test`), post()),
      rotateSecret: (siteId: string, id: string) =>
        apiFetch<{ alert: Alert; webhook_secret: string }>(
          sited(siteId, `alerts/${enc(id)}/webhook-secret`),
          post(),
        ),
    },
    shares: {
      create: (siteId: string, name: string) =>
        apiFetch<Share>(sited(siteId, 'shares'), post({ name })),
      revoke: (siteId: string, id: string) =>
        apiFetch<unknown>(sited(siteId, `shares/${enc(id)}`), del),
    },
    integrations: {
      connect: (siteId: string, provider: IntegrationProvider) =>
        apiFetch<{ authorize_url: string }>(
          sited(siteId, `integrations/${provider}/connect`),
          post(),
        ),
      callback: (
        siteId: string,
        provider: IntegrationProvider,
        input: { state: string; code: string },
      ) => apiFetch<Integration>(sited(siteId, `integrations/${provider}/callback`), post(input)),
      sync: (siteId: string, provider: IntegrationProvider) =>
        apiFetch<Integration>(sited(siteId, `integrations/${provider}/sync`), post()),
      disconnect: (siteId: string, provider: IntegrationProvider) =>
        apiFetch<unknown>(sited(siteId, `integrations/${provider}`), del),
    },
    prediction: {
      train: (siteId: string) =>
        apiFetch<PredictionModelInfo>(sited(siteId, 'prediction/train'), post()),
    },
  };
}

export type AnalyticsApi = ReturnType<typeof analyticsApi>;

/** Mutation that toasts failures and refreshes the analytics queries of the tenant. */
export function useAnalyticsMutation<TVariables, TResult>(
  tenant: string,
  mutationFn: (variables: TVariables) => Promise<TResult>,
  options: {
    invalidate?: QueryKey[];
    success?: MessageKey;
    onSuccess?: (result: TResult, variables: TVariables) => void;
    /** Returning true silences the error toast (e.g. a step-up dialog took over). */
    onError?: (error: unknown, variables: TVariables) => boolean | void;
  } = {},
) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: async (result, variables) => {
      options.onSuccess?.(result, variables);
      if (options.success) toast.success(t(options.success));
      await Promise.all(
        (options.invalidate ?? [analyticsKeys.root(tenant)]).map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      );
    },
    onError: (error, variables) => {
      if (options.onError?.(error, variables) === true) return;
      toast.error(analyticsErrorMessage(t, error));
    },
  });
}
