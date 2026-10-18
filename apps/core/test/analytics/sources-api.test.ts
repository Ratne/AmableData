import { trafficSourceInputSchema, type TrafficSourceTemplateDef } from '@amable/api-types';
import { beforeAll, describe, expect, it } from 'vitest';
import { FakeAnalyticsNamespace } from '../../../edge/test/helpers';
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

let h: Harness;
let owner: TestClient;
let viewer: TestClient;
let stranger: TestClient;
let siteId = '';

beforeAll(async () => {
  h = await createHarness();
  const ns = new FakeAnalyticsNamespace(() => h.clock.now);
  h.env.ANALYTICS = ns as unknown as Env['ANALYTICS'];
  h.env.EDGE_ORIGIN = 'https://t.acme.test';
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
  const created = await owner.post(`${BASE}/sites`, { name: 'Acme', hostnames: ['acme.test'] });
  siteId = String((created.body['site'] as Record<string, unknown>)['id']);
});

const sq = () => `site_id=${siteId}`;

describe('traffic source templates', () => {
  let templates: TrafficSourceTemplateDef[] = [];

  beforeAll(async () => {
    const res = await viewer.get(`${BASE}/traffic-sources/templates`);
    expect(res.status).toBe(200);
    templates = res.body['data'] as TrafficSourceTemplateDef[];
  });

  const byName = (name: string) => templates.find((t) => t.template === name)!.source;
  const tokens = (name: string) =>
    Object.fromEntries(byName(name).fields!.map((f) => [f.url_param, [f.source_token, f.append]]));

  it('offers meta, google, tiktok and custom, all valid inputs', () => {
    expect(templates.map((t) => t.template)).toEqual(['meta', 'google', 'tiktok', 'custom']);
    for (const t of templates) expect(trafficSourceInputSchema.safeParse(t.source).success, t.template).toBe(true);
  });

  it('uses the Meta dynamic URL parameters; fbclid is captured, not appended', () => {
    const meta = byName('meta');
    expect(meta.reserved_fields).toEqual({
      campaign: { url_param: 'campaign', source_token: '{{campaign.id}}', append: true },
      external: { url_param: 'fbclid', source_token: '', append: false },
    });
    expect(tokens('meta')).toMatchObject({
      adset: ['{{adset.id}}', true],
      ad: ['{{ad.id}}', true],
      campaign_name: ['{{campaign.name}}', true],
      adset_name: ['{{adset.name}}', true],
      ad_name: ['{{ad.name}}', true],
    });
    expect(byName('meta').fields![0]?.slot).toBe('c1');
    expect(byName('meta').fields![1]?.slot).toBe('c2');
  });

  it('uses Google ValueTrack parameters; gclid comes from auto-tagging', () => {
    expect(byName('google').reserved_fields).toEqual({
      campaign: { url_param: 'campaign', source_token: '{campaignid}', append: true },
      external: { url_param: 'gclid', source_token: '', append: false },
    });
    expect(tokens('google')).toMatchObject({
      adgroup: ['{adgroupid}', true],
      creative: ['{creative}', true],
      keyword: ['{keyword}', true],
      matchtype: ['{matchtype}', true],
      device: ['{device}', true],
      network: ['{network}', true],
      gbraid: ['', false],
      wbraid: ['', false],
    });
  });

  it('uses TikTok macros; ttclid is captured, not appended', () => {
    expect(byName('tiktok').reserved_fields).toEqual({
      campaign: { url_param: 'campaign', source_token: '__CAMPAIGN_ID__', append: true },
      external: { url_param: 'ttclid', source_token: '', append: false },
    });
    expect(tokens('tiktok')).toMatchObject({ adgroup: ['__AID__', true], ad: ['__CID__', true] });
  });
});

