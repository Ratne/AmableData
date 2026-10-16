import { ROLES, type Role } from '@amable/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { fakeTenantDbNamespace } from '../crm/helpers';
import { fakeMailDbNamespace } from '../email/helpers';
import {
  addMember,
  createHarness,
  login,
  seedTenant,
  seedUser,
  type Harness,
  type TestClient,
} from '../helpers/harness';

const BASE = '/api/v2/t/shop';

let h: Harness;
const clients = {} as Record<Role, TestClient>;

const widget = (id: string, reportId: string, x: number, y: number) => ({
  id,
  type: 'kpi',
  report_id: reportId,
  measures: ['revenue'],
  layout: { x, y, w: 3, h: 2 },
});

beforeAll(async () => {
  h = await createHarness();
  h.env.TENANT_DB = fakeTenantDbNamespace(() => h.clock.now);
  h.env.MAIL_DB = fakeMailDbNamespace().namespace;
  const shop = await seedTenant(h, 'shop');
  for (const role of ROLES) {
    const user = await seedUser(h, { email: `${role}@shop.test` });
    await addMember(h, user.id, shop.id, role);
    clients[role] = await login(h, user.email);
  }
  const owner = clients.owner;
  const contact = await owner.post(`${BASE}/contacts`, { given_name: 'Buyer' });
  const product = await owner.post(`${BASE}/products`, {
    name: 'Course',
    price_minor: 10_000,
    currency: 'EUR',
  });
  const order = await owner.post(`${BASE}/orders`, {
    contact_id: contact.body['id'],
    items: [{ product_id: product.body['id'], quantity: 2 }],
  });
  expect(order.status).toBe(201);
});

