import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { rootRoute } from '../../routes/root';
import { tenantRoute } from '../../routes/tenant';
import { validateAppDetailSearch, validateAuthorizeSearch } from './search';

/* Settings → Apps (marketplace, app detail and consent, installed apps). */

const marketplaceRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'settings/apps',
  component: lazyRouteComponent(() => import('./pages/marketplace'), 'MarketplacePage'),
});

const installedRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'settings/apps/installed',
  component: lazyRouteComponent(() => import('./pages/installed'), 'InstalledAppsPage'),
});

const appDetailRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'settings/apps/$appId',
  validateSearch: validateAppDetailSearch,
  component: lazyRouteComponent(() => import('./pages/app-detail'), 'AppDetailPage'),
});

/** `app.page` and `app.settings` screens of installed apps. */
const appScreenRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'apps/$appId/$screenKey',
  component: lazyRouteComponent(() => import('./slots'), 'AppScreenPage'),
});

export const appsRoutes = [marketplaceRoute, installedRoute, appDetailRoute, appScreenRoute] as const;

export const appsPublicRoutes = [
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/apps/authorize',
    validateSearch: validateAuthorizeSearch,
    component: lazyRouteComponent(() => import('./pages/authorize'), 'AuthorizeAppPage'),
  }),
] as const;
