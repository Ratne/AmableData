import type {
  FunnelEdge,
  FunnelGraph,
  FunnelHeatmap,
  FunnelNode,
  HeatmapMetric,
} from '@amable/api-types';
import { liveEdges, liveNodes, weightShare } from './state';

/**
 * Sample data for tests and local previews (the builder itself runs on the
 * funnel API): a valid sample graph and a deterministic heatmap propagated
 * through the graph.
 */

const T0 = Date.UTC(2026, 9, 15, 10);

export function mockFunnelGraph(id: string): FunnelGraph {
  const nodes: FunnelNode[] = [
    { id: 'n1', kind: 'traffic', label: 'Traffic', position: { x: 0, y: 160 }, config: {} },
    {
      id: 'n2',
      kind: 'condition',
      label: 'Geo split',
      position: { x: 280, y: 140 },
      config: {
        routes: [
          {
            id: 'r1',
            label: 'Italy mobile',
            priority: 1,
            groups: [
              {
                match: 'all',
                rules: [
                  { attr: 'country', op: 'is', values: ['IT'] },
                  { attr: 'device', op: 'is', values: ['mobile'] },
                ],
              },
            ],
          },
        ],
      },
    },
    {
      id: 'n3',
      kind: 'rotator',
      label: 'A/B landers',
      position: { x: 580, y: 20 },
      config: { stickiness: 'sticky' },
    },
    {
      id: 'n4',
      kind: 'page_group',
      label: 'Landers',
      position: { x: 880, y: 0 },
      config: {
        page_type: 'lander',
        pages: [
          { id: 'p1', name: 'Quiz lander', amable_page_id: 'pg_quiz', weight: 80, paused: false },
          {
            id: 'p2',
            name: 'Advertorial',
            url: 'https://example.com/advertorial',
            weight: 20,
            paused: false,
          },
        ],
        map_action_to_page: false,
      },
    },
    {
      id: 'n5',
      kind: 'page_group',
      label: 'Offers',
      position: { x: 1180, y: 140 },
      config: {
        page_type: 'offer',
        pages: [
          { id: 'p3', name: 'Checkout', amable_page_id: 'pg_checkout', weight: 100, paused: false },
        ],
        map_action_to_page: false,
      },
    },
    {
      id: 'n6',
      kind: 'tag',
      label: 'Buyer tag',
      position: { x: 1480, y: 140 },
      config: { add: ['buyer'], remove: [] },
    },
    {
      id: 'n7',
      kind: 'external_url',
      label: 'Thank you',
      position: { x: 1780, y: 140 },
      config: { url: 'https://example.com/thanks', append_data: true },
    },
    {
      id: 'n8',
      kind: 'page_group',
      label: 'Opt-in',
      position: { x: 580, y: 300 },
      config: {
        page_type: 'lander',
        pages: [
          { id: 'p4', name: 'Opt-in page', amable_page_id: 'pg_optin', weight: 100, paused: false },
        ],
        map_action_to_page: false,
      },
    },
  ];
  const edges: FunnelEdge[] = [
    { id: 'e1', from: 'n1', to: 'n2', via: { type: 'default' } },
    { id: 'e2', from: 'n2', to: 'n3', via: { type: 'route', route_id: 'r1' } },
    { id: 'e3', from: 'n2', to: 'n8', via: { type: 'default' } },
    { id: 'e4', from: 'n3', to: 'n4', via: { type: 'weight', weight: 50 } },
    { id: 'e5', from: 'n3', to: 'n8', via: { type: 'weight', weight: 50 } },
    { id: 'e6', from: 'n4', to: 'n5', via: { type: 'default' } },
    { id: 'e7', from: 'n8', to: 'n5', via: { type: 'default' } },
    { id: 'e8', from: 'n5', to: 'n6', via: { type: 'default' } },
    { id: 'e9', from: 'n6', to: 'n7', via: { type: 'default' } },
  ];
  return {
    id,
    name: 'Sample funnel',
    group_id: null,
    version: 1,
    nodes,
    edges,
    default_cost_minor: 30,
    ip_anonymize: false,
    status: 'active',
    created_at: T0,
    updated_at: T0,
  };
}

const ENTRANCES = 10_000;
/** Share of visitors of a page that execute an action. */
const PAGE_CTR = 0.42;
const OFFER_CVR = 0.09;
const PAYOUT_MINOR = 4_500;
const COST_PER_ENTRANCE_MINOR = 30;

