import { describe, expect, it } from 'vitest';
import type { AggregateInput, AggregateOutput } from '../../src/reports/aggregate';
import { buildBuckets, parseDate, rangeMs } from '../../src/reports/time';
import { commerceWorld, DAY, type CommerceWorld } from '../commerce/helpers';
import { createTestTenant, type TestTenant, USER_ACTOR } from '../crm/helpers';

const YEAR = { from: parseDate('2026-01-01'), to: parseDate('2026-12-31') };

function agg(
  t: TestTenant,
  input: Partial<AggregateInput> & Pick<AggregateInput, 'source' | 'measures'>,
): AggregateOutput {
  const months = buildBuckets(YEAR, 'month', 'UTC');
  return t.op('reports.aggregate', {
    dimension: null,
    range: rangeMs(YEAR, 'UTC'),
    buckets: input.dimension === 'date' ? months.bounds : null,
    limit: 100,
    offset: 0,
    now: t.clock.now,
    ...input,
  });
}

const iso = (y: number, m: number, d: number, h = 12): string =>
  new Date(Date.UTC(y, m - 1, d, h)).toISOString();

function order(
  w: CommerceWorld,
  contactId: string,
  date: string,
  items: Array<{ product_id: string; quantity?: number }>,
) {
  return w.t.op('orders.create', { contact_id: contactId, order_date: date, items });
}

function pay(w: CommerceWorld, orderId: string, amount: number) {
  return w.t.op('payments.record', { orderId, data: { amount_minor: amount, method: 'card' } });
}

