import { describe, expect, it, vi } from 'vitest';
import {
  AddressLookupUnauthorized,
  AddressLookupUnavailable,
  lookupMapbox,
  mapboxRequestUrl,
  mapboxToSuggestion,
  verifyMapboxToken,
  addressLookupUrl,
  DEFAULT_ADDRESS_LOOKUP_URL,
  lookupAddresses,
  photonRequestUrl,
  photonToSuggestion,
} from '../../src/crm/address-lookup';
import { mapRow } from '../../src/crm/import/mapping';
import { createTestTenant } from './helpers';

describe('contact address street number', () => {
  it('stores the house number apart from the street and reads it back', () => {
    const t = createTestTenant();
    const contact = t.op('contacts.create', {
      given_name: 'Mario',
      addresses: [
        { type: 'billing', line1: 'Via Roma', street_number: '10/B', locality: 'Milano', country_code: 'IT' },
      ],
    });
    expect(contact.addresses[0]).toMatchObject({ line1: 'Via Roma', street_number: '10/B' });
    const updated = t.op('contacts.update', {
      id: contact.id,
      data: { addresses: [{ type: 'shipping', line1: 'Corso Italia', locality: 'Torino' }] },
    });
    expect(updated.addresses[0]).toMatchObject({ line1: 'Corso Italia', street_number: null });
  });

  it('imports a separate house number column', () => {
    const mapped = mapRow(
      ['via', 'civico'],
      ['Via Roma', '12'],
      { via: 'address.line1', civico: 'address.street_number' },
      ';',
    );
    expect(mapped.contact['addresses']).toEqual([{ type: 'billing', line1: 'Via Roma', street_number: '12' }]);
  });
});

const photon = (features: unknown[]) =>
  vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ type: 'FeatureCollection', features }), { status: 200 }));

describe('address lookup', () => {
  it('reads the setting: default public instance, custom URL, or off', () => {
    expect(addressLookupUrl(undefined)).toBe(DEFAULT_ADDRESS_LOOKUP_URL);
    expect(addressLookupUrl(' ')).toBe(DEFAULT_ADDRESS_LOOKUP_URL);
    expect(addressLookupUrl('https://geo.example.com/api/')).toBe('https://geo.example.com/api');
    expect(addressLookupUrl('OFF')).toBeNull();
    expect(addressLookupUrl('javascript:alert(1)')).toBeNull();
  });

  it('asks in a supported language only', () => {
    expect(photonRequestUrl(DEFAULT_ADDRESS_LOOKUP_URL, { q: 'via roma 1', lang: 'it' })).toBe(
      'https://photon.komoot.io/api?q=via+roma+1&limit=10',
    );
    expect(photonRequestUrl(DEFAULT_ADDRESS_LOOKUP_URL, { q: 'main st', lang: 'en-US' })).toContain('lang=en');
  });

  it('maps houses and streets to address fields, province first in Italy', () => {
    expect(
      photonToSuggestion({
        type: 'house',
        street: 'Via Roma',
        housenumber: '10',
        postcode: '20121',
        city: 'Milano',
        county: 'Milano',
        state: 'Lombardia',
        countrycode: 'it',
      }),
    ).toEqual({
      label: 'Via Roma 10, 20121 Milano, Milano, IT',
      line1: 'Via Roma',
      street_number: '10',
      locality: 'Milano',
      region: 'Milano',
      postal_code: '20121',
      country_code: 'IT',
    });
    expect(
      photonToSuggestion({ type: 'street', name: 'Main Street', city: 'Springfield', state: 'Illinois', county: 'Sangamon', countrycode: 'US' }),
    ).toMatchObject({ line1: 'Main Street', street_number: null, region: 'Illinois' });
    expect(photonToSuggestion({ type: 'city', name: 'Milano', countrycode: 'IT' })).toBeNull();
  });

  it('keeps only the chosen country, dedupes and returns at most 5', async () => {
    const house = (n: number, cc: string) => ({
      properties: { type: 'house', street: 'Via Roma', housenumber: String(n), city: 'X', countrycode: cc },
    });
    const features = [house(1, 'CH'), house(1, 'IT'), house(1, 'IT'), ...[2, 3, 4, 5, 6].map((n) => house(n, 'IT'))];
    const fetchFn = photon(features);
    const result = await lookupAddresses(DEFAULT_ADDRESS_LOOKUP_URL, { q: 'via roma', country: 'IT' }, fetchFn);
    expect(result.map((s) => `${s.street_number ?? ''}${s.country_code ?? ''}`)).toEqual(['1IT', '2IT', '3IT', '4IT', '5IT']);
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain('limit=25');
    const anywhere = await lookupAddresses(DEFAULT_ADDRESS_LOOKUP_URL, { q: 'via roma' }, photon(features));
    expect(anywhere[0]?.country_code).toBe('CH');
  });

  it('fails as unavailable when the geocoder errors or is unreachable', async () => {
    const down = vi.fn<typeof fetch>(async () => new Response('busy', { status: 429 }));
    await expect(lookupAddresses(DEFAULT_ADDRESS_LOOKUP_URL, { q: 'via roma' }, down)).rejects.toBeInstanceOf(
      AddressLookupUnavailable,
    );
    const offline = vi.fn<typeof fetch>(async () => {
      throw new TypeError('network');
    });
    await expect(lookupAddresses(DEFAULT_ADDRESS_LOOKUP_URL, { q: 'via roma' }, offline)).rejects.toBeInstanceOf(
      AddressLookupUnavailable,
    );
  });
});

