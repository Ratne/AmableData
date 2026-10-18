import { z } from '@hono/zod-openapi';
import {
  createTrackingDomainSchema,
  errorResponseSchema,
  FUNNEL_STATUSES,
  funnelGraphErrorSchema,
  funnelGraphInputSchema,
  funnelGraphSchema,
  funnelGraphSummarySchema,
  funnelGraphUpdateSchema,
  funnelHeatmapSchema,
  funnelLinksSchema,
  HEATMAP_METRICS,
  validateGraph,
  type FunnelGraph,
  type FunnelGraphError,
  type FunnelNode,
  type FunnelNodeOf,
  type FunnelPage,
} from '@amable/api-types';
import { siteStub } from '@amable/app-edge/analytics';
import {
  buildActionUrl,
  buildDirectSuffix,
  buildDirectUrl,
  buildEntranceUrl,
} from '@amable/app-edge/funnel-engine';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { zonedLocalToUtc } from '../broadcast/tz';
import { crmRoute, json, jsonBody } from '../crm/api/core';
import { CrmError } from '../crm/errors';
import { audit, getTenant, HttpError, type AppEnv } from '../middleware';
import { computeHeatmap } from './heatmap';
import { edgeOrigin, namespace, siteForQuery, siteRecord, snippetFor, unwrap } from './service';

type Ctx = Context<AppEnv>;

const tags = ['Analytics'];
const siteQuery = z.object({ site_id: z.string().min(1).max(64) });
const idParam = z.object({ id: z.string().min(1).max(64) });

const invalidGraphSchema = z.object({
  error: z.literal('invalid_graph'),
  errors: z.array(funnelGraphErrorSchema),
});
const unprocessable = json(
  z.union([invalidGraphSchema, errorResponseSchema]),
  '`invalid_graph` with the structural errors, or `validation_failed`',
);

const linksQuery = siteQuery.extend({
  source: z.string().min(1).max(64),
  /** Entry / page node; default: the traffic node. */
  node: z.string().min(1).max(40).optional(),
  page: z.string().min(1).max(40).optional(),
  /** Tracking domain host overriding the site's edge origin. */
  domain: createTrackingDomainSchema.shape.hostname.optional(),
  /** Entrance cost (`0.25`, `cpm_12.34`) or a platform cost macro. */
  cost: z
    .string()
    .regex(/^[A-Za-z0-9_.{}[\]-]{1,64}$/, 'invalid cost')
    .optional(),
  /** Leave `p` out of the direct suffix (WordPress uses it for post ids). */
  wordpress: z.enum(['true', 'false']).optional(),
});

/** The hostname is an active tracking domain of this site (installation D1). */
async function activeTrackingDomain(c: Ctx, siteId: string, hostname: string): Promise<boolean> {
  const row = await c.env.DB.prepare(
    `SELECT 1 AS ok FROM tracking_domains WHERE hostname = ? AND site_id = ? AND tenant_id = ? AND status = 'active'`,
  )
    .bind(hostname, siteId, getTenant(c).tenant.id)
    .first<{ ok: number }>();
  return row !== null;
}

const funnelLinksResponseSchema = funnelLinksSchema.extend({
  base_url: z.string(),
  /** Page URL + direct suffix, when the page has an external URL. */
  direct_url: z.string().nullable(),
  /** Page node the direct / action links belong to. */
  page_node_id: z.string().nullable(),
  action_urls: z.array(
    z.object({
      action: z.number().int(),
      url: z.string(),
      /** Same action carrying the page node as fallback origin (visits without a known session). */
      default_url: z.string(),
    }),
  ),
});

export const rangeBound = z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.iso.datetime({ offset: true })]);
const heatmapQuery = siteQuery.extend({
  metric: z.enum(HEATMAP_METRICS).default('visits'),
  from: rangeBound.optional(),
  to: rangeBound.optional(),
  /** Only touches of one traffic source. */
  source: z.string().min(1).max(64).optional(),
});

const WEEK_MS = 7 * 86_400_000;
const MAX_TOUCHES = 10_000;

function invalidGraph(c: Ctx, errors: FunnelGraphError[]) {
  return c.json({ error: 'invalid_graph' as const, errors }, 422);
}

