import {
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
  useNavigate,
} from '@tanstack/react-router';
import { useEffect } from 'react';
import { analyticsPublicRoutes, analyticsRoutes } from './features/analytics/routes';
import { appsPublicRoutes, appsRoutes } from './features/apps/routes';
import { createAuthRoutes } from './features/auth/routes';
import { automationRoutes } from './features/automations/routes';
import { backupRoutes } from './features/backups/routes';
import { billingRoutes } from './features/billing/routes';
import { broadcastRoutes } from './features/broadcasts/routes';
import { commerceRoutes } from './features/commerce/routes';
import { conversationRoutes } from './features/conversations/routes';
import { crmRoutes } from './features/crm/routes';
import { developerPublicRoutes, developerRoutes } from './features/developers/routes';
import { emailRoutes } from './features/email/routes';
import { bookingRoutes } from './features/booking/routes';
import { formsRoutes } from './features/forms/routes';
import { integrationsRoutes } from './features/integrations/routes';
import { landingRoutes } from './features/landing/routes';
import { membersRoutes } from './features/members/routes';
import { supportPublicRoutes, supportRoutes } from './features/support/routes';
import { reportRoutes } from './features/reports/routes';
import { workspaceRoutes } from './features/workspace/routes';
import { useMe } from './lib/api';
import { ALL_MODULES, type ModuleDef } from './navigation';
import { ModulePlaceholder } from './pages/placeholder';
import { rootRoute } from './routes/root';
import { tenantRoute } from './routes/tenant';

/*
 * Route tree (code-based):
 *
 *   /                      → last workspace (signed in) or sign-in
 *   /login, /auth/*, …     → features/auth/routes.ts (owned by the auth module)
 *   /t/$tenant             → AppShell layout
 *     /                    → redirect to dashboard
 *     /<module path>       → real page, or the placeholder until its phase ships
 *     /dev/*               → editor demo and UI kit (vite dev only)
 *
 * Feature modules add pages by exporting routes with `getParentRoute: () => tenantRoute`
 * and listing them in `featureRoutes`; a feature route replaces the placeholder of the
 * module with the same path.
 */

// Auth pages (sign-in, 2FA, magic link, reset, invite, account security) are owned by the
// auth module and attach to the root route.
const authRoutes = createAuthRoutes(rootRoute);

function IndexRedirect() {
  const me = useMe();
  const navigate = useNavigate();
  useEffect(() => {
    if (me.isPending) return;
    const slug = me.data?.lastTenantSlug ?? null;
    if (slug)
      void navigate({ to: '/t/$tenant/dashboard', params: { tenant: slug }, replace: true });
    else if (me.data === null) void navigate({ to: '/login', replace: true });
    // API unreachable (UI-only dev without the worker): open the seeded demo workspace.
    else void navigate({ to: '/t/$tenant/dashboard', params: { tenant: 'demo' }, replace: true });
  }, [me.data, me.isPending, navigate]);
  return null;
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: IndexRedirect,
});

const tenantIndexRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: '/',
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/t/$tenant/dashboard', params });
  },
});

const devRoutes = import.meta.env.DEV
  ? [
      createRoute({
        getParentRoute: () => tenantRoute,
        path: 'dev/editor',
        component: lazyRouteComponent(() => import('./pages/dev/editor-demo'), 'EditorDemoPage'),
      }),
      createRoute({
        getParentRoute: () => tenantRoute,
        path: 'dev/ui-kit',
        component: lazyRouteComponent(() => import('./pages/dev/ui-kit'), 'UiKitPage'),
      }),
    ]
  : [];

/** Real module pages. CRM, marketing, … phases append their routes here. */
const featureRoutes = [
  ...reportRoutes,
  ...crmRoutes,
  ...conversationRoutes,
  ...analyticsRoutes,
  ...formsRoutes,
  ...bookingRoutes,
  ...landingRoutes,
  ...commerceRoutes,
  ...emailRoutes,
  ...broadcastRoutes,
  ...automationRoutes,
  ...supportRoutes,
  ...backupRoutes,
  ...developerRoutes,
  ...integrationsRoutes,
  ...appsRoutes,
  ...membersRoutes,
  ...billingRoutes,
  ...workspaceRoutes,
] as const;

const implemented = new Set<string>(
  [...featureRoutes, ...devRoutes].map((route) => (route.options as { path?: string }).path ?? ''),
);

function placeholderRoute(module: ModuleDef) {
  return createRoute({
    getParentRoute: () => tenantRoute,
    path: module.path,
    component: () => <ModulePlaceholder module={module} />,
  });
}

const placeholderRoutes = ALL_MODULES.filter((module) => !implemented.has(module.path)).map(
  placeholderRoute,
);

const routeTree = rootRoute.addChildren([
  indexRoute,
  ...authRoutes,
  ...analyticsPublicRoutes,
  ...supportPublicRoutes,
  ...developerPublicRoutes,
  ...appsPublicRoutes,
  tenantRoute.addChildren([tenantIndexRoute, ...featureRoutes, ...devRoutes, ...placeholderRoutes]),
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
