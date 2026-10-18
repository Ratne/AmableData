import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeTenantDbNamespace } from './helpers';
import {
  addMember,
  createHarness,
  login,
  seedTenant,
  seedUser,
  type Harness,
  type TestClient,
} from '../helpers/harness';

const BASE = '/api/v2/t/geo';

let h: Harness;
let owner: TestClient;
let viewer: TestClient;

const photonFeature = {
  properties: { type: 'house', street: 'Via Roma', housenumber: '1', city: 'Milano', countrycode: 'IT' },
};

beforeAll(async () => {
  h = await createHarness();
  h.env.TENANT_DB = fakeTenantDbNamespace(() => h.clock.now);
  const tenant = await seedTenant(h, 'geo');
  const o = await seedUser(h, { email: 'owner@geo.test' });
  await addMember(h, o.id, tenant.id, 'owner');
  owner = await login(h, o.email);
  const v = await seedUser(h, { email: 'viewer@geo.test' });
  await addMember(h, v.id, tenant.id, 'viewer');
  viewer = await login(h, v.email);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete h.env.ADDRESS_LOOKUP_URL;
});

describe('address lookup without an address app', () => {
  it('shows the source to integrations managers only', async () => {
    expect((await viewer.get(`${BASE}/settings/addressLookup`)).status).toBe(403);
    const res = await owner.get(`${BASE}/settings/addressLookup`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ default_available: true, app: null });
    expect((await owner.patch(`${BASE}/settings/addressLookup`, { provider: 'mapbox' })).status).toBe(404);
  });

  it('suggests from OpenStreetMap, and is off when the installation turns it off', async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://photon.komoot.io/')) return Response.json({ features: [photonFeature] });
      return realFetch(input, init);
    });
    const res = await owner.get(`${BASE}/addressSuggestions?q=via%20roma%201&country=IT`);
    expect(res.body).toMatchObject({ enabled: true, provider: 'photon', attribution: '© OpenStreetMap' });
    expect((res.body['data'] as Array<{ line1: string }>)[0]?.line1).toBe('Via Roma');

    h.env.ADDRESS_LOOKUP_URL = 'off';
    const off = await owner.get(`${BASE}/addressSuggestions?q=via%20roma%201`);
    expect(off.body).toEqual({ enabled: false, provider: null, attribution: null, data: [] });
  });
});