describe('report catalog and runs by role', () => {
  it('filters the catalog by report and module permissions', async () => {
    const ids = async (role: Role) =>
      ((await clients[role].get(`${BASE}/reports`)).body['data'] as Array<{ id: string }>).map(
        (r) => r.id,
      );
    const viewer = await ids('viewer');
    expect(viewer).toEqual(
      expect.arrayContaining([
        'sales_monthly',
        'broadcast_performance',
        'subscription_mrr',
        'lead_source_roi',
      ]),
    );
    const sales = await ids('sales');
    expect(sales).toContain('sales_monthly');
    expect(sales).toContain('pipeline_by_stage');
    expect(sales).not.toContain('broadcast_performance');
    expect(sales).not.toContain('new_contacts');
    const sources = (await clients.sales.get(`${BASE}/reports`)).body['sources'] as Record<
      string,
      unknown
    >;
    expect(Object.keys(sources)).not.toContain('emails');
  });

  it('runs reports for every role that may read them and refuses the others', async () => {
    const run = await clients.viewer.post(`${BASE}/reports/sales_monthly/run`, {
      overrides: { date_range: { preset: 'this_month' }, dimension: null, compare: 'none' },
    });
    expect(run.status).toBe(200);
    expect(run.body['totals']).toMatchObject({ revenue: 20_000, count: 1 });
    expect(run.body['currency']).toBe('EUR');
    expect((await clients.sales.post(`${BASE}/reports/sales_monthly/run`, {})).status).toBe(200);
    expect((await clients.sales.post(`${BASE}/reports/broadcast_performance/run`, {})).status).toBe(
      403,
    );
    expect((await clients.viewer.post(`${BASE}/reports/nope/run`, {})).status).toBe(404);
    const bad = await clients.viewer.post(`${BASE}/reports/sales_monthly/run`, {
      overrides: { measures: ['mrr'] },
    });
    expect(bad.status).toBe(422);
    const analytics = await clients.viewer.post(`${BASE}/reports/revenue_by_channel/run`, {});
    expect(analytics.status).toBe(200);
    expect((analytics.body['meta'] as { empty_reason: string }).empty_reason).toBe(
      'analytics_unavailable',
    );
    const adHoc = await clients.marketer.post(`${BASE}/reports/run`, {
      definition: {
        source: 'orders',
        measures: ['count'],
        dimension: 'status',
        date_range: { preset: 'this_year' },
      },
    });
    expect(adHoc.status).toBe(200);
    expect(adHoc.body['rows']).toEqual([{ key: 'unpaid', label: 'unpaid', values: { count: 1 } }]);
  });

  it('streams CSV exports to analysts, owners and admins only, and audits them', async () => {
    const expected: Record<Role, number> = {
      owner: 200,
      admin: 200,
      analyst: 200,
      marketer: 403,
      sales: 403,
      viewer: 403,
    };
    for (const role of ROLES) {
      const res = await clients[role].get(`${BASE}/reports/revenue_by_product/export.csv`);
      expect([role, res.status]).toEqual([role, expected[role]]);
    }
    const overrides = encodeURIComponent(JSON.stringify({ date_range: { preset: 'this_month' } }));
    const res = await clients.analyst.get(
      `${BASE}/reports/revenue_by_product/export.csv?overrides=${overrides}`,
    );
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toMatch(
      /attachment; filename="revenue_by_product-/,
    );
    const text = String(res.body['text']).replace(/^\uFEFF/, '');
    expect(text.split('\r\n')).toEqual([
      'product,revenue,quantity,orders,currency',
      'Course,200.00,2,1,EUR',
      'Total,200.00,2,1,EUR',
      '',
    ]);
    const audit = await h.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'reports.exported'`,
    ).first<{ n: number }>();
    expect(audit?.n).toBeGreaterThanOrEqual(4);
    const bad = await clients.analyst.get(
      `${BASE}/reports/revenue_by_product/export.csv?overrides=%7Bnope`,
    );
    expect(bad.status).toBe(422);
  });
});

describe('custom reports and dashboards', () => {
  it('lets analysts save custom reports that viewers can read but not create', async () => {
    const definition = {
      source: 'orders',
      measures: ['revenue'],
      dimension: 'source',
      date_range: { preset: 'this_year' },
    };
    const created = await clients.analyst.post(`${BASE}/customReports`, {
      name: 'By source',
      definition,
      chart: 'bar',
    });
    expect(created.status).toBe(201);
    const id = String(created.body['id']);
    expect(
      (await clients.viewer.post(`${BASE}/customReports`, { name: 'x', definition })).status,
    ).toBe(403);
    expect(
      (
        await clients.analyst.post(`${BASE}/customReports`, {
          name: 'x',
          definition: { ...definition, measures: ['nope'] },
        })
      ).status,
    ).toBe(422);
    const listed = (await clients.viewer.get(`${BASE}/reports`)).body['data'] as Array<{
      id: string;
      kind: string;
    }>;
    expect(listed).toContainEqual(expect.objectContaining({ id, kind: 'custom' }));
    const run = await clients.viewer.post(`${BASE}/reports/${id}/run`, {});
    expect(run.status).toBe(200);
    expect(run.body['rows']).toEqual([
      { key: 'manual', label: 'manual', values: { revenue: 20_000 } },
    ]);
    expect(
      (await clients.viewer.patch(`${BASE}/customReports/${id}`, { name: 'Mine' })).status,
    ).toBe(403);
    expect(
      (await clients.admin.patch(`${BASE}/customReports/${id}`, { name: 'Renamed' })).body['name'],
    ).toBe('Renamed');
    expect((await clients.analyst.delete(`${BASE}/customReports/${id}`)).status).toBe(200);
    expect((await clients.viewer.post(`${BASE}/reports/${id}/run`, {})).status).toBe(404);
  });

  it('persists dashboard layouts, keeps private dashboards private and sets the tenant home', async () => {
    const home = await clients.sales.get(`${BASE}/dashboards/home`);
    expect(home.body).toMatchObject({ builtin: true, id: 'home' });
    const homeReports = (home.body['widgets'] as Array<{ report_id: string }>).map(
      (w) => w.report_id,
    );
    expect(homeReports).toContain('sales_monthly');
    expect(homeReports).not.toContain('broadcast_performance');

    const created = await clients.analyst.post(`${BASE}/dashboards`, {
      name: 'Revenue',
      shared: false,
      widgets: [widget('a', 'sales_monthly', 0, 0), widget('b', 'subscription_mrr', 3, 0)],
    });
    expect(created.status).toBe(201);
    const id = String(created.body['id']);
    const moved = await clients.analyst.patch(`${BASE}/dashboards/${id}`, {
      widgets: [
        widget('a', 'sales_monthly', 6, 1),
        { ...widget('b', 'subscription_mrr', 0, 0), layout: { x: 0, y: 0, w: 6, h: 4 } },
      ],
    });
    expect(moved.status).toBe(200);
    const read = await clients.analyst.get(`${BASE}/dashboards/${id}`);
    expect(
      (read.body['widgets'] as Array<{ id: string; layout: unknown }>).map((w) => [w.id, w.layout]),
    ).toEqual([
      ['a', { x: 6, y: 1, w: 3, h: 2 }],
      ['b', { x: 0, y: 0, w: 6, h: 4 }],
    ]);
    expect((await clients.viewer.get(`${BASE}/dashboards/${id}`)).status).toBe(404);
    expect((await clients.viewer.post(`${BASE}/dashboards`, { name: 'x' })).status).toBe(403);
    expect(
      (
        await clients.analyst.patch(`${BASE}/dashboards/${id}`, {
          widgets: [widget('a', 'missing_report', 0, 0)],
        })
      ).status,
    ).toBe(422);
    expect(
      (await clients.analyst.patch(`${BASE}/dashboards/${id}`, { shared: true, is_default: true }))
        .status,
    ).toBe(403);
    expect((await clients.analyst.patch(`${BASE}/dashboards/${id}`, { shared: true })).status).toBe(
      200,
    );
    expect(
      (await clients.owner.patch(`${BASE}/dashboards/${id}`, { is_default: true })).status,
    ).toBe(200);
    const newHome = await clients.viewer.get(`${BASE}/dashboards/home`);
    expect(newHome.body).toMatchObject({ id, builtin: false, is_default: true, name: 'Revenue' });
  });

  it('publishes its OpenAPI document', async () => {
    const doc = await clients.viewer.get('/api/v2/openapi/reports.json');
    expect(doc.status).toBe(200);
    expect(Object.keys(doc.body['paths'] as object)).toEqual(
      expect.arrayContaining([
        '/reports',
        '/reports/{reportId}/run',
        '/reports/{reportId}/export.csv',
        '/customReports',
        '/dashboards/{id}',
      ]),
    );
  });
});
