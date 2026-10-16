import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeTenantDbNamespace } from './helpers';
import {
  addMember,
  createHarness,
  login,
  seedTenant,
  seedUser,
  stepUp,
  type Harness,
  type TestClient,
} from '../helpers/harness';

const BASE = '/api/v2/t/geo';
const TOKEN = 'pk.eyJ1IjoidGVzdCIsImEiOiJjbGFiYyJ9.abcdefghijklmnop';

let h: Harness;
let owner: TestClient;
let viewer: TestClient;

const mapboxFeature = {
  properties: {
    feature_type: 'address',
    context: {
      address: { address_number: '9', street_name: 'Via Fontanastasia' },
      postcode: { name: '00060' },
      place: { name: 'Castelnuovo di Porto' },
      country: { country_code: 'it' },
    },
  },
};
const photonFeature = {
  properties: { type: 'house', street: 'Via Roma', housenumber: '1', city: 'Milano', countrycode: 'IT' },
};

/** Fake geocoders; every other URL goes to the real fetch (none expected). */
function stubGeocoders(mapbox: () => Response) {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith('https://api.mapbox.com/')) {
      calls.push('mapbox');
      return mapbox();
    }
    if (url.startsWith('https://photon.komoot.io/')) {
      calls.push('photon');
      return new Response(JSON.stringify({ features: [photonFeature] }), { status: 200 });
    }
    return realFetch(input, init);
  });
  return calls;
}

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

afterEach(() => vi.unstubAllGlobals());

describe('address lookup settings API', () => {
  it('is reserved to integrations managers and never returns the token', async () => {
    expect((await viewer.get(`${BASE}/settings/addressLookup`)).status).toBe(403);
    const res = await owner.get(`${BASE}/settings/addressLookup`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      provider: 'default',
      default_available: true,
      mapbox: { configured: false, token_hint: null, permanent: false },
    });
  });

  it('refuses mapbox without a token and tokens Mapbox rejects', async () => {
    await stepUp(h, owner);
    expect((await owner.patch(`${BASE}/settings/addressLookup`, { provider: 'mapbox' })).status).toBe(422);
    stubGeocoders(() => new Response('{"message":"Not Authorized - Invalid Token"}', { status: 401 }));
    const res = await owner.patch(`${BASE}/settings/addressLookup`, { provider: 'mapbox', mapbox_token: TOKEN });
    expect(res.status).toBe(422);
    expect(res.body['details']).toEqual([{ path: 'mapbox_token', message: 'Mapbox rejected this token' }]);
  });

  it('stores a verified token encrypted, uses Mapbox for suggestions and falls back to OpenStreetMap', async () => {
    await stepUp(h, owner);
    let mapboxUp = true;
    const calls = stubGeocoders(() =>
      mapboxUp
        ? new Response(JSON.stringify({ features: [mapboxFeature] }), { status: 200 })
        : new Response('{"message":"Rate limit"}', { status: 429 }),
    );
    const saved = await owner.patch(`${BASE}/settings/addressLookup`, { provider: 'mapbox', mapbox_token: TOKEN });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ provider: 'mapbox', mapbox: { configured: true, token_hint: '…mnop' } });
    expect(JSON.stringify(saved.body)).not.toContain(TOKEN);

    const viaMapbox = await owner.get(`${BASE}/addressSuggestions?q=via%20fontanastasia%209&country=IT`);
    expect(viaMapbox.body).toMatchObject({ enabled: true, provider: 'mapbox' });
    expect((viaMapbox.body['data'] as Array<{ line1: string }>)[0]?.line1).toBe('Via Fontanastasia');

    mapboxUp = false;
    const fallback = await owner.get(`${BASE}/addressSuggestions?q=via%20roma%201&country=IT`);
    expect(fallback.body).toMatchObject({ enabled: true, provider: 'photon' });
    expect(calls).toEqual(['mapbox', 'mapbox', 'mapbox', 'photon']);

    const removed = await owner.patch(`${BASE}/settings/addressLookup`, { mapbox_token: null });
    expect(removed.body).toMatchObject({ provider: 'default', mapbox: { configured: false, token_hint: null } });
  });
});