describe('e-commerce aggregates (TenantDb)', () => {
  it('sums sales per month in one currency, excluding drafts and cancelled orders', () => {
    const w = commerceWorld();
    const jan = order(w, w.contactId, iso(2026, 1, 10), [{ product_id: w.course }]);
    const mar = order(w, w.otherContactId, iso(2026, 3, 5), [{ product_id: w.mug, quantity: 2 }]);
    order(w, w.contactId, iso(2026, 3, 20), [{ product_id: w.mug }]);
    w.t.op('orders.create', {
      contact_id: w.contactId,
      status: 'draft',
      order_date: iso(2026, 3, 1),
      items: [{ product_id: w.course }],
    });
    const cancelled = order(w, w.contactId, iso(2026, 3, 2), [{ product_id: w.course }]);
    w.t.op('orders.cancel', { id: cancelled.id, data: {} });
    const usd = w.t.op('products.create', {
      name: 'USD thing',
      price_minor: 999,
      currency: 'USD',
    }).id;
    order(w, w.contactId, iso(2026, 3, 3), [{ product_id: usd }]);
    pay(w, jan.id, jan.total_minor);

    const out = agg(w.t, {
      source: 'orders',
      measures: ['revenue', 'count', 'paid', 'customers'],
      dimension: 'date',
    });
    expect(out.currency).toBe('EUR');
    expect(out.currencies).toEqual(['USD']);
    expect(out.rows.map((r) => [r.key, r.values])).toEqual([
      ['0', { revenue: jan.total_minor, count: 1, paid: jan.total_minor, customers: 1 }],
      ['2', { revenue: mar.total_minor + 1_375, count: 2, paid: 0, customers: 2 }],
    ]);
    expect(out.totals).toEqual({
      revenue: jan.total_minor + mar.total_minor + 1_375,
      count: 3,
      paid: jan.total_minor,
      customers: 2,
    });
    const usdOut = agg(w.t, { source: 'orders', measures: ['revenue'], currency: 'USD' });
    expect(usdOut.totals['revenue']).toBe(999);
  });

  it('applies the query-builder contact filter (tags) and groups revenue by product', () => {
    const w = commerceWorld();
    const vip = w.t.op('tags.create', { name: 'VIP' });
    w.t.op('contacts.applyTags', { id: w.contactId, data: { tag_ids: [vip.id] } });
    order(w, w.contactId, iso(2026, 2, 1), [
      { product_id: w.course },
      { product_id: w.mug, quantity: 4 },
    ]);
    order(w, w.otherContactId, iso(2026, 2, 2), [{ product_id: w.mug, quantity: 10 }]);
    const filter = {
      type: 'group',
      op: 'and',
      conditions: [{ type: 'tags', match: 'any', tag_ids: [vip.id] }],
    } as const;
    const out = agg(w.t, {
      source: 'order_items',
      measures: ['quantity', 'revenue', 'orders'],
      dimension: 'product',
      filter,
    });
    expect(out.rows.map((r) => [r.label, r.values['quantity'], r.values['orders']])).toEqual([
      ['Mug', 4, 1],
      ['Analytics Course', 1, 1],
    ]);
    const all = agg(w.t, { source: 'order_items', measures: ['quantity'], dimension: 'product' });
    expect(all.rows[0]).toMatchObject({ label: 'Mug', values: { quantity: 14 } });
  });

  it('splits one-time sales, first subscription orders and renewals', () => {
    const w = commerceWorld();
    order(w, w.contactId, iso(2026, 10, 1), [{ product_id: w.mug }]);
    w.t.op('subscriptions.create', { contact_id: w.contactId, plan_id: w.monthly });
    w.t.clock.now += 32 * DAY;
    w.t.op('billing.run', {});
    const range = { from: parseDate('2026-01-01'), to: parseDate('2027-12-31') };
    const out = w.t.op('reports.aggregate', {
      source: 'orders',
      measures: ['count'],
      dimension: 'kind',
      range: rangeMs(range, 'UTC'),
      buckets: null,
      limit: 10,
      offset: 0,
      now: w.t.clock.now,
    });
    expect(Object.fromEntries(out.rows.map((r) => [r.key, r.values['count']]))).toEqual({
      one_time: 1,
      new_subscription: 1,
      renewal: 1,
    });
  });

  it('reports payments, refunds and net amounts', () => {
    const w = commerceWorld();
    const o = order(w, w.contactId, iso(2026, 4, 1), [{ product_id: w.course }]);
    pay(w, o.id, o.total_minor);
    w.t.op('refunds.record', { orderId: o.id, data: { amount_minor: 5_000, reason: 'damaged' } });
    const payments = agg(w.t, {
      source: 'payments',
      measures: ['count', 'amount', 'refunded', 'net'],
      dimension: 'method',
    });
    expect(payments.rows).toEqual([
      {
        key: 'card',
        label: null,
        values: { count: 1, amount: o.total_minor, refunded: 5_000, net: o.total_minor - 5_000 },
      },
    ]);
    // The refund is recorded "now" (October 2026, clock of the test tenant).
    const refunds = agg(w.t, {
      source: 'refunds',
      measures: ['amount', 'count'],
      dimension: 'reason',
    });
    expect(refunds.rows[0]).toMatchObject({ key: 'damaged', values: { amount: 5_000, count: 1 } });
  });

  it('ages open balances of unpaid and partially paid orders', () => {
    const w = commerceWorld();
    const now = w.t.clock.now;
    const due = (offsetDays: number) => {
      const o = order(w, w.contactId, iso(2026, 1, 1), [{ product_id: w.mug }]);
      w.t.db.run(`UPDATE crm_orders SET due_at = ? WHERE id = ?`, now + offsetDays * DAY, o.id);
      return o;
    };
    const current = due(5);
    const late10 = due(-10);
    const late45 = due(-45);
    const late200 = due(-200);
    pay(w, late45.id, 375); // partially paid: balance 1375 - 375 = 1000
    const paid = due(-20);
    pay(w, paid.id, paid.total_minor);
    const out = agg(w.t, {
      source: 'receivables',
      measures: ['balance', 'count', 'overdue_balance'],
      dimension: 'aging',
      now: now + 1,
    });
    expect(out.rows.map((r) => [r.key, r.values['balance'], r.values['count']])).toEqual([
      ['current', current.total_minor, 1],
      ['1_30', late10.total_minor, 1],
      ['31_60', 1_000, 1],
      ['90_plus', late200.total_minor, 1],
    ]);
    expect(out.totals).toEqual({
      balance: current.total_minor + late10.total_minor + 1_000 + late200.total_minor,
      count: 4,
      overdue_balance: late10.total_minor + 1_000 + late200.total_minor,
    });
    const byContact = agg(w.t, {
      source: 'receivables',
      measures: ['balance'],
      dimension: 'contact',
    });
    expect(byContact.rows).toEqual([
      { key: w.contactId, label: 'Ada Lovelace', values: { balance: out.totals['balance'] } },
    ]);
  });

  it('computes customer lifetime value net of refunds', () => {
    const w = commerceWorld();
    const a1 = order(w, w.contactId, iso(2026, 1, 5), [{ product_id: w.course }]);
    const a2 = order(w, w.contactId, iso(2026, 6, 5), [{ product_id: w.mug }]);
    const b1 = order(w, w.otherContactId, iso(2026, 2, 5), [{ product_id: w.mug }]);
    pay(w, a1.id, a1.total_minor);
    pay(w, a2.id, a2.total_minor);
    pay(w, b1.id, 1_000);
    w.t.op('refunds.record', { orderId: a2.id, data: {} });
    const out = agg(w.t, {
      source: 'customers',
      measures: ['lifetime_value', 'orders', 'customers'],
      dimension: 'contact',
    });
    expect(out.rows.map((r) => [r.label, r.values['lifetime_value'], r.values['orders']])).toEqual([
      ['Ada Lovelace', a1.total_minor, 2],
      ['Grace Hopper', 1_000, 1],
    ]);
    expect(out.totals).toEqual({ lifetime_value: a1.total_minor + 1_000, orders: 3, customers: 2 });
  });

  it('computes MRR, active subscriptions and churn per month inside the DO', () => {
    const w = commerceWorld();
    const s1 = w.t.op('subscriptions.create', { contact_id: w.contactId, plan_id: w.monthly });
    const s2 = w.t.op('subscriptions.create', { contact_id: w.otherContactId, plan_id: w.yearly });
    const start = Date.UTC(2026, 0, 10);
    w.t.db.run(
      `UPDATE crm_subscriptions SET started_at = ? WHERE id IN (?, ?)`,
      start,
      s1.id,
      s2.id,
    );
    w.t.db.run(
      `UPDATE crm_subscriptions SET status = 'cancelled', ended_at = ? WHERE id = ?`,
      Date.UTC(2026, 4, 15),
      s1.id,
    );
    const out = agg(w.t, {
      source: 'subscriptions',
      measures: ['mrr', 'active', 'churned', 'active_start', 'new'],
      dimension: 'date',
    });
    expect(out.rows).toHaveLength(12);
    expect(out.rows[0]?.values).toEqual({
      mrr: 4_900 + 4_083,
      active: 2,
      churned: 0,
      active_start: 0,
      new: 2,
    });
    expect(out.rows[4]?.values).toEqual({
      mrr: 4_083,
      active: 1,
      churned: 1,
      active_start: 2,
      new: 0,
    });
    expect(out.totals).toEqual({ mrr: 4_083, active: 1, churned: 1, active_start: 0, new: 2 });
    const byPlan = agg(w.t, {
      source: 'subscriptions',
      measures: ['mrr', 'active'],
      dimension: 'plan',
    });
    expect(byPlan.rows.map((r) => [r.label, r.values['mrr']])).toEqual([
      ['Yearly', 4_083],
      ['Monthly', 0],
    ]);
  });
});

