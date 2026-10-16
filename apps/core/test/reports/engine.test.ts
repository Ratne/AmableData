import { reportDefinitionSchema, type ReportDefinitionInput } from '@amable/api-types/reports';
import { describe, expect, it } from 'vitest';
import { runAutomationReportOp } from '../../src/automation/report-queries';
import type { AggregateOutput } from '../../src/reports/aggregate';
import type {
  AdsFacts,
  AnalyticsPort,
  AnalyticsSiteApi,
  BreakdownFacts,
  OverviewFacts,
} from '../../src/reports/analytics-source';
import { builtinReport } from '../../src/reports/catalog';
import { applyOverrides, runReport, type ReportPorts } from '../../src/reports/engine';
import {
  createEngineHarness,
  edge,
  goal,
  graph,
  seq,
  tagStep,
  type EngineHarness,
} from '../automation/helpers';
import { commerceWorld, DAY } from '../commerce/helpers';
import type { TestTenant } from '../crm/helpers';
import { createMailWorld, type MailWorld } from '../email/helpers';

function ports(
  options: {
    tenant?: TestTenant;
    mail?: MailWorld;
    engine?: EngineHarness;
    analytics?: AnalyticsPort | null;
    now?: number;
  } = {},
): ReportPorts {
  return {
    tenantId: 'tenant_1',
    aggregate: async (target, input) => {
      const clone = structuredClone(input);
      if (target === 'tenant') {
        if (options.tenant === undefined) throw new Error('no tenant');
        return structuredClone(options.tenant.op('reports.aggregate', clone));
      }
      if (target === 'mail') {
        if (options.mail === undefined) throw new Error('no mail');
        return structuredClone(await options.mail.op('reports.aggregate', clone));
      }
      if (options.engine === undefined) throw new Error('no engine');
      const result = runAutomationReportOp(
        options.engine.db,
        options.engine.engine,
        'reports.aggregate',
        clone,
      );
      if (!result.ok) throw new Error(result.error.message);
      return structuredClone(result.value as AggregateOutput);
    },
    analytics: options.analytics ?? null,
    userLabels: (ids) => Promise.resolve(new Map(ids.map((id) => [id, `User ${id}`]))),
    now: () => options.now ?? options.tenant?.clock.now ?? Date.UTC(2026, 9, 15, 12),
  };
}

const def = (input: ReportDefinitionInput) => reportDefinitionSchema.parse(input);
const iso = (ms: number) => new Date(ms).toISOString();

