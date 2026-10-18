import { HEATMAP_METRICS, type HeatmapMetric } from '@amable/api-types';
import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { rootRoute } from '../../routes/root';
import { tenantRoute } from '../../routes/tenant';
import { validateAnalyticsSearch, type AnalyticsSearch } from './lib/query-state';
import { searchString } from './lib/search';
import {
  validateCohortSearch,
  validateJourneySearch,
  validateLtvSearch,
  validatePerformanceSearch,
} from './reports-ads/search';

/*
 * Web analytics pages under /t/$tenant/analytics, each in its own lazily
 * loaded chunk, plus the public read-only share page at /share/$token
 * (outside the workspace shell). Site, range, filters and model live in the
 * search params (see lib/query-state.ts) so every view is a shareable link.
 */

export interface FunnelsSearch extends AnalyticsSearch {
  readonly funnel?: string;
}

export interface FunnelBuilderSearch extends AnalyticsSearch {
  /** Heatmap overlay metric; absent = heatmap off. */
  readonly heatmap?: HeatmapMetric;
  /** `1` highlights the paths through the selected node. */
  readonly trace?: '1';
}

export const SETTINGS_TABS = [
  'sites',
  'tracking',
  'keys',
  'alerts',
  'sharing',
  'integrations',
  'prediction',
  'domains',
  'ads',
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export interface SettingsSearch extends AnalyticsSearch {
  readonly tab?: SettingsTab;
  /** `1` opens the create-site dialog. */
  readonly create?: string;
  /** OAuth return of an integration (`?integration=<provider>&state=…&code=…`). */
  readonly integration?: string;
  readonly state?: string;
  readonly code?: string;
  /** Ad platform of an OAuth return on the `ads` tab (dev fake provider). */
  readonly platform?: string;
}

/** Query of the fixed OAuth redirect page of the ad platforms. */
export interface AdsOAuthSearch {
  readonly state?: string;
  readonly code?: string;
  readonly error?: string;
}

const str = searchString;

function adsOAuthSearch(raw: Record<string, unknown>): AdsOAuthSearch {
  const state = str(raw['state']);
  const code = str(raw['code']);
  const error = str(raw['error']);
  return {
    ...(state ? { state } : {}),
    ...(code ? { code } : {}),
    ...(error ? { error } : {}),
  };
}

function settingsSearch(raw: Record<string, unknown>): SettingsSearch {
  const tab = raw['tab'];
  const base = validateAnalyticsSearch(raw);
  const out: { -readonly [K in keyof SettingsSearch]: SettingsSearch[K] } = { ...base };
  if (typeof tab === 'string' && (SETTINGS_TABS as readonly string[]).includes(tab))
    out.tab = tab as SettingsTab;
  const create = str(raw['create']);
  const integration = str(raw['integration']);
  const state = str(raw['state']);
  const code = str(raw['code']);
  if (create) out.create = create;
  if (integration) out.integration = integration;
  if (state) out.state = state;
  if (code) out.code = code;
  const platform = str(raw['platform']);
  if (platform) out.platform = platform;
  return out;
}

function funnelsSearch(raw: Record<string, unknown>): FunnelsSearch {
  const funnel = str(raw['funnel']);
  return { ...validateAnalyticsSearch(raw), ...(funnel ? { funnel } : {}) };
}

function funnelBuilderSearch(raw: Record<string, unknown>): FunnelBuilderSearch {
  const heatmap = raw['heatmap'];
  return {
    ...validateAnalyticsSearch(raw),
    ...(typeof heatmap === 'string' && (HEATMAP_METRICS as readonly string[]).includes(heatmap)
      ? { heatmap: heatmap as HeatmapMetric }
      : {}),
    ...(str(raw['trace']) === '1' ? { trace: '1' as const } : {}),
  };
}

export const analyticsDashboardRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'analytics',
  validateSearch: validateAnalyticsSearch,
  component: lazyRouteComponent(() => import('./pages/dashboard'), 'AnalyticsDashboardPage'),
});

export const analyticsRealtimeRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'analytics/realtime',
  validateSearch: validateAnalyticsSearch,
  component: lazyRouteComponent(() => import('./pages/realtime'), 'AnalyticsRealtimePage'),
});

