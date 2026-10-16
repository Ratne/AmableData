import type { AddressSuggestion } from '@amable/api-types';

/**
 * Address autocomplete through a Photon geocoder (OpenStreetMap data, Apache-2.0,
 * https://github.com/komoot/photon). The public instance is free under a fair-use
 * policy; self-hosters can point `ADDRESS_LOOKUP_URL` at their own Photon or set
 * it to `off`. Requests go through the core worker so the SPA keeps `connect-src 'self'`
 * and the user's IP never reaches the geocoder.
 */
export const DEFAULT_ADDRESS_LOOKUP_URL = 'https://photon.komoot.io/api';

const MAX_SUGGESTIONS = 5;
const UPSTREAM_LIMIT = 10;
/** Wider net when results are restricted to one country, which drops the others. */
const UPSTREAM_LIMIT_ONE_COUNTRY = 25;
const TIMEOUT_MS = 4000;
const CACHE_TTL_S = 7 * 24 * 3600;
/** Languages the public Photon instance can answer in; anything else uses local names. */
const PHOTON_LANGS = new Set(['en', 'de', 'fr']);
/** Countries where the province (county), not the region (state), goes on the address. */
const COUNTY_REGION_COUNTRIES = new Set(['IT', 'ES']);
const ADDRESS_TYPES = new Set(['house', 'street']);

export class AddressLookupUnavailable extends Error {}
/** The provider rejected the credentials (wrong, revoked or URL-restricted token). */
export class AddressLookupUnauthorized extends AddressLookupUnavailable {}

export function addressLookupUrl(setting: string | undefined): string | null {
  const value = setting?.trim();
  if (value === undefined || value === '') return DEFAULT_ADDRESS_LOOKUP_URL;
  if (value.toLowerCase() === 'off') return null;
  return /^https?:\/\//i.test(value) ? value.replace(/\/+$/, '') : null;
}

export interface AddressLookupQuery {
  readonly q: string;
  readonly lang?: string | undefined;
  readonly country?: string | undefined;
}

interface PhotonProperties {
  readonly type?: string;
  readonly name?: string;
  readonly street?: string;
  readonly housenumber?: string;
  readonly postcode?: string;
  readonly city?: string;
  readonly locality?: string;
  readonly district?: string;
  readonly county?: string;
  readonly state?: string;
  readonly countrycode?: string;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, max);
}

export function photonToSuggestion(p: PhotonProperties): AddressSuggestion | null {
  if (p.type !== undefined && !ADDRESS_TYPES.has(p.type)) return null;
  const line1 = text(p.street ?? (p.type === 'street' ? p.name : undefined), 255);
  if (line1 === null) return null;
  const countryCode = text(p.countrycode, 2)?.toUpperCase() ?? null;
  const county = text(p.county, 100);
  const state = text(p.state, 100);
  const suggestion = {
    line1,
    street_number: text(p.housenumber, 20),
    locality: text(p.city ?? p.locality ?? p.district ?? p.county, 100),
    region:
      countryCode !== null && COUNTY_REGION_COUNTRIES.has(countryCode) ? (county ?? state) : (state ?? county),
    postal_code: text(p.postcode, 20),
    country_code: countryCode !== null && /^[A-Z]{2}$/.test(countryCode) ? countryCode : null,
  };
  return { label: suggestionLabel(suggestion), ...suggestion };
}

function suggestionLabel(s: Omit<AddressSuggestion, 'label'>): string {
  return [
    [s.line1, s.street_number].filter(Boolean).join(' '),
    [s.postal_code, s.locality].filter(Boolean).join(' '),
    s.region,
    s.country_code,
  ]
    .filter(Boolean)
    .join(', ');
}

export function photonRequestUrl(base: string, query: AddressLookupQuery): string {
  const url = new URL(base);
  url.searchParams.set('q', query.q);
  url.searchParams.set('limit', String(query.country === undefined ? UPSTREAM_LIMIT : UPSTREAM_LIMIT_ONE_COUNTRY));
  const lang = query.lang?.slice(0, 2).toLowerCase();
  if (lang !== undefined && PHOTON_LANGS.has(lang)) url.searchParams.set('lang', lang);
  return url.toString();
}

function select(suggestions: AddressSuggestion[], country: string | undefined): AddressSuggestion[] {
  const seen = new Set<string>();
  return suggestions
    .filter((s) => country === undefined || s.country_code === country)
    .filter((s) => !seen.has(s.label) && seen.add(s.label))
    .slice(0, MAX_SUGGESTIONS);
}

async function cached(url: string, load: () => Promise<Response>): Promise<Response> {
  const cache = typeof caches === 'undefined' ? null : (caches as unknown as { default?: Cache }).default;
  if (cache === undefined || cache === null) return load();
  const key = new Request(url);
  const hit = await cache.match(key);
  if (hit !== undefined) return hit;
  const response = await load();
  if (response.ok) {
    const copy = new Response(response.clone().body, response);
    copy.headers.set('Cache-Control', `public, max-age=${String(CACHE_TTL_S)}`);
    await cache.put(key, copy);
  }
  return response;
}

