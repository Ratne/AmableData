import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { tenantRoute } from '../../routes/tenant';

const billingRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'settings/billing',
  component: lazyRouteComponent(() => import('./pages/billing'), 'BillingPage'),
});

export const billingRoutes = [billingRoute] as const;
