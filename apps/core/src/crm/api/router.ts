import type { Hono } from 'hono';
import { requireAuth, requireTenant, type AppEnv } from '../../middleware';
import { createCrmRouter, idempotency } from './core';
import { registerAddressLookupRoutes } from './address-lookup';
import { registerContactRoutes } from './contacts';
import { registerRecordRoutes } from './records';
import { registerSalesRoutes } from './sales';
import { registerSearchRoutes } from './search';
import { registerAutomationRoutes } from '../../automation/api/routes';
import { registerCommerceRoutes } from '../../commerce/api';
import { registerWorkspaceRoutes } from '../../workspace/api';

/** Every CRM REST v2 route, relative to `/api/v2/t/{slug}`. */
export const crmApi = createCrmRouter();
crmApi.use('*', idempotency());
registerContactRoutes(crmApi);
registerAddressLookupRoutes(crmApi);
registerRecordRoutes(crmApi);
registerSalesRoutes(crmApi);
registerSearchRoutes(crmApi);
registerAutomationRoutes(crmApi);
registerCommerceRoutes(crmApi);
registerWorkspaceRoutes(crmApi);

crmApi.openAPIRegistry.registerComponent('securitySchemes', 'apiKey', {
  type: 'http',
  scheme: 'bearer',
  description: 'Tenant API key (`amb_…`), scoped to a subset of permissions.',
});
crmApi.openAPIRegistry.registerComponent('securitySchemes', 'session', {
  type: 'apiKey',
  in: 'cookie',
  name: '__Host-sid',
  description: 'Browser session; mutating requests also need the CSRF header.',
});

/** OpenAPI 3.1 document of the REST v2 surface. */
export function crmOpenApiDocument(): ReturnType<typeof crmApi.getOpenAPI31Document> {
  return crmApi.getOpenAPI31Document({
    openapi: '3.1.0',
    info: {
      title: 'amabledata REST API',
      version: '2.0.0',
      description:
        'Tenant-scoped CRM API. Authenticate with a session or an API key; every operation lists the permission it requires in `x-amable-permission`. Lists use cursor pagination (`limit`, `cursor` → `next_cursor`). POST requests accept an `Idempotency-Key` header (24 h replay).',
    },
    servers: [{ url: '/api/v2/t/{slug}', variables: { slug: { default: 'demo' } } }],
  });
}

/**
 * Mounts the CRM API on the core app (basePath `/api`):
 * - `/api/v2/t/:slug/*` behind the central guards (session or API key, then
 *   membership + role); each route adds its own `requirePermission`;
 * - `/api/v2/openapi.json` (public description of the API, no data).
 */
export function mountCrmApi(app: Hono<AppEnv>): void {
  app.use('/v2/t/:slug/*', requireAuth({ apiKey: true }), requireTenant());
  app.route('/v2/t/:slug', crmApi);
  app.get('/v2/openapi.json', (c) => c.json(crmOpenApiDocument()));

  // Dev-only (ENVIRONMENT=dev, used by `pnpm seed`): fake CRM data in the demo tenant.
  app.post('/dev/seed-crm', async (c) => {
    if (c.env.ENVIRONMENT !== 'dev') return c.notFound();
    const slug = c.req.query('tenant') ?? 'demo';
    const tenant = await c.env.DB.prepare(`SELECT id FROM tenants WHERE slug = ?`)
      .bind(slug)
      .first<{ id: string }>();
    if (tenant === null)
      return c.json({ error: 'tenant_not_found', message: 'run the base seed first' }, 404);
    const stub = c.env.TENANT_DB.get(c.env.TENANT_DB.idFromName(tenant.id));
    const crm = await stub.crmDevSeed();
    return c.json({ ok: true, tenant: slug, crm, commerce: await stub.commerceDevSeed() });
  });
}
