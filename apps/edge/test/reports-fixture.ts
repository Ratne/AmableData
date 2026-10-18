import type { FunnelTouch } from '@amable/api-types';
import type { SqlDb } from '../src/analytics/db/sql';
import type { AnalyticsStore } from '../src/analytics/store/index';
import { siteInit } from './helpers';

export const DAY = 86_400_000;
/** Noon UTC of an October 2026 day (`D(32)` = November 1st…). */
export const D = (n: number): number => Date.UTC(2026, 9, n, 12);

export function createSources(store: AnalyticsStore): { meta: string; google: string } {
  const meta = store.createTrafficSource({
    name: 'Meta Ads',
    template: 'meta',
    reserved_fields: {
      campaign: { url_param: 'utm_campaign', source_token: '{{campaign.id}}' },
      external: { url_param: 'fbclid' },
    },
    fields: [
      { slot: 'c1', name: 'adset', url_param: 'adset_id', source_token: '{{adset.id}}' },
      { slot: 'c2', name: 'Ad ID', url_param: 'creative', source_token: '{{ad.id}}' },
    ],
  });
  const google = store.createTrafficSource({
    name: 'Google Ads',
    template: 'google',
    reserved_fields: {
      campaign: { url_param: 'campaign', source_token: '{campaignid}' },
      external: { url_param: 'gclid' },
    },
    fields: [{ slot: 'c3', name: 'group', url_param: 'adgroup_id', source_token: '{adgroupid}' }],
  });
  if (!meta.ok || !google.ok) throw new Error('sources not created');
  return { meta: meta.value.id, google: google.value.id };
}

let seq = 0;

export function touch(
  visitor: string,
  ts: number,
  source: string | null,
  campaign: string | null,
  extra: Partial<FunnelTouch> = {},
): FunnelTouch {
  seq += 1;
  return {
    id: `hit-${visitor}-${String(seq)}`,
    ts,
    visitor_id: visitor,
    session_id: `s-${visitor}-${String(seq)}`,
    funnel_id: 'fn_main',
    node_id: 'traffic',
    traffic_source_id: source,
    kind: 'entrance',
    campaign,
    ...extra,
  };
}

export function insertPayment(
  db: SqlDb,
  p: {
    tx: string;
    visitor: string | null;
    ts: number;
    amount: number;
    contact?: string;
    order?: string;
  },
): void {
  db.run(
    `INSERT INTO payments (transaction_id, visitor_id, ts, amount_minor, currency, source, order_id, contact_id)
     VALUES (?, ?, ?, ?, 'EUR', 'crm', ?, ?)`,
    p.tx,
    p.visitor,
    p.ts,
    p.amount,
    p.order ?? null,
    p.contact ?? null,
  );
}

export function mergeVisitors(db: SqlDb, child: string, origin: string, active = true): void {
  db.run(
    `INSERT INTO visitor_merges (child_visitor_id, origin_visitor_id, mechanism, active, created_at, updated_at)
     VALUES (?, ?, 'email', ?, 0, 0)
     ON CONFLICT (child_visitor_id, origin_visitor_id) DO UPDATE SET active = excluded.active`,
    child,
    origin,
    active ? 1 : 0,
  );
}

/**
 * 20 visitors, 2 sources (Meta: campaigns m1 / m2 with adset + ad fields,
 * Google: campaign g1), campaign-level spend. Paths (entrances) and events:
 *
 * - v01: m1 D2, g1 D9, m2 D16 → sale 7000 D16 (ages 14 / 7 / 0 days)
 * - v02: g1 D3, m1 D10 → sale 3000 D10 (ages 7 / 0)
 * - v03: m1 D5 → sale 2000 D8 (hard cost 200 + COGS 300)
 * - v04: g1 D6 → lead D6+1h, CRM payment 5000 D20
 * - v05 (child of v06): g1 D8; v06: m2 D1 → sale 4000 by v05 D15 (ages 14 / 7)
 * - v07: m1 D2 → sales 1000 D3 and 1500 D12 (returning)
 * - v08: no touch → sale 600 D7 (unattributed)
 * - v09…v14: m1 D4 (adsets s1 ×3, s2 ×3), v15…v20: g1 D5 (cost 50 each), no conversion
 *
 * Spend: m1 1000 D2 + 2000 D10 (reported 3 conversions / 12000), m2 500 D9,
 * g1 4000 D3 (reported 1 / 2000).
 */
