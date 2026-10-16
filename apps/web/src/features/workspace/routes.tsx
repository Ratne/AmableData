import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { tenantRoute } from '../../routes/tenant';

export const generalSettingsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'settings',
  component: lazyRouteComponent(() => import('./pages/general'), 'GeneralSettingsPage'),
});

export const workspaceRoutes = [generalSettingsRoute] as const;