/** Topological order from the entry nodes; back edges of cycles are ignored. */
function order(nodes: readonly FunnelNode[], edges: readonly FunnelEdge[]): string[] {
  const out: string[] = [];
  const state = new Map<string, 'open' | 'done'>();
  const visit = (id: string) => {
    if (state.has(id)) return;
    state.set(id, 'open');
    for (const e of edges) if (e.from === id && state.get(e.to) !== 'open') visit(e.to);
    state.set(id, 'done');
    out.push(id);
  };
  const entries = nodes.filter((n) => n.kind === 'traffic');
  for (const n of entries.length > 0 ? entries : nodes.slice(0, 1)) visit(n.id);
  for (const n of nodes) visit(n.id);
  return out.reverse();
}

/** Deterministic heatmap: entrances flow through weights, routes and actions. */
export function mockHeatmap(
  graph: Pick<FunnelGraph, 'nodes' | 'edges'>,
  metric: HeatmapMetric,
): FunnelHeatmap {
  const nodes = liveNodes(graph);
  const edges = liveEdges(graph);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const sorted = order(nodes, edges);
  const rank = new Map(sorted.map((id, i) => [id, i]));
  const visits = new Map<string, number>();
  const edgeCount = new Map<string, number>();
  for (const n of nodes) if (n.kind === 'traffic') visits.set(n.id, ENTRANCES);

  for (const id of sorted) {
    const node = byId.get(id);
    const inflow = visits.get(id) ?? 0;
    if (!node || inflow === 0) continue;
    const out = edges.filter((e) => e.from === id && (rank.get(e.to) ?? 0) > (rank.get(id) ?? 0));
    if (out.length === 0) continue;
    const split = (e: FunnelEdge): number => {
      switch (e.via.type) {
        case 'weight':
          return weightShare(graph, e);
        case 'action':
          return PAGE_CTR / out.length;
        default:
          return node.kind === 'page_group' ? PAGE_CTR / out.length : 1 / out.length;
      }
    };
    for (const e of out) {
      const count = Math.round(inflow * split(e));
      edgeCount.set(e.id, count);
      visits.set(e.to, (visits.get(e.to) ?? 0) + count);
    }
  }

  const ownConversions = (n: FunnelNode) =>
    n.kind === 'page_group' && n.config.page_type === 'offer'
      ? Math.round((visits.get(n.id) ?? 0) * OFFER_CVR)
      : 0;
  // Downstream attribution: a node is credited with every conversion after it.
  const downstream = new Map<string, number>();
  for (const id of [...sorted].reverse()) {
    const node = byId.get(id);
    if (!node) continue;
    const v = visits.get(id) ?? 0;
    let total = ownConversions(node);
    for (const e of edges) {
      if (e.from !== id || (rank.get(e.to) ?? 0) <= (rank.get(id) ?? 0)) continue;
      const childVisits = visits.get(e.to) ?? 0;
      const share = childVisits > 0 ? (edgeCount.get(e.id) ?? 0) / childVisits : 0;
      total += (downstream.get(e.to) ?? 0) * share;
    }
    downstream.set(id, Math.min(Math.round(total), v));
  }

  return {
    metric,
    nodes: nodes.map((n) => {
      const v = visits.get(n.id) ?? 0;
      const conversions = downstream.get(n.id) ?? 0;
      const revenue = conversions * PAYOUT_MINOR;
      const cost = v * COST_PER_ENTRANCE_MINOR;
      const clicks = n.kind === 'page_group' ? Math.round(v * PAGE_CTR) : 0;
      const value =
        metric === 'visits'
          ? v
          : metric === 'flow_pct'
            ? (v / ENTRANCES) * 100
            : metric === 'cvr'
              ? v > 0
                ? (conversions / v) * 100
                : 0
              : cost > 0
                ? ((revenue - cost) / cost) * 100
                : 0;
      return {
        node_id: n.id,
        visits: v,
        clicks,
        conversions,
        revenue_minor: revenue,
        cost_minor: cost,
        value,
      };
    }),
    edges: edges.map((e) => {
      const count = edgeCount.get(e.id) ?? 0;
      return { edge_id: e.id, count, flow_pct: (count / ENTRANCES) * 100 };
    }),
    truncated: false,
  };
}
