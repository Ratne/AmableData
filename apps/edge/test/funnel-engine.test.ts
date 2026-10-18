import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  funnelEdgeSchema,
  funnelNodeSchema,
  validateGraph as sharedValidateGraph,
  type ConditionRule,
  type FunnelEdge,
  type FunnelNode,
} from '@amable/api-types';
import {
  FunnelEngineError,
  buildActionUrl,
  buildDirectSuffix,
  buildDirectUrl,
  buildEntranceUrl,
  conditionAttributeValues,
  evaluateRule,
  executeStep,
  isReservedUrlParam,
  mergeDestinationUrl,
  reservedDataParamKeys,
  resolveTokens,
  validateGraph,
  type FunnelEvent,
  type FunnelSessionState,
  type FunnelVisitContext,
  type LinkSource,
  type Rng,
} from '../src/analytics/funnel-engine';

const T0 = Date.UTC(2026, 9, 15, 10); // Thursday 10:00 UTC

const node = (input: unknown): FunnelNode => funnelNodeSchema.parse(input);
const edge = (id: string, from: string, to: string, via: unknown = { type: 'default' }): FunnelEdge =>
  funnelEdgeSchema.parse({ id, from, to, via });
const page = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  url: `https://pages.example.com/${id}`,
  weight: 1,
  ...extra,
});
const pageGroup = (id: string, pages: unknown[], extra: Record<string, unknown> = {}) =>
  node({ id, kind: 'page_group', config: { page_type: 'offer', pages, ...extra } });
const traffic = () => node({ id: 'traffic', kind: 'traffic' });

/** Deterministic RNG walking the grid 0, 1/n, 2/n, … */
function gridRng(n: number): Rng {
  let i = 0;
  return () => (i++ % n) / n;
}
const fixedRng =
  (value: number): Rng =>
  () =>
    value;

const entrance: FunnelEvent = { type: 'entrance' };
const ctx: FunnelVisitContext = { visitorId: 'v1', funnelId: 'f1', trafficSourceId: 'ts1' };

function run(
  graph: { nodes: FunnelNode[]; edges: FunnelEdge[] },
  opts: { state?: FunnelSessionState; event?: FunnelEvent; ctx?: FunnelVisitContext; rng?: Rng; now?: number } = {},
) {
  return executeStep(
    graph,
    opts.state ?? {},
    opts.event ?? entrance,
    opts.ctx ?? ctx,
    opts.rng ?? fixedRng(0),
    opts.now ?? T0,
  );
}

function expectEngineError(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(FunnelEngineError);
    expect((err as FunnelEngineError).code).toBe(code);
    return;
  }
  throw new Error(`expected FunnelEngineError ${code}`);
}

// ------------------------------------------------------------------ rotation

describe('weighted rotation', () => {
  const rotatorGraph = (stickiness: string, deletedC = false) => ({
    nodes: [
      traffic(),
      node({ id: 'rot', kind: 'rotator', config: { stickiness } }),
      pageGroup('a', [page('pa')]),
      pageGroup('b', [page('pb')]),
      node({ ...pageGroup('c', [page('pc')]), deleted_at: deletedC ? 1 : null }),
    ],
    edges: [
      edge('e0', 'traffic', 'rot'),
      edge('ea', 'rot', 'a', { type: 'weight', weight: 50 }),
      edge('eb', 'rot', 'b', { type: 'weight', weight: 30 }),
      edge('ec', 'rot', 'c', { type: 'weight', weight: 20 }),
    ],
  });

  it('splits 1000 draws exactly by relative weight', () => {
    const graph = rotatorGraph('none');
    const rng = gridRng(1000);
    const counts: Record<string, number> = {};
    for (let i = 0; i < 1000; i++) {
      const { destination } = run(graph, { rng });
      counts[destination.nodeId] = (counts[destination.nodeId] ?? 0) + 1;
    }
    expect(counts).toEqual({ a: 500, b: 300, c: 200 });
  });

  it('rotates pages of a group by weight, skipping paused pages', () => {
    const graph = {
      nodes: [
        traffic(),
        pageGroup('g', [page('p1', { weight: 1 }), page('p2', { weight: 3 }), page('p3', { weight: 9, paused: true })]),
      ],
      edges: [edge('e0', 'traffic', 'g')],
    };
    const rng = gridRng(1000);
    const counts: Record<string, number> = {};
    for (let i = 0; i < 1000; i++) {
      const { destination } = run(graph, { rng });
      counts[destination.pageId!] = (counts[destination.pageId!] ?? 0) + 1;
    }
    expect(counts).toEqual({ p1: 250, p2: 750 });
  });

  it('never picks soft-deleted targets', () => {
    const graph = rotatorGraph('none', true);
    const rng = gridRng(800);
    const counts: Record<string, number> = {};
    for (let i = 0; i < 800; i++) {
      const { destination } = run(graph, { rng });
      counts[destination.nodeId] = (counts[destination.nodeId] ?? 0) + 1;
    }
    expect(counts).toEqual({ a: 500, b: 300 });
  });

  it('sticky repeats the first destination', () => {
    const graph = rotatorGraph('sticky');
    const rng = gridRng(10);
    let state: FunnelSessionState = {};
    const seen: string[] = [];
    for (let i = 0; i < 10; i++) {
      const r = run(graph, { state, rng });
      seen.push(r.destination.nodeId);
      state = r.nextState;
    }
    expect(new Set(seen)).toEqual(new Set(['a']));
    expect(state.rotations).toEqual({ rot: ['ea'] });
  });

  it('sticky re-picks when the remembered edge is gone', () => {
    const r = run(rotatorGraph('sticky'), { state: { rotations: { rot: ['e_removed'] } }, rng: fixedRng(0.9) });
    expect(r.destination.nodeId).toBe('c');
    expect(r.nextState.rotations).toEqual({ rot: ['ec'] });
  });

  it('anti-affinity cycles through every destination before repeating', () => {
    const graph = rotatorGraph('anti_affinity');
    let state: FunnelSessionState = {};
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      // Always the heaviest pick: without anti-affinity this would be `a` every time.
      const r = run(graph, { state, rng: fixedRng(0) });
      seen.push(r.destination.nodeId);
      state = r.nextState;
    }
    expect(seen).toEqual(['a', 'b', 'c', 'a', 'b', 'c']);
  });

  it('stickiness none keeps no history', () => {
    const r = run(rotatorGraph('none'), { rng: fixedRng(0.6) });
    expect(r.destination.nodeId).toBe('b');
    expect(r.nextState.rotations).toEqual({});
    expect(r.path).toEqual(['traffic', 'rot', 'b']);
    expect(r.edgeIds).toEqual(['e0', 'eb']);
  });
});

