import { describe, expect, it, vi } from 'vitest';
import {
  AddressLookupUnavailable,
  addressLookupUrl,
  appSuggestions,
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

describe('address app answers', () => {
  it('trims and caps fields, rebuilds missing labels and drops bad entries', () => {
    const answer = {
      suggestions: [
        { line1: ' Via Roma ', street_number: '1', locality: 'Milano', country_code: 'it', extra: true },
        { label: 'Custom label', line1: 'Corso Italia', country_code: 'Italy' },
        { line1: '   ' },
        null,
        'junk',
      ],
    };
    expect(appSuggestions(answer, undefined)).toEqual([
      {
        label: 'Via Roma 1, Milano, IT',
        line1: 'Via Roma',
        street_number: '1',
        locality: 'Milano',
        region: null,
        postal_code: null,
        country_code: 'IT',
      },
      {
        label: 'Custom label',
        line1: 'Corso Italia',
        street_number: null,
        locality: null,
        region: null,
        postal_code: null,
        country_code: null,
      },
    ]);
    expect(appSuggestions(answer, 'IT')?.map((s) => s.line1)).toEqual(['Via Roma']);
    expect(appSuggestions({ data: [] }, undefined)).toBeNull();
  });
});
