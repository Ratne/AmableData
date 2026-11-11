import { conversionReportSchema, conversionRuleSchema } from '@amable/api-types';
import { beforeAll, describe, expect, it } from 'vitest';
import { ev, FakeAnalyticsNamespace, T0 } from '../../../edge/test/helpers';
import type { Env } from '../../src/env';
import {
  addMember,
  createHarness,
  login,
  seedTenant,
  seedUser,
  type Harness,
  type TestClient,
} from '../helpers/harness';

const BASE = '/api/v2/t/acme/analytics';
const OTHER = '/api/v2/t/other/analytics';
const DAY = 86_400_000;

let h: Harness;
let ns: FakeAnalyticsNamespace;
let owner: TestClient;
let viewer: TestClient;
let stranger: TestClient;
let siteId = '';

beforeAll(async () => {
  h = await createHarness();
  ns = new FakeAnalyticsNamespace(() => h.clock.now);
  h.env.ANALYTICS = ns as unknown as Env['ANALYTICS'];
  const acme = await seedTenant(h, 'acme');
  const other = await seedTenant(h, 'other');
  const o = await seedUser(h, { email: 'owner@example.com' });
  const v = await seedUser(h, { email: 'viewer@example.com' });
  const x = await seedUser(h, { email: 'stranger@example.com' });
  await addMember(h, o.id, acme.id, 'owner');
  await addMember(h, v.id, acme.id, 'viewer');
  await addMember(h, x.id, other.id, 'owner');
  owner = await login(h, 'owner@example.com');
  viewer = await login(h, 'viewer@example.com');
  stranger = await login(h, 'stranger@example.com');
  const created = await owner.post(`${BASE}/sites`, {
    name: 'Acme',
    hostnames: ['acme.test'],
    timezone: 'Europe/Rome',
  });
  siteId = String((created.body['site'] as Record<string, unknown>)['id']);
});

const sq = () => `site_id=${siteId}`;
const days = 'from=2026-10-01&to=2026-10-31';

describe('custom conversions API', () => {
  let ruleId = '';

  it('creates, lists, updates and validates rules; writers only', async () => {
    const res = await owner.post(`${BASE}/conversions?${sq()}`, {
      name: 'Acquisto',
      value: 'https://acme.test/grazie/',
    });
    expect(res.status).toBe(201);
    expect(conversionRuleSchema.parse(res.body)).toMatchObject({
      key: 'acquisto',
      value: '/grazie',
      hostname: 'acme.test',
      event: 'event:100',
    });
    ruleId = String(res.body['id']);
    expect((await viewer.get(`${BASE}/conversions?${sq()}`)).body['data']).toHaveLength(1);
    const patched = await owner.request('PATCH', `${BASE}/conversions/${ruleId}?${sq()}`, {
      count: 'every',
    });
    expect(patched.status).toBe(200);
    expect(patched.body['count']).toBe('every');
    expect(
      (await owner.request('PATCH', `${BASE}/conversions/nope?${sq()}`, { count: 'once' })).status,
    ).toBe(404);
    expect(
      (await owner.post(`${BASE}/conversions?${sq()}`, { name: 'x', value: 'https://' })).status,
    ).toBe(422);
    expect(
      (await viewer.post(`${BASE}/conversions?${sq()}`, { name: 'x', value: '/x' })).status,
    ).toBe(403);
  });

  it('reports the conversions credited to the entry session', async () => {
    ns.store(`site:${siteId}`).ingest(
      [
        ev({
          vid: 'v1',
          sid: 's1',
          ts: T0,
          hostname: 'acme.test',
          path: '/landing',
          channel: 'Paid social',
          paid: true,
        }),
        ev({
          vid: 'v1',
          sid: 's2',
          ts: T0 + DAY,
          hostname: 'acme.test',
          path: '/grazie',
          sessionNumber: 2,
        }),
      ],
      [],
    );
    const res = await viewer.get(`${BASE}/conversions/report?${sq()}&${days}&model=first_touch`);
    expect(res.status).toBe(200);
    const report = conversionReportSchema.parse(res.body);
    expect(report.totals).toMatchObject({ conversions: 1, persons: 1 });
    expect(report.breakdown).toEqual([
      expect.objectContaining({ value: 'Paid social', conversions: 1 }),
    ]);
    expect(report.recent[0]).toMatchObject({
      rule_id: ruleId,
      entry_page: '/landing',
      visitor_id: 'v1',
    });
    expect((await viewer.get(`${BASE}/conversions/report?${sq()}&rule_id=nope`)).status).toBe(404);
    expect((await viewer.get(`${BASE}/conversions/report?${sq()}&dimension=nope`)).status).toBe(
      422,
    );
  });

  it('deletes a rule with its conversions and isolates tenants', async () => {
    expect((await stranger.get(`${OTHER}/conversions?${sq()}`)).status).toBe(404);
    expect((await stranger.get(`${OTHER}/conversions/report?${sq()}`)).status).toBe(404);
    expect((await viewer.request('DELETE', `${BASE}/conversions/${ruleId}?${sq()}`)).status).toBe(
      403,
    );
    expect((await owner.request('DELETE', `${BASE}/conversions/${ruleId}?${sq()}`)).status).toBe(
      200,
    );
    const res = await viewer.get(`${BASE}/conversions/report?${sq()}&${days}`);
    expect(res.body['totals']).toMatchObject({ conversions: 0 });
  });

  it('publishes the routes in the OpenAPI document', async () => {
    const paths = (await h.client().get('/api/v2/openapi/analytics.json')).body['paths'] as Record<
      string,
      unknown
    >;
    for (const p of ['/conversions', '/conversions/{id}', '/conversions/report'])
      expect(paths, p).toHaveProperty([p]);
  });
});