export const analyticsInsightsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'analytics/insights',
  validateSearch: validateAnalyticsSearch,
  component: lazyRouteComponent(() => import('./pages/insights'), 'AnalyticsInsightsPage'),
});

export const analyticsVisitorsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'analytics/visitors',
  validateSearch: validateAnalyticsSearch,
  component: lazyRouteComponent(() => import('./pages/visitors'), 'AnalyticsVisitorsPage'),
});

export const analyticsVisitorRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'analytics/visitors/$visitorId',
  validateSearch: validateAnalyticsSearch,
  component: lazyRouteComponent(() => import('./pages/visitor-profile'), 'AnalyticsVisitorPage'),
});

export const analyticsFunnelsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'analytics/funnels',
  validateSearch: funnelsSearch,
  component: lazyRouteComponent(() => import('./pages/funnels'), 'AnalyticsFunnelsPage'),
});

export const analyticsFunnelBuilderRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'analytics/funnels/$funnelId/builder',
  validateSearch: funnelBuilderSearch,
  component: lazyRouteComponent(
    () => import('./pages/funnel-builder'),
    'AnalyticsFunnelBuilderPage',
  ),
});

export const analyticsPerformanceRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'analytics/performance',
  validateSearch: validatePerformanceSearch,
  component: lazyRouteComponent(() => import('./pages/performance'), 'AnalyticsPerformancePage'),
});

export const analyticsLtvRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'analytics/ltv',
  validateSearch: validateLtvSearch,
  component: lazyRouteComponent(() => import('./pages/ltv'), 'AnalyticsLtvPage'),
});

export const analyticsCohortsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'analytics/cohorts',
  validateSearch: validateCohortSearch,
  component: lazyRouteComponent(() => import('./pages/cohorts'), 'AnalyticsCohortsPage'),
});

export const analyticsJourneysRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'analytics/journeys',
  validateSearch: validateJourneySearch,
  component: lazyRouteComponent(() => import('./pages/journeys'), 'AnalyticsJourneysPage'),
});

export const analyticsSourcesRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'analytics/sources',
  validateSearch: validateAnalyticsSearch,
  component: lazyRouteComponent(() => import('./pages/sources'), 'AnalyticsSourcesPage'),
});

export const analyticsSettingsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'analytics/settings',
  validateSearch: settingsSearch,
  component: lazyRouteComponent(() => import('./pages/settings'), 'AnalyticsSettingsPage'),
});

export const analyticsFunnelsV2Route = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'analytics/funnels-v2',
  validateSearch: validateAnalyticsSearch,
  component: lazyRouteComponent(() => import('./pages/funnels-v2'), 'AnalyticsFunnelsV2Page'),
});

/** Every workspace analytics route, for `featureRoutes` in the app router. */
export const analyticsRoutes = [
  analyticsDashboardRoute,
  analyticsRealtimeRoute,
  analyticsInsightsRoute,
  analyticsVisitorsRoute,
  analyticsVisitorRoute,
  analyticsFunnelsRoute,
  analyticsFunnelBuilderRoute,
  analyticsPerformanceRoute,
  analyticsLtvRoute,
  analyticsCohortsRoute,
  analyticsJourneysRoute,
  analyticsSourcesRoute,
  analyticsSettingsRoute,
  analyticsFunnelsV2Route,
] as const;

/** Public read-only dashboard of a share link, attached to the root route (no shell, no auth). */
export const analyticsShareRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'share/$token',
  component: lazyRouteComponent(() => import('./pages/public-share'), 'PublicSharePage'),
});

/** Fixed OAuth redirect of the ad platforms; the workspace slug is the prefix of `state`. */
export const analyticsAdsOAuthRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'oauth/ads/callback',
  validateSearch: adsOAuthSearch,
  component: lazyRouteComponent(() => import('./pages/ads-oauth-callback'), 'AdsOAuthCallbackPage'),
});

/** Root-level analytics routes (outside the workspace shell). */
export const analyticsPublicRoutes = [analyticsShareRoute, analyticsAdsOAuthRoute] as const;
