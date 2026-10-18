import { afterEach, describe, expect, it } from 'vitest';
import { createAppsHarness, resetAppsHarness, type AppsHarness } from './helpers';
import { installApp, type InstalledApp } from './oauth-helpers';

const SUGGEST = 'https://apps.example.com/address/suggest';
const PHOTON = 'https://photon.komoot.io/';

afterEach(() => resetAppsHarness());

const fontanastasia = {
  line1: 'Via Fontanastasia',
  street_number: '9',
  locality: 'Castelnuovo di Porto',
  region: 'Roma',
  postal_code: '00060',
  country_code: 'it',
};

async function setup(answer: () => Response): Promise<{ h: AppsHarness; installed: InstalledApp; calls: () => string[] }> {
  const h = await createAppsHarness();
  h.routes.set(SUGGEST, answer);
  h.routes.set(PHOTON, () =>
    Response.json({
      features: [{ properties: { type: 'house', street: 'Via Roma', housenumber: '1', city: 'Milano', countrycode: 'IT' } }],
    }),
  );
  const installed = await installApp(h, {
    id: 'mapbox',
    name: 'Mapbox',
    categories: ['productivity'],
    scopes: ['contacts:read'],
    webhooks: undefined,
    custom_fields: [],
    extensions: { address_lookup: { endpoint: '/address/suggest', attribution: '© Mapbox © OpenStreetMap' } },
  });
  const calls = () =>
    h.calls.flatMap((c) => (c.url === SUGGEST ? ['app'] : c.url.startsWith(PHOTON) ? ['photon'] : []));
  return { h, installed, calls };
}

describe('address lookup app', () => {
  it('asks the installed app, normalizes its answer and shows its attribution', async () => {
    const { h, installed } = await setup(() => Response.json({ suggestions: [fontanastasia, { line1: '' }, 'junk'] }));
    const res = await installed.owner.get('/api/v2/t/acme/addressSuggestions?q=via%20fontanastasia%209&lang=it&country=IT');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enabled: true,
      provider: 'app',
      attribution: '© Mapbox © OpenStreetMap',
      data: [{ label: 'Via Fontanastasia 9, 00060 Castelnuovo di Porto, Roma, IT', ...fontanastasia, country_code: 'IT' }],
    });
    const call = h.calls.find((c) => c.url === SUGGEST);
    expect(JSON.parse(call!.body)).toMatchObject({ q: 'via fontanastasia 9', lang: 'it', country: 'IT' });
    expect(call!.headers.get('amable-signature')).toBeTruthy();

    const settings = await installed.owner.get('/api/v2/t/acme/settings/addressLookup');
    expect(settings.body).toEqual({
      default_available: true,
      app: { app_id: 'mapbox', name: 'Mapbox', icon_url: 'https://apps.example.com/icon.png', paused: false },
    });
  });

  it('falls back to OpenStreetMap when the app fails or is paused', async () => {
    const { h, installed, calls } = await setup(() => new Response('{"error":"mapbox_rejected_token"}', { status: 502 }));
    const failed = await installed.owner.get('/api/v2/t/acme/addressSuggestions?q=via%20roma%201&country=IT');
    expect(failed.body).toMatchObject({ enabled: true, provider: 'photon', attribution: '© OpenStreetMap' });

    await h.env.DB.prepare(`UPDATE app_installs SET status = 'paused' WHERE id = ?`).bind(installed.installId).run();
    const paused = await installed.owner.get('/api/v2/t/acme/addressSuggestions?q=via%20roma%202&country=IT');
    expect(paused.body).toMatchObject({ provider: 'photon' });
    expect(calls().filter((c) => c === 'app')).toHaveLength(1);
    expect((await installed.owner.get('/api/v2/t/acme/settings/addressLookup')).body).toMatchObject({ app: { paused: true } });
  });

  it('reports the app as unavailable when the installation geocoder is off', async () => {
    const { h, installed } = await setup(() => new Response('down', { status: 500 }));
    h.env.ADDRESS_LOOKUP_URL = 'off';
    const res = await installed.owner.get('/api/v2/t/acme/addressSuggestions?q=via%20roma%201');
    expect(res.status).toBe(503);
    expect(res.body['error']).toBe('address_lookup_unavailable');
  });
});
