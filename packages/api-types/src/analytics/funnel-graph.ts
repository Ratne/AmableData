import { z } from 'zod';

/**
 * Funnel graphs: a funnel is a directed graph of nodes (traffic entry, rotators,
 * page groups, conditions, external URLs, action proxies, tags, webhooks)
 * executed server-side by the edge link routes (`/go`, `/a/:n`). Tracking links
 * are derived from (funnel id + traffic source id) and never stored, so editing
 * weights, pages or rules never breaks live links. Nodes are soft-deleted.
 */

export const FUNNEL_NODE_KINDS = [
  'traffic',
  'rotator',
  'page_group',
  'condition',
  'external_url',
  'action_proxy',
  'tag',
  'webhook',
] as const;
export type FunnelNodeKind = (typeof FUNNEL_NODE_KINDS)[number];

/** Node kinds the engine resolves without showing anything to the visitor. */
export const FUNNEL_SERVER_NODE_KINDS = [
  'traffic',
  'rotator',
  'condition',
  'action_proxy',
  'tag',
  'webhook',
] as const satisfies readonly FunnelNodeKind[];

/** Highest action number of a page (`/a/1` … `/a/255`). */
export const MAX_FUNNEL_ACTION = 255;

export const funnelIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'invalid id');

const dataParamsSchema = z
  .record(z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/), z.string().max(512))
  .refine((r) => Object.keys(r).length <= 30, 'at most 30 parameters');

// ------------------------------------------------------------------ conditions

export const CONDITION_ATTRIBUTES = [
  'country',
  'region',
  'city',
  'device',
  'os',
  'browser',
  'language',
  'referrer',
  'hour',
  'weekday',
  'tag',
  'traffic_source',
  'campaign',
] as const;
export type ConditionBaseAttribute = (typeof CONDITION_ATTRIBUTES)[number];

/** A base attribute or `field:<name>` (tracking field / data parameter of the visit). */
export const conditionAttributeSchema = z
  .string()
  .regex(
    new RegExp(`^(?:${CONDITION_ATTRIBUTES.join('|')}|field:[A-Za-z0-9_.-]{1,64})$`),
    'unknown condition attribute',
  );

