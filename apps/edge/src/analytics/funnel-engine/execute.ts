import {
  MAX_FUNNEL_ACTION,
  type ConditionRoute,
  type ConditionRule,
  type FunnelEdge,
  type FunnelNode,
  type FunnelNodeOf,
  type FunnelPage,
  type PageType,
  type ValidatableGraph,
} from '@amable/api-types';
import { localParts } from '../time';
import { mergeDestinationUrl } from './links';
import { resolveTokens, type TokenContext } from './tokens';

/** Uniform random number in [0, 1). Injected so tests are deterministic. */
export type Rng = () => number;

export const FUNNEL_ENGINE_ERROR_CODES = [
  'no_entry',
  'invalid_origin',
  'invalid_action',
  'no_exit',
  'empty_page_group',
  'loop_limit',
] as const;
export type FunnelEngineErrorCode = (typeof FUNNEL_ENGINE_ERROR_CODES)[number];

/** Raised when a broken graph leaves the engine without a destination. */
export class FunnelEngineError extends Error {
  override readonly name = 'FunnelEngineError';
  constructor(
    readonly code: FunnelEngineErrorCode,
    message: string,
    readonly nodeId?: string,
  ) {
    super(message);
  }
}

/** Per-visit routing state, kept by the caller between steps. */
export interface FunnelSessionState {
  /** Node of the page the visitor is on (origin of the next action). */
  currentNodeId?: string | null;
  currentPageId?: string | null;
  /** Previous rotator choices (edge ids, oldest first) by node id. */
  rotations?: Record<string, string[]>;
  tags?: string[];
}

export type FunnelEvent =
  /** Tracking link hit; `nodeId`/`pageId` come from `/go/{f}-{ts}/{nodeId}/{pageId}`. */
  | { type: 'entrance'; nodeId?: string; pageId?: string }
  /** Action link `/a/N`; `fromNodeId` overrides the state origin (`rn`, default path). */
  | { type: 'action'; action: number; fromNodeId?: string };

/** Visit attributes used by conditions and tokens. */
export interface FunnelVisitContext extends TokenContext {
  /** IANA time zone for `hour` / `weekday` (default UTC). */
  timezone?: string | null;
  region?: string | null;
  city?: string | null;
  language?: string | null;
  referrer?: string | null;
  /** Public URL of a page built with the AmableCRM page builder. */
  hostedPageUrl?: (amablePageId: string) => string | undefined;
}

export interface FunnelDestination {
  nodeId: string;
  kind: 'page' | 'external';
  pageId?: string;
  pageType?: PageType;
  amablePageId?: string;
  /** Final URL with data passing resolved and `vid` appended (empty if a hosted page has no URL). */
  url: string;
}

export type FunnelEffect =
  | { type: 'tag'; nodeId: string; add: string[]; remove: string[] }
  | {
      type: 'webhook';
      nodeId: string;
      url: string;
      method: 'GET' | 'POST';
      headers: Record<string, string>;
      body?: string;
    };

export interface FunnelStepResult {
  destination: FunnelDestination;
  /** Nodes entered during this step, in order, ending with the destination node. */
  path: string[];
  /** Edges traversed during this step, in order. */
  edgeIds: string[];
  effects: FunnelEffect[];
  nextState: FunnelNextState;
}

export interface FunnelNextState extends FunnelSessionState {
  currentNodeId: string;
  currentPageId: string | null;
  rotations: Record<string, string[]>;
  tags: string[];
}

const MAX_HOPS = 64;

interface GraphIndex {
  all: Map<string, FunnelNode>;
  live: Map<string, FunnelNode>;
  /** Outgoing edges whose target is live, by source node id. */
  out: Map<string, FunnelEdge[]>;
}

function indexGraph(graph: ValidatableGraph): GraphIndex {
  const all = new Map<string, FunnelNode>();
  const live = new Map<string, FunnelNode>();
  for (const node of graph.nodes) {
    all.set(node.id, node);
    if (node.deleted_at == null) live.set(node.id, node);
  }
  const out = new Map<string, FunnelEdge[]>();
  for (const edge of graph.edges) {
    if (!live.has(edge.to)) continue;
    out.set(edge.from, [...(out.get(edge.from) ?? []), edge]);
  }
  return { all, live, out };
}

function defaultEdge(g: GraphIndex, nodeId: string): FunnelEdge | undefined {
  return g.out.get(nodeId)?.find((e) => e.via.type === 'default');
}

