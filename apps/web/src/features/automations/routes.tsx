import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { tenantRoute } from '../../routes/tenant';

/* Automation builder pages under /t/$tenant, each in its own lazily loaded chunk. */

export const automationsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'automations',
  component: lazyRouteComponent(() => import('./pages/automations-list'), 'AutomationsListPage'),
});

export const automationEditorRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'automations/$automationId',
  staticData: { immersive: true },
  component: lazyRouteComponent(() => import('./pages/automation-editor'), 'AutomationEditorPage'),
});

/** Every automation route, for `featureRoutes` in the app router. */
export const automationRoutes = [automationsRoute, automationEditorRoute] as const;