function nextDay(day: string): string {
  const [y = 1970, m = 1, d = 1] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** Epoch ms of a range bound: a local day of the site (`end`: the day after) or an ISO date-time. */
export function epochBound(value: string, end: boolean, timeZone: string): number {
  return value.length === 10 ? zonedLocalToUtc(end ? nextDay(value) : value, '00:00', timeZone) : Date.parse(value);
}

/** Epoch range of the heatmap; dates are local days of the site, `to` inclusive. */
function heatmapRange(c: Ctx, from: string | undefined, to: string | undefined, timeZone: string) {
  const now = c.get('services').now();
  const range = {
    from: from === undefined ? now - WEEK_MS : epochBound(from, false, timeZone),
    to: to === undefined ? now : epochBound(to, true, timeZone),
  };
  if (!(range.from < range.to)) throw new CrmError('validation_failed', '`from` must be before `to`');
  return range;
}

async function graphOf(c: Ctx, siteId: string, id: string, version?: number) {
  const stub = await siteForQuery(c, siteId);
  const graph = await stub.getFunnelGraph(id, version);
  if (graph === null) throw new CrmError('not_found', 'funnel not found');
  return { stub, graph };
}

function liveNode(graph: FunnelGraph, id: string): FunnelNode | undefined {
  return graph.nodes.find((n) => n.id === id && n.deleted_at == null);
}

/** First page group reached from `start` through single-exit server nodes. */
function firstPageGroup(graph: FunnelGraph, start: FunnelNode): FunnelNodeOf<'page_group'> | null {
  let node: FunnelNode | undefined = start;
  const seen = new Set<string>();
  while (node !== undefined && !seen.has(node.id)) {
    if (node.kind === 'page_group') return node;
    if (!['traffic', 'action_proxy', 'tag', 'webhook'].includes(node.kind)) return null;
    seen.add(node.id);
    const from: string = node.id;
    const exit = graph.edges.find((e) => e.from === from && e.via.type === 'default');
    node = exit === undefined ? undefined : liveNode(graph, exit.to);
  }
  return null;
}

function actionNumbers(graph: FunnelGraph, nodeId: string): number[] {
  const out = new Set<number>();
  let fallback = false;
  for (const e of graph.edges) {
    if (e.from !== nodeId || liveNode(graph, e.to) === undefined) continue;
    if (e.via.type === 'action') for (const a of e.via.actions) out.add(a);
    else if (e.via.type === 'default') fallback = true;
  }
  if (out.size === 0 && fallback) out.add(1);
  return [...out].sort((a, b) => a - b);
}

/** Funnel graphs v2: CRUD with structural validation, tracking links and heatmap. */
export function registerFunnelRoutes(api: OpenAPIHono<AppEnv>): void {
  api.openapi(
    crmRoute('analytics:read', {
      method: 'get',
      path: '/funnels-v2',
      tags,
      summary: 'Funnel graphs of a site',
      request: { query: siteQuery.extend({ status: z.enum(FUNNEL_STATUSES).optional() }) },
      responses: { 200: json(z.object({ data: z.array(funnelGraphSummarySchema) }), 'Funnel graphs') },
    }),
    async (c) => {
      const { site_id, status } = c.req.valid('query');
      const stub = await siteForQuery(c, site_id);
      return c.json({ data: await stub.listFunnelGraphs(status) }, 200);
    },
  );

  api.openapi(
    crmRoute('analytics:configure', {
      method: 'post',
      path: '/funnels-v2',
      tags,
      summary: 'Create a funnel graph',
      request: { query: siteQuery, body: jsonBody(funnelGraphInputSchema) },
      responses: { 201: json(funnelGraphSchema, 'Funnel graph (version 1)'), 422: unprocessable },
    }),
    async (c) => {
      const { site_id } = c.req.valid('query');
      const input = c.req.valid('json');
      const stub = await siteForQuery(c, site_id);
      const errors = validateGraph(input);
      if (errors.length > 0) return invalidGraph(c, errors);
      const graph = unwrap(await stub.createFunnelGraph(input));
      await audit(c, 'analytics.funnel_graph_created', { target: graph.id, details: { site: site_id } });
      return c.json(graph, 201);
    },
  );

  api.openapi(
    crmRoute('analytics:read', {
      method: 'get',
      path: '/funnels-v2/{id}',
      tags,
      summary: 'Get a funnel graph (current or a saved version)',
      request: {
        params: idParam,
        query: siteQuery.extend({ version: z.coerce.number().int().min(1).optional() }),
      },
      responses: { 200: json(funnelGraphSchema, 'Funnel graph') },
    }),
    async (c) => {
      const { site_id, version } = c.req.valid('query');
      const { graph } = await graphOf(c, site_id, c.req.valid('param').id, version);
      return c.json(graph, 200);
    },
  );

  api.openapi(
    crmRoute('analytics:configure', {
      method: 'put',
      path: '/funnels-v2/{id}',
      tags,
      summary: 'Save a funnel graph',
      description: '`version` must be the stored version (optimistic concurrency): otherwise 409 `conflict`.',
      request: { params: idParam, query: siteQuery, body: jsonBody(funnelGraphUpdateSchema) },
      responses: {
        200: json(funnelGraphSchema, 'Funnel graph (version + 1)'),
        409: json(errorResponseSchema, 'The funnel was saved meanwhile'),
        422: unprocessable,
      },
    }),
    async (c) => {
      const { site_id } = c.req.valid('query');
      const { id } = c.req.valid('param');
      const input = c.req.valid('json');
      const stub = await siteForQuery(c, site_id);
      const errors = validateGraph(input);
      if (errors.length > 0) return invalidGraph(c, errors);
      const graph = unwrap(await stub.updateFunnelGraph(id, input));
      await audit(c, 'analytics.funnel_graph_saved', { target: id, details: { site: site_id, version: graph.version } });
      return c.json(graph, 200);
    },
  );

  for (const action of ['archive', 'restore'] as const) {
    api.openapi(
      crmRoute('analytics:configure', {
        method: 'post',
        path: `/funnels-v2/{id}/${action}`,
        tags,
        summary:
          action === 'archive'
            ? 'Archive a funnel graph (its links keep working)'
            : 'Restore an archived funnel graph',
        request: { params: idParam, query: siteQuery },
        responses: { 200: json(funnelGraphSchema, 'Funnel graph') },
      }),
      async (c) => {
        const { site_id } = c.req.valid('query');
        const { id } = c.req.valid('param');
        const stub = await siteForQuery(c, site_id);
        const graph = action === 'archive' ? await stub.archiveFunnelGraph(id) : await stub.restoreFunnelGraph(id);
        if (graph === null) throw new CrmError('not_found', 'funnel not found');
        await audit(c, `analytics.funnel_graph_${action}d`, { target: id, details: { site: site_id } });
        return c.json(graph, 200);
      },
    );
  }

  api.openapi(
    crmRoute('analytics:configure', {
      method: 'post',
      path: '/funnels-v2/{id}/duplicate',
      tags,
      summary: 'Duplicate a funnel graph (new id, same nodes and edges)',
      request: {
        params: idParam,
        query: siteQuery,
        body: { required: false, content: { 'application/json': { schema: z.object({ name: z.string().trim().min(1).max(200).optional() }) } } },
      },
      responses: { 201: json(funnelGraphSchema, 'The copy (version 1)') },
    }),
    async (c) => {
      const { site_id } = c.req.valid('query');
      const body = c.req.valid('json') as { name?: string } | undefined;
      const { stub, graph } = await graphOf(c, site_id, c.req.valid('param').id);
      const copy = unwrap(
        await stub.createFunnelGraph({
          name: body?.name ?? `${graph.name} (copy)`.slice(0, 200),
          group_id: graph.group_id ?? null,
          nodes: graph.nodes,
          edges: graph.edges,
          default_cost_minor: graph.default_cost_minor ?? null,
          ip_anonymize: graph.ip_anonymize,
        }),
      );
      await audit(c, 'analytics.funnel_graph_created', { target: copy.id, details: { site: site_id, from: graph.id } });
      return c.json(copy, 201);
    },
  );

  api.openapi(
    crmRoute('analytics:read', {
      method: 'get',
      path: '/funnels-v2/{id}/links',
      tags,
      summary: 'Tracking links of a funnel for a traffic source',
      description:
        'Entrance (redirect) link, direct-link suffix, action links of the page node and the universal JS snippet. ' +
        'Links are derived, never stored: regenerate them at will.',
      request: { params: idParam, query: linksQuery },
      responses: { 200: json(funnelLinksResponseSchema, 'Links') },
    }),
    async (c) => {
      const q = c.req.valid('query');
      const record = await siteRecord(c, q.site_id);
      const stub = siteStub(namespace(c), q.site_id);
      const graph = await stub.getFunnelGraph(c.req.valid('param').id);
      if (graph === null) throw new CrmError('not_found', 'funnel not found');
      const source = await stub.getTrafficSource(q.source);
      if (source === null) throw new CrmError('not_found', 'traffic source not found');
      const traffic = graph.nodes.find((n) => n.kind === 'traffic' && n.deleted_at == null);
      const node = q.node === undefined ? traffic : liveNode(graph, q.node);
      if (node === undefined) throw new CrmError('not_found', 'node not found');
      const pageNode = firstPageGroup(graph, node);
      let page: FunnelPage | undefined;
      if (q.page !== undefined) {
        page = pageNode?.config.pages.find((p) => p.id === q.page);
        if (page === undefined) throw new CrmError('not_found', 'page not found');
      }
      // Custom tracking domains carry the site in the hostname; the shared edge host in the path.
      if (q.domain !== undefined && !(await activeTrackingDomain(c, q.site_id, q.domain))) {
        throw new HttpError(422, 'tracking_domain_not_active');
      }
      const origin = q.domain === undefined ? edgeOrigin(c) : `https://${q.domain}`;
      const base = q.domain === undefined ? `${origin}/s/${q.site_id}` : origin;
      const entryNode = node.kind === 'traffic' ? undefined : node.id;
      const entrance_url = buildEntranceUrl(base, graph.id, source, {
        ...(entryNode === undefined ? {} : { nodeId: entryNode }),
        ...(entryNode !== undefined && page !== undefined && node.kind === 'page_group' ? { pageId: page.id } : {}),
        cost: q.cost ?? null,
      });
      const directPage = page ?? pageNode?.config.pages.find((p) => !p.paused) ?? pageNode?.config.pages[0];
      const withPage = directPage !== undefined && (page !== undefined || (pageNode?.config.pages.length ?? 0) > 1);
      const direct_suffix =
        pageNode === null
          ? ''
          : buildDirectSuffix(graph.id, source, {
              nodeId: pageNode.id,
              ...(withPage ? { pageId: directPage.id } : {}),
              wordpress: q.wordpress === 'true',
            });
      const action_urls =
        pageNode === null
          ? []
          : actionNumbers(graph, pageNode.id).map((action) => ({
              action,
              url: buildActionUrl(base, action),
              default_url: buildActionUrl(base, action, { funnelId: graph.id, nodeId: pageNode.id }),
            }));
      return c.json(
        {
          base_url: base,
          entrance_url,
          direct_suffix,
          direct_url:
            pageNode !== null && directPage?.url !== undefined ? buildDirectUrl(directPage.url, direct_suffix) : null,
          page_node_id: pageNode?.id ?? null,
          action_urls,
          snippet: snippetFor(record.site, origin).html,
        },
        200,
      );
    },
  );

  api.openapi(
    crmRoute('analytics:read', {
      method: 'get',
      path: '/funnels-v2/{id}/heatmap',
      tags,
      summary: 'Heatmap of a funnel graph from its touches and conversions',
      description:
        'Visits, clicks, conversions, revenue and cost per node, flow per edge. `value` is the selected metric ' +
        '(`visits`, `flow_pct` = % of the entrances, `cvr` = % of the node visits, `roi` = % of the cost). ' +
        'Dates are local days of the site (`to` inclusive); default: the last 7 days.',
      request: { params: idParam, query: heatmapQuery },
      responses: { 200: json(funnelHeatmapSchema, 'Heatmap') },
    }),
    async (c) => {
      const q = c.req.valid('query');
      const record = await siteRecord(c, q.site_id);
      const stub = siteStub(namespace(c), q.site_id);
      const graph = await stub.getFunnelGraph(c.req.valid('param').id);
      if (graph === null) throw new CrmError('not_found', 'funnel not found');
      const range = heatmapRange(c, q.from, q.to, record.site.timezone);
      const [touches, conversions] = await Promise.all([
        stub.listTouches({
          from: range.from,
          to: range.to,
          funnel_id: graph.id,
          traffic_source_id: q.source,
          limit: MAX_TOUCHES,
        }),
        stub.listConversions({
          from: range.from,
          to: range.to,
          funnel_id: graph.id,
          traffic_source_id: q.source,
          limit: MAX_TOUCHES,
        }),
      ]);
      return c.json(computeHeatmap(graph, touches, conversions, q.metric), 200);
    },
  );
}
