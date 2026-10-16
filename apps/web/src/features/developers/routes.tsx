import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { rootRoute } from '../../routes/root';
import { tenantRoute } from '../../routes/tenant';

/* Settings → Developers (API keys, webhooks, API reference) and Domains. */

const apiKeysRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'settings/api-keys',
  component: lazyRouteComponent(() => import('./pages/api-keys'), 'ApiKeysPage'),
});

const webhooksRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'settings/webhooks',
  component: lazyRouteComponent(() => import('./pages/webhooks'), 'WebhooksPage'),
});

const apiDocsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'settings/api-docs',
  component: lazyRouteComponent(() => import('./pages/api-docs'), 'ApiDocsPage'),
});

const domainsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'settings/domains',
  component: lazyRouteComponent(() => import('./pages/domains'), 'DomainsPage'),
});

export const developerRoutes = [apiKeysRoute, webhooksRoute, apiDocsRoute, domainsRoute] as const;

export const developerPublicRoutes = [
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/docs/api',
    component: lazyRouteComponent(() => import('./pages/api-docs'), 'PublicApiDocsPage'),
  }),
] as const;