export const CONDITION_OPERATORS = [
  'is',
  'is_not',
  'contains',
  'not_contains',
  'starts_with',
  'gt',
  'lt',
  'between',
  'exists',
  'not_exists',
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export const conditionRuleSchema = z.object({
  attr: conditionAttributeSchema,
  op: z.enum(CONDITION_OPERATORS),
  /** `is`/`is_not` match any of the values; `between` takes exactly two numbers. */
  values: z.array(z.string().max(255)).max(200).default([]),
});
export type ConditionRule = z.infer<typeof conditionRuleSchema>;

export const conditionGroupSchema = z.object({
  match: z.enum(['any', 'all']),
  rules: z.array(conditionRuleSchema).min(1).max(50),
});
export type ConditionGroup = z.infer<typeof conditionGroupSchema>;

export const conditionRouteSchema = z.object({
  id: funnelIdSchema,
  label: z.string().trim().min(1).max(100),
  /** Lower runs first; the first matching route wins. */
  priority: z.number().int().min(0).max(1000),
  /** All groups must match. */
  groups: z.array(conditionGroupSchema).min(1).max(20),
});
export type ConditionRoute = z.infer<typeof conditionRouteSchema>;

// ----------------------------------------------------------------------- nodes

export const ROTATOR_STICKINESS = ['none', 'sticky', 'anti_affinity'] as const;
export type RotatorStickiness = (typeof ROTATOR_STICKINESS)[number];

export const PAGE_TYPES = ['lander', 'offer'] as const;
export type PageType = (typeof PAGE_TYPES)[number];

export const funnelPageSchema = z
  .object({
    id: funnelIdSchema,
    name: z.string().trim().min(1).max(200),
    /** External page URL; optional when the page is hosted by AmableCRM. */
    url: z.url().max(2048).optional(),
    /** Page built with the AmableCRM page builder. */
    amable_page_id: z.string().max(64).optional(),
    weight: z.number().finite().positive().max(10_000),
    paused: z.boolean().default(false),
    /** Page-level data passing (overrides the node level). */
    data_params: dataParamsSchema.optional(),
  })
  .refine((p) => p.url !== undefined || p.amable_page_id !== undefined, {
    message: 'url or amable_page_id required',
    path: ['url'],
  });
export type FunnelPage = z.infer<typeof funnelPageSchema>;

const positionSchema = z.object({ x: z.number().finite(), y: z.number().finite() });

const nodeBase = {
  id: funnelIdSchema,
  label: z.string().trim().max(100).optional(),
  position: positionSchema.default({ x: 0, y: 0 }),
  /** Soft-delete: kept for reporting, skipped by the engine. */
  deleted_at: z.number().int().nullable().optional(),
};

export const funnelNodeSchema = z.discriminatedUnion('kind', [
  z.object({ ...nodeBase, kind: z.literal('traffic'), config: z.object({}).default({}) }),
  z.object({
    ...nodeBase,
    kind: z.literal('rotator'),
    config: z.object({ stickiness: z.enum(ROTATOR_STICKINESS).default('none') }),
  }),
  z.object({
    ...nodeBase,
    kind: z.literal('page_group'),
    config: z.object({
      page_type: z.enum(PAGE_TYPES),
      pages: z.array(funnelPageSchema).max(50),
      /** Action N leads to the N-th page of the next page group (offer walls). */
      map_action_to_page: z.boolean().default(false),
      data_params: dataParamsSchema.optional(),
    }),
  }),
  z.object({
    ...nodeBase,
    kind: z.literal('condition'),
    config: z.object({ routes: z.array(conditionRouteSchema).max(50) }),
  }),
  z.object({
    ...nodeBase,
    kind: z.literal('external_url'),
    config: z.object({
      url: z.url().max(2048),
      /** Append tracking fields + data parameters to the URL. */
      append_data: z.boolean().default(true),
      data_params: dataParamsSchema.optional(),
    }),
  }),
  z.object({ ...nodeBase, kind: z.literal('action_proxy'), config: z.object({}).default({}) }),
  z.object({
    ...nodeBase,
    kind: z.literal('tag'),
    config: z.object({
      add: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
      remove: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
    }),
  }),
  z.object({
    ...nodeBase,
    kind: z.literal('webhook'),
    config: z.object({
      url: z.url().max(2048),
      method: z.enum(['GET', 'POST']).default('POST'),
      headers: z
        .record(z.string().max(100), z.string().max(1000))
        .refine((r) => Object.keys(r).length <= 20, 'at most 20 headers')
        .optional(),
      /** Body template with `{token}` placeholders (POST only). */
      body: z.string().max(10_000).optional(),
    }),
  }),
]);
export type FunnelNode = z.infer<typeof funnelNodeSchema>;
export type FunnelNodeOf<K extends FunnelNodeKind> = Extract<FunnelNode, { kind: K }>;

// ----------------------------------------------------------------------- edges

export const funnelEdgeViaSchema = z.discriminatedUnion('type', [
  /** Rotator / traffic split. */
  z.object({ type: z.literal('weight'), weight: z.number().finite().positive().max(10_000) }),
  /** Condition route. */
  z.object({ type: z.literal('route'), route_id: funnelIdSchema }),
  /** Page action numbers (`/a/N`). */
  z.object({
    type: z.literal('action'),
    actions: z.array(z.number().int().min(1).max(MAX_FUNNEL_ACTION)).min(1).max(50),
  }),
  /** Fallback of a decision node (no matching route / unmapped action / single exit). */
  z.object({ type: z.literal('default') }),
]);
export type FunnelEdgeVia = z.infer<typeof funnelEdgeViaSchema>;

export const funnelEdgeSchema = z.object({
  id: funnelIdSchema,
  from: funnelIdSchema,
  to: funnelIdSchema,
  via: funnelEdgeViaSchema,
});
export type FunnelEdge = z.infer<typeof funnelEdgeSchema>;

// ----------------------------------------------------------------------- graph

export const FUNNEL_STATUSES = ['active', 'archived'] as const;
export type FunnelStatus = (typeof FUNNEL_STATUSES)[number];

const funnelGraphBody = {
  name: z.string().trim().min(1).max(200),
  group_id: z.string().max(64).nullable().optional(),
  nodes: z.array(funnelNodeSchema).min(1).max(200),
  edges: z.array(funnelEdgeSchema).max(500),
  /** Default entrance cost (minor units) when the link carries no `c=`. */
  default_cost_minor: z.number().int().nonnegative().nullable().optional(),
  /** Drop the last IP octet before storing visits of this funnel. */
  ip_anonymize: z.boolean().default(false),
};

function uniqueIds(graph: { nodes: { id: string }[]; edges: { id: string }[] }, ctx: z.RefinementCtx) {
  const seen = new Set<string>();
  graph.nodes.forEach((n, i) => {
    if (seen.has(n.id)) ctx.addIssue({ code: 'custom', message: 'duplicate node id', path: ['nodes', i, 'id'] });
    seen.add(n.id);
  });
  const edges = new Set<string>();
  graph.edges.forEach((e, i) => {
    if (edges.has(e.id)) ctx.addIssue({ code: 'custom', message: 'duplicate edge id', path: ['edges', i, 'id'] });
    edges.add(e.id);
  });
}

/**
 * Stored funnel graph. Structural rules (edges between existing nodes,
 * mandatory fallbacks, reachable exits) are checked by the edge funnel engine
 * `validateGraph`, not by this schema.
 */
export const funnelGraphSchema = z
  .object({
    id: z.string().min(1).max(64),
    ...funnelGraphBody,
    /** Incremented on every save. */
    version: z.number().int().min(1),
    status: z.enum(FUNNEL_STATUSES),
    created_at: z.number().int(),
    updated_at: z.number().int(),
  })
  .superRefine(uniqueIds);
export type FunnelGraph = z.infer<typeof funnelGraphSchema>;

export const funnelGraphInputSchema = z.strictObject(funnelGraphBody).superRefine(uniqueIds);
export type FunnelGraphInput = z.input<typeof funnelGraphInputSchema>;

/** Update with optimistic concurrency on `version`. */
export const funnelGraphUpdateSchema = z
  .strictObject({ ...funnelGraphBody, version: z.number().int().min(1) })
  .superRefine(uniqueIds);
export type FunnelGraphUpdate = z.input<typeof funnelGraphUpdateSchema>;

export const funnelGraphSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  group_id: z.string().nullable(),
  status: z.enum(FUNNEL_STATUSES),
  version: z.number().int(),
  node_count: z.number().int(),
  updated_at: z.number().int(),
});
export type FunnelGraphSummary = z.infer<typeof funnelGraphSummarySchema>;