// ------------------------------------------------------------------ conditions

describe('condition rules', () => {
  const rule = (attr: string, op: ConditionRule['op'], values: string[] = []): ConditionRule => ({ attr, op, values });
  const visit: FunnelVisitContext = {
    country: 'IT',
    region: 'Lombardia',
    city: 'Milano',
    device: 'mobile',
    os: 'iOS',
    browser: 'Safari',
    language: 'it-IT,it;q=0.9,en;q=0.8',
    referrer: 'https://www.google.com/search?q=crm',
    trafficSourceId: 'ts_meta',
    campaign: 'Spring-Sale',
    fields: { adset: 'retargeting' },
    data: { zone: '42' },
    timezone: 'Europe/Rome',
  };
  const check = (r: ConditionRule, tags: string[] = [], now = T0) =>
    evaluateRule(r, conditionAttributeValues(r.attr, visit, tags, now));

  it.each([
    [rule('country', 'is', ['us', 'it']), true],
    [rule('country', 'is', ['us']), false],
    [rule('country', 'is_not', ['us']), true],
    [rule('country', 'is_not', ['IT']), false],
    [rule('region', 'contains', ['lomb']), true],
    [rule('city', 'not_contains', ['rom']), true],
    [rule('city', 'not_contains', ['mil']), false],
    [rule('device', 'is', ['mobile']), true],
    [rule('os', 'starts_with', ['io']), true],
    [rule('browser', 'starts_with', ['chrome']), false],
    [rule('language', 'is', ['it']), true],
    [rule('language', 'is', ['it-it']), true],
    [rule('language', 'is', ['en']), false],
    [rule('referrer', 'contains', ['google.']), true],
    [rule('traffic_source', 'is', ['ts_meta']), true],
    [rule('campaign', 'starts_with', ['spring']), true],
    [rule('field:adset', 'is', ['retargeting']), true],
    [rule('field:zone', 'gt', ['40']), true],
    [rule('field:zone', 'lt', ['40']), false],
    [rule('field:zone', 'between', ['40', '42']), true],
    [rule('field:zone', 'between', ['43', '50']), false],
    [rule('field:missing', 'exists'), false],
    [rule('field:missing', 'not_exists'), true],
    [rule('field:adset', 'exists'), true],
    [rule('field:missing', 'is_not', ['x']), true],
    [rule('field:missing', 'gt', ['0']), false],
    [rule('field:adset', 'gt', ['0']), false],
  ])('%j → %s', (r, expected) => {
    expect(check(r)).toBe(expected);
  });

  it('matches visitor tags with is / is_not', () => {
    expect(check(rule('tag', 'is', ['vip']), ['buyer', 'vip'])).toBe(true);
    expect(check(rule('tag', 'is_not', ['vip']), ['buyer'])).toBe(true);
    expect(check(rule('tag', 'is_not', ['vip']), ['vip'])).toBe(false);
    expect(check(rule('tag', 'exists'), [])).toBe(false);
  });

  it('computes hour and weekday in the visit time zone', () => {
    // 10:00 UTC on Thursday = 12:00 in Rome (CEST), 06:00 in New York.
    expect(conditionAttributeValues('hour', visit, [], T0)).toEqual(['12']);
    expect(conditionAttributeValues('hour', { timezone: 'America/New_York' }, [], T0)).toEqual(['6']);
    expect(conditionAttributeValues('hour', {}, [], T0)).toEqual(['10']);
    expect(conditionAttributeValues('weekday', visit, [], T0)).toEqual(['4', 'thu']);
    // 23:00 UTC Thursday is already Friday 01:00 in Rome.
    const late = Date.UTC(2026, 9, 15, 23);
    expect(conditionAttributeValues('weekday', visit, [], late)).toEqual(['5', 'fri']);
    expect(conditionAttributeValues('weekday', {}, [], late)).toEqual(['4', 'thu']);
    expect(conditionAttributeValues('hour', { timezone: 'Not/AZone' }, [], T0)).toEqual(['10']);
  });

  it('applies time operators to the local clock', () => {
    expect(check(rule('hour', 'is', ['12']))).toBe(true);
    expect(check(rule('hour', 'between', ['9', '17']))).toBe(true);
    expect(check(rule('hour', 'gt', ['11']))).toBe(true);
    expect(check(rule('hour', 'lt', ['11']))).toBe(false);
    const late = Date.UTC(2026, 9, 15, 23); // 01:00 in Rome
    expect(check(rule('hour', 'between', ['22', '2']), [], late)).toBe(true);
    expect(check(rule('hour', 'between', ['22', '2']), [], T0)).toBe(false);
    expect(check(rule('weekday', 'is', ['thu']))).toBe(true);
    expect(check(rule('weekday', 'is', ['fri']), [], late)).toBe(true);
    expect(check(rule('weekday', 'between', ['1', '5']))).toBe(true);
    expect(check(rule('weekday', 'gt', ['5']))).toBe(false);
  });

  const conditionGraph = () => ({
    nodes: [
      traffic(),
      node({
        id: 'cond',
        kind: 'condition',
        config: {
          routes: [
            {
              id: 'r_late',
              label: 'Mobile Italy',
              priority: 5,
              groups: [{ match: 'all', rules: [rule('country', 'is', ['it']), rule('device', 'is', ['mobile'])] }],
            },
            {
              id: 'r_first',
              label: 'US or desktop, and Safari',
              priority: 1,
              groups: [
                { match: 'any', rules: [rule('country', 'is', ['us']), rule('device', 'is', ['desktop'])] },
                { match: 'all', rules: [rule('browser', 'is', ['safari'])] },
              ],
            },
            {
              id: 'r_unwired',
              label: 'Germany',
              priority: 0,
              groups: [{ match: 'any', rules: [rule('country', 'is', ['de'])] }],
            },
          ],
        },
      }),
      pageGroup('mobile_it', [page('m')]),
      pageGroup('us_desktop', [page('u')]),
      pageGroup('fallback', [page('f')]),
    ],
    edges: [
      edge('e0', 'traffic', 'cond'),
      edge('e_late', 'cond', 'mobile_it', { type: 'route', route_id: 'r_late' }),
      edge('e_first', 'cond', 'us_desktop', { type: 'route', route_id: 'r_first' }),
      edge('e_def', 'cond', 'fallback'),
    ],
  });

  it('evaluates routes by priority with groups in AND', () => {
    const g = conditionGraph();
    expect(run(g, { ctx: { country: 'US', device: 'mobile', browser: 'Safari' } }).destination.nodeId).toBe(
      'us_desktop',
    );
    expect(run(g, { ctx: { country: 'IT', device: 'desktop', browser: 'Safari' } }).destination.nodeId).toBe(
      'us_desktop',
    );
    expect(run(g, { ctx: { country: 'IT', device: 'mobile', browser: 'Chrome' } }).destination.nodeId).toBe(
      'mobile_it',
    );
    expect(run(g, { ctx: { country: 'US', device: 'mobile', browser: 'Chrome' } }).destination.nodeId).toBe(
      'fallback',
    );
  });

  it('falls back to the default route when nothing matches or the route is unwired', () => {
    const g = conditionGraph();
    expect(run(g, { ctx: {} }).destination.nodeId).toBe('fallback');
    expect(run(g, { ctx: { country: 'DE', browser: 'Safari', device: 'desktop' } }).destination.nodeId).toBe(
      'fallback',
    );
  });

  it('sees tags added earlier in the same step', () => {
    const g = conditionGraph();
    g.nodes.push(node({ id: 'tagger', kind: 'tag', config: { add: ['vip'] } }));
    const cond = g.nodes[1] as Extract<FunnelNode, { kind: 'condition' }>;
    cond.config.routes.push({
      id: 'r_vip',
      label: 'VIP',
      priority: 0,
      groups: [{ match: 'any', rules: [rule('tag', 'is', ['vip'])] }],
    });
    g.edges[0] = edge('e0', 'traffic', 'tagger');
    g.edges.push(edge('e_tag', 'tagger', 'cond'), edge('e_vip', 'cond', 'mobile_it', { type: 'route', route_id: 'r_vip' }));
    const r = run(g, { ctx: {} });
    expect(r.destination.nodeId).toBe('mobile_it');
    expect(r.nextState.tags).toEqual(['vip']);
  });
});

