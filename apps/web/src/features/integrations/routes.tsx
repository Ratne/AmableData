import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { tenantRoute } from '../../routes/tenant';

export const integrationsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'settings/integrations',
  component: lazyRouteComponent(() => import('./pages/integrations'), 'IntegrationsPage'),
});

export const integrationsRoutes = [integrationsRoute] as const;