async function fetchJson(url: string, fetchFn: typeof fetch, cacheable: boolean): Promise<unknown> {
  const load = () =>
    fetchFn(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'amabledata-crm (address autocomplete)' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  let response: Response;
  try {
    response = cacheable ? await cached(url, load) : await load();
  } catch {
    throw new AddressLookupUnavailable('address lookup unreachable');
  }
  if (response.status === 401 || response.status === 403) {
    throw new AddressLookupUnauthorized(`address lookup refused the credentials (${String(response.status)})`);
  }
  if (!response.ok) throw new AddressLookupUnavailable(`address lookup answered ${String(response.status)}`);
  return response.json().catch(() => null);
}

export async function lookupAddresses(
  base: string,
  query: AddressLookupQuery,
  fetchFn: typeof fetch = fetch,
): Promise<AddressSuggestion[]> {
  const body = (await fetchJson(photonRequestUrl(base, query), fetchFn, true)) as {
    features?: { properties?: PhotonProperties }[];
  } | null;
  const features = Array.isArray(body?.features) ? body.features : [];
  const suggestions = features
    .map((f) => (f.properties === undefined ? null : photonToSuggestion(f.properties)))
    .filter((s): s is AddressSuggestion => s !== null);
  return select(suggestions, query.country);
}

// ------------------------------------------------------------------- Mapbox

/**
 * Mapbox Geocoding v6 with the tenant's own access token. Mapbox lets results be
 * stored only with `permanent=true` (billed separately), and temporary results may
 * not be cached: these responses skip the cache.
 */
export const MAPBOX_GEOCODE_URL = 'https://api.mapbox.com/search/geocode/v6/forward';

interface MapboxContextPart {
  readonly name?: string;
  readonly address_number?: string;
  readonly street_name?: string;
  readonly country_code?: string;
}

interface MapboxProperties {
  readonly feature_type?: string;
  readonly name?: string;
  readonly context?: Partial<
    Record<'address' | 'street' | 'postcode' | 'place' | 'locality' | 'district' | 'region' | 'country', MapboxContextPart>
  >;
}

export function mapboxRequestUrl(
  token: string,
  query: AddressLookupQuery,
  options: { permanent?: boolean; limit?: number } = {},
): string {
  const url = new URL(MAPBOX_GEOCODE_URL);
  url.searchParams.set('q', query.q);
  url.searchParams.set('autocomplete', 'true');
  url.searchParams.set('types', 'address,street');
  url.searchParams.set('limit', String(options.limit ?? MAX_SUGGESTIONS));
  const lang = query.lang?.slice(0, 2).toLowerCase();
  if (lang !== undefined && /^[a-z]{2}$/.test(lang)) url.searchParams.set('language', lang);
  if (query.country !== undefined) url.searchParams.set('country', query.country.toLowerCase());
  if (options.permanent === true) url.searchParams.set('permanent', 'true');
  url.searchParams.set('access_token', token);
  return url.toString();
}

export function mapboxToSuggestion(p: MapboxProperties): AddressSuggestion | null {
  const ctx = p.context ?? {};
  const isStreet = p.feature_type === 'street';
  if (p.feature_type !== undefined && p.feature_type !== 'address' && !isStreet) return null;
  const line1 = text(ctx.address?.street_name ?? ctx.street?.name ?? (isStreet ? p.name : undefined), 255);
  if (line1 === null) return null;
  const countryCode = text(ctx.country?.country_code, 2)?.toUpperCase() ?? null;
  const district = text(ctx.district?.name, 100);
  const region = text(ctx.region?.name, 100);
  const suggestion = {
    line1,
    street_number: isStreet ? null : text(ctx.address?.address_number, 20),
    locality: text(ctx.place?.name ?? ctx.locality?.name, 100),
    region:
      countryCode !== null && COUNTY_REGION_COUNTRIES.has(countryCode) ? (district ?? region) : (region ?? district),
    postal_code: text(ctx.postcode?.name, 20),
    country_code: countryCode !== null && /^[A-Z]{2}$/.test(countryCode) ? countryCode : null,
  };
  return { label: suggestionLabel(suggestion), ...suggestion };
}

export async function lookupMapbox(
  token: string,
  query: AddressLookupQuery,
  options: { permanent?: boolean } = {},
  fetchFn: typeof fetch = fetch,
): Promise<AddressSuggestion[]> {
  const body = (await fetchJson(mapboxRequestUrl(token, query, options), fetchFn, false)) as {
    features?: { properties?: MapboxProperties }[];
  } | null;
  const features = Array.isArray(body?.features) ? body.features : [];
  const suggestions = features
    .map((f) => (f.properties === undefined ? null : mapboxToSuggestion(f.properties)))
    .filter((s): s is AddressSuggestion => s !== null);
  return select(suggestions, query.country);
}

/** One cheap request to tell a working token from a rejected one before saving it. */
export async function verifyMapboxToken(token: string, fetchFn: typeof fetch = fetch): Promise<void> {
  await fetchJson(mapboxRequestUrl(token, { q: 'Roma' }, { limit: 1 }), fetchFn, false);
}