describe('traffic sources API', () => {
  let sourceId = '';
  const input = {
    name: 'Newsletter',
    template: 'custom',
    reserved_fields: {
      campaign: { url_param: 'campaign', source_token: '{issue}' },
      external: { url_param: 'external', source_token: '' },
    },
    fields: [{ slot: 'c1', name: 'segment', url_param: 'segment', source_token: '{segment}' }],
  };

  it('creates, lists, reads and replaces a source', async () => {
    const res = await owner.post(`${BASE}/traffic-sources?${sq()}`, input);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Newsletter', status: 'active', cost_type: 'cpc' });
    sourceId = String(res.body['id']);
    expect((await viewer.get(`${BASE}/traffic-sources?${sq()}`)).body['data']).toEqual([
      expect.objectContaining({ id: sourceId }),
    ]);
    expect((await viewer.get(`${BASE}/traffic-sources/${sourceId}?${sq()}`)).body['name']).toBe('Newsletter');
    const replaced = await owner.request('PUT', `${BASE}/traffic-sources/${sourceId}?${sq()}`, {
      ...input,
      name: 'Weekly newsletter',
      cost_type: 'none',
    });
    expect(replaced.status).toBe(200);
    expect(replaced.body).toMatchObject({ name: 'Weekly newsletter', cost_type: 'none' });
    expect((await viewer.get(`${BASE}/traffic-sources/nope?${sq()}`)).status).toBe(404);
    expect((await owner.request('PUT', `${BASE}/traffic-sources/nope?${sq()}`, input)).status).toBe(404);
  });

  it('validates fields: reserved and duplicate URL parameters are 422', async () => {
    const reserved = await owner.post(`${BASE}/traffic-sources?${sq()}`, {
      ...input,
      fields: [{ slot: 'c1', name: 'x', url_param: 'vid', source_token: '' }],
    });
    expect(reserved.status).toBe(422);
    const duplicate = await owner.post(`${BASE}/traffic-sources?${sq()}`, {
      ...input,
      fields: [{ slot: 'c1', name: 'x', url_param: 'campaign', source_token: '' }],
    });
    expect(duplicate.status).toBe(422);
  });

  it('archives and restores', async () => {
    expect((await owner.post(`${BASE}/traffic-sources/${sourceId}/archive?${sq()}`)).body['status']).toBe('archived');
    expect((await viewer.get(`${BASE}/traffic-sources?${sq()}&status=active`)).body['data']).toEqual([]);
    expect((await owner.post(`${BASE}/traffic-sources/${sourceId}/restore?${sq()}`)).body['status']).toBe('active');
    expect((await owner.post(`${BASE}/traffic-sources/nope/archive?${sq()}`)).status).toBe(404);
  });

  it('requires analytics:configure to write', async () => {
    expect((await viewer.post(`${BASE}/traffic-sources?${sq()}`, input)).status).toBe(403);
    expect((await viewer.request('PUT', `${BASE}/traffic-sources/${sourceId}?${sq()}`, input)).status).toBe(403);
    expect((await viewer.post(`${BASE}/traffic-sources/${sourceId}/archive?${sq()}`)).status).toBe(403);
  });

  it("isolates tenants: another tenant's site is a 404 on every endpoint", async () => {
    const q = `site_id=${siteId}`;
    const statuses = [
      (await stranger.get(`${OTHER}/traffic-sources?${q}`)).status,
      (await stranger.post(`${OTHER}/traffic-sources?${q}`, input)).status,
      (await stranger.get(`${OTHER}/traffic-sources/${sourceId}?${q}`)).status,
      (await stranger.request('PUT', `${OTHER}/traffic-sources/${sourceId}?${q}`, input)).status,
      (await stranger.post(`${OTHER}/traffic-sources/${sourceId}/archive?${q}`)).status,
      (await stranger.post(`${OTHER}/traffic-sources/${sourceId}/restore?${q}`)).status,
    ];
    expect(statuses).toEqual(statuses.map(() => 404));
    expect((await stranger.get(`${BASE}/traffic-sources/templates`)).status).toBe(404);
    expect((await h.client().get(`${BASE}/traffic-sources/templates`)).status).toBe(401);
  });
});
