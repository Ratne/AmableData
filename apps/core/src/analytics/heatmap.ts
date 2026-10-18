import {
  FUNNEL_SERVER_NODE_KINDS,
  type FunnelEdge,
  type FunnelGraph,
  type FunnelHeatmap,
  type FunnelNode,
  type FunnelTouch,
  type HeatmapMetric,
} from '@amable/api-types';

/** Conversion fields the heatmap needs (`ConversionRecord` of the edge store). */
export interface HeatmapConversion {
  hit: string;
  visitor_id: string | null;
  ts: number;
  status: string;
  revenue_minor: number;
}

const SERVER_KINDS: ReadonlySet<string> = new Set(FUNNEL_SERVER_NODE_KINDS);

interface Chain {
  start: number;
  cost: number;
  /** Nodes in visit order, server nodes inferred between two touches included. */
  order: string[];
  seen: Set<string>;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Funnel heatmap from the click-log. Touches are replayed per visitor: every
 * `entrance` (or the first touch of a visitor) starts a journey at the traffic
 * node, `entrance`/`view` touches are visits of their node and `click`/`action`
 * touches are clicks of the page they leave. The server nodes between two
 * visited nodes (rotators, conditions, tags…) are not in the click-log: the
 * shortest edge path through server nodes is credited instead. A conversion
 * credits every node of its journey up to the converting hit; a journey's
 * entrance cost is counted once on every node it reached.
 */
export function computeHeatmap(
  graph: Pick<FunnelGraph, 'nodes' | 'edges'>,
  touches: readonly FunnelTouch[],
  conversions: readonly HeatmapConversion[],
  metric: HeatmapMetric,
): FunnelHeatmap {
  const live = new Map<string, FunnelNode>();
  for (const n of graph.nodes) if (n.deleted_at == null) live.set(n.id, n);
  const edges = graph.edges.filter((e) => live.has(e.from) && live.has(e.to));
  const outgoing = new Map<string, FunnelEdge[]>();
  for (const e of edges) outgoing.set(e.from, [...(outgoing.get(e.from) ?? []), e]);
  const traffic = [...live.values()].find((n) => n.kind === 'traffic');

  const paths = new Map<string, FunnelEdge[]>();
  const pathBetween = (from: string, to: string): FunnelEdge[] => {
    const key = `${from}\u0000${to}`;
    const cached = paths.get(key);
    if (cached !== undefined) return cached;
    let found: FunnelEdge[] = [];
    const queue: Array<{ node: string; path: FunnelEdge[] }> = [{ node: from, path: [] }];
    const visited = new Set([from]);
    search: while (queue.length > 0) {
      const { node, path } = queue.shift() as { node: string; path: FunnelEdge[] };
      for (const e of outgoing.get(node) ?? []) {
        if (e.to === to) {
          found = [...path, e];
          break search;
        }
        const next = live.get(e.to);
        if (next !== undefined && SERVER_KINDS.has(next.kind) && !visited.has(e.to)) {
          visited.add(e.to);
          queue.push({ node: e.to, path: [...path, e] });
        }
      }
    }
    paths.set(key, found);
    return found;
  };

  const visits = new Map<string, number>();
  const clicks = new Map<string, number>();
  const cost = new Map<string, number>();
  const edgeCount = new Map<string, number>();
  const inc = (m: Map<string, number>, k: string, by = 1) => m.set(k, (m.get(k) ?? 0) + by);

  const visit = (chain: Chain, nodeId: string) => {
    inc(visits, nodeId);
    chain.order.push(nodeId);
    if (!chain.seen.has(nodeId)) {
      chain.seen.add(nodeId);
      inc(cost, nodeId, chain.cost);
    }
  };
  const move = (chain: Chain, from: string, to: string) => {
    for (const e of pathBetween(from, to)) {
      inc(edgeCount, e.id);
      if (e.to !== to) visit(chain, e.to);
    }
  };

  const byVisitor = new Map<string, FunnelTouch[]>();
  for (const t of touches) {
    if (!live.has(t.node_id)) continue;
    byVisitor.set(t.visitor_id, [...(byVisitor.get(t.visitor_id) ?? []), t]);
  }

  let entrances = 0;
  const atTouch = new Map<string, { chain: Chain; index: number }>();
  const chainsOf = new Map<string, Chain[]>();
  for (const [visitorId, list] of byVisitor) {
    list.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const chains: Chain[] = [];
    let chain: Chain | null = null;
    let prev: string | null = null;
    let clicked = false;
    for (const t of list) {
      const arrival = t.kind === 'entrance' || t.kind === 'view';
      if (t.kind === 'entrance' || chain === null) {
        chain = { start: t.ts, cost: t.cost_minor ?? 0, order: [], seen: new Set() };
        chains.push(chain);
        entrances += 1;
        prev = null;
        clicked = false;
        if (traffic !== undefined && t.node_id !== traffic.id) {
          visit(chain, traffic.id);
          prev = traffic.id;
        }
      }
      if (arrival) {
        if (t.node_id !== prev || clicked || chain.order.length === 0) {
          if (prev !== null) move(chain, prev, t.node_id);
          visit(chain, t.node_id);
        }
        clicked = false;
      } else {
        inc(clicks, t.node_id);
        clicked = true;
      }
      prev = t.node_id;
      atTouch.set(t.id, { chain, index: chain.order.length });
    }
    chainsOf.set(visitorId, chains);
  }

  const converted = new Map<string, number>();
  const revenue = new Map<string, number>();
  for (const conv of conversions) {
    if (conv.status === 'rejected') continue;
    let target = atTouch.get(conv.hit);
    if (target === undefined && conv.visitor_id !== null) {
      const chain = (chainsOf.get(conv.visitor_id) ?? []).filter((ch) => ch.start <= conv.ts).at(-1);
      if (chain !== undefined) target = { chain, index: chain.order.length };
    }
    if (target === undefined) continue;
    for (const nodeId of new Set(target.chain.order.slice(0, target.index))) {
      inc(converted, nodeId);
      inc(revenue, nodeId, conv.revenue_minor);
    }
  }

  return {
    metric,
    nodes: [...live.values()].map((n) => {
      const v = visits.get(n.id) ?? 0;
      const conv = converted.get(n.id) ?? 0;
      const rev = revenue.get(n.id) ?? 0;
      const spent = cost.get(n.id) ?? 0;
      const value =
        metric === 'visits'
          ? v
          : metric === 'flow_pct'
            ? entrances > 0
              ? (v / entrances) * 100
              : 0
            : metric === 'cvr'
              ? v > 0
                ? (conv / v) * 100
                : 0
              : spent > 0
                ? ((rev - spent) / spent) * 100
                : 0;
      return {
        node_id: n.id,
        visits: v,
        clicks: clicks.get(n.id) ?? 0,
        conversions: conv,
        revenue_minor: rev,
        cost_minor: spent,
        value: round2(value),
      };
    }),
    edges: edges.map((e) => {
      const count = edgeCount.get(e.id) ?? 0;
      return { edge_id: e.id, count, flow_pct: entrances > 0 ? round2((count / entrances) * 100) : 0 };
    }),
  };
}