// ------------------------------------------------------------------ fallbacks

describe('default fallback on every node kind', () => {
  it('follows the single default exit of traffic, tag, webhook and action proxy', () => {
    const graph = {
      nodes: [
        traffic(),
        node({ id: 'tag', kind: 'tag', config: { add: ['a'], remove: ['old'] } }),
        node({ id: 'hook', kind: 'webhook', config: { url: 'https://hooks.example.com/in?v={visitor}', method: 'GET' } }),
        node({ id: 'proxy', kind: 'action_proxy' }),
        pageGroup('end', [page('p')]),
      ],
      edges: [edge('e1', 'traffic', 'tag'), edge('e2', 'tag', 'hook'), edge('e3', 'hook', 'proxy'), edge('e4', 'proxy', 'end')],
    };
    const r = run(graph, { state: { tags: ['old', 'keep'] } });
    expect(r.path).toEqual(['traffic', 'tag', 'hook', 'proxy', 'end']);
    expect(r.nextState.tags).toEqual(['keep', 'a']);
    expect(r.effects).toEqual([
      { type: 'tag', nodeId: 'tag', add: ['a'], remove: ['old'] },
      { type: 'webhook', nodeId: 'hook', url: 'https://hooks.example.com/in?v=v1', method: 'GET', headers: {} },
    ]);
  });

  it('routes an unmapped action of a page group through its default exit', () => {
    const graph = {
      nodes: [traffic(), pageGroup('lander', [page('l')]), pageGroup('offer_a', [page('a')]), pageGroup('offer_b', [page('b')])],
      edges: [
        edge('e0', 'traffic', 'lander'),
        edge('e1', 'lander', 'offer_a', { type: 'action', actions: [1, 2] }),
        edge('e2', 'lander', 'offer_b'),
      ],
    };
    const state = { currentNodeId: 'lander' };
    expect(run(graph, { state, event: { type: 'action', action: 2 } }).destination.nodeId).toBe('offer_a');
    const r = run(graph, { state, event: { type: 'action', action: 7 } });
    expect(r.destination.nodeId).toBe('offer_b');
    expect(r.path).toEqual(['offer_b']);
    expect(r.edgeIds).toEqual(['e2']);
    expect(r.nextState).toMatchObject({ currentNodeId: 'offer_b', currentPageId: 'b' });
  });

  it('skips an action edge whose target is soft-deleted', () => {
    const graph = {
      nodes: [
        traffic(),
        pageGroup('lander', [page('l')]),
        node({ ...pageGroup('gone', [page('g')]), deleted_at: 1 }),
        pageGroup('safe', [page('s')]),
      ],
      edges: [
        edge('e0', 'traffic', 'lander'),
        edge('e1', 'lander', 'gone', { type: 'action', actions: [1] }),
        edge('e2', 'lander', 'safe'),
      ],
    };
    const r = run(graph, { state: { currentNodeId: 'lander' }, event: { type: 'action', action: 1 } });
    expect(r.destination.nodeId).toBe('safe');
  });

  it('passes through a page group whose pages are all paused', () => {
    const graph = {
      nodes: [traffic(), pageGroup('paused', [page('x', { paused: true })]), pageGroup('next', [page('n')])],
      edges: [edge('e0', 'traffic', 'paused'), edge('e1', 'paused', 'next')],
    };
    expect(run(graph).path).toEqual(['traffic', 'paused', 'next']);
  });

  it('routes actions taken on a soft-deleted page node', () => {
    const graph = {
      nodes: [traffic(), node({ ...pageGroup('old', [page('o')]), deleted_at: 1 }), pageGroup('next', [page('n')])],
      edges: [edge('e1', 'old', 'next')],
    };
    const r = run(graph, { state: { currentNodeId: 'old' }, event: { type: 'action', action: 1 } });
    expect(r.destination.nodeId).toBe('next');
  });

  it('throws typed errors when no destination exists', () => {
    const lone = { nodes: [traffic()], edges: [] };
    expectEngineError(() => run(lone), 'no_exit');
    expectEngineError(() => run({ nodes: [pageGroup('p', [page('x')])], edges: [] }), 'no_entry');
    expectEngineError(
      () => run({ nodes: [traffic(), pageGroup('p', [page('x', { paused: true })])], edges: [edge('e', 'traffic', 'p')] }),
      'empty_page_group',
    );
    expectEngineError(() => run(lone, { event: { type: 'action', action: 1 } }), 'invalid_origin');
    expectEngineError(
      () => run(lone, { state: { currentNodeId: 'traffic' }, event: { type: 'action', action: 1 } }),
      'invalid_origin',
    );
    const pages = { nodes: [traffic(), pageGroup('p', [page('x')])], edges: [edge('e', 'traffic', 'p')] };
    expectEngineError(() => run(pages, { state: { currentNodeId: 'p' }, event: { type: 'action', action: 0 } }), 'invalid_action');
    expectEngineError(() => run(pages, { state: { currentNodeId: 'p' }, event: { type: 'action', action: 1 } }), 'no_exit');
    const rotatorNoExit = {
      nodes: [traffic(), node({ id: 'rot', kind: 'rotator', config: {} })],
      edges: [edge('e', 'traffic', 'rot')],
    };
    expectEngineError(() => run(rotatorNoExit), 'no_exit');
    const conditionNoDefault = {
      nodes: [traffic(), node({ id: 'cond', kind: 'condition', config: { routes: [] } })],
      edges: [edge('e', 'traffic', 'cond')],
    };
    expectEngineError(() => run(conditionNoDefault), 'no_exit');
    const loop = {
      nodes: [traffic(), node({ id: 'a', kind: 'action_proxy' }), node({ id: 'b', kind: 'tag', config: {} })],
      edges: [edge('e0', 'traffic', 'a'), edge('e1', 'a', 'b'), edge('e2', 'b', 'a')],
    };
    expectEngineError(() => run(loop), 'loop_limit');
  });
});

