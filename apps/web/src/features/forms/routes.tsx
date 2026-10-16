import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { tenantRoute } from '../../routes/tenant';

/*
 * Forms pages under /t/$tenant, each in a lazily loaded chunk. `forms`
 * replaces the navigation placeholder.
 */

export const formsListRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'forms',
  component: lazyRouteComponent(() => import('./pages/forms-list'), 'FormsListPage'),
});

export const formBuilderRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'forms/$formId',
  component: lazyRouteComponent(() => import('./pages/form-builder'), 'FormBuilderPage'),
});

export const formSubmissionsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'forms/$formId/submissions',
  validateSearch: (search: Record<string, unknown>): { submission?: string } =>
    typeof search['submission'] === 'string' && search['submission'] !== '' ? { submission: search['submission'] } : {},
  component: lazyRouteComponent(() => import('./pages/submissions'), 'SubmissionsPage'),
});

export const formConnectionsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'forms/$formId/connections',
  component: lazyRouteComponent(() => import('./pages/connections'), 'ConnectionsPage'),
});

export const formsRoutes = [formsListRoute, formBuilderRoute, formSubmissionsRoute, formConnectionsRoute] as const;