function weightedPick<T>(items: readonly T[], weight: (item: T) => number, rng: Rng): T | undefined {
  const total = items.reduce((sum, item) => sum + weight(item), 0);
  if (items.length === 0 || !(total > 0)) return undefined;
  const r = Math.min(Math.max(rng(), 0), 1) * total;
  let acc = 0;
  for (const item of items) {
    acc += weight(item);
    if (r < acc) return item;
  }
  return items[items.length - 1];
}

function pickRotatorEdge(
  g: GraphIndex,
  node: FunnelNodeOf<'rotator'>,
  rotations: Record<string, string[]>,
  rng: Rng,
): FunnelEdge | undefined {
  const candidates = (g.out.get(node.id) ?? []).filter((e) => e.via.type === 'weight' && e.via.weight > 0);
  const weight = (e: FunnelEdge) => (e.via.type === 'weight' ? e.via.weight : 0);
  const ids = new Set(candidates.map((e) => e.id));
  const history = (rotations[node.id] ?? []).filter((id) => ids.has(id));

  switch (node.config.stickiness) {
    case 'sticky': {
      const previous = candidates.find((e) => e.id === history[history.length - 1]);
      const chosen = previous ?? weightedPick(candidates, weight, rng);
      if (chosen) rotations[node.id] = [chosen.id];
      return chosen;
    }
    case 'anti_affinity': {
      let remaining = candidates.filter((e) => !history.includes(e.id));
      let kept = history;
      if (remaining.length === 0) {
        remaining = candidates;
        kept = [];
      }
      const chosen = weightedPick(remaining, weight, rng);
      if (chosen) rotations[node.id] = [...kept, chosen.id];
      return chosen;
    }
    default:
      return weightedPick(candidates, weight, rng);
  }
}

// ------------------------------------------------------------------ conditions

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

function localClock(now: number, timeZone: string | null | undefined): { hour: number; weekday: number } {
  let parts;
  try {
    parts = localParts(now, timeZone || 'UTC');
  } catch {
    parts = localParts(now, 'UTC');
  }
  return { hour: parts.hour, weekday: new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay() };
}

const present = (v: string | null | undefined): string[] => (v == null || v === '' ? [] : [v]);

/** Values of a condition attribute for this visit (several for tags, language, weekday). */
export function conditionAttributeValues(
  attr: string,
  ctx: FunnelVisitContext,
  tags: readonly string[],
  now: number,
): string[] {
  if (attr.startsWith('field:')) {
    const name = attr.slice(6);
    return present(ctx.fields?.[name] ?? ctx.data?.[name]);
  }
  switch (attr) {
    case 'country':
      return present(ctx.country);
    case 'region':
      return present(ctx.region);
    case 'city':
      return present(ctx.city);
    case 'device':
      return present(ctx.device);
    case 'os':
      return present(ctx.os);
    case 'browser':
      return present(ctx.browser);
    case 'referrer':
      return present(ctx.referrer);
    case 'traffic_source':
      return present(ctx.trafficSourceId);
    case 'campaign':
      return present(ctx.campaign);
    case 'tag':
      return [...tags];
    case 'language': {
      const tag = (ctx.language ?? '').split(/[,;]/)[0]!.trim();
      if (tag === '') return [];
      const primary = tag.split(/[-_]/)[0]!;
      return primary === tag ? [tag] : [tag, primary];
    }
    case 'hour':
      return [String(localClock(now, ctx.timezone).hour)];
    case 'weekday': {
      // ISO number (Monday = 1 … Sunday = 7) first, so numeric operators use it.
      const day = localClock(now, ctx.timezone).weekday;
      return [String(day === 0 ? 7 : day), WEEKDAYS[day]!];
    }
    default:
      return [];
  }
}