describe('CRM aggregates (TenantDb)', () => {
  it('counts tag applications and removals over time and per tag', () => {
    const t = createTestTenant();
    const vip = t.op('tags.create', { name: 'VIP' });
    const lead = t.op('tags.create', { name: 'Lead' });
    const a = t.op('contacts.create', { given_name: 'A' });
    const b = t.op('contacts.create', { given_name: 'B' });
    t.op('tags.apply', { tagId: vip.id, contactIds: [a.id, b.id] });
    t.op('tags.apply', { tagId: lead.id, contactIds: [a.id] });
    t.op('contacts.removeTag', { id: a.id, tagId: vip.id });
    const out = agg(t, {
      source: 'tags',
      measures: ['applications', 'removals', 'contacts'],
      dimension: 'tag',
    });
    expect(out.rows.map((r) => [r.label, r.values])).toEqual([
      ['VIP', { applications: 2, removals: 1, contacts: 2 }],
      ['Lead', { applications: 1, removals: 0, contacts: 1 }],
    ]);
    const monthly = agg(t, { source: 'tags', measures: ['applications'], dimension: 'date' });
    expect(monthly.rows).toEqual([{ key: '9', label: null, values: { applications: 3 } }]);
    const indexes = t.db
      .all<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'rpt_%' ORDER BY name`,
      )
      .map((r) => r.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'rpt_activities_type_at',
        'rpt_opportunities_closed',
        'rpt_tasks_created',
      ]),
    );
    const plan = t.db.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN SELECT COUNT(*) FROM crm_activities a
        WHERE a.type IN ('contact.tag_applied', 'contact.tag_removed') AND a.occurred_at >= 0 AND a.occurred_at < 1`,
    );
    expect(plan.map((p) => p.detail).join(' ')).toContain('rpt_activities_type_at');
  });

  it('groups contacts by lead source and measures lead source revenue', () => {
    const w = commerceWorld();
    const ads = w.t.op('leadSources.create', { name: 'Ads' });
    const c = w.t.op('contacts.create', { given_name: 'Lead', lead_source_id: ads.id });
    w.t.op('contacts.create', { given_name: 'Other', lead_source_id: ads.id });
    const o = order(w, c.id, iso(2026, 10, 1), [{ product_id: w.course }]);
    pay(w, o.id, o.total_minor);
    const contacts = agg(w.t, {
      source: 'contacts',
      measures: ['count'],
      dimension: 'lead_source',
    });
    expect(contacts.rows[0]).toMatchObject({ key: '', values: { count: 2 } });
    expect(contacts.rows).toContainEqual({ key: ads.id, label: 'Ads', values: { count: 2 } });
    const roi = agg(w.t, {
      source: 'lead_sources',
      measures: ['contacts', 'customers', 'revenue'],
      dimension: 'lead_source',
    });
    expect(roi.rows).toContainEqual({
      key: ads.id,
      label: 'Ads',
      values: { contacts: 2, customers: 1, revenue: o.total_minor },
    });
  });

  it('reports the pipeline by stage (snapshot) and closed deals by close date', () => {
    const t = createTestTenant();
    const pipeline = t.op('pipelines.create', { name: 'Sales' });
    const stage = (kind: string) => pipeline.stages.find((s) => s.kind === kind);
    const first = pipeline.stages[0];
    const won = stage('won');
    const lost = stage('lost');
    if (first === undefined || won === undefined || lost === undefined) throw new Error('stages');
    const make = (value: number) =>
      t.op('opportunities.create', {
        title: 'D',
        pipeline_id: pipeline.id,
        value_minor: value,
        currency: 'EUR',
      });
    make(1_000);
    make(3_000);
    const w1 = make(5_000);
    const l1 = make(7_000);
    t.clock.now += 10 * DAY;
    t.op('opportunities.update', { id: w1.id, data: { stage_id: won.id } });
    t.op('opportunities.update', { id: l1.id, data: { stage_id: lost.id } });
    const byStage = agg(t, {
      source: 'opportunities',
      measures: ['open_count', 'open_value', 'weighted_value', 'won', 'lost'],
      dimension: 'stage',
    });
    expect(byStage.rows[0]).toMatchObject({
      key: first.id,
      values: { open_count: 2, open_value: 4_000 },
    });
    expect(byStage.totals).toMatchObject({ open_count: 2, open_value: 4_000, won: 1, lost: 1 });
    const cycle = agg(t, { source: 'opportunities', measures: ['won_value', 'cycle_ms_won'] });
    expect(cycle.totals['won_value']).toBe(5_000);
    expect(Math.round((cycle.totals['cycle_ms_won'] ?? 0) / DAY)).toBe(10);
  });

  it('counts tasks created, completed and overdue', () => {
    const t = createTestTenant();
    const a = t.op('tasks.create', {
      title: 'a',
      assigned_to: 'user_1',
      due_at: new Date(t.clock.now - DAY).toISOString(),
    });
    t.op('tasks.create', { title: 'b', assigned_to: 'user_1' });
    t.op('tasks.create', {
      title: 'c',
      assigned_to: 'user_2',
      due_at: new Date(t.clock.now - DAY).toISOString(),
    });
    t.op('tasks.complete', { id: a.id });
    const out = agg(t, {
      source: 'tasks',
      measures: ['created', 'completed', 'overdue'],
      dimension: 'assignee',
    });
    expect(Object.fromEntries(out.rows.map((r) => [r.key, r.values]))).toEqual({
      user_1: { created: 2, completed: 1, overdue: 0 },
      user_2: { created: 1, completed: 0, overdue: 1 },
    });
  });

  it('measures form submissions per form when the forms module is installed', () => {
    const t = createTestTenant();
    const hasForms =
      t.db.all(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'form_submissions'`)
        .length > 0;
    if (!hasForms) {
      expect(agg(t, { source: 'forms', measures: ['submissions'] }).emptyReason).toBe(
        'source_unavailable',
      );
      return;
    }
    const c = t.op('contacts.create', { given_name: 'F' });
    const now = t.clock.now;
    t.db.run(
      `INSERT INTO form_forms (id, name, definition, created_at, updated_at) VALUES ('f1', 'Newsletter', '{}', ?, ?)`,
      now,
      now,
    );
    const submit = (id: string, contact: string | null, created: number) =>
      t.db.run(
        `INSERT INTO form_submissions (id, form_id, ciphertext, contact_id, contact_created, utm_source, created_at)
         VALUES (?, 'f1', 'x', ?, ?, 'google', ?)`,
        id,
        contact,
        created,
        now,
      );
    submit('s1', c.id, 1);
    submit('s2', c.id, 0);
    submit('s3', null, 0);
    const out = agg(t, {
      source: 'forms',
      measures: ['submissions', 'contacts', 'new_contacts'],
      dimension: 'form',
    });
    expect(out.rows).toEqual([
      { key: 'f1', label: 'Newsletter', values: { submissions: 3, contacts: 1, new_contacts: 1 } },
    ]);
  });
});

describe('saved reports and dashboards (TenantDb store)', () => {
  const definition = {
    source: 'orders' as const,
    measures: ['revenue'],
    dimension: 'date',
    granularity: 'month' as const,
    date_range: { preset: 'last_12_months' as const },
    compare: 'none' as const,
    limit: 100,
  };
  const other = { type: 'user' as const, id: 'user_2', canReadSensitive: true };

  it('keeps private reports to their owner and lets only owners (or admins) change them', () => {
    const t = createTestTenant();
    const mine = t.op('reports.custom.create', {
      data: { name: 'Mine', definition, chart: 'bar', shared: false },
    });
    const shared = t.op('reports.custom.create', {
      data: { name: 'Team', definition, chart: 'line', shared: true },
    });
    expect(
      t
        .op('reports.custom.list', {})
        .map((r) => r.name)
        .sort(),
    ).toEqual(['Mine', 'Team']);
    expect(t.op('reports.custom.list', {}, other).map((r) => r.name)).toEqual(['Team']);
    expect(() => t.op('reports.custom.get', { id: mine.id }, other)).toThrow(/not_found/);
    expect(() =>
      t.op(
        'reports.custom.update',
        { id: shared.id, data: { name: 'x' }, canManageAll: false },
        other,
      ),
    ).toThrow(/forbidden/);
    expect(
      t.op(
        'reports.custom.update',
        { id: shared.id, data: { name: 'Team 2' }, canManageAll: true },
        other,
      ).name,
    ).toBe('Team 2');
    t.op('reports.custom.delete', { id: mine.id, canManageAll: false });
    expect(t.op('reports.custom.list', {}).map((r) => r.name)).toEqual(['Team 2']);
    expect(mine.owner_id).toBe(USER_ACTOR.id);
  });

  it('persists widget layouts and keeps a single default shared dashboard', () => {
    const t = createTestTenant();
    const widget = (id: string, x: number, y: number) => ({
      id,
      type: 'kpi' as const,
      title: null,
      report_id: 'sales_monthly',
      layout: { x, y, w: 3, h: 2 },
    });
    const d = t.op('reports.dashboards.create', {
      data: {
        name: 'Sales',
        shared: true,
        is_default: true,
        widgets: [widget('a', 0, 0), widget('b', 3, 0)],
      },
      canManageAll: true,
    });
    const moved = t.op('reports.dashboards.update', {
      id: d.id,
      data: {
        widgets: [widget('a', 6, 2), { ...widget('b', 0, 0), layout: { x: 0, y: 0, w: 6, h: 4 } }],
      },
      canManageAll: false,
    });
    expect(moved.widgets.map((w) => [w.id, w.layout])).toEqual([
      ['a', { x: 6, y: 2, w: 3, h: 2 }],
      ['b', { x: 0, y: 0, w: 6, h: 4 }],
    ]);
    expect(t.op('reports.dashboards.get', { id: d.id }).widgets[0]?.layout).toEqual({
      x: 6,
      y: 2,
      w: 3,
      h: 2,
    });
    const second = t.op('reports.dashboards.create', {
      data: { name: 'Marketing', shared: true, is_default: true, widgets: [] },
      canManageAll: true,
    });
    expect(t.op('reports.dashboards.default', {})?.id).toBe(second.id);
    expect(t.op('reports.dashboards.get', { id: d.id }).is_default).toBe(false);
    expect(() =>
      t.op('reports.dashboards.create', {
        data: { name: 'x', shared: true, is_default: true, widgets: [] },
        canManageAll: false,
      }),
    ).toThrow(/forbidden/);
    expect(() =>
      t.op('reports.dashboards.update', {
        id: d.id,
        data: { widgets: [widget('a', 0, 0), widget('a', 3, 0)] },
        canManageAll: true,
      }),
    ).toThrow(/duplicate widget/);
    expect(() =>
      t.op('reports.dashboards.update', {
        id: d.id,
        data: { widgets: [{ ...widget('a', 11, 0) }] },
        canManageAll: true,
      }),
    ).toThrow(/overflows/);
    const priv = t.op('reports.dashboards.create', {
      data: { name: 'Private', shared: false, is_default: false, widgets: [] },
      canManageAll: false,
    });
    expect(t.op('reports.dashboards.list', {}, other).map((x) => x.id)).not.toContain(priv.id);
  });
});