/** Structured error of `validateGraph` (HTTP 422 body `errors`). */
export const FUNNEL_GRAPH_ERROR_CODES = [
  'no_traffic_node',
  'multiple_traffic_nodes',
  'edge_unknown_node',
  'edge_invalid_for_kind',
  'missing_fallback',
  'non_positive_weight',
  'route_without_edge',
  'edge_unknown_route',
  'empty_page_group',
  'dead_end_cycle',
  'unreachable_node',
] as const;
export type FunnelGraphErrorCode = (typeof FUNNEL_GRAPH_ERROR_CODES)[number];

export const funnelGraphErrorSchema = z.object({
  code: z.enum(FUNNEL_GRAPH_ERROR_CODES),
  node_id: z.string().optional(),
  edge_id: z.string().optional(),
  message: z.string(),
});
export type FunnelGraphError = z.infer<typeof funnelGraphErrorSchema>;

// ------------------------------------------------------------ links & heatmap

export const funnelLinksSchema = z.object({
  /** `/go/{funnelId}-{trafficSourceId}?…` with the source tokens appended. */
  entrance_url: z.string(),
  /** Query suffix for pages reached directly (no redirect): `f, ts, n, p` + fields. */
  direct_suffix: z.string(),
  /** Action URLs of the selected page node (`/a/1`, `/a/2`, …). */
  action_urls: z.array(z.object({ action: z.number().int(), url: z.string() })),
  /** Universal JS snippet for external pages. */
  snippet: z.string(),
});
export type FunnelLinks = z.infer<typeof funnelLinksSchema>;

export const HEATMAP_METRICS = ['visits', 'flow_pct', 'cvr', 'roi'] as const;
export type HeatmapMetric = (typeof HEATMAP_METRICS)[number];

export const funnelHeatmapSchema = z.object({
  metric: z.enum(HEATMAP_METRICS),
  nodes: z.array(
    z.object({
      node_id: z.string(),
      visits: z.number().int(),
      clicks: z.number().int(),
      conversions: z.number().int(),
      revenue_minor: z.number().int(),
      cost_minor: z.number().int(),
      value: z.number(),
    }),
  ),
  edges: z.array(z.object({ edge_id: z.string(), count: z.number().int(), flow_pct: z.number() })),
});
export type FunnelHeatmap = z.infer<typeof funnelHeatmapSchema>;

// --------------------------------------------------------------------- touches

export const TOUCH_KINDS = ['entrance', 'view', 'click', 'action'] as const;
export type TouchKind = (typeof TOUCH_KINDS)[number];

/** One immutable funnel hit (click-log row). Attribution is recomputed from these. */
export const funnelTouchSchema = z.object({
  id: z.string(),
  ts: z.number().int(),
  visitor_id: z.string(),
  session_id: z.string(),
  funnel_id: z.string(),
  node_id: z.string(),
  page_id: z.string().nullable().optional(),
  traffic_source_id: z.string().nullable().optional(),
  kind: z.enum(TOUCH_KINDS),
  action_number: z.number().int().min(1).max(MAX_FUNNEL_ACTION).nullable().optional(),
  campaign: z.string().max(255).nullable().optional(),
  external_click_id: z.string().max(512).nullable().optional(),
  /** Stored tracking fields by slot (`c1`…`c20`). */
  fields: z.record(z.string(), z.string().max(512)).nullable().optional(),
  cost_minor: z.number().int().nonnegative().nullable().optional(),
});
export type FunnelTouch = z.infer<typeof funnelTouchSchema>;
