import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { rootRoute } from '../../routes/root';
import { tenantRoute } from '../../routes/tenant';

/*
 * Support tickets + assisted access (/t/$tenant/support), ideas board +
 * changelog (/t/$tenant/ideas), and the public assisted-access entry
 * (/support-access, reached through /api/platform/assist/enter#token=…).
 */

export const supportRoutes = [
  createRoute({
    getParentRoute: () => tenantRoute,
    path: 'support',
    component: lazyRouteComponent(() => import('./support-page'), 'SupportPage'),
  }),
  createRoute({
    getParentRoute: () => tenantRoute,
    path: 'ideas',
    component: lazyRouteComponent(() => import('./ideas-page'), 'IdeasPage'),
  }),
] as const;

export const supportPublicRoutes = [
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/support-access',
    component: lazyRouteComponent(() => import('./enter-page'), 'AssistEnterPage'),
  }),
] as const;
