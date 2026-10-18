import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTION_MODELS,
  ATTRIBUTION_MODELS_V2,
  adEntitySchema,
  adSpendDaySchema,
  cohortQuerySchema,
  conditionAttributeSchema,
  contactJourneySchema,
  funnelHeatmapSchema,
  funnelLinksSchema,
  createTrackingDomainSchema,
  funnelEdgeSchema,
  funnelGraphInputSchema,
  funnelGraphSchema,
  funnelNodeSchema,
  funnelTouchSchema,
  identityKeySchema,
  journeyQuerySchema,
  ltvQuerySchema,
  outboundConversionJobSchema,
  performanceQuerySchema,
  performanceRowSchema,
  trafficSourceInputSchema,
  trafficSourceSchema,
  visitorMergeSchema,
  type FunnelGraphInput,
  type TrafficSourceInput,
} from '../src/index';

const NOW = Date.UTC(2026, 9, 15, 10);

function graphInput(): FunnelGraphInput {
  return {
    name: 'Webinar funnel',
    nodes: [
      { id: 'n_traffic', kind: 'traffic', config: {} },
      { id: 'n_rot', kind: 'rotator', config: { stickiness: 'sticky' } },
      {
        id: 'n_cond',
        kind: 'condition',
        config: {
          routes: [
            {
              id: 'r_it_mobile',
              label: 'IT mobile',
              priority: 0,
              groups: [
                { match: 'all', rules: [{ attr: 'country', op: 'is', values: ['IT'] }] },
                { match: 'any', rules: [{ attr: 'device', op: 'is', values: ['mobile', 'tablet'] }] },
              ],
            },
          ],
        },
      },
      {
        id: 'n_lp',
        kind: 'page_group',
        config: {
          page_type: 'lander',
          pages: [
            { id: 'p_a', name: 'Lander A', url: 'https://example.com/a', weight: 70 },
            { id: 'p_b', name: 'Lander B', amable_page_id: 'pg_1', weight: 30, paused: true },
          ],
        },
      },
      {
        id: 'n_offer',
        kind: 'page_group',
        config: {
          page_type: 'offer',
          pages: [{ id: 'o_1', name: 'Offer', url: 'https://shop.example.com/buy', weight: 1 }],
          map_action_to_page: true,
        },
      },
      { id: 'n_tag', kind: 'tag', config: { add: ['hot'] } },
      { id: 'n_hook', kind: 'webhook', config: { url: 'https://hooks.example.com/x', body: '{"hit":"{hit}"}' } },
      { id: 'n_ext', kind: 'external_url', config: { url: 'https://example.org' } },
      { id: 'n_proxy', kind: 'action_proxy' },
    ],
    edges: [
      { id: 'e1', from: 'n_traffic', to: 'n_rot', via: { type: 'default' } },
      { id: 'e2', from: 'n_rot', to: 'n_cond', via: { type: 'weight', weight: 1 } },
      { id: 'e3', from: 'n_cond', to: 'n_lp', via: { type: 'route', route_id: 'r_it_mobile' } },
      { id: 'e4', from: 'n_cond', to: 'n_ext', via: { type: 'default' } },
      { id: 'e5', from: 'n_lp', to: 'n_offer', via: { type: 'action', actions: [1, 2] } },
    ],
    default_cost_minor: 25,
  };
}

function sourceInput(): TrafficSourceInput {
  return {
    name: 'Meta Ads',
    template: 'meta',
    reserved_fields: {
      campaign: { url_param: 'campaign', source_token: '{{campaign.id}}' },
      external: { url_param: 'fbclid', source_token: '', append: false },
    },
    fields: [
      { slot: 'c1', name: 'Ad set', url_param: 'adset', source_token: '{{adset.id}}' },
      { slot: 'c2', name: 'Ad', url_param: 'ad', source_token: '{{ad.id}}' },
    ],
    conversion: { platform: 'meta', mapping: [{ event: 'sale', platform_event: 'Purchase' }] },
    skip_zero_revenue_postbacks: true,
  };
}

