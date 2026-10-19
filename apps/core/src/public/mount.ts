import type { Hono } from 'hono';
import { registerBookingRoutes } from '../booking/api';
import { createCrmRouter } from '../crm/api/core';
import { registerFormsRoutes } from '../forms/api';
import { registerEsignRoutes } from '../esign/api';
import { requireAuth, requireTenant, type AppEnv } from '../middleware';
import { registerPagesRoutes } from '../pages/api';

/** Forms, calendars & bookings, landing pages and e-signatures REST v2, relative to `/api/v2/t/{slug}`. */
export const publishingApi = createCrmRouter();
registerFormsRoutes(publishingApi);
registerBookingRoutes(publishingApi);
registerPagesRoutes(publishingApi);
registerEsignRoutes(publishingApi);

publishingApi.openAPIRegistry.registerComponent('securitySchemes', 'apiKey', {
  type: 'http',
  scheme: 'bearer',
  description: 'Tenant API key (`amb_…`), scoped to a subset of permissions.',
});
publishingApi.openAPIRegistry.registerComponent('securitySchemes', 'session', {
  type: 'apiKey',
  in: 'cookie',
  name: '__Host-sid',
  description: 'Browser session; mutating requests also need the CSRF header.',
});

export function publishingOpenApiDocument(): ReturnType<typeof publishingApi.getOpenAPI31Document> {
  return publishingApi.getOpenAPI31Document({
    openapi: '3.1.0',
    info: {
      title: 'amabledata forms, bookings, landing pages & signatures API',
      version: '2.0.0',
      description:
        'Forms (submissions, connections), calendars and bookings, landing pages (versions, publish, saved sections, media), e-signature templates and requests. Same authentication, permissions (`x-amable-permission`), pagination and idempotency rules as the CRM API.',
    },
    servers: [{ url: '/api/v2/t/{slug}', variables: { slug: { default: 'demo' } } }],
  });
}

/**
 * Mounts the publishing modules on the core app (basePath `/api`) behind the
 * central guards, plus the public `/api/v2/openapi/publishing.json`.
 */
export function mountPublishingApi(app: Hono<AppEnv>): void {
  const auth = requireAuth({ apiKey: true });
  const tenant = requireTenant();
  // The CRM mount may already have run the same guards for /v2/t/:slug/*.
  app.use('/v2/t/:slug/*', (c, next) => (c.get('auth') === undefined ? auth(c, next) : next()));
  app.use('/v2/t/:slug/*', (c, next) => (c.get('tenant') === undefined ? tenant(c, next) : next()));
  app.route('/v2/t/:slug', publishingApi);
  app.get('/v2/openapi/publishing.json', (c) => c.json(publishingOpenApiDocument()));
}
