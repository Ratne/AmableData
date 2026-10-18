import type { FunnelGraph, FunnelGraphInput, FunnelTouch, TrafficSource, TrafficSourceInput } from '@amable/api-types';
import { createLinkRoutes } from '../src/analytics/link-routes';
import type { LinkSiteResolver } from '../src/analytics/links/site';
import type { AnalyticsStore } from '../src/analytics/store/index';
import { edgeEnv, FakeAnalyticsNamespace, SITE_ID, siteInit, T0 } from './helpers';

export const HOST = 'track.example.com';
export const OTHER_HOST = 'track.other.test';
export const OTHER_SITE = 'st_bbbbbbbbbbbbbbbbbbbb';

export const CHROME_DESKTOP =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
export const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

export function sourceInput(overrides: Partial<TrafficSourceInput> = {}): TrafficSourceInput {
  return {
    name: 'Paid social',
    template: 'meta',
    cost_type: 'cpc',
    default_cost_minor: 5,
    reserved_fields: {
      campaign: { url_param: 'cid', source_token: '{{campaign.id}}' },
      external: { url_param: 'fbclid', source_token: '', append: false },
    },
    fields: [
      { slot: 'c1', name: 'adset', url_param: 'adset', source_token: '{{adset.id}}' },
      { slot: 'c3', name: 'zone', url_param: 'zone', source_token: '[zone]' },
    ],
    ...overrides,
  };
}

/**
 * traffic → condition (IT + mobile → `mobile`, default → tag `entered` → `lander`);
 * lander action 1 → offer, action 2 → webhook → offer; mobile action 1 → offer.
 */