// ------------------------------------------------------------------ page mapping

describe('map_action_to_page', () => {
  const graph = () => ({
    nodes: [
      traffic(),
      pageGroup('wall', [page('w')], { page_type: 'lander' }),
      node({ id: 'proxy', kind: 'action_proxy' }),
      pageGroup('offers', [page('o1'), page('o2'), page('paused', { paused: true }), page('o3'), page('o4')], {
        map_action_to_page: true,
      }),
    ],
    edges: [
      edge('e0', 'traffic', 'wall'),
      edge('e1', 'wall', 'proxy'),
      edge('e2', 'proxy', 'offers'),
    ],
  });
  const act = (action: number) =>
    run(graph(), { state: { currentNodeId: 'wall' }, event: { type: 'action', action }, rng: fixedRng(0.99) });

  it('serves the N-th active page for action N, forwarded by an action proxy', () => {
    expect(act(1).destination.pageId).toBe('o1');
    expect(act(3).destination.pageId).toBe('o3');
    expect(act(4).destination.pageId).toBe('o4');
    expect(act(3).path).toEqual(['proxy', 'offers']);
  });

  it('serves page 1 without an action or for an out-of-range action', () => {
    const g = graph();
    g.edges[0] = edge('e0', 'traffic', 'offers');
    expect(run(g, { rng: fixedRng(0.99) }).destination.pageId).toBe('o1');
    expect(act(9).destination.pageId).toBe('o1');
  });

  it('honours the page requested by the entrance link', () => {
    const r = run(graph(), { event: { type: 'entrance', nodeId: 'offers', pageId: 'o2' } });
    expect(r.destination).toMatchObject({ nodeId: 'offers', pageId: 'o2', pageType: 'offer' });
    expect(r.path).toEqual(['offers']);
    const paused = run(graph(), { event: { type: 'entrance', nodeId: 'offers', pageId: 'paused' } });
    expect(paused.destination.pageId).toBe('o1');
  });

  it('starts from the traffic node when the requested entry node is missing', () => {
    const r = run(graph(), { event: { type: 'entrance', nodeId: 'ghost', pageId: 'o4' } });
    expect(r.path).toEqual(['traffic', 'wall']);
  });
});

