import type { FunnelGraphInput, FunnelTouch, TrafficSourceInput } from '@amable/api-types';
import { siteStub, tenantSitesStub, type AnalyticsNamespace } from '@amable/app-edge/analytics';
import {
  adsRedirectUri,
  adsStub,
  adsSyncPorts,
  backfillAdConnection,
  finishAdsConnect,
  localDay,
  startAdsConnect,
} from './ads-sync';
import { seeded } from './integrations';
import type { Env } from '../env';

/**
 * Local development only (`/api/dev/analytics/funnel-demo`, ENVIRONMENT=dev):
 * a demo funnel (traffic → rotator → condition → two landers → offer), a paid
 * social traffic source with tracking fields, an ad connection on the fake ad
 * platform client with its synced campaigns and spend, and `visitors` funnel
 * visitors over `days` (entrances, lander views, action clicks, offer views,
 * some returning through another campaign). Converting offer views are
 * returned as postbacks for the caller to send to the edge `/pb` route, so
 * conversions take the production path. Deterministic for a given seed.
 */

const DAY = 86_400_000;
const MIN = 60_000;

export const DEMO_FUNNEL_NAME = 'Demo funnel';
export const DEMO_SOURCE_NAME = 'Paid social (demo)';
const DEMO_ORIGIN = 'https://www.example.com';
const FALLBACK_CAMPAIGNS = ['demo-campaign-1', 'demo-campaign-2'];

function demoFunnel(): FunnelGraphInput {
  return {
    name: DEMO_FUNNEL_NAME,
    nodes: [
      { id: 'traffic', kind: 'traffic', config: {}, position: { x: 0, y: 160 } },
      { id: 'split', kind: 'rotator', label: 'A/B split', config: { stickiness: 'sticky' }, position: { x: 220, y: 160 } },
      {
        id: 'device',
        kind: 'condition',
        label: 'Device',
        position: { x: 440, y: 80 },
        config: {
          routes: [
            {
              id: 'mobile',
              label: 'Mobile',
              priority: 1,
              groups: [{ match: 'all', rules: [{ attr: 'device', op: 'is', values: ['mobile'] }] }],
            },
          ],
        },
      },
      {
        id: 'lander_a',
        kind: 'page_group',
        label: 'Lander A',
        position: { x: 660, y: 40 },
        config: {
          page_type: 'lander',
          pages: [{ id: 'lp_a', name: 'Lander A', url: `${DEMO_ORIGIN}/lp/a`, weight: 1 }],
          data_params: { sub: '{campaign}' },
        },
      },
      {
        id: 'lander_b',
        kind: 'page_group',
        label: 'Lander B',
        position: { x: 660, y: 280 },
        config: { page_type: 'lander', pages: [{ id: 'lp_b', name: 'Lander B', url: `${DEMO_ORIGIN}/lp/b`, weight: 1 }] },
      },
      {
        id: 'offer',
        kind: 'page_group',
        label: 'Offer',
        position: { x: 900, y: 160 },
        config: {
          page_type: 'offer',
          pages: [{ id: 'offer_1', name: 'Offer', url: `${DEMO_ORIGIN}/offer`, weight: 1 }],
          data_params: { s1: '{hit}' },
        },
      },
    ],
    edges: [
      { id: 'e_traffic', from: 'traffic', to: 'split', via: { type: 'default' } },
      { id: 'e_split_device', from: 'split', to: 'device', via: { type: 'weight', weight: 3 } },
      { id: 'e_split_b', from: 'split', to: 'lander_b', via: { type: 'weight', weight: 1 } },
      { id: 'e_mobile', from: 'device', to: 'lander_b', via: { type: 'route', route_id: 'mobile' } },
      { id: 'e_device_a', from: 'device', to: 'lander_a', via: { type: 'default' } },
      { id: 'e_a_offer', from: 'lander_a', to: 'offer', via: { type: 'action', actions: [1] } },
      { id: 'e_a_default', from: 'lander_a', to: 'offer', via: { type: 'default' } },
      { id: 'e_b_offer', from: 'lander_b', to: 'offer', via: { type: 'action', actions: [1] } },
      { id: 'e_b_default', from: 'lander_b', to: 'offer', via: { type: 'default' } },
    ],
  };
}

