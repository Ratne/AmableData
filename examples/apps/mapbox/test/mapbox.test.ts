import { generateAppKey, kvInstallStore } from '@amable/app-sdk';
import {
  fakeCrm,
  fixtureFetch,
  memoryKv,
  routeFetch,
  signedCaller,
  testInstall,
  type Fixture,
} from '@amable/app-sdk/testing';
import { describe, expect, it } from 'vitest';
import { passed, runConformance } from '../../../../packages/app-cli/src/conformance';
import manifest from '../manifest.json';
import { createWorker } from '../src/app';
import { checkToken, lookup, requestUrl, toSuggestion, type Fetch } from '../src/mapbox';
import forbidden from './fixtures/mapbox/error-forbidden.json';
import invalidToken from './fixtures/mapbox/error-invalid-token.json';
import rateLimited from './fixtures/mapbox/error-rate-limited.json';
import forward from './fixtures/mapbox/forward-addresses.json';

const fx = (value: unknown) => value as Fixture;
const TOKEN = 'pk.eyJ1IjoidGVzdCIsImEiOiJjbGFiYyJ9.abcdefghijklmnop';

const saltLake = {
  line1: '2100 South',
  street_number: '974',
  locality: 'Salt Lake City',
  region: 'Utah',
  postal_code: '84106',
  country_code: 'US',
};

async function setup(options: { token?: string | null; permanent?: boolean } = {}) {
  const kv = memoryKv();
  // One install per test: the settings cache is per install id.
  const install = testInstall({ scopes: manifest.scopes });
  await kvInstallStore(kv).put(install);
  const crm = fakeCrm();
  if (options.token !== null)
    crm.data.set('mapbox_token', { value: options.token ?? TOKEN, secret: true });
  if (options.permanent === true) crm.data.set('mapbox_permanent', { value: true, secret: false });
  const mapbox = fixtureFetch([fx(forward)]);
  const worker = createWorker({ fetch: routeFetch(crm.fetch, mapbox.fetch) });
  const env = { APP_KEYS: JSON.stringify([await generateAppKey()]), INSTALLS: kv };
  const fetch = (input: string, init?: RequestInit) => worker.fetch(new Request(input, init), env);
  const call = signedCaller({
    fetch: (request) => worker.fetch(request, env),
    baseUrl: manifest.base_url,
    install,
  });
  const screen = async (method: 'GET' | 'POST', body?: unknown) => {
    const token = await crm.sessionToken({
      appId: manifest.id,
      audience: manifest.base_url,
      install,
    });
    const response = await fetch(`${manifest.base_url}/api/settings`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { crm, mapbox, install, fetch, call, screen };
}

describe('mapbox: geocoding', () => {
  it('asks for addresses and streets, in the user language and country', () => {
    const url = new URL(
      requestUrl('pk.test', { q: 'via roma 1', lang: 'it-IT', country: 'IT' }, { permanent: true }),
    );
    expect(url.origin + url.pathname).toBe('https://api.mapbox.com/search/geocode/v6/forward');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'via roma 1',
      autocomplete: 'true',
      types: 'address,street',
      limit: '5',
      language: 'it',
      country: 'it',
      permanent: 'true',
      access_token: 'pk.test',
    });
    const plain = new URL(requestUrl('pk.test', { q: 'main st', lang: null, country: 'nope' }));
    expect(plain.searchParams.has('permanent')).toBe(false);
    expect(plain.searchParams.has('country')).toBe(false);
    expect(plain.searchParams.has('language')).toBe(false);
  });

  it('reads the recorded answer of the API reference', async () => {
    const result = await lookup(
      TOKEN,
      { q: '974 2100 South' },
      { fetch: fixtureFetch([fx(forward)]).fetch },
    );
    expect(result).toEqual({
      kind: 'ok',
      suggestions: [saltLake, { ...saltLake, locality: 'South Salt Lake', postal_code: '84119' }],
    });
  });

  it('puts the province on Italian and Spanish addresses, and skips places', () => {
    const context = {
      address: { address_number: '9', street_name: 'Via Fontanastasia' },
      postcode: { name: '00060' },
      place: { name: 'Castelnuovo di Porto' },
      district: { name: 'Roma' },
      region: { name: 'Lazio' },
      country: { country_code: 'it' },
    };
    expect(toSuggestion({ feature_type: 'address', context })).toEqual({
      line1: 'Via Fontanastasia',
      street_number: '9',
      locality: 'Castelnuovo di Porto',
      region: 'Roma',
      postal_code: '00060',
      country_code: 'IT',
    });
    expect(
      toSuggestion({
        feature_type: 'street',
        name: 'Main Street',
        context: { region: { name: 'Illinois' }, country: { country_code: 'US' } },
      }),
    ).toMatchObject({ line1: 'Main Street', street_number: null, region: 'Illinois' });
    expect(toSuggestion({ feature_type: 'place', name: 'Roma' })).toBeNull();
  });

  it('tells rejected tokens, rate limits and timeouts apart', async () => {
    const answer = (fixture: unknown) => checkToken(TOKEN, fixtureFetch([fx(fixture)]).fetch);
    expect(await answer(invalidToken)).toEqual({
      kind: 'failed',
      status: 401,
      message: 'Mapbox: Not Authorized - Invalid Token',
    });
    expect(await answer(forbidden)).toMatchObject({ kind: 'failed', status: 403 });
    expect(await answer(rateLimited)).toMatchObject({ kind: 'failed', status: 429 });
    const slow: Fetch = (_input, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
      );
    expect(await lookup(TOKEN, { q: 'via roma' }, { fetch: slow, timeoutMs: 20 })).toMatchObject({
      kind: 'failed',
      status: 0,
    });
  });
});

