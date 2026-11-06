import { z, type OpenAPIHono } from '@hono/zod-openapi';
import { connectorInfoSchema } from '@amable/api-types';
import { crmRoute, json } from '../../crm/api/core';
import { getTenant, type AppEnv } from '../../middleware';
import { appConnectorCatalog } from '../connectors/app';
import { connectorCatalog } from '../connectors/registry';
import { formsRuntime } from '../runtime';
import { connectionsTag } from './shared';

export function registerCatalogRoutes(router: OpenAPIHono<AppEnv>): void {
  router.openapi(
    crmRoute('forms:read', {
      method: 'get',
      path: '/formConnectorTypes',
      tags: connectionsTag,
      summary: 'Connector types a form connection can use on this installation',
      responses: {
        200: json(z.object({ data: z.array(connectorInfoSchema) }), 'Connector catalog'),
      },
    }),
    async (c) =>
      c.json(
        {
          data: [
            ...connectorCatalog(await formsRuntime(c.env)),
            ...(await appConnectorCatalog(c.env, getTenant(c).tenant.id)),
          ],
        },
        200,
      ),
  );
}
