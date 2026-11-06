import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../../middleware';
import { registerCatalogRoutes } from './catalog';
import { registerFormRecordRoutes } from './forms';
import { registerSubmissionsRoutes } from './submissions';
import { registerConnectionsRoutes } from './connections';

/** Forms REST v2 routes (relative to `/api/v2/t/{slug}`). */
export function registerFormsRoutes(router: OpenAPIHono<AppEnv>): void {
  registerCatalogRoutes(router);
  registerFormRecordRoutes(router);
  registerSubmissionsRoutes(router);
  registerConnectionsRoutes(router);
}
