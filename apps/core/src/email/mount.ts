import type { Hono } from 'hono';
import { registerArchiveBroadcastRoutes } from '../archive/api';
import { registerBroadcastRoutes } from '../broadcast/api';
import type { AppEnv } from '../middleware';
import { registerEmailRoutes } from './api';
import { createMailRouter } from './http';
import { registerLiquidRoutes } from './liquid-api';

/** Email + broadcast REST v2 routes, relative to `/api/v2/t/{slug}`. */
export const emailApi = createMailRouter();
registerEmailRoutes(emailApi);
registerBroadcastRoutes(emailApi);
registerArchiveBroadcastRoutes(emailApi);
registerLiquidRoutes(emailApi);

/** OpenAPI 3.1 document of the email + broadcast surface. */
export function emailOpenApiDocument(): ReturnType<typeof emailApi.getOpenAPI31Document> {
  return emailApi.getOpenAPI31Document({
    openapi: '3.1.0',
    info: {
      title: 'amabledata REST API — email marketing',
      version: '2.0.0',
      description:
        'Templates, Dynamic Content snippets, suppressions, email messages, email settings and broadcasts. Same authentication, permissions (`x-amable-permission`) and conventions as the CRM API.',
    },
    servers: [{ url: '/api/v2/t/{slug}', variables: { slug: { default: 'demo' } } }],
  });
}

/**
 * Mounts the email API on the core app (basePath `/api`). The central guards
 * on `/v2/t/:slug/*` are registered by the CRM mount; this adds the routes and
 * `/api/v2/openapi/email.json`.
 */
export function mountEmailApi(app: Hono<AppEnv>): void {
  app.route('/v2/t/:slug', emailApi);
  app.get('/v2/openapi/email.json', (c) => c.json(emailOpenApiDocument()));
}
