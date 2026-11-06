import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { tenantRoute } from '../../routes/tenant';

/*
 * Electronic signature pages under /t/$tenant, each in a lazily loaded chunk:
 * requests sent for signature, templates and the template editor.
 */

const esignRequestsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'signatures',
  component: lazyRouteComponent(() => import('./pages/requests-list'), 'EsignRequestsPage'),
});

const esignTemplatesRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'signatures/templates',
  component: lazyRouteComponent(() => import('./pages/templates-list'), 'EsignTemplatesPage'),
});

const esignTemplateRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'signatures/templates/$templateId',
  component: lazyRouteComponent(() => import('./pages/template-editor'), 'EsignTemplateEditorPage'),
});

const esignRequestRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'signatures/$requestId',
  component: lazyRouteComponent(() => import('./pages/request-detail'), 'EsignRequestDetailPage'),
});

export const esignRoutes = [esignRequestsRoute, esignTemplatesRoute, esignTemplateRoute, esignRequestRoute] as const;