function firstNumber(values: readonly string[]): number {
  for (const v of values) {
    if (v.trim() === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return Number.NaN;
}

/** Evaluates one rule against the attribute values (string comparisons are case-insensitive). */
export function evaluateRule(rule: ConditionRule, attrValues: readonly string[]): boolean {
  const values = attrValues.map((v) => v.toLowerCase());
  const targets = rule.values.map((v) => v.trim().toLowerCase()).filter((v) => v !== '');
  const contains = () => values.some((v) => targets.some((t) => v.includes(t)));
  switch (rule.op) {
    case 'exists':
      return values.length > 0;
    case 'not_exists':
      return values.length === 0;
    case 'is':
      return values.some((v) => targets.includes(v));
    case 'is_not':
      return !values.some((v) => targets.includes(v));
    case 'contains':
      return contains();
    case 'not_contains':
      return !contains();
    case 'starts_with':
      return values.some((v) => targets.some((t) => v.startsWith(t)));
    case 'gt':
      return firstNumber(values) > firstNumber(targets);
    case 'lt':
      return firstNumber(values) < firstNumber(targets);
    case 'between': {
      const x = firstNumber(values);
      const lo = firstNumber(targets.slice(0, 1));
      const hi = firstNumber(targets.slice(1, 2));
      if ([x, lo, hi].some(Number.isNaN)) return false;
      // Inverted bounds wrap around (e.g. hour between 22 and 2).
      return lo <= hi ? x >= lo && x <= hi : x >= lo || x <= hi;
    }
    default:
      return false;
  }
}

/** A route matches when every group matches (ANY/ALL of its rules). */
export function routeMatches(
  route: ConditionRoute,
  ctx: FunnelVisitContext,
  tags: readonly string[],
  now: number,
): boolean {
  if (route.groups.length === 0) return false;
  return route.groups.every((group) => {
    const test = (rule: ConditionRule) => evaluateRule(rule, conditionAttributeValues(rule.attr, ctx, tags, now));
    return group.match === 'all' ? group.rules.every(test) : group.rules.some(test);
  });
}

function pickConditionEdge(
  g: GraphIndex,
  node: FunnelNodeOf<'condition'>,
  ctx: FunnelVisitContext,
  tags: readonly string[],
  now: number,
): FunnelEdge | undefined {
  const routes = [...node.config.routes].sort((a, b) => a.priority - b.priority);
  const matched = routes.find((r) => routeMatches(r, ctx, tags, now));
  const edges = g.out.get(node.id) ?? [];
  const routeEdge = matched && edges.find((e) => e.via.type === 'route' && e.via.route_id === matched.id);
  return routeEdge ?? defaultEdge(g, node.id);
}

// ------------------------------------------------------------------ page groups

function choosePage(
  node: FunnelNodeOf<'page_group'>,
  requestedPageId: string | undefined,
  incomingAction: number | undefined,
  rng: Rng,
): FunnelPage | undefined {
  const active = node.config.pages.filter((p) => !p.paused);
  if (active.length === 0) return undefined;
  const requested = requestedPageId ? active.find((p) => p.id === requestedPageId) : undefined;
  if (requested) return requested;
  if (node.config.map_action_to_page) {
    return (incomingAction !== undefined ? active[incomingAction - 1] : undefined) ?? active[0];
  }
  return weightedPick(active, (p) => p.weight, rng);
}

function webhookEffect(node: FunnelNodeOf<'webhook'>, ctx: TokenContext, tags: readonly string[], now: number): FunnelEffect {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(node.config.headers ?? {})) headers[k] = resolveTokens(v, ctx, 'raw');
  const effect: FunnelEffect = {
    type: 'webhook',
    nodeId: node.id,
    url: resolveTokens(node.config.url, ctx),
    method: node.config.method,
    headers,
  };
  if (node.config.method === 'POST') {
    effect.body =
      node.config.body !== undefined
        ? resolveTokens(node.config.body, ctx, 'json')
        : JSON.stringify({
            event: 'funnel.webhook',
            ts: now,
            funnel_id: ctx.funnelId ?? null,
            node_id: node.id,
            visitor_id: ctx.visitorId ?? null,
            hit_id: ctx.hitId ?? null,
            traffic_source_id: ctx.trafficSourceId ?? null,
            campaign: ctx.campaign ?? null,
            external: ctx.external ?? null,
            fields: ctx.fields ?? {},
            data: ctx.data ?? {},
            tags,
          });
  }
  return effect;
}

/**
 * Runs one routing step: from the entry (traffic node, or the node of the
 * link) or from the action taken on the current page, walks the server-side
 * nodes until a page or an external URL. Pure: randomness comes from `rng`,
 * time from `now`; tag and webhook side effects are returned, not executed.
 * `ctx.hitId` is the hit id of the destination touch. Throws
 * `FunnelEngineError` when the graph offers no destination.
 */
export function executeStep(
  graph: ValidatableGraph,
  state: FunnelSessionState,
  event: FunnelEvent,
  ctx: FunnelVisitContext,
  rng: Rng,
  now: number,
): FunnelStepResult {
  const g = indexGraph(graph);
  const rotations: Record<string, string[]> = {};
  for (const [id, list] of Object.entries(state.rotations ?? {})) rotations[id] = [...list];
  const tags = new Set(state.tags ?? []);
  const path: string[] = [];
  const edgeIds: string[] = [];
  const effects: FunnelEffect[] = [];

  let node: FunnelNode;
  let requestedPageId: string | undefined;
  let incomingAction: number | undefined;

  if (event.type === 'entrance') {
    const start = event.nodeId !== undefined ? g.live.get(event.nodeId) : undefined;
    const entry = start ?? [...g.live.values()].find((n) => n.kind === 'traffic');
    if (entry === undefined) throw new FunnelEngineError('no_entry', 'the funnel has no active traffic node');
    node = entry;
    requestedPageId = start ? event.pageId : undefined;
  } else {
    if (!Number.isInteger(event.action) || event.action < 1 || event.action > MAX_FUNNEL_ACTION) {
      throw new FunnelEngineError('invalid_action', `invalid action number ${event.action}`);
    }
    const originId = event.fromNodeId ?? state.currentNodeId ?? undefined;
    // A soft-deleted origin still routes: the visitor may be on its page already.
    const origin = originId !== undefined ? g.all.get(originId) : undefined;
    if (origin === undefined || origin.kind !== 'page_group') {
      throw new FunnelEngineError('invalid_origin', 'the action has no page node to start from', originId);
    }
    const edges = g.out.get(origin.id) ?? [];
    const action = event.action;
    const edge =
      edges.find((e) => e.via.type === 'action' && e.via.actions.includes(action)) ?? defaultEdge(g, origin.id);
    if (edge === undefined) throw new FunnelEngineError('no_exit', `action ${action} leads nowhere`, origin.id);
    edgeIds.push(edge.id);
    node = g.live.get(edge.to)!;
    incomingAction = action;
  }

  const tokensFor = (nodeId: string): TokenContext => ({ ...ctx, currentNodeId: nodeId });
  const finish = (destination: FunnelDestination): FunnelStepResult => ({
    destination,
    path,
    edgeIds,
    effects,
    nextState: {
      currentNodeId: destination.nodeId,
      currentPageId: destination.pageId ?? null,
      rotations,
      tags: [...tags],
    },
  });

  for (let hops = 0; ; hops++) {
    if (hops >= MAX_HOPS) throw new FunnelEngineError('loop_limit', 'the funnel loops without a destination', node.id);
    path.push(node.id);
    let edge: FunnelEdge | undefined;

    switch (node.kind) {
      case 'page_group': {
        const page = choosePage(node, requestedPageId, incomingAction, rng);
        if (page !== undefined) {
          const base =
            page.url ?? (page.amable_page_id !== undefined ? ctx.hostedPageUrl?.(page.amable_page_id) : undefined) ?? '';
          const destination: FunnelDestination = {
            nodeId: node.id,
            kind: 'page',
            pageId: page.id,
            pageType: node.config.page_type,
            url: mergeDestinationUrl(base, node.config.data_params, page.data_params, {
              tokens: tokensFor(node.id),
              vid: ctx.visitorId,
            }),
          };
          if (page.amable_page_id !== undefined) destination.amablePageId = page.amable_page_id;
          return finish(destination);
        }
        edge = defaultEdge(g, node.id);
        if (edge === undefined) {
          throw new FunnelEngineError('empty_page_group', 'the page group has no active page', node.id);
        }
        break;
      }
      case 'external_url': {
        const appended = node.config.append_data;
        return finish({
          nodeId: node.id,
          kind: 'external',
          url: mergeDestinationUrl(node.config.url, node.config.data_params, undefined, {
            tokens: tokensFor(node.id),
            vid: appended ? ctx.visitorId : null,
            params: appended ? ctx.data : null,
          }),
        });
      }
      case 'rotator':
        edge = pickRotatorEdge(g, node, rotations, rng);
        break;
      case 'condition':
        edge = pickConditionEdge(g, node, ctx, [...tags], now);
        break;
      case 'tag':
        for (const t of node.config.remove) tags.delete(t);
        for (const t of node.config.add) tags.add(t);
        effects.push({ type: 'tag', nodeId: node.id, add: [...node.config.add], remove: [...node.config.remove] });
        edge = defaultEdge(g, node.id);
        break;
      case 'webhook':
        effects.push(webhookEffect(node, tokensFor(node.id), [...tags], now));
        edge = defaultEdge(g, node.id);
        break;
      case 'traffic':
      case 'action_proxy':
        edge = defaultEdge(g, node.id);
        break;
    }

    if (edge === undefined) throw new FunnelEngineError('no_exit', `the ${node.kind} node has no usable exit`, node.id);
    edgeIds.push(edge.id);
    node = g.live.get(edge.to)!;
    requestedPageId = undefined;
  }
}
