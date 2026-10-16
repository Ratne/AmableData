import { createRoute, lazyRouteComponent, redirect } from '@tanstack/react-router';
import { tenantRoute } from '../../routes/tenant';

/*
 * Landing pages under /t/$tenant, each in a lazily loaded chunk.
 * `landing-pages` replaces the navigation placeholder.
 */

export const landingListRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'landing-pages',
  component: lazyRouteComponent(() => import('./pages/pages-list'), 'PagesListPage'),
});

export const landingPageRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'landing-pages/$pageId',
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/t/$tenant/landing-pages/$pageId/edit', params });
  },
});

export const landingEditorRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'landing-pages/$pageId/edit',
  staticData: { immersive: true },
  component: lazyRouteComponent(() => import('./pages/canvas-editor'), 'CanvasEditorPage'),
});

export const landingSettingsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'landing-pages/$pageId/settings',
  component: lazyRouteComponent(() => import('./pages/page-settings'), 'PageSettingsPage'),
});

export const landingRoutes = [landingListRoute, landingPageRoute, landingEditorRoute, landingSettingsRoute] as const;
