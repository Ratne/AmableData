import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { tenantRoute } from '../../routes/tenant';

/* Short links under /t/$tenant, in a lazily loaded chunk. */

const shortlinksRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'shortlinks',
  component: lazyRouteComponent(() => import('./pages/shortlinks'), 'ShortlinksPage'),
});

export const shortlinksRoutes = [shortlinksRoute] as const;
