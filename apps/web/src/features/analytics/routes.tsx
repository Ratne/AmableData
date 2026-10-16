import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { rootRoute } from '../../routes/root';
import { tenantRoute } from '../../routes/tenant';
import { validateAnalyticsSearch, type AnalyticsSearch } from './lib/query-state';
import { searchString } from './lib/search';

/*
 * Web analytics pages under /t/$tenant/analytics, each in its own lazily
 * loaded chunk, plus the public read-only share page at /share/$token
 * (outside the workspace shell). Site, range, filters and model live in the
 * search params (see lib/query-state.ts) so every view is a shareable link.
 */

export interface FunnelsSearch extends AnalyticsSearch {
  readonly funnel?: string;
}

export const SETTINGS_TABS = [
  'sites',
  'tracking',
  'keys',
  'alerts',
  'sharing',
  'integrations',
  'prediction',
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
}

const str = searchString;

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
  return out;
}

function funnelsSearch(raw: Record<string, unknown>): FunnelsSearch {
  const funnel = str(raw['funnel']);
  return { ...validateAnalyticsSearch(raw), ...(funnel ? { funnel } : {}) };
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

export const analyticsSettingsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'analytics/settings',
  validateSearch: settingsSearch,
  component: lazyRouteComponent(() => import('./pages/settings'), 'AnalyticsSettingsPage'),
});

/** Every workspace analytics route, for `featureRoutes` in the app router. */
export const analyticsRoutes = [
  analyticsDashboardRoute,
  analyticsRealtimeRoute,
  analyticsInsightsRoute,
  analyticsVisitorsRoute,
  analyticsVisitorRoute,
  analyticsFunnelsRoute,
  analyticsSettingsRoute,
] as const;

/** Public read-only dashboard of a share link, attached to the root route (no shell, no auth). */
export const analyticsShareRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'share/$token',
  component: lazyRouteComponent(() => import('./pages/public-share'), 'PublicSharePage'),
});

/** Root-level analytics routes (outside the workspace shell). */
export const analyticsPublicRoutes = [analyticsShareRoute] as const;