export function seedPerformanceFixture(
  store: AnalyticsStore,
  db: SqlDb,
): { meta: string; google: string } {
  store.initSite(siteInit());
  const { meta, google } = createSources(store);
  const touches: FunnelTouch[] = [
    touch('v01', D(2), meta, 'm1'),
    touch('v01', D(9), google, 'g1'),
    touch('v01', D(16), meta, 'm2'),
    touch('v02', D(3), google, 'g1'),
    touch('v02', D(10), meta, 'm1'),
    touch('v03', D(5), meta, 'm1'),
    touch('v04', D(6), google, 'g1'),
    touch('v05', D(8), google, 'g1'),
    touch('v06', D(1), meta, 'm2'),
    touch('v07', D(2), meta, 'm1'),
  ];
  for (let i = 9; i <= 14; i += 1) {
    const adset = i <= 11 ? 'm1-s1' : 'm1-s2';
    touches.push(
      touch(`v${String(i).padStart(2, '0')}`, D(4), meta, 'm1', {
        fields: { c1: adset, c2: `${adset}-a1` },
      }),
    );
  }
  for (let i = 15; i <= 20; i += 1)
    touches.push(touch(`v${String(i)}`, D(5), google, 'g1', { cost_minor: 50 }));
  const recorded = store.recordTouches(touches);
  if (!recorded.ok) throw new Error(recorded.error.message);
  const hitOf = (visitor: string): string => {
    const t = touches.filter((x) => x.visitor_id === visitor).at(-1);
    if (t === undefined) throw new Error(visitor);
    return t.id;
  };
  const conversions = [
    { hit: hitOf('v01'), tx: 't1', revenue_minor: 7000, ts: D(16) },
    { hit: hitOf('v02'), tx: 't2', revenue_minor: 3000, ts: D(10) },
    {
      hit: hitOf('v03'),
      tx: 't3',
      revenue_minor: 2000,
      ts: D(8),
      data: { hard_cost_minor: '200', cogs_minor: '300' },
    },
    { hit: hitOf('v04'), event: 'lead', revenue_minor: 0, ts: D(6) + 3_600_000 },
    { hit: hitOf('v05'), tx: 't6', revenue_minor: 4000, ts: D(15) },
    { hit: hitOf('v07'), tx: 't7', revenue_minor: 1000, ts: D(3) },
    { hit: hitOf('v07'), tx: 't8', revenue_minor: 1500, ts: D(12) },
    { hit: 'offline-1', visitor_id: 'v08', tx: 't9', revenue_minor: 600, ts: D(7) },
  ];
  for (const c of conversions) {
    const r = store.recordConversionFromPostback({ currency: 'EUR', ...c });
    if (!r.ok) throw new Error(r.error.message);
  }
  // Already logged by postback: the payment of the same transaction is not counted twice.
  insertPayment(db, { tx: 't1', visitor: 'v01', ts: D(16), amount: 7000 });
  insertPayment(db, { tx: 'crm_p4', visitor: 'v04', ts: D(20), amount: 5000 });
  mergeVisitors(db, 'v05', 'v06');
  store.upsertAdEntities([
    {
      platform: 'meta',
      level: 'campaign',
      external_id: 'm1',
      name: 'Meta Prospecting',
      status: 'active',
    },
    {
      platform: 'meta',
      level: 'campaign',
      external_id: 'm2',
      name: 'Meta Retargeting',
      status: 'active',
    },
    {
      platform: 'meta',
      level: 'adset',
      external_id: 'm1-s1',
      parent_external_id: 'm1',
      name: 'Lookalike',
      status: 'active',
    },
    {
      platform: 'meta',
      level: 'adset',
      external_id: 'm1-s2',
      parent_external_id: 'm1',
      name: 'Interests',
      status: 'active',
    },
    {
      platform: 'google',
      level: 'campaign',
      external_id: 'g1',
      name: 'Google Brand',
      status: 'active',
    },
  ]);
  store.upsertAdSpend([
    { platform: 'meta', entity_external_id: 'm1', day: '2026-10-02', spend_minor: 1000 },
    {
      platform: 'meta',
      entity_external_id: 'm1',
      day: '2026-10-10',
      spend_minor: 2000,
      reported_conversions: 3,
      reported_revenue_minor: 12000,
    },
    { platform: 'meta', entity_external_id: 'm2', day: '2026-10-09', spend_minor: 500 },
    {
      platform: 'google',
      entity_external_id: 'g1',
      day: '2026-10-03',
      spend_minor: 4000,
      reported_conversions: 1,
      reported_revenue_minor: 2000,
    },
  ]);
  return { meta, google };
}
