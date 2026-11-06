import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../../../middleware';
import { registerCompaniesRoutes } from './companies';
import { registerTagsRoutes } from './tags';
import { registerNotesRoutes } from './notes';
import { registerCustomFieldsRoutes } from './custom-fields';

export function registerRecordRoutes(app: OpenAPIHono<AppEnv>): void {
  registerCompaniesRoutes(app);
  registerTagsRoutes(app);
  registerNotesRoutes(app);
  registerCustomFieldsRoutes(app);
}