// ------------------------------------------------------------------ destinations & effects

describe('destination URLs and effects', () => {
  const visit: FunnelVisitContext = {
    visitorId: 'vis 1',
    hitId: 'hit9',
    funnelId: 'f1',
    trafficSourceId: 'ts1',
    campaign: 'camp&1',
    external: 'gclid_x',
    data: { zone: '42', email: 'a@b.it' },
    fields: { adset: 'as1' },
  };

  it('merges node and page data passing with tokens and appends vid', () => {
    const graph = {
      nodes: [
        traffic(),
        pageGroup(
          'offer',
          [page('o', { url: 'https://network.example/offer?aff=7&sub1=base', data_params: { sub2: '{external}' } })],
          { data_params: { sub1: '{hit}', sub2: 'node', sub3: '{data-zone}-{campaign}', vid: 'x' } },
        ),
      ],
      edges: [edge('e0', 'traffic', 'offer')],
    };
    const r = run(graph, { ctx: visit });
    expect(r.destination.url).toBe(
      'https://network.example/offer?aff=7&sub1=hit9&sub2=gclid_x&sub3=42-camp%261&vid=vis%201',
    );
  });

  it('resolves hosted pages through the context', () => {
    const graph = {
      nodes: [traffic(), pageGroup('lp', [{ id: 'h', name: 'Hosted', amable_page_id: 'pg_1', weight: 1 }])],
      edges: [edge('e0', 'traffic', 'lp')],
    };
    const hosted = run(graph, { ctx: { ...visit, hostedPageUrl: (id) => `https://site.example/p/${id}` } });
    expect(hosted.destination).toMatchObject({ amablePageId: 'pg_1', url: 'https://site.example/p/pg_1?vid=vis%201' });
    expect(run(graph, { ctx: visit }).destination).toMatchObject({ amablePageId: 'pg_1', url: '' });
  });

  it('builds external URLs with or without the data buffer', () => {
    const graph = (append: boolean) => ({
      nodes: [
        traffic(),
        node({
          id: 'ext',
          kind: 'external_url',
          config: { url: 'https://partner.example/in?src=amable', append_data: append, data_params: { cid: '{campaign}' } },
        }),
      ],
      edges: [edge('e0', 'traffic', 'ext')],
    });
    expect(run(graph(true), { ctx: visit }).destination).toEqual({
      nodeId: 'ext',
      kind: 'external',
      url: 'https://partner.example/in?src=amable&zone=42&email=a%40b.it&cid=camp%261&vid=vis%201',
    });
    expect(run(graph(false), { ctx: visit }).destination.url).toBe('https://partner.example/in?src=amable&cid=camp%261');
    expect(run(graph(true), { ctx: visit }).nextState.currentNodeId).toBe('ext');
  });

  it('returns webhooks as effects with resolved url, headers and body', () => {
    const graph = (body?: string) => ({
      nodes: [
        traffic(),
        node({
          id: 'hook',
          kind: 'webhook',
          config: {
            url: 'https://hooks.example.com/{funnel-id}?c={campaign}',
            headers: { 'x-node': '{current-node-id}', 'x-camp': '{campaign}' },
            ...(body !== undefined ? { body } : {}),
          },
        }),
        pageGroup('end', [page('p')]),
      ],
      edges: [edge('e0', 'traffic', 'hook'), edge('e1', 'hook', 'end')],
    });
    const custom = run(graph('{"campaign":"{campaign}","q":"{data-quote}"}'), {
      ctx: { ...visit, data: { quote: 'say "hi"' } },
    });
    expect(custom.effects).toEqual([
      {
        type: 'webhook',
        nodeId: 'hook',
        url: 'https://hooks.example.com/f1?c=camp%261',
        method: 'POST',
        headers: { 'x-node': 'hook', 'x-camp': 'camp&1' },
        body: '{"campaign":"camp&1","q":"say \\"hi\\""}',
      },
    ]);
    expect(JSON.parse((custom.effects[0] as { body: string }).body)).toEqual({ campaign: 'camp&1', q: 'say "hi"' });

    const fallback = run(graph(), { ctx: visit, state: { tags: ['vip'] } });
    const payload = JSON.parse((fallback.effects[0] as { body: string }).body);
    expect(payload).toEqual({
      event: 'funnel.webhook',
      ts: T0,
      funnel_id: 'f1',
      node_id: 'hook',
      visitor_id: 'vis 1',
      hit_id: 'hit9',
      traffic_source_id: 'ts1',
      campaign: 'camp&1',
      external: 'gclid_x',
      fields: { adset: 'as1' },
      data: { zone: '42', email: 'a@b.it' },
      tags: ['vip'],
    });
  });

  it('does not mutate the input state', () => {
    const state: FunnelSessionState = { rotations: { rot: ['ea'] }, tags: ['t'] };
    const graph = {
      nodes: [
        traffic(),
        node({ id: 'rot', kind: 'rotator', config: { stickiness: 'anti_affinity' } }),
        node({ id: 'tag', kind: 'tag', config: { add: ['new'] } }),
        pageGroup('a', [page('a')]),
      ],
      edges: [
        edge('e0', 'traffic', 'rot'),
        edge('ea', 'rot', 'a', { type: 'weight', weight: 1 }),
        edge('eb', 'rot', 'tag', { type: 'weight', weight: 1 }),
        edge('et', 'tag', 'a'),
      ],
    };
    const r = run(graph, { state });
    expect(r.nextState.rotations).toEqual({ rot: ['ea', 'eb'] });
    expect(r.nextState.tags).toEqual(['t', 'new']);
    expect(state).toEqual({ rotations: { rot: ['ea'] }, tags: ['t'] });
  });
});

