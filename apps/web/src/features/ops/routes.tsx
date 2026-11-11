import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { tenantRoute } from '../../routes/tenant';

/* Settings > Operations under /t/$tenant (lazy chunk). The path matches navigation.ts. */

const opsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'settings/operations',
  component: lazyRouteComponent(() => import('./pages/ops'), 'OpsPage'),
});

export const opsRoutes = [opsRoute] as const;