describe('mapbox: app', () => {
  it('suggests addresses with the workspace token and its storage mode', async () => {
    const app = await setup({ permanent: true });
    const answer = await app.call('/address/suggest', {
      q: '974 2100 South',
      lang: 'en',
      country: 'US',
    });
    expect(answer).toEqual({
      status: 200,
      body: {
        suggestions: [saltLake, { ...saltLake, locality: 'South Salt Lake', postal_code: '84119' }],
      },
    });
    const url = new URL(app.mapbox.calls[0]!.url);
    expect(url.searchParams.get('access_token')).toBe(TOKEN);
    expect(url.searchParams.get('permanent')).toBe('true');
    await app.call('/address/suggest', { q: '974 2100 South' });
    // The settings are read once per install and cached.
    expect(app.crm.calls.filter((c) => c.url.endsWith('/apps/data/mapbox_token'))).toHaveLength(1);
    expect(app.mapbox.unmatched).toEqual([]);
  });

  it('lets the CRM fall back to OpenStreetMap without a token or when Mapbox fails', async () => {
    const unconfigured = await setup({ token: null });
    expect(await unconfigured.call('/address/suggest', { q: 'via roma 1' })).toEqual({
      status: 422,
      body: { error: 'add your Mapbox access token in the app settings' },
    });
    expect(unconfigured.mapbox.calls).toEqual([]);

    const app = await setup();
    expect((await app.call('/address/suggest', { q: 'vi' })).body).toEqual({ suggestions: [] });
    app.mapbox.use(fx(rateLimited));
    expect((await app.call('/address/suggest', { q: 'via roma 1' })).status).toBe(429);
    app.mapbox.use(fx(invalidToken));
    expect(await app.call('/address/suggest', { q: 'via roma 1' })).toEqual({
      status: 502,
      body: { error: 'Mapbox: Not Authorized - Invalid Token' },
    });
  });

  it('checks the token before saving it and keeps the storage mode', async () => {
    const app = await setup({ token: null });
    expect((await app.screen('GET')).body).toEqual({
      configured: false,
      hint: null,
      permanent: false,
    });
    expect(await app.screen('POST', { token: 'not-a-token' })).toEqual({
      status: 422,
      body: { error: 'invalid_token' },
    });
    app.mapbox.use(fx(invalidToken));
    expect(await app.screen('POST', { token: TOKEN })).toEqual({
      status: 422,
      body: { error: 'invalid_token' },
    });
    expect(app.crm.data.has('mapbox_token')).toBe(false);

    app.mapbox.use(fx(forward));
    expect((await app.screen('POST', { token: TOKEN, permanent: true })).body).toEqual({
      configured: true,
      hint: '…mnop',
      permanent: true,
    });
    expect(app.crm.data.get('mapbox_token')).toEqual({ value: TOKEN, secret: true });
    expect(JSON.stringify((await app.screen('GET')).body)).not.toContain(TOKEN);
    expect((await app.screen('POST', { token: '' })).body).toEqual({
      configured: false,
      hint: null,
      permanent: true,
    });
    expect(app.crm.data.has('mapbox_token')).toBe(false);
  });

  it('passes the conformance suite', async () => {
    const app = await setup({ token: null });
    const results = await runConformance({
      manifest,
      fetch: app.fetch,
      secret: app.install.webhookSecrets[0]!,
      installationId: app.install.id,
    });
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(passed(results)).toBe(true);
  });
});
