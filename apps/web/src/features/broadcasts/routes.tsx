import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { tenantRoute } from '../../routes/tenant';

/* Broadcast pages under /t/$tenant (lazy chunks): list, then composer (draft) or report. */

const broadcastsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'broadcasts',
  component: lazyRouteComponent(() => import('./pages/broadcasts-list'), 'BroadcastsListPage'),
});

const broadcastDetailRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'broadcasts/$broadcastId',
  component: lazyRouteComponent(() => import('./pages/broadcast-detail'), 'BroadcastDetailPage'),
});

export const broadcastRoutes = [broadcastsRoute, broadcastDetailRoute] as const;