// ------------------------------------------------------------------ tokens

describe('resolveTokens', () => {
  const full = {
    hitId: 'h1',
    visitorId: 'v1',
    campaign: 'c a',
    external: 'x1',
    funnelId: 'f1',
    trafficSourceId: 'ts1',
    currentNodeId: 'n1',
    country: 'IT',
    device: 'mobile',
    browser: 'Safari',
    os: 'iOS',
    payout: 12.5,
    txid: 'tx/1',
    fields: { adset: 'as1', zone: 'field-wins' },
    slots: { c1: 'one', c20: 'twenty' },
    data: { zone: 'z9', email: 'a+b@c.it' },
  };

  it('resolves every engine token with URL encoding', () => {
    const template =
      '{hit}|{visitor}|{campaign}|{external}|{funnel-id}|{trafficsource-id}|{current-node-id}|{country}|{device}|{browser}|{os}|{payout}|{txid}|{c1}|{c20}|{data-adset}|{data-zone}|{data-email}';
    expect(resolveTokens(template, full)).toBe(
      'h1|v1|c%20a|x1|f1|ts1|n1|IT|mobile|Safari|iOS|12.5|tx%2F1|one|twenty|as1|field-wins|a%2Bb%40c.it',
    );
  });

  it('turns missing values into empty strings, never "undefined"', () => {
    const out = resolveTokens('a={hit}&b={data-nope}&c={c5}&d={payout}&e={txid}', { payout: null });
    expect(out).toBe('a=&b=&c=&d=&e=');
    expect(out).not.toContain('undefined');
    expect(out).not.toContain('null');
  });

  it('leaves unknown placeholders and platform macros literal', () => {
    expect(resolveTokens('{{campaign.id}}|{unknown}|{c21}|{data-}|[zone]', full)).toBe(
      '{{campaign.id}}|{unknown}|{c21}|{data-}|[zone]',
    );
  });

  it('supports raw and JSON encodings', () => {
    expect(resolveTokens('{campaign}/{txid}', full, 'raw')).toBe('c a/tx/1');
    expect(resolveTokens('"{data-q}"', { data: { q: 'a"b\\c' } }, 'json')).toBe('"a\\"b\\\\c"');
  });

  it('rejects reserved keys in data passing', () => {
    expect(reservedDataParamKeys({ vid: '1', N: '2', sub1: '{hit}', Rev: '3', hit: '4', tx: '5' })).toEqual([
      'vid',
      'N',
      'Rev',
      'hit',
      'tx',
    ]);
    expect(reservedDataParamKeys(undefined)).toEqual([]);
    for (const key of ['vid', 'n', 'c', 'ts', 'f', 'p', 'hit', 'rev', 'tx', 'rn']) {
      expect(isReservedUrlParam(key)).toBe(true);
    }
    expect(isReservedUrlParam('sub1')).toBe(false);
  });
});

