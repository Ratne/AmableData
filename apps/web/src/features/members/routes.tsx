import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { tenantRoute } from '../../routes/tenant';

export const membersRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'settings/members',
  component: lazyRouteComponent(() => import('./pages/members'), 'MembersPage'),
});

export const auditLogRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'settings/audit-log',
  component: lazyRouteComponent(() => import('./pages/audit-log'), 'AuditLogPage'),
});

export const membersRoutes = [membersRoute, auditLogRoute] as const;
