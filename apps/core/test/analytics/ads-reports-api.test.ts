import { beforeAll, describe, expect, it } from 'vitest';
import { FakeAnalyticsNamespace } from '../../../edge/test/helpers';
import { createSources, D, touch } from '../../../edge/test/reports-fixture';
import type { Env } from '../../src/env';
import { fakeTenantDbNamespace } from '../crm/helpers';
import {
  addMember,
  createHarness,
  login,
  seedTenant,
  seedUser,
  type Harness,
  type TestClient,
} from '../helpers/harness';

const BASE = '/api/v2/t/acme/analytics/ads-reports';

let h: Harness;
let viewer: TestClient;
let sales: TestClient;
let siteId = '';
let otherSiteId = '';
const range = () => `site_id=${siteId}&from=2026-10-01&to=2026-10-31`;

beforeAll(async () => {
  h = await createHarness();
  const ns = new FakeAnalyticsNamespace(() => h.clock.now);
  h.env.ANALYTICS = ns as unknown as Env['ANALYTICS'];
  h.env.TENANT_DB = fakeTenantDbNamespace();
  h.env.EDGE_ORIGIN = 'https://t.acme.test';
  const acme = await seedTenant(h, 'acme');
  const other = await seedTenant(h, 'other');
  const o = await seedUser(h, { email: 'owner@example.com' });
  const v = await seedUser(h, { email: 'viewer@example.com' });
  const s = await seedUser(h, { email: 'sales@example.com' });
  await addMember(h, o.id, acme.id, 'owner');
  await addMember(h, o.id, other.id, 'owner');
  await addMember(h, v.id, acme.id, 'viewer');
  await addMember(h, s.id, acme.id, 'sales');
  const owner = await login(h, 'owner@example.com');
  viewer = await login(h, 'viewer@example.com');
  sales = await login(h, 'sales@example.com');
  const created = await owner.post('/api/v2/t/acme/analytics/sites', {
    name: 'Acme',
    hostnames: ['acme.test'],
  });
  siteId = String((created.body['site'] as Record<string, unknown>)['id']);
  const foreign = await owner.post('/api/v2/t/other/analytics/sites', {
    name: 'Other',
    hostnames: ['other.test'],
  });
  otherSiteId = String((foreign.body['site'] as Record<string, unknown>)['id']);
  const store = ns.store(`site:${siteId}`);
  const { meta } = createSources(store);
  const t = touch('v1', D(3), meta, 'm1', { external_click_id: 'fb.1' });
  store.recordTouches([t, touch('v2', D(4), meta, 'm2')]);
  store.recordConversionFromPostback({ hit: t.id, tx: 'o1', revenue_minor: 5000, ts: D(5) });
  store.upsertAdSpend([
    { platform: 'meta', entity_external_id: 'm1', day: '2026-10-03', spend_minor: 2000 },
  ]);
});

describe('ad attribution report routes', () => {
  it('serves the performance report with drill-down filters', async () => {
    const res = await viewer.get(
      `${BASE}/performance?${range()}&group_by=campaign&model=linear&basis=sale_date`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      model: 'linear',
      group_by: 'campaign',
      basis: 'sale_date',
      currency: 'EUR',
      window_days: 7,
    });
    expect(res.body['totals']).toMatchObject({
      visits: 2,
      cost_minor: 2000,
      revenue_minor: 5000,
      roas: 2.5,
    });
    const drill = await viewer.get(
      `${BASE}/performance?${range()}&group_by=campaign&filter_campaign=m2`,
    );
    expect((drill.body['rows'] as Array<{ key: string }>).map((r) => r.key)).toEqual(['m2']);
    expect((await viewer.get(`${BASE}/performance?${range()}&model=bogus`)).status).toBe(422);
    expect(
      (await viewer.get(`${BASE}/performance?site_id=${siteId}&from=2026-10-31&to=2026-10-01`))
        .status,
    ).toBe(422);
  });

  it('serves LTV, cohorts, journeys and tracking quality', async () => {
    const ltv = await viewer.get(`${BASE}/ltv?${range()}`);
    expect(ltv.status).toBe(200);
    expect(ltv.body).toMatchObject({
      windows: [30, 60, 90, 180, 365],
      rows: [{ customers: 1, revenue_minor: { '30': 5000 } }],
    });
    const cohorts = await viewer.get(`${BASE}/cohorts?${range()}&granularity=month`);
    expect(cohorts.body).toMatchObject({
      granularity: 'month',
      rows: [{ cohort: '2026-10-01', customers: 1, cost_minor: 2000 }],
    });
    const journeys = await viewer.get(`${BASE}/journeys?${range()}&converted_only=true`);
    expect(journeys.body).toMatchObject({
      rows: [{ steps: ['Meta Ads'], visitors: 1, conversions: 1, revenue_minor: 5000 }],
    });
    const quality = await viewer.get(`${BASE}/tracking-quality?${range()}`);
    expect(quality.body).toEqual({
      conversions: 1,
      with_identity: 0,
      with_click_id: 1,
      with_touch: 1,
      score: 0.6667,
    });
  });

  it('defaults the range and guards permissions and tenants', async () => {
    expect((await viewer.get(`${BASE}/performance?site_id=${siteId}`)).status).toBe(200);
    expect((await sales.get(`${BASE}/performance?${range()}`)).status).toBe(403);
    expect((await viewer.get(`${BASE}/ltv?site_id=${otherSiteId}`)).status).toBe(404);
    expect((await viewer.get(`${BASE}/journeys?site_id=st_unknownunknownunkno`)).status).toBe(404);
  });
});
