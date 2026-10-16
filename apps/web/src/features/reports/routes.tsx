import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { tenantRoute } from '../../routes/tenant';

/* Reports, report builder and widget dashboards under /t/$tenant, each in its own lazily loaded chunk. */

/** Tenant home page: the default widget dashboard. */
export const homeDashboardRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'dashboard',
  component: lazyRouteComponent(() => import('./pages/home'), 'HomeDashboardPage'),
});

export const reportsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'reports',
  component: lazyRouteComponent(() => import('./pages/reports-catalog'), 'ReportsCatalogPage'),
});

export const reportBuilderRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'reports/builder',
  validateSearch: (search: Record<string, unknown>): { from?: string } =>
    typeof search['from'] === 'string' ? { from: search['from'] } : {},
  component: lazyRouteComponent(() => import('./pages/report-builder'), 'ReportBuilderPage'),
});

export const reportBuilderEditRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'reports/builder/$customId',
  component: lazyRouteComponent(() => import('./pages/report-builder'), 'ReportBuilderPage'),
});

export const dashboardsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'reports/dashboards',
  component: lazyRouteComponent(() => import('./pages/dashboards'), 'DashboardsListPage'),
});

export const dashboardDetailRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'reports/dashboards/$dashboardId',
  component: lazyRouteComponent(() => import('./pages/dashboards'), 'DashboardDetailPage'),
});

export const reportRunRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'reports/$reportId',
  component: lazyRouteComponent(() => import('./pages/report-runner'), 'ReportRunnerPage'),
});

/** Every report route, for `featureRoutes` in the app router. */
export const reportRoutes = [
  homeDashboardRoute,
  reportsRoute,
  reportBuilderRoute,
  reportBuilderEditRoute,
  dashboardsRoute,
  dashboardDetailRoute,
  reportRunRoute,
] as const;