describe('funnel graph contracts', () => {
  it('parses a full graph with every node kind and applies defaults', () => {
    const parsed = funnelGraphInputSchema.parse(graphInput());
    expect(parsed.nodes).toHaveLength(9);
    const proxy = parsed.nodes.find((n) => n.id === 'n_proxy');
    expect(proxy).toMatchObject({ kind: 'action_proxy', config: {}, position: { x: 0, y: 0 } });
    const lp = parsed.nodes.find((n) => n.id === 'n_lp');
    if (lp?.kind !== 'page_group') throw new Error('expected page group');
    expect(lp.config.pages[0]?.paused).toBe(false);
    expect(lp.config.map_action_to_page).toBe(false);
    expect(parsed.ip_anonymize).toBe(false);
  });

  it('round-trips a stored graph', () => {
    const stored = { ...graphInput(), id: 'fg_1', version: 3, status: 'active', created_at: NOW, updated_at: NOW };
    const once = funnelGraphSchema.parse(stored);
    expect(funnelGraphSchema.parse(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });

  it('rejects a non-positive edge weight', () => {
    const g = graphInput();
    g.edges[1] = { id: 'e2', from: 'n_rot', to: 'n_cond', via: { type: 'weight', weight: -1 } };
    expect(funnelGraphInputSchema.safeParse(g).success).toBe(false);
    expect(funnelEdgeSchema.safeParse({ id: 'e', from: 'a', to: 'b', via: { type: 'weight', weight: 0 } }).success).toBe(false);
  });

  it('rejects duplicate node and edge ids', () => {
    const g = graphInput();
    g.nodes.push({ id: 'n_rot', kind: 'action_proxy' });
    g.edges.push({ id: 'e1', from: 'n_proxy', to: 'n_ext', via: { type: 'default' } });
    const res = funnelGraphInputSchema.safeParse(g);
    expect(res.success).toBe(false);
    const messages = res.error?.issues.map((i) => i.message) ?? [];
    expect(messages).toContain('duplicate node id');
    expect(messages).toContain('duplicate edge id');
  });

  it('accepts edges to unknown nodes (structural validation is the engine job)', () => {
    const g = graphInput();
    g.edges.push({ id: 'e9', from: 'n_lp', to: 'ghost', via: { type: 'default' } });
    expect(funnelGraphInputSchema.safeParse(g).success).toBe(true);
  });

  it('rejects action numbers out of range and pages without a destination', () => {
    expect(
      funnelEdgeSchema.safeParse({ id: 'e', from: 'a', to: 'b', via: { type: 'action', actions: [256] } }).success,
    ).toBe(false);
    expect(
      funnelNodeSchema.safeParse({
        id: 'x',
        kind: 'page_group',
        config: { page_type: 'lander', pages: [{ id: 'p', name: 'P', weight: 1 }] },
      }).success,
    ).toBe(false);
  });

  it('validates condition attributes including field:<name>', () => {
    expect(conditionAttributeSchema.safeParse('country').success).toBe(true);
    expect(conditionAttributeSchema.safeParse('field:utm_term').success).toBe(true);
    expect(conditionAttributeSchema.safeParse('field:').success).toBe(false);
    expect(conditionAttributeSchema.safeParse('planet').success).toBe(false);
  });

  it('rejects an unknown node kind', () => {
    expect(funnelNodeSchema.safeParse({ id: 'x', kind: 'teleport', config: {} }).success).toBe(false);
  });

  it('parses touches', () => {
    const touch = {
      id: 't1',
      ts: NOW,
      visitor_id: 'v1',
      session_id: 's1',
      funnel_id: 'fg_1',
      node_id: 'n_lp',
      kind: 'action',
      action_number: 2,
      fields: { c1: 'adset_9' },
      cost_minor: 30,
    };
    expect(funnelTouchSchema.parse(touch)).toEqual(touch);
    expect(funnelTouchSchema.safeParse({ ...touch, kind: 'hover' }).success).toBe(false);
  });
});

describe('funnel links, heatmap and contact journey contracts', () => {
  it('describes every field of the links response', () => {
    const links = {
      base_url: 'https://edge.test/s/st_1',
      entrance_url: 'https://edge.test/s/st_1/go/fg_1-ts_1?campaign={campaignid}',
      direct_suffix: 'f=fg_1&ts=ts_1&n=la',
      direct_url: 'https://lander.test/a?f=fg_1&ts=ts_1&n=la',
      page_node_id: 'la',
      action_urls: [{ action: 1, url: 'https://edge.test/s/st_1/a/1', default_url: 'https://edge.test/s/st_1/go/fg_1/la/a/1' }],
      snippet: '<script></script>',
    };
    expect(funnelLinksSchema.strict().parse(links)).toEqual(links);
    expect(funnelLinksSchema.safeParse({ ...links, action_urls: [{ action: 1, url: 'x' }] }).success).toBe(false);
    expect(funnelLinksSchema.safeParse({ ...links, direct_url: null, page_node_id: null, action_urls: [] }).success).toBe(true);
  });

  it('flags truncated heatmaps, false when absent', () => {
    const heatmap = { metric: 'visits', nodes: [], edges: [] };
    expect(funnelHeatmapSchema.parse(heatmap).truncated).toBe(false);
    expect(funnelHeatmapSchema.parse({ ...heatmap, truncated: true }).truncated).toBe(true);
  });

  it('keeps the identity-graph fields of a contact journey optional', () => {
    const journey = {
      contact_id: 'ct_1',
      sites: [],
      visitors: [],
      first_visit: null,
      totals: { sessions: 0, pageviews: 0, goals: 0, revenue: [], orders: 0, emails_opened: 0, emails_clicked: 0 },
      sources: [],
      top_pages: [],
      goals: [],
      first_touch: null,
      last_non_direct_touch: null,
      time_to_conversion: {
        first_seen: null,
        first_purchase_at: null,
        sessions_before_purchase: null,
        days_to_purchase: null,
        hours_to_purchase: null,
      },
      prediction: null,
      items: [],
    };
    expect(contactJourneySchema.safeParse(journey).success).toBe(true);
    const touch = {
      id: 'hit_1',
      ts: '2026-10-15T10:00:00.000Z',
      site_id: 'st_1',
      visitor_id: 'v1',
      kind: 'entrance',
      funnel_id: 'fg_1',
      funnel_name: 'Main',
      node_id: 't',
      page_id: null,
      traffic_source_id: 'ts_1',
      traffic_source_name: 'Meta',
      campaign: '123',
      campaign_name: 'Spring',
      external_click_id: 'fb.1',
      fields: { c1: 'adset' },
    };
    const full = { ...journey, merged_visitor_ids: ['v2'], funnel_touches: [touch], tags: ['hot'] };
    expect(contactJourneySchema.parse(full)).toEqual(full);
    expect(contactJourneySchema.safeParse({ ...full, funnel_touches: [{ ...touch, kind: 'bogus' }] }).success).toBe(false);
  });
});

describe('traffic source contracts', () => {
  it('parses a template-like source with defaults', () => {
    const parsed = trafficSourceInputSchema.parse(sourceInput());
    expect(parsed.cost_type).toBe('cpc');
    expect(parsed.fields[0]?.append).toBe(true);
    expect(parsed.reserved_fields.external.append).toBe(false);
  });

  it('round-trips a stored source', () => {
    const stored = { ...sourceInput(), id: 'ts_1', status: 'active', created_at: NOW, updated_at: NOW };
    const once = trafficSourceSchema.parse(stored);
    expect(trafficSourceSchema.parse(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });

  it('rejects duplicate slots', () => {
    const s = sourceInput();
    s.fields = [
      { slot: 'c1', name: 'A', url_param: 'a' },
      { slot: 'c1', name: 'B', url_param: 'b' },
    ];
    const res = trafficSourceInputSchema.safeParse(s);
    expect(res.success).toBe(false);
    expect(res.error?.issues.map((i) => i.message)).toContain('duplicate slot');
  });

  it('rejects reserved URL parameters', () => {
    for (const p of ['vid', 'VID', 'hit', 'tx', 'rn']) {
      const s = sourceInput();
      s.fields = [{ slot: 'c3', name: 'Bad', url_param: p }];
      expect(trafficSourceInputSchema.safeParse(s).success, p).toBe(false);
    }
  });

  it('rejects the same URL parameter used twice', () => {
    const s = sourceInput();
    s.fields = [{ slot: 'c1', name: 'Campaign copy', url_param: 'Campaign' }];
    expect(trafficSourceInputSchema.safeParse(s).success).toBe(false);
  });

  it('rejects slots beyond c20 and more than 20 fields', () => {
    const s = sourceInput();
    s.fields = [{ slot: 'c21' as 'c1', name: 'X', url_param: 'x' }];
    expect(trafficSourceInputSchema.safeParse(s).success).toBe(false);
    const many = sourceInput();
    many.fields = Array.from({ length: 21 }, (_, i) => ({ slot: `c${(i % 20) + 1}` as 'c1', name: `F${i}`, url_param: `f${i}` }));
    expect(trafficSourceInputSchema.safeParse(many).success).toBe(false);
  });

  it('validates conversion events and tracking domain hostnames', () => {
    const s = sourceInput();
    s.conversion = { mapping: [{ event: 'refund', platform_event: 'X' }] };
    expect(trafficSourceInputSchema.safeParse(s).success).toBe(false);
    expect(createTrackingDomainSchema.parse({ site_id: 'st_1', hostname: 'Track.Example.com' }).hostname).toBe(
      'track.example.com',
    );
    expect(createTrackingDomainSchema.safeParse({ site_id: 'st_1', hostname: 'localhost' }).success).toBe(false);
  });
});

describe('ads and identity contracts', () => {
  it('parses entities, spend and outbound jobs', () => {
    expect(
      adEntitySchema.parse({ platform: 'meta', level: 'adset', external_id: '123', parent_external_id: '1', name: 'Set', status: 'ACTIVE' }),
    ).toMatchObject({ level: 'adset' });
    expect(adSpendDaySchema.safeParse({ platform: 'google', entity_external_id: '9', day: '2026-10-15', spend_minor: 1234, reported_conversions: 2.5 }).success).toBe(true);
    expect(adSpendDaySchema.safeParse({ platform: 'google', entity_external_id: '9', day: '15/10/2026', spend_minor: 1 }).success).toBe(false);
    expect(adSpendDaySchema.safeParse({ platform: 'bing', entity_external_id: '9', day: '2026-10-15', spend_minor: 1 }).success).toBe(false);
    const job = outboundConversionJobSchema.parse({
      id: 'oc_1',
      platform: 'tiktok',
      connection_id: 'ac_1',
      kind: 'purchase',
      payload: { event_name: 'CompletePayment', event_time: NOW, value_minor: 4900, currency: 'EUR', click_ids: { ttclid: 'x' } },
      status: 'pending',
      attempts: 0,
      event_id: 'evt_abc',
      created_at: NOW,
    });
    expect(job.payload.click_ids).toEqual({ ttclid: 'x' });
  });

  it('parses identity keys and merges', () => {
    expect(identityKeySchema.safeParse({ key_type: 'phone', key_value: '+393331234567', visitor_id: 'v', first_seen: NOW }).success).toBe(true);
    expect(identityKeySchema.safeParse({ key_type: 'fax', key_value: '1', visitor_id: 'v', first_seen: NOW }).success).toBe(false);
    expect(visitorMergeSchema.safeParse({ child_visitor_id: 'a', origin_visitor_id: 'b', mechanism: 'session', active: true, created_at: NOW }).success).toBe(true);
  });
});

describe('attribution report contracts', () => {
  it('keeps the legacy models untouched and adds the v2 set', () => {
    expect(ATTRIBUTION_MODELS).toEqual(['first_touch', 'last_touch', 'last_non_direct', 'linear', 'position_based']);
    expect(ATTRIBUTION_MODELS_V2).toEqual(['first_click', 'last_click', 'linear', 'u_shaped', 'time_decay', 'windowed_hybrid']);
  });

  it('applies performance query defaults and bounds the window', () => {
    const q = performanceQuerySchema.parse({ site_id: 'st_1', from: '2026-10-01', to: '2026-10-15' });
    expect(q).toMatchObject({ model: 'last_click', window_days: 7, group_by: 'source', basis: 'click_date', filters: [] });
    expect(performanceQuerySchema.parse({ site_id: 'st_1', from: '2026-10-01', to: '2026-10-15', window_days: '30' }).window_days).toBe(30);
    expect(performanceQuerySchema.safeParse({ site_id: 'st_1', from: '2026-10-01', to: '2026-10-15', window_days: 31 }).success).toBe(false);
    expect(performanceQuerySchema.safeParse({ site_id: 'st_1', from: '2026-10-01', to: '2026-10-15', model: 'last_touch' }).success).toBe(false);
  });

  it('parses a performance row and the other report queries', () => {
    const row = {
      key: 'ts_1',
      label: 'Meta',
      parent_key: null,
      visits: 10,
      clicks: 8,
      cost_minor: 1000,
      revenue_minor: 3000,
      total_revenue_minor: 3500,
      profit_minor: 2000,
      net_profit_minor: 1800,
      roas: 3,
      roi: 2,
      sales: 1.5,
      leads: 4,
      new_leads: 3,
      returning_customers: 0,
      aov_minor: 2000,
      cpa_minor: 666,
      cvr: 0.15,
      reported_conversions: 2,
      reported_revenue_minor: 4000,
      reported_vs_revenue_minor: -1000,
    };
    // Rows without hard costs (older servers) read as 0.
    expect(performanceRowSchema.parse(row)).toEqual({ ...row, hard_costs_minor: 0 });
    expect(performanceRowSchema.parse({ ...row, hard_costs_minor: 200 }).hard_costs_minor).toBe(200);
    expect(ltvQuerySchema.parse({ site_id: 's', from: '2026-01-01', to: '2026-10-01' }).model).toBe('first_click');
    expect(cohortQuerySchema.parse({ site_id: 's', from: '2026-01-01', to: '2026-10-01' }).granularity).toBe('month');
    expect(journeyQuerySchema.parse({ site_id: 's', from: '2026-01-01', to: '2026-10-01', converted_only: 'true' }).converted_only).toBe(true);
  });
});
