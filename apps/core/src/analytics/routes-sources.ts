import { z } from '@hono/zod-openapi';
import { trafficSourceInputSchema, trafficSourceSchema, trafficSourceTemplateSchema } from '@amable/api-types';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { crmRoute, json, jsonBody } from '../crm/api/core';
import { CrmError } from '../crm/errors';
import { audit, type AppEnv } from '../middleware';
import { siteForQuery, unwrap } from './service';
import { TRAFFIC_SOURCE_TEMPLATE_DEFS } from './traffic-source-templates';

const tags = ['Analytics'];
const siteQuery = z.object({ site_id: z.string().min(1).max(64) });
const idParam = z.object({ id: z.string().min(1).max(64) });

/** Traffic sources (tracking fields, conversion config) and their static templates. */
export function registerSourceRoutes(api: OpenAPIHono<AppEnv>): void {
  api.openapi(
    crmRoute('analytics:read', {
      method: 'get',
      path: '/traffic-sources/templates',
      tags,
      summary: 'Traffic source templates (ad platforms with their URL macros, custom)',
      responses: { 200: json(z.object({ data: z.array(trafficSourceTemplateSchema) }), 'Templates') },
    }),
    (c) => c.json({ data: [...TRAFFIC_SOURCE_TEMPLATE_DEFS] }, 200),
  );

  api.openapi(
    crmRoute('analytics:read', {
      method: 'get',
      path: '/traffic-sources',
      tags,
      summary: 'Traffic sources of a site',
      request: { query: siteQuery.extend({ status: z.enum(['active', 'archived']).optional() }) },
      responses: { 200: json(z.object({ data: z.array(trafficSourceSchema) }), 'Traffic sources') },
    }),
    async (c) => {
      const { site_id, status } = c.req.valid('query');
      const stub = await siteForQuery(c, site_id);
      return c.json({ data: await stub.listTrafficSources(status) }, 200);
    },
  );

  api.openapi(
    crmRoute('analytics:configure', {
      method: 'post',
      path: '/traffic-sources',
      tags,
      summary: 'Create a traffic source',
      request: { query: siteQuery, body: jsonBody(trafficSourceInputSchema) },
      responses: { 201: json(trafficSourceSchema, 'Traffic source') },
    }),
    async (c) => {
      const { site_id } = c.req.valid('query');
      const stub = await siteForQuery(c, site_id);
      const source = unwrap(await stub.createTrafficSource(c.req.valid('json')));
      await audit(c, 'analytics.traffic_source_created', { target: source.id, details: { site: site_id } });
      return c.json(source, 201);
    },
  );

  api.openapi(
    crmRoute('analytics:read', {
      method: 'get',
      path: '/traffic-sources/{id}',
      tags,
      summary: 'Get a traffic source',
      request: { params: idParam, query: siteQuery },
      responses: { 200: json(trafficSourceSchema, 'Traffic source') },
    }),
    async (c) => {
      const stub = await siteForQuery(c, c.req.valid('query').site_id);
      const source = await stub.getTrafficSource(c.req.valid('param').id);
      if (source === null) throw new CrmError('not_found', 'traffic source not found');
      return c.json(source, 200);
    },
  );

  api.openapi(
    crmRoute('analytics:configure', {
      method: 'put',
      path: '/traffic-sources/{id}',
      tags,
      summary: 'Replace a traffic source',
      request: { params: idParam, query: siteQuery, body: jsonBody(trafficSourceInputSchema) },
      responses: { 200: json(trafficSourceSchema, 'Traffic source') },
    }),
    async (c) => {
      const { site_id } = c.req.valid('query');
      const { id } = c.req.valid('param');
      const stub = await siteForQuery(c, site_id);
      const source = unwrap(await stub.updateTrafficSource(id, c.req.valid('json')));
      await audit(c, 'analytics.traffic_source_updated', { target: id, details: { site: site_id } });
      return c.json(source, 200);
    },
  );

  for (const action of ['archive', 'restore'] as const) {
    api.openapi(
      crmRoute('analytics:configure', {
        method: 'post',
        path: `/traffic-sources/{id}/${action}`,
        tags,
        summary:
          action === 'archive'
            ? 'Archive a traffic source (fields keep being captured)'
            : 'Restore an archived traffic source',
        request: { params: idParam, query: siteQuery },
        responses: { 200: json(trafficSourceSchema, 'Traffic source') },
      }),
      async (c) => {
        const { site_id } = c.req.valid('query');
        const { id } = c.req.valid('param');
        const stub = await siteForQuery(c, site_id);
        const source = action === 'archive' ? await stub.archiveTrafficSource(id) : await stub.restoreTrafficSource(id);
        if (source === null) throw new CrmError('not_found', 'traffic source not found');
        await audit(c, `analytics.traffic_source_${action}d`, { target: id, details: { site: site_id } });
        return c.json(source, 200);
      },
    );
  }
}
