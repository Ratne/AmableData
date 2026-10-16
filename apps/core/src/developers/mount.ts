import type { Hono } from 'hono';
import type { AppEnv } from '../middleware';
import { domainsApi, domainsOpenApiDocument } from '../domains/api';
import { webhooksApi, webhooksOpenApiDocument } from '../webhooks/api';
import { mergedOpenApiDocument, OPENAPI_SOURCES } from './openapi';

let merged: ReturnType<typeof mergedOpenApiDocument> | null = null;

/**
 * Developer surface (basePath `/api`): outgoing webhook routes under
 * `/v2/t/:slug` (central guards registered by the CRM mount), the module
 * OpenAPI documents and the merged public one used by the docs page.
 */
export function mountDevelopersApi(app: Hono<AppEnv>): void {
  app.route('/v2/t/:slug', webhooksApi);
  app.route('/v2/t/:slug', domainsApi);
  app.get('/v2/openapi/webhooks.json', (c) => c.json(webhooksOpenApiDocument()));
  app.get('/v2/openapi/domains.json', (c) => c.json(domainsOpenApiDocument()));
  app.get('/v2/openapi/all.json', (c) => {
    merged ??= mergedOpenApiDocument();
    c.header('cache-control', 'public, max-age=300');
    return c.json(merged);
  });
  app.get('/v2/openapi', (c) =>
    c.json({
      merged: '/api/v2/openapi/all.json',
      documents: OPENAPI_SOURCES.map((s) => ({
        id: s.id,
        title: s.title,
        url: s.id === 'crm' ? '/api/v2/openapi.json' : `/api/v2/openapi/${s.id}.json`,
      })),
    }),
  );
}