function demoSource(connectionId: string | null): TrafficSourceInput {
  return {
    name: DEMO_SOURCE_NAME,
    template: 'meta',
    category: 'social',
    cost_type: 'cpc',
    default_cost_minor: 35,
    reserved_fields: {
      campaign: { url_param: 'cid', source_token: '{{campaign.id}}' },
      external: { url_param: 'fbclid', source_token: '', append: false },
    },
    fields: [
      { slot: 'c1', name: 'adset', url_param: 'adset', source_token: '{{adset.id}}' },
      { slot: 'c2', name: 'ad', url_param: 'ad', source_token: '{{ad.id}}' },
      { slot: 'c3', name: 'placement', url_param: 'placement', source_token: '{{placement}}' },
    ],
    ...(connectionId === null
      ? {}
      : {
          conversion: {
            ad_connection_id: connectionId,
            platform: 'meta' as const,
            mapping: [
              { event: 'sale', platform_event: 'Purchase' },
              { event: 'lead', platform_event: 'Lead' },
            ],
          },
        }),
  };
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const idOf = (rnd: () => number, length: number): string =>
  Array.from({ length }, () => BASE32[Math.floor(rnd() * 32)]).join('');

function uuid(rnd: () => number): string {
  const h = Array.from({ length: 32 }, () => Math.floor(rnd() * 16).toString(16)).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20)}`;
}

const anyOf = <T,>(rnd: () => number, list: readonly T[]): T => list[Math.floor(rnd() * list.length)] as T;

/** Conversion postback for the edge `/pb` route of the site. */
export interface DemoPostback {
  hit: string;
  /** Major units, as sent by a shop or a network. */
  rev: string;
  tx: string;
  /** Epoch ms. */
  conversion_time: number;
}

export interface FunnelDemoReport {
  siteId: string;
  funnelId: string;
  trafficSourceId: string;
  connectionId: string | null;
  /** Campaign ids of the synced entities (the demo `cid` values). */
  campaigns: string[];
  spendRows: number;
  visitors: number;
  touches: number;
  postbacks: DemoPostback[];
}

export class FunnelDemoError extends Error {}

async function ensureAdConnection(
  env: Env,
  ns: AnalyticsNamespace,
  site: { tenantId: string; tenantSlug: string; id: string; name: string },
  days: number,
  now: number,
): Promise<{ connectionId: string | null; spendRows: number }> {
  const ports = adsSyncPorts(env, ns, () => now);
  // Real ad platform apps configured locally: never connect them for a demo.
  if (!ports.clients.fake) return { connectionId: null, spendRows: 0 };
  let conn = (await adsStub(ns, site.id).listAdConnections('meta')).find((c) => c.status !== 'disconnected');
  if (conn === undefined) {
    const redirectUri = adsRedirectUri(env);
    const { state } = await startAdsConnect(ports, {
      tenantId: site.tenantId,
      tenantSlug: site.tenantSlug,
      siteId: site.id,
      platform: 'meta',
      redirectUri,
    });
    [conn] = await finishAdsConnect(ports, { tenantId: site.tenantId, siteId: site.id, platform: 'meta', state, code: 'demo' });
  }
  if (conn === undefined) return { connectionId: null, spendRows: 0 };
  const timeZone = typeof conn.metadata['timezone'] === 'string' ? conn.metadata['timezone'] : 'UTC';
  const backfill = await backfillAdConnection(
    ports,
    { tenantId: site.tenantId, id: site.id, name: site.name },
    conn,
    { from: localDay(now - Math.min(days, 89) * DAY, timeZone), to: localDay(now, timeZone) },
  );
  return { connectionId: conn.id, spendRows: backfill.rows };
}

/** Funnel, traffic source, fake ad data and click-log of the demo site (created by the traffic generator). */
export async function generateFunnelDemo(
  env: Env,
  ns: AnalyticsNamespace,
  tenant: { id: string; slug: string },
  opts: { days: number; visitors: number; seed: string; now: number },
): Promise<FunnelDemoReport> {
  const siteId = (await tenantSitesStub(ns, tenant.id).indexList())[0];
  if (siteId === undefined) throw new FunnelDemoError('no analytics site: generate the demo traffic first');
  const stub = siteStub(ns, siteId);
  const record = await stub.getSite();
  if (record === null) throw new FunnelDemoError('no analytics site: generate the demo traffic first');
  const { now, days } = opts;

  const { connectionId, spendRows } = await ensureAdConnection(
    env,
    ns,
    { tenantId: tenant.id, tenantSlug: tenant.slug, id: siteId, name: record.site.name },
    days,
    now,
  );

  let funnelId = (await stub.listFunnelGraphs()).find((g) => g.name === DEMO_FUNNEL_NAME)?.id;
  if (funnelId === undefined) {
    const created = await stub.createFunnelGraph(demoFunnel());
    if (!created.ok) throw new FunnelDemoError(`demo funnel: ${created.error.message}`);
    funnelId = created.value.id;
  }
  let source = (await stub.listTrafficSources()).find((s) => s.name === DEMO_SOURCE_NAME);
  if (source === undefined) {
    const created = await stub.createTrafficSource(demoSource(connectionId));
    if (!created.ok) throw new FunnelDemoError(`demo traffic source: ${created.error.message}`);
    source = created.value;
  }

  const entities = connectionId === null ? [] : await stub.listAdEntities({ platform: 'meta' });
  const campaigns = entities.filter((e) => e.level === 'campaign').map((e) => e.external_id);
  const pool = campaigns.length > 0 ? campaigns : FALLBACK_CAMPAIGNS;
  const childrenOf = (parent: string, level: 'adset' | 'ad'): string[] =>
    entities.filter((e) => e.level === level && e.parent_external_id === parent).map((e) => e.external_id);

  const rnd = seeded(`${opts.seed}|${siteId}|funnel`);
  const start = now - days * DAY;
  const postbacks: DemoPostback[] = [];
  let touches = 0;
  const sourceId = source.id;
  const fid = funnelId;

  for (let i = 0; i < opts.visitors; i += 1) {
    const vid = uuid(rnd);
    const mobile = rnd() < 0.38;
    const visits = rnd() < 0.22 ? 2 : 1;
    let ts = start + Math.floor(rnd() * days * DAY * 0.92);
    let lastOffer: string | null = null;
    for (let v = 0; v < visits && ts < now; v += 1) {
      const campaign = anyOf(rnd, pool);
      const adset = childrenOf(campaign, 'adset');
      const fields: Record<string, string> = { c3: mobile ? 'stories' : 'feed' };
      if (adset.length > 0) {
        fields['c1'] = anyOf(rnd, adset);
        const ads = childrenOf(fields['c1'], 'ad');
        if (ads.length > 0) fields['c2'] = anyOf(rnd, ads);
      }
      const lander = rnd() < 0.25 || mobile ? 'lander_b' : 'lander_a';
      const base = {
        visitor_id: vid,
        session_id: vid,
        funnel_id: fid,
        traffic_source_id: sourceId,
        campaign,
        external_click_id: `fb.demo.${idOf(rnd, 16)}`,
        fields,
      };
      const step: FunnelTouch[] = [
        { ...base, id: idOf(rnd, 26), ts, node_id: 'traffic', page_id: null, kind: 'entrance', action_number: null, cost_minor: 35 },
        { ...base, id: idOf(rnd, 26), ts: ts + 1, node_id: lander, page_id: lander === 'lander_a' ? 'lp_a' : 'lp_b', kind: 'view', action_number: null, cost_minor: null },
      ];
      if (rnd() < (lander === 'lander_a' ? 0.58 : 0.46)) {
        const clickAt = Math.min(ts + 20_000 + Math.floor(rnd() * 3 * MIN), now - 2);
        lastOffer = idOf(rnd, 26);
        step.push(
          { ...base, id: idOf(rnd, 26), ts: clickAt, node_id: lander, page_id: step[1]!.page_id ?? null, kind: 'click', action_number: 1, cost_minor: null },
          { ...base, id: lastOffer, ts: clickAt + 1, node_id: 'offer', page_id: 'offer_1', kind: 'view', action_number: null, cost_minor: null },
        );
      }
      const last = step[step.length - 1]!;
      const saved = await stub.recordFunnelStep({
        touches: step,
        session: {
          visitor_id: vid,
          funnel_id: fid,
          current_node_id: last.node_id,
          current_page_id: last.page_id ?? null,
          traffic_source_id: sourceId,
          campaign,
          external_click_id: base.external_click_id,
          fields,
        },
      });
      if (saved.ok) touches += saved.value.inserted;
      ts = last.ts + DAY + Math.floor(rnd() * 9 * DAY);
    }
    if (lastOffer !== null && rnd() < 0.3) {
      const offerTs = (await stub.getTouch(lastOffer))?.ts ?? null;
      if (offerTs === null) continue;
      postbacks.push({
        hit: lastOffer,
        rev: (39 + Math.floor(rnd() * 160) + 0.9).toFixed(2),
        tx: `DEMO-${idOf(rnd, 10).toUpperCase()}`,
        conversion_time: Math.min(offerTs + 2 * MIN + Math.floor(rnd() * 3 * DAY), now - 1),
      });
    }
  }

  return {
    siteId,
    funnelId: fid,
    trafficSourceId: sourceId,
    connectionId,
    campaigns: pool,
    spendRows,
    visitors: opts.visitors,
    touches,
    postbacks,
  };
}