export function graphInput(): FunnelGraphInput {
  return {
    name: 'Spring launch',
    nodes: [
      { id: 't', kind: 'traffic', config: {} },
      {
        id: 'cond',
        kind: 'condition',
        config: {
          routes: [
            {
              id: 'r_it_mobile',
              label: 'IT mobile',
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
      { id: 'tagn', kind: 'tag', config: { add: ['entered'], remove: [] } },
      {
        id: 'lander',
        kind: 'page_group',
        config: {
          page_type: 'lander',
          pages: [{ id: 'l1', name: 'Lander A', url: 'https://lp.example.com/a', weight: 1 }],
          data_params: { sub: '{campaign}', z: '{data-zone}', x: '{data-extra}' },
        },
      },
      {
        id: 'mobile',
        kind: 'page_group',
        config: {
          page_type: 'lander',
          pages: [{ id: 'm1', name: 'Mobile', url: 'https://lp.example.com/m', weight: 1 }],
        },
      },
      {
        id: 'offer',
        kind: 'page_group',
        config: {
          page_type: 'offer',
          pages: [{ id: 'o1', name: 'Offer', url: 'https://offer.example.net/o?aff=1', weight: 1 }],
          data_params: { s1: '{hit}' },
        },
      },
      // Pages built with the page builder: published, unknown with a default exit, unknown without.
      {
        id: 'hosted',
        kind: 'page_group',
        config: { page_type: 'lander', pages: [{ id: 'h1', name: 'Hosted', amable_page_id: 'pg_live', weight: 1 }] },
      },
      {
        id: 'gone',
        kind: 'page_group',
        config: { page_type: 'lander', pages: [{ id: 'g1', name: 'Gone', amable_page_id: 'pg_gone', weight: 1 }] },
      },
      {
        id: 'gone2',
        kind: 'page_group',
        config: { page_type: 'lander', pages: [{ id: 'g2', name: 'Gone too', amable_page_id: 'pg_gone', weight: 1 }] },
      },
      {
        id: 'hook',
        kind: 'webhook',
        config: { url: 'https://hooks.example.net/funnel', method: 'POST' },
      },
    ],
    edges: [
      { id: 'e1', from: 't', to: 'cond', via: { type: 'default' } },
      { id: 'e2', from: 'cond', to: 'mobile', via: { type: 'route', route_id: 'r_it_mobile' } },
      { id: 'e3', from: 'cond', to: 'tagn', via: { type: 'default' } },
      { id: 'e4', from: 'tagn', to: 'lander', via: { type: 'default' } },
      { id: 'e5', from: 'lander', to: 'offer', via: { type: 'action', actions: [1] } },
      { id: 'e6', from: 'lander', to: 'hook', via: { type: 'action', actions: [2] } },
      { id: 'e7', from: 'hook', to: 'offer', via: { type: 'default' } },
      { id: 'e8', from: 'mobile', to: 'offer', via: { type: 'action', actions: [1] } },
      { id: 'e9', from: 'gone', to: 'offer', via: { type: 'default' } },
    ],
  };
}

export interface RequestInit2 {
  headers?: Record<string, string>;
  cf?: Record<string, unknown>;
}

export interface LinkHarness {
  clock: { now: number };
  ns: FakeAnalyticsNamespace;
  store: AnalyticsStore;
  graph: FunnelGraph;
  source: TrafficSource;
  fetched: Request[];
  /** `tenant:page` of every hosted page lookup. */
  hostedLookups: string[];
  pending: Promise<unknown>[];
  get(pathAndQuery: string, init?: RequestInit2, host?: string): Promise<Response>;
  touches(visitorId: string): FunnelTouch[];
  /** Waits for the background tasks (webhooks, direct-link views). */
  settle(): Promise<void>;
}

export function linkHarness(options: { source?: Partial<TrafficSourceInput> } = {}): LinkHarness {
  const clock = { now: T0 };
  const ns = new FakeAnalyticsNamespace(() => clock.now);
  const env = edgeEnv(ns);
  const store = ns.store(`site:${SITE_ID}`);
  store.initSite(siteInit());
  ns.store(`site:${OTHER_SITE}`).initSite(siteInit({ siteId: OTHER_SITE, tenantId: 'tenant_2', hostnames: ['other.test'] }));
  const source = store.createTrafficSource(sourceInput(options.source));
  const graph = store.createFunnelGraph(graphInput());
  if (!source.ok || !graph.ok) throw new Error('fixture');

  const sites: Record<string, string> = { [HOST]: SITE_ID, [OTHER_HOST]: OTHER_SITE };
  const resolver: LinkSiteResolver = (_env, host) =>
    Promise.resolve(sites[host] === undefined ? null : { siteId: sites[host]!, tenantId: null, basePath: '' });
  const fetched: Request[] = [];
  const pending: Promise<unknown>[] = [];
  const hostedLookups: string[] = [];
  const hostedUrls: Record<string, string> = { pg_live: 'https://shop.example/spring?promo=1' };
  const app = createLinkRoutes({
    hostedPages: () => (tenantId, pageId) => {
      hostedLookups.push(`${tenantId}:${pageId}`);
      return Promise.resolve(hostedUrls[pageId] ?? null);
    },
    resolvers: [resolver],
    rng: () => 0.1,
    now: () => clock.now,
    fetch: (input, init) => {
      fetched.push(new Request(input, init));
      return Promise.resolve(new Response('ok'));
    },
  });
  const executionCtx = {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;

  return {
    clock,
    ns,
    store,
    graph: graph.value,
    source: source.value,
    fetched,
    hostedLookups,
    pending,
    get(pathAndQuery, init = {}, host = HOST) {
      const request = new Request(`https://${host}${pathAndQuery}`, {
        headers: { 'user-agent': CHROME_DESKTOP, ...init.headers },
      });
      if (init.cf !== undefined) Object.defineProperty(request, 'cf', { value: init.cf });
      return Promise.resolve(app.fetch(request, env, executionCtx));
    },
    touches: (visitorId) => store.listTouchesByVisitor(visitorId),
    async settle() {
      await Promise.all(pending.splice(0));
    },
  };
}

/** Funnel visitor id of a redirect (`vid` of the Location). */
export function vidOf(response: Response): string {
  const location = response.headers.get('location') ?? '';
  return new URL(location).searchParams.get('vid') ?? '';
}
