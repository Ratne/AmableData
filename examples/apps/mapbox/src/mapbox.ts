/**
 * Mapbox Geocoding v6 (https://docs.mapbox.com/api/search/geocoding/), forward search
 * with autocomplete, restricted to addresses and streets. Temporary results may not
 * be stored nor cached; `permanent=true` (billed apart) allows keeping them.
 */

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export const MAPBOX_GEOCODE_URL = 'https://api.mapbox.com/search/geocode/v6/forward';

const MAX_SUGGESTIONS = 5;
/** The CRM waits 3 s, then falls back to its own geocoder. */
const TIMEOUT_MS = 2_500;
/** Countries where the province (Mapbox `district`), not the region, goes on the address. */
const COUNTY_REGION_COUNTRIES = new Set(['IT', 'ES']);

export interface AddressQuery {
  readonly q: string;
  readonly lang?: string | null;
  readonly country?: string | null;
}

/** An address as the CRM's `extensions.address_lookup` expects it (the CRM builds the label). */
export interface Suggestion {
  line1: string;
  street_number: string | null;
  locality: string | null;
  region: string | null;
  postal_code: string | null;
  country_code: string | null;
}

interface ContextPart {
  readonly name?: string;
  readonly address_number?: string;
  readonly street_name?: string;
  readonly country_code?: string;
}

export interface FeatureProperties {
  readonly feature_type?: string;
  readonly name?: string;
  readonly context?: Partial<
    Record<
      'address' | 'street' | 'postcode' | 'place' | 'locality' | 'district' | 'region' | 'country',
      ContextPart
    >
  >;
}

const text = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, max);
};

export function requestUrl(
  token: string,
  query: AddressQuery,
  options: { permanent?: boolean; limit?: number } = {},
): string {
  const url = new URL(MAPBOX_GEOCODE_URL);
  url.searchParams.set('q', query.q);
  url.searchParams.set('autocomplete', 'true');
  url.searchParams.set('types', 'address,street');
  url.searchParams.set('limit', String(options.limit ?? MAX_SUGGESTIONS));
  const lang = query.lang?.slice(0, 2).toLowerCase();
  if (lang !== undefined && /^[a-z]{2}$/.test(lang)) url.searchParams.set('language', lang);
  if (typeof query.country === 'string' && /^[A-Za-z]{2}$/.test(query.country)) {
    url.searchParams.set('country', query.country.toLowerCase());
  }
  if (options.permanent === true) url.searchParams.set('permanent', 'true');
  url.searchParams.set('access_token', token);
  return url.toString();
}

export function toSuggestion(p: FeatureProperties): Suggestion | null {
  const ctx = p.context ?? {};
  const isStreet = p.feature_type === 'street';
  if (p.feature_type !== undefined && p.feature_type !== 'address' && !isStreet) return null;
  const line1 = text(
    ctx.address?.street_name ?? ctx.street?.name ?? (isStreet ? p.name : undefined),
    255,
  );
  if (line1 === null) return null;
  const countryCode = text(ctx.country?.country_code, 2)?.toUpperCase() ?? null;
  const district = text(ctx.district?.name, 100);
  const region = text(ctx.region?.name, 100);
  return {
    line1,
    street_number: isStreet ? null : text(ctx.address?.address_number, 20),
    locality: text(ctx.place?.name ?? ctx.locality?.name, 100),
    region:
      countryCode !== null && COUNTY_REGION_COUNTRIES.has(countryCode)
        ? (district ?? region)
        : (region ?? district),
    postal_code: text(ctx.postcode?.name, 20),
    country_code: countryCode !== null && /^[A-Z]{2}$/.test(countryCode) ? countryCode : null,
  };
}

export type LookupResult =
  | { readonly kind: 'ok'; readonly suggestions: Suggestion[] }
  | { readonly kind: 'failed'; readonly status: number; readonly message: string };

export async function lookup(
  token: string,
  query: AddressQuery,
  options: { fetch: Fetch; permanent?: boolean; limit?: number; timeoutMs?: number },
): Promise<LookupResult> {
  let response: Response;
  try {
    response = await options.fetch(requestUrl(token, query, options), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
    });
  } catch {
    return { kind: 'failed', status: 0, message: 'Mapbox did not answer' };
  }
  const body = (await response.json().catch(() => null)) as {
    message?: unknown;
    features?: Array<{ properties?: FeatureProperties }>;
  } | null;
  if (!response.ok) {
    const message =
      typeof body?.message === 'string' ? body.message : `HTTP ${String(response.status)}`;
    return { kind: 'failed', status: response.status, message: `Mapbox: ${message}` };
  }
  const features = Array.isArray(body?.features) ? body.features : [];
  const suggestions = features
    .map((f) => (f.properties === undefined ? null : toSuggestion(f.properties)))
    .filter((s): s is Suggestion => s !== null);
  return { kind: 'ok', suggestions };
}

/** Whether Mapbox accepts the token: one cheap search, as Mapbox has no token-info call for public tokens. */
export async function checkToken(token: string, fetch: Fetch): Promise<LookupResult> {
  return lookup(token, { q: 'Roma' }, { fetch, limit: 1, timeoutMs: 5_000 });
}

/** Rejected credentials (wrong, revoked or URL-restricted token). */
export const isRejected = (result: LookupResult): boolean =>
  result.kind === 'failed' && (result.status === 401 || result.status === 403);
