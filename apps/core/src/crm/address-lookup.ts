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

async function fetchJson(url: string, fetchFn: typeof fetch): Promise<unknown> {
  const load = () =>
    fetchFn(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'amabledata-crm (address autocomplete)' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  let response: Response;
  try {
    response = await cached(url, load);
  } catch {
    throw new AddressLookupUnavailable('address lookup unreachable');
  }
  if (!response.ok) throw new AddressLookupUnavailable(`address lookup answered ${String(response.status)}`);
  return response.json().catch(() => null);
}

export async function lookupAddresses(
  base: string,
  query: AddressLookupQuery,
  fetchFn: typeof fetch = fetch,
): Promise<AddressSuggestion[]> {
  const body = (await fetchJson(photonRequestUrl(base, query), fetchFn)) as {
    features?: { properties?: PhotonProperties }[];
  } | null;
  const features = Array.isArray(body?.features) ? body.features : [];
  const suggestions = features
    .map((f) => (f.properties === undefined ? null : photonToSuggestion(f.properties)))
    .filter((s): s is AddressSuggestion => s !== null);
  return select(suggestions, query.country);
}

// --------------------------------------------------------------- Address apps

/**
 * Suggestions from an installed app (`extensions.address_lookup`), normalized
 * like the geocoder's: fields trimmed and capped, label rebuilt when missing,
 * filtered to the requested country.
 */
export function appSuggestions(body: unknown, country: string | undefined): AddressSuggestion[] | null {
  const list = (body as { suggestions?: unknown } | null)?.suggestions;
  if (!Array.isArray(list)) return null;
  const suggestions = list.slice(0, UPSTREAM_LIMIT_ONE_COUNTRY).flatMap((item): AddressSuggestion[] => {
    if (typeof item !== 'object' || item === null) return [];
    const v = item as Record<string, unknown>;
    const line1 = text(v['line1'], 255);
    if (line1 === null) return [];
    const countryCode = text(v['country_code'], 3)?.toUpperCase() ?? null;
    const suggestion = {
      line1,
      street_number: text(v['street_number'], 20),
      locality: text(v['locality'], 100),
      region: text(v['region'], 100),
      postal_code: text(v['postal_code'], 20),
      country_code: countryCode !== null && /^[A-Z]{2}$/.test(countryCode) ? countryCode : null,
    };
    return [{ label: text(v['label'], 300) ?? suggestionLabel(suggestion), ...suggestion }];
  });
  return select(suggestions, country);
}
