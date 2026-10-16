import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { tenantRoute } from '../../routes/tenant';

export const membersRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'settings/members',
  component: lazyRouteComponent(() => import('./pages/members'), 'MembersPage'),
});

export const membersRoutes = [membersRoute] as const;
