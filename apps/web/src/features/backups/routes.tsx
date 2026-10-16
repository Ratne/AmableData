import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { tenantRoute } from '../../routes/tenant';

/* Settings > Backups under /t/$tenant (lazy chunk). The path matches navigation.ts. */

export const backupsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'settings/backups',
  component: lazyRouteComponent(() => import('./pages/backups'), 'BackupsPage'),
});

export const backupRoutes = [backupsRoute] as const;