describe('report engine', () => {
  it('runs monthly sales with every bucket filled, derived averages and the previous-year comparison', async () => {
    const w = commerceWorld();
    const jan2026 = Date.UTC(2026, 0, 15);
    const o1 = w.t.op('orders.create', {
      contact_id: w.contactId,
      order_date: iso(jan2026),
      items: [{ product_id: w.mug }],
    });
    const o2 = w.t.op('orders.create', {
      contact_id: w.contactId,
      order_date: iso(jan2026 + DAY),
      items: [{ product_id: w.course }],
    });
    const old = w.t.op('orders.create', {
      contact_id: w.contactId,
      order_date: iso(Date.UTC(2025, 0, 20)),
      items: [{ product_id: w.mug }],
    });
    const report = builtinReport('sales_monthly');
    if (report === undefined) throw new Error('missing');
    const result = await runReport(
      ports({ tenant: w.t }),
      applyOverrides(report.definition, {
        measures: ['revenue', 'count', 'avg_order_value'],
        date_range: { from: '2026-01-01', to: '2026-12-31' },
      }),
      { reportId: report.id },
    );
    expect(result.range).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(result.compare_range).toEqual({ from: '2025-01-01', to: '2025-12-31' });
    expect(result.rows).toHaveLength(12);
    expect(result.rows[0]).toEqual({
      key: '2026-01',
      label: '2026-01',
      values: {
        revenue: o1.total_minor + o2.total_minor,
        count: 2,
        avg_order_value: Math.round((o1.total_minor + o2.total_minor) / 2),
      },
    });
    expect(result.rows[1]?.values).toEqual({ revenue: 0, count: 0, avg_order_value: null });
    expect(result.compare?.rows[0]?.values['revenue']).toBe(old.total_minor);
    expect(result.compare?.totals['count']).toBe(1);
    expect(result.measures).toEqual([
      { key: 'revenue', kind: 'money' },
      { key: 'count', kind: 'count' },
      { key: 'avg_order_value', kind: 'money' },
    ]);
    expect(result.currency).toBe('EUR');
    expect(result.meta.empty_reason).toBeNull();
  });

  it('replaces the stored contact filter with the run-time filter override', () => {
    const report = builtinReport('sales_monthly');
    if (report === undefined) throw new Error('missing');
    const stored = applyOverrides(
      { ...report.definition, filter: { type: 'group', op: 'and', conditions: [] } },
      undefined,
    );
    const filter = {
      type: 'group' as const,
      op: 'and' as const,
      conditions: [
        {
          type: 'field' as const,
          field: 'email',
          operator: 'contains' as const,
          value: 'example.com',
        },
      ],
    };
    expect(applyOverrides(stored, { filter }).filter).toEqual(filter);
    expect(applyOverrides(stored, { compare: 'none' }).filter).toEqual(stored.filter);
  });

  it('buckets by local days of the report time zone', async () => {
    const w = commerceWorld();
    // 23:30 UTC on 31 January is already 1 February in Rome.
    w.t.op('orders.create', {
      contact_id: w.contactId,
      order_date: iso(Date.UTC(2026, 0, 31, 23, 30)),
      items: [{ product_id: w.mug }],
    });
    const base: ReportDefinitionInput = {
      source: 'orders',
      measures: ['count'],
      dimension: 'date',
      granularity: 'month',
      date_range: { from: '2026-01-01', to: '2026-02-28' },
    };
    const utc = await runReport(ports({ tenant: w.t }), def(base), { reportId: null });
    const rome = await runReport(
      ports({ tenant: w.t }),
      def({ ...base, timezone: 'Europe/Rome' }),
      { reportId: null },
    );
    expect(utc.rows.map((r) => r.values['count'])).toEqual([1, 0]);
    expect(rome.rows.map((r) => r.values['count'])).toEqual([0, 1]);
  });

  it('derives churn rate and revenue churn from base subscription counters', async () => {
    const w = commerceWorld();
    const subs = [
      w.t.op('subscriptions.create', { contact_id: w.contactId, plan_id: w.monthly }),
      w.t.op('subscriptions.create', { contact_id: w.otherContactId, plan_id: w.monthly }),
    ];
    w.t.db.run(`UPDATE crm_subscriptions SET started_at = ?`, Date.UTC(2026, 0, 1));
    w.t.db.run(
      `UPDATE crm_subscriptions SET status = 'cancelled', ended_at = ? WHERE id = ?`,
      Date.UTC(2026, 2, 10),
      subs[0]?.id ?? '',
    );
    const result = await runReport(
      ports({ tenant: w.t }),
      def({
        source: 'subscriptions',
        measures: ['mrr', 'arr', 'churn_rate', 'revenue_churn_rate', 'churned'],
        dimension: 'date',
        granularity: 'month',
        date_range: { from: '2026-01-01', to: '2026-04-30' },
      }),
      { reportId: null },
    );
    expect(result.rows.map((r) => r.values)).toEqual([
      { mrr: 9_800, arr: 117_600, churn_rate: null, revenue_churn_rate: null, churned: 0 },
      { mrr: 9_800, arr: 117_600, churn_rate: 0, revenue_churn_rate: 0, churned: 0 },
      { mrr: 4_900, arr: 58_800, churn_rate: 0.5, revenue_churn_rate: 0.5, churned: 1 },
      { mrr: 4_900, arr: 58_800, churn_rate: 0, revenue_churn_rate: 0, churned: 0 },
    ]);
  });

  it('derives pipeline win rate, cycle length and velocity, and labels owners', async () => {
    const w = commerceWorld();
    const t = w.t;
    const pipeline = t.op('pipelines.create', { name: 'Sales' });
    const won = pipeline.stages.find((s) => s.kind === 'won');
    const lost = pipeline.stages.find((s) => s.kind === 'lost');
    if (won === undefined || lost === undefined) throw new Error('stages');
    const make = (value: number) =>
      t.op('opportunities.create', {
        title: 'D',
        pipeline_id: pipeline.id,
        value_minor: value,
        owner_id: 'user_9',
      });
    make(1_000);
    const a = make(10_000);
    const b = make(20_000);
    const c = make(30_000);
    t.clock.now += 20 * DAY;
    t.op('opportunities.update', { id: a.id, data: { stage_id: won.id } });
    t.op('opportunities.update', { id: b.id, data: { stage_id: won.id } });
    t.op('opportunities.update', { id: c.id, data: { stage_id: lost.id } });
    const result = await runReport(
      ports({ tenant: t }),
      def({
        source: 'opportunities',
        measures: ['win_rate', 'avg_cycle_days', 'velocity_per_day', 'open_count'],
        dimension: 'owner',
        date_range: { preset: 'this_year' },
      }),
      { reportId: null },
    );
    // velocity = open (1) × avg won value (15 000) × win rate (2/3) ÷ 20 days = 500 per day
    expect(result.totals).toEqual({
      win_rate: 0.6667,
      avg_cycle_days: 20,
      velocity_per_day: 500,
      open_count: 1,
    });
    expect(result.rows).toEqual([{ key: 'user_9', label: 'User user_9', values: result.totals }]);
  });

  it('reports broadcast performance and link clicks from the MailDb', async () => {
    const mail = createMailWorld();
    const now = mail.clock.now;
    const db = mail.deps.db;
    db.run(
      `INSERT INTO mail_broadcasts (id, name, status, created_at, updated_at, started_at) VALUES ('b1', 'October news', 'sent', ?, ?, ?)`,
      now,
      now,
      now,
    );
    const msg = (id: string, fields: { opened?: boolean; clicked?: boolean; unsub?: boolean }) =>
      db.run(
        `INSERT INTO mail_messages (id, request_id, contact_id, status, source_type, broadcast_id, sent_at, delivered_at,
                                    opened_at, clicked_at, unsubscribed_at, created_at, updated_at)
         VALUES (?, ?, 'c', 'delivered', 'broadcast', 'b1', ?, ?, ?, ?, ?, ?, ?)`,
        id,
        `req_${id}`,
        now,
        now,
        fields.opened === true ? now : null,
        fields.clicked === true ? now : null,
        fields.unsub === true ? now : null,
        now,
        now,
      );
    msg('m1', { opened: true, clicked: true });
    msg('m2', { opened: true });
    msg('m3', { unsub: true });
    msg('m4', {});
    const click = (id: string, message: string, url: string) =>
      db.run(
        `INSERT INTO mail_clicks (id, message_id, position, url, broadcast_id, created_at) VALUES (?, ?, 0, ?, 'b1', ?)`,
        id,
        message,
        url,
        now,
      );
    click('k1', 'm1', 'https://a.test');
    click('k2', 'm1', 'https://a.test');
    click('k3', 'm2', 'https://b.test');
    const p = ports({ mail, now });
    const perf = await runReport(
      p,
      def({
        source: 'broadcasts',
        measures: ['sent', 'open_rate', 'click_rate', 'unsubscribe_rate'],
        dimension: 'broadcast',
        date_range: { preset: 'last_30_days' },
      }),
      { reportId: null },
    );
    expect(perf.rows).toEqual([
      {
        key: 'b1',
        label: 'October news',
        values: { sent: 4, open_rate: 0.5, click_rate: 0.25, unsubscribe_rate: 0.25 },
      },
    ]);
    const links = await runReport(
      p,
      def({
        source: 'broadcast_links',
        measures: ['clicks', 'unique_clicks'],
        dimension: 'link',
        params: { broadcast_id: 'b1' },
      }),
      { reportId: null },
    );
    expect(links.rows.map((r) => [r.label, r.values])).toEqual([
      ['https://a.test', { clicks: 2, unique_clicks: 1 }],
      ['https://b.test', { clicks: 1, unique_clicks: 1 }],
    ]);
    expect(links.meta.options['broadcast_id']).toEqual([{ value: 'b1', label: 'October news' }]);
    const engagement = await runReport(
      p,
      def({
        source: 'emails',
        measures: ['sent', 'opened'],
        dimension: 'date',
        granularity: 'week',
        date_range: { preset: 'last_7_days' },
      }),
      { reportId: null },
    );
    expect(engagement.totals).toEqual({ sent: 4, opened: 2 });
  });

  it('reports automation performance per automation and per node from the Engine DO', async () => {
    const h = createEngineHarness();
    const trigger = h.tag('Lead');
    const done = h.tag('Welcomed');
    const id = await h.publish(
      graph(
        [goal('g', [{ type: 'tag_applied', tag_ids: [trigger] }]), seq('s', [tagStep('t1', done)])],
        [edge('g', 's')],
      ),
    );
    for (const name of ['Ada', 'Bob']) {
      h.tenant.op('contacts.applyTags', { id: h.contact(name), data: { tag_ids: [trigger] } });
    }
    await h.flush();
    const p = ports({ engine: h, now: h.clock.now });
    const perf = await runReport(
      p,
      def({
        source: 'automations',
        measures: ['entered', 'completed', 'completion_rate', 'active', 'errors'],
        dimension: 'automation',
        date_range: { preset: 'last_30_days' },
      }),
      { reportId: null },
    );
    expect(perf.rows).toEqual([
      {
        key: id,
        label: expect.any(String),
        values: { entered: 2, completed: 2, completion_rate: 1, active: 0, errors: 0 },
      },
    ]);
    const missing = await runReport(
      p,
      def({ source: 'automation_nodes', measures: ['entered'], dimension: 'node' }),
      { reportId: null },
    );
    expect(missing.meta.empty_reason).toBe('param_required');
    expect(missing.meta.options['automation_id']?.[0]?.value).toBe(id);
    const nodes = await runReport(
      p,
      def({
        source: 'automation_nodes',
        measures: ['entered', 'completed'],
        dimension: 'node',
        params: { automation_id: id },
      }),
      { reportId: null },
    );
    expect(nodes.rows.find((r) => r.key === 'g')?.values).toEqual({ entered: 2, completed: 2 });
    expect(nodes.rows.find((r) => r.key === 's#t1')).toMatchObject({
      label: 'sequence s › apply_tag t1',
      values: { entered: 2 },
    });
  });

  it('degrades analytics and attribution reports gracefully and reads the attribution API when present', async () => {
    const unavailable = await runReport(
      ports({ analytics: null }),
      def({ source: 'analytics', measures: ['revenue'], dimension: 'channel' }),
      { reportId: null },
    );
    expect(unavailable.meta.empty_reason).toBe('analytics_unavailable');

    const overview: OverviewFacts = {
      visitors: 100,
      sessions: 120,
      pageviews: 300,
      // Visitors with any goal: the channel totals use the credited purchases instead.
      conversions: 1_480,
      revenue_minor: 50_000,
      currency: 'EUR',
    };
    const breakdown: BreakdownFacts = {
      rows: [
        { value: 'Organic search', visitors: 60, revenue_minor: 30_000, conversions: 2.5 },
        { value: 'Email', visitors: 40, revenue_minor: 20_000, conversions: 1.5 },
      ],
    };
    const calls: string[] = [];
    const site: AnalyticsSiteApi = {
      getSite: () =>
        Promise.resolve({
          tenantId: 'tenant_1',
          deleted: false,
          site: { id: 'st_1', name: 'Shop', currency: 'EUR' },
        }),
      overview: () => Promise.resolve({ ok: true, value: overview }),
      timeseries: () =>
        Promise.resolve({ ok: false, error: { code: 'invalid_range', message: 'x' } }),
      breakdown: (_r, _d, _l, model) => {
        calls.push(model ?? 'site-default');
        return Promise.resolve({ ok: true, value: breakdown });
      },
      ads: () => Promise.reject(new Error('method not implemented')),
    };
    const analytics: AnalyticsPort = { siteIds: () => Promise.resolve(['st_1']), site: () => site };
    const byChannel = await runReport(
      ports({ analytics }),
      def({
        source: 'analytics',
        measures: ['revenue', 'conversions', 'revenue_per_visitor'],
        dimension: 'channel',
        params: { model: 'linear' },
      }),
      { reportId: null },
    );
    expect(calls).toEqual(['linear']);
    expect(byChannel.currency).toBe('EUR');
    expect(byChannel.rows[0]).toEqual({
      key: 'Organic search',
      label: 'Organic search',
      values: { revenue: 30_000, conversions: 2.5, revenue_per_visitor: 500 },
    });
    expect(byChannel.totals).toEqual({ revenue: 50_000, conversions: 4, revenue_per_visitor: 500 });
    expect(byChannel.meta.options['site_id']).toEqual([{ value: 'st_1', label: 'Shop' }]);
    expect(byChannel.meta.options['model']?.map((o) => o.value)).toEqual([
      'first_touch',
      'last_touch',
      'last_non_direct',
      'linear',
      'position_based',
    ]);

    const dimensions: string[] = [];
    site.breakdown = (_r, dimension, _l, model) => {
      dimensions.push(dimension);
      calls.push(model ?? 'site-default');
      return Promise.resolve({ ok: true, value: breakdown });
    };
    for (const model of ['last_touch', 'position_based', 'bogus']) {
      const byPage = await runReport(
        ports({ analytics }),
        def({
          source: 'analytics',
          measures: ['revenue'],
          dimension: 'entry_page',
          params: { model },
        }),
        { reportId: null },
      );
      expect(byPage.meta.empty_reason).toBeNull();
      expect(byPage.rows).toHaveLength(2);
    }
    expect(dimensions).toEqual(['entry_page', 'entry_page', 'entry_page']);
    expect(calls).toEqual(['linear', 'last_touch', 'position_based', 'site-default']);

    const ads = await runReport(
      ports({ analytics }),
      def({ source: 'ad_campaigns', measures: ['spend', 'roas'], dimension: 'campaign' }),
      { reportId: null },
    );
    expect(ads.meta.empty_reason).toBe('attribution_unavailable');

    const report: AdsFacts = {
      currency: 'EUR',
      totals: { spend_minor: 10_000, revenue_minor: 40_000, clicks: 10, impressions: 100 },
      campaigns: [
        {
          campaign_id: 'c1',
          campaign_name: 'Autumn',
          spend_minor: 10_000,
          impressions: 100,
          clicks: 10,
          customers: 2,
          revenue_minor: 40_000,
        },
      ],
    };
    site.ads = () => Promise.resolve({ ok: true, value: report });
    const roas = await runReport(
      ports({ analytics }),
      def({
        source: 'ad_campaigns',
        measures: ['spend', 'revenue', 'roas', 'cost_per_acquisition'],
        dimension: 'campaign',
      }),
      { reportId: null },
    );
    expect(roas.rows).toEqual([
      {
        key: 'c1',
        label: 'Autumn',
        values: { spend: 10_000, revenue: 40_000, roas: 4, cost_per_acquisition: 5_000 },
      },
    ]);

    const noSites = await runReport(
      ports({ analytics: { siteIds: () => Promise.resolve([]), site: () => site } }),
      def({ source: 'analytics', measures: ['visitors'] }),
      { reportId: null },
    );
    expect(noSites.meta.empty_reason).toBe('no_sites');
  });

  it('rejects measures, dimensions and filters a source does not support', async () => {
    const p = ports();
    await expect(
      runReport(p, def({ source: 'orders', measures: ['mrr'] }), { reportId: null }),
    ).rejects.toThrow(/not a measure/);
    await expect(
      runReport(p, def({ source: 'orders', measures: ['count'], dimension: 'tag' }), {
        reportId: null,
      }),
    ).rejects.toThrow(/not a dimension/);
    await expect(
      runReport(
        p,
        def({
          source: 'emails',
          measures: ['sent'],
          filter: {
            type: 'group',
            op: 'and',
            conditions: [{ type: 'field', field: 'email', operator: 'is_not_empty' }],
          },
        }),
        { reportId: null },
      ),
    ).rejects.toThrow(/cannot be filtered/);
    await expect(
      runReport(
        p,
        def({
          source: 'orders',
          measures: ['count'],
          dimension: 'date',
          granularity: 'day',
          date_range: { preset: 'all_time' },
        }),
        { reportId: null },
      ),
    ).rejects.toThrow(/buckets/);
  });
});
