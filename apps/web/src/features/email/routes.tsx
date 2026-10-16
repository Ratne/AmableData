import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { tenantRoute } from '../../routes/tenant';

/* Email pages under /t/$tenant (lazy chunks). Paths matching navigation.ts replace their placeholder. */

export const templatesRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'templates',
  component: lazyRouteComponent(() => import('./pages/templates'), 'TemplatesPage'),
});

export const templateEditorRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'templates/$templateId',
  component: lazyRouteComponent(() => import('./pages/template-editor'), 'TemplateEditorPage'),
});

export const suppressionsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'suppressions',
  component: lazyRouteComponent(() => import('./pages/suppressions'), 'SuppressionsPage'),
});

export const emailSettingsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'settings/email',
  component: lazyRouteComponent(() => import('./pages/email-settings'), 'EmailSettingsPage'),
});

export const emailRoutes = [templatesRoute, templateEditorRoute, suppressionsRoute, emailSettingsRoute] as const;