describe('Mapbox address lookup', () => {
  const viaFontanastasia = {
    type: 'Feature',
    properties: {
      feature_type: 'address',
      name: 'Via Fontanastasia 9',
      context: {
        address: { name: 'Via Fontanastasia 9', address_number: '9', street_name: 'Via Fontanastasia' },
        street: { name: 'Via Fontanastasia' },
        postcode: { name: '00060' },
        place: { name: 'Castelnuovo di Porto' },
        district: { name: 'Roma' },
        region: { name: 'Lazio' },
        country: { name: 'Italia', country_code: 'it' },
      },
    },
  };

  it('builds the forward geocoding request with country, language and storage mode', () => {
    const url = new URL(
      mapboxRequestUrl('pk.test-token', { q: 'via fontanastasia 9', lang: 'it-IT', country: 'IT' }, { permanent: true }),
    );
    expect(url.origin + url.pathname).toBe('https://api.mapbox.com/search/geocode/v6/forward');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      q: 'via fontanastasia 9',
      autocomplete: 'true',
      types: 'address,street',
      language: 'it',
      country: 'it',
      permanent: 'true',
      access_token: 'pk.test-token',
    });
    expect(new URL(mapboxRequestUrl('pk.x', { q: 'a b c' })).searchParams.has('permanent')).toBe(false);
  });

  it('maps addresses and streets to address fields', () => {
    expect(mapboxToSuggestion(viaFontanastasia.properties)).toEqual({
      label: 'Via Fontanastasia 9, 00060 Castelnuovo di Porto, Roma, IT',
      line1: 'Via Fontanastasia',
      street_number: '9',
      locality: 'Castelnuovo di Porto',
      region: 'Roma',
      postal_code: '00060',
      country_code: 'IT',
    });
    expect(
      mapboxToSuggestion({ feature_type: 'street', name: 'Main Street', context: { region: { name: 'Illinois' }, country: { country_code: 'US' } } }),
    ).toMatchObject({ line1: 'Main Street', street_number: null, region: 'Illinois' });
    expect(mapboxToSuggestion({ feature_type: 'place', name: 'Roma' })).toBeNull();
  });

  it('never caches Mapbox answers and reports rejected tokens apart', async () => {
    const fetchFn = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ features: [viaFontanastasia] }), { status: 200 }),
    );
    const first = await lookupMapbox('pk.t', { q: 'via fontanastasia 9', country: 'IT' }, {}, fetchFn);
    await lookupMapbox('pk.t', { q: 'via fontanastasia 9', country: 'IT' }, {}, fetchFn);
    expect(first[0]?.street_number).toBe('9');
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const refused = vi.fn<typeof fetch>(async () => new Response('{"message":"Not Authorized"}', { status: 401 }));
    await expect(verifyMapboxToken('pk.wrong', refused)).rejects.toBeInstanceOf(AddressLookupUnauthorized);
  });
});

describe('address lookup settings', () => {
  it('defaults to the installation geocoder and keeps only what is written', () => {
    const t = createTestTenant();
    expect(t.op('addressLookup.settings.get', {})).toEqual({
      provider: 'default',
      mapbox_token_ciphertext: null,
      mapbox_token_hint: null,
      mapbox_permanent: false,
    });
    t.op('addressLookup.settings.update', {
      provider: 'mapbox',
      mapbox_token_ciphertext: 'cipher',
      mapbox_token_hint: '…abcd',
      mapbox_permanent: true,
    });
    expect(t.op('addressLookup.settings.get', {})).toMatchObject({ provider: 'mapbox', mapbox_permanent: true });
    const cleared = t.op('addressLookup.settings.update', {
      provider: 'default',
      mapbox_token_ciphertext: null,
      mapbox_token_hint: null,
    });
    expect(cleared).toEqual({ provider: 'default', mapbox_token_ciphertext: null, mapbox_token_hint: null, mapbox_permanent: true });
  });
});
