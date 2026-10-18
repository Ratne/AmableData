import { validateGraph } from '@amable/api-types';
import { beforeAll, describe, expect, it } from 'vitest';
import { FakeAnalyticsNamespace } from '../../../edge/test/helpers';
import { DEMO_FUNNEL_NAME, DEMO_SOURCE_NAME, FunnelDemoError, generateFunnelDemo } from '../../src/analytics/dev-funnel-demo';
import type { Env } from '../../src/env';
import { addMember, createHarness, login, seedTenant, seedUser, type Harness } from '../helpers/harness';

let h: Harness;
let ns: FakeAnalyticsNamespace;
let tenant = { id: '', slug: 'acme' };
let siteId = '';

beforeAll(async () => {
  h = await createHarness();
  ns = new FakeAnalyticsNamespace(() => h.clock.now);
  h.env.ANALYTICS = ns as unknown as Env['ANALYTICS'];
  const acme = await seedTenant(h, 'acme');
  tenant = { id: acme.id, slug: 'acme' };
  const owner = await seedUser(h, { email: 'owner@example.com' });
  await addMember(h, owner.id, acme.id, 'owner');
  const client = await login(h, 'owner@example.com');
  const created = await client.post('/api/v2/t/acme/analytics/sites', { name: 'Acme', hostnames: ['acme.test'] });
  siteId = String((created.body['site'] as Record<string, unknown>)['id']);
});

describe('funnel tracking demo seed', () => {
  it('needs the demo site first', async () => {
    const empty = await seedTenant(h, 'empty');
    await expect(
      generateFunnelDemo(h.env, h.env.ANALYTICS!, { id: empty.id, slug: 'empty' }, { days: 30, visitors: 5, seed: 's', now: h.clock.now }),
    ).rejects.toBeInstanceOf(FunnelDemoError);
  });

  it('creates the funnel, the source, a fake ad connection with spend and a click-log, deterministically', async () => {
    const opts = { days: 30, visitors: 80, seed: 'test-seed', now: h.clock.now };
    const report = await generateFunnelDemo(h.env, h.env.ANALYTICS!, tenant, opts);
    const store = ns.store(`site:${siteId}`);

    const graph = store.getFunnelGraph(report.funnelId);
    expect(graph?.name).toBe(DEMO_FUNNEL_NAME);
    expect(validateGraph(graph!)).toEqual([]);
    const source = store.getTrafficSource(report.trafficSourceId);
    expect(source).toMatchObject({ name: DEMO_SOURCE_NAME, template: 'meta' });
    expect(source?.fields.map((f) => f.slot)).toEqual(['c1', 'c2', 'c3']);
    expect(report.connectionId).not.toBeNull();
    expect(source?.conversion).toMatchObject({ ad_connection_id: report.connectionId, platform: 'meta' });
    expect(store.getAdConnection(report.connectionId!)).toMatchObject({ platform: 'meta', status: 'active' });

    expect(report.spendRows).toBeGreaterThan(0);
    expect(report.campaigns.length).toBeGreaterThan(0);
    const touches = store.listTouches({ from: opts.now - 31 * 86_400_000, to: opts.now + 1, limit: 10_000 });
    expect(touches).toHaveLength(report.touches);
    expect(new Set(touches.map((t) => t.kind))).toEqual(new Set(['entrance', 'view', 'click']));
    expect(touches.every((t) => report.campaigns.includes(t.campaign ?? ''))).toBe(true);

    expect(report.postbacks.length).toBeGreaterThan(0);
    for (const pb of report.postbacks) {
      const hit = store.getTouch(pb.hit);
      expect(hit).toMatchObject({ kind: 'view', node_id: 'offer' });
      expect(pb.conversion_time).toBeGreaterThanOrEqual(hit!.ts);
      expect(pb.conversion_time).toBeLessThan(opts.now);
      expect(pb.rev).toMatch(/^\d+\.\d{2}$/);
    }

    // Running it again reuses everything and records no duplicate touch.
    const again = await generateFunnelDemo(h.env, h.env.ANALYTICS!, tenant, opts);
    expect(again).toMatchObject({ funnelId: report.funnelId, trafficSourceId: report.trafficSourceId, connectionId: report.connectionId, touches: 0 });
    expect(again.postbacks).toEqual(report.postbacks);
    expect(store.listFunnelGraphs()).toHaveLength(1);
  });
});