// ------------------------------------------------------------------ links

describe('links', () => {
  const source: LinkSource = {
    id: 'ts_meta',
    reserved_fields: {
      campaign: { url_param: 'campaign', source_token: '{{campaign.id}}', append: true },
      external: { url_param: 'fbclid', source_token: '', append: true },
    },
    fields: [
      { slot: 'c10', name: 'placement', url_param: 'placement', source_token: '{{placement}}', append: true },
      { slot: 'c2', name: 'adset', url_param: 'adset', source_token: '{{adset.id}}', append: true },
      { slot: 'c3', name: 'hidden', url_param: 'hidden', source_token: '{{ad.id}}', append: false },
      { slot: 'c1', name: 'ad', url_param: 'ad', source_token: '{{ad.name}}', append: true },
    ],
  };

  it('builds entrance URLs byte for byte', () => {
    expect(buildEntranceUrl('https://trk.example.com/', 'f1', source)).toBe(
      'https://trk.example.com/go/f1-ts_meta?campaign={{campaign.id}}&ad={{ad.name}}&adset={{adset.id}}&placement={{placement}}',
    );
    expect(buildEntranceUrl('https://trk.example.com', 'f1', source, { nodeId: 'n2', pageId: 'p3', cost: '0.004' })).toBe(
      'https://trk.example.com/go/f1-ts_meta/n2/p3?campaign={{campaign.id}}&ad={{ad.name}}&adset={{adset.id}}&placement={{placement}}&c=0.004',
    );
    const bare: LinkSource = {
      id: 'ts2',
      reserved_fields: {
        campaign: { url_param: 'cid', source_token: '[campaign]', append: false },
        external: { url_param: 'click', source_token: '[clickid]', append: true },
      },
      fields: [],
    };
    expect(buildEntranceUrl('https://trk.example.com', 'f1', bare)).toBe('https://trk.example.com/go/f1-ts2?click=[clickid]');
    expect(buildEntranceUrl('https://trk.example.com', 'f1', { ...bare, reserved_fields: { ...bare.reserved_fields, external: { url_param: 'click', source_token: '', append: true } } })).toBe(
      'https://trk.example.com/go/f1-ts2',
    );
    expect(buildEntranceUrl('https://trk.example.com', 'f1', bare, { pageId: 'ignored-without-node', cost: 'cpm_12.34' })).toBe(
      'https://trk.example.com/go/f1-ts2?click=[clickid]&c=cpm_12.34',
    );
  });

  it('builds action URLs', () => {
    expect(buildActionUrl('https://trk.example.com/', 3)).toBe('https://trk.example.com/a/3');
    expect(buildActionUrl('https://trk.example.com', 255, { funnelId: 'f1', nodeId: 'lander' })).toBe(
      'https://trk.example.com/go/f1/lander/a/255',
    );
    expect(() => buildActionUrl('https://trk.example.com', 0)).toThrow(RangeError);
    expect(() => buildActionUrl('https://trk.example.com', 256)).toThrow(RangeError);
    expect(() => buildActionUrl('https://trk.example.com', 1.5)).toThrow(RangeError);
  });

  it('builds direct-link suffixes', () => {
    expect(buildDirectSuffix('f1', source, { nodeId: 'n1', pageId: 'p1' })).toBe(
      'f=f1&ts=ts_meta&n=n1&p=p1&campaign={{campaign.id}}&ad={{ad.name}}&adset={{adset.id}}&placement={{placement}}',
    );
    expect(buildDirectSuffix('f1', source, { nodeId: 'n1', pageId: 'p1', wordpress: true })).toBe(
      'f=f1&ts=ts_meta&n=n1&campaign={{campaign.id}}&ad={{ad.name}}&adset={{adset.id}}&placement={{placement}}',
    );
    expect(buildDirectUrl('https://lp.example.com/a', 'f=1')).toBe('https://lp.example.com/a?f=1');
    expect(buildDirectUrl('https://lp.example.com/a?x=1#top', 'f=1')).toBe('https://lp.example.com/a?x=1&f=1#top');
    expect(buildDirectUrl('https://lp.example.com/a?', 'f=1')).toBe('https://lp.example.com/a?f=1');
  });

  it('merges destination URLs: base → node → page, last wins, no duplicates', () => {
    expect(
      mergeDestinationUrl(
        'https://o.example/x?sub1=base&keep=1&sub1=dup#frag',
        { sub1: 'node', sub2: 'node', vid: 'evil', N: 'evil' },
        { sub2: 'page', sub3: '{data-zone}' },
        { tokens: { data: { zone: 'a b' } }, vid: 'v 1', params: { keep: 'buffer', extra: 'e' } },
      ),
    ).toBe('https://o.example/x?sub1=node&keep=buffer&extra=e&sub2=page&sub3=a%20b&vid=v%201#frag');
  });

  it('keeps the base URL untouched when there is nothing to merge', () => {
    expect(mergeDestinationUrl('https://o.example/x?a=%20b')).toBe('https://o.example/x?a=%20b');
    expect(mergeDestinationUrl('https://o.example/x', {}, {}, { vid: null })).toBe('https://o.example/x');
    expect(mergeDestinationUrl('https://o.example/x?vid=old', undefined, undefined, { vid: 'new' })).toBe(
      'https://o.example/x?vid=new',
    );
    expect(mergeDestinationUrl('', { a: '1' })).toBe('');
  });

  it('leaves tokens literal when no context is given', () => {
    expect(mergeDestinationUrl('https://o.example/', { s: '{hit}' })).toBe('https://o.example/?s=%7Bhit%7D');
  });
});

// ------------------------------------------------------------------ module boundaries

describe('funnel engine module', () => {
  it('re-exports the shared validator', () => {
    expect(validateGraph).toBe(sharedValidateGraph);
  });

  it('has no storage imports', () => {
    const dir = join(__dirname, '../src/analytics/funnel-engine');
    for (const file of readdirSync(dir)) {
      const source = readFileSync(join(dir, file), 'utf8');
      expect(source, file).not.toMatch(/from ['"][^'"]*\/store(?:\/|['"])/);
      expect(source, file).not.toMatch(/from ['"][^'"]*\/do['"]/);
    }
  });
});
