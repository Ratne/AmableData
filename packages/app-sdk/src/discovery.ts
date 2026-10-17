/**
 * Every installation (managed or self-hosted) describes itself at
 * `/.well-known/amable-apps.json`; the SDK reads endpoints and keys from there
 * instead of hard-coding them.
 */

export const DISCOVERY_PATH = '/.well-known/amable-apps.json';

export interface Discovery {
  readonly issuer: string;
  readonly jwks_uri: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly revocation_endpoint: string;
  readonly api_base: string;
  readonly version: string | null;
  readonly api_versions: string[];
  readonly current_api_version: string;
  readonly extension_points: string[];
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; value: unknown }>();

/** `http:` origins are accepted only for localhost (development installations). */
export function normalizeOrigin(origin: string): string {
  const url = new URL(origin);
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) throw new Error(`installation origin must be https: ${origin}`);
  return url.origin;
}

async function getJson(url: string, fetcher: Fetch): Promise<unknown> {
  const hit = cache.get(url);
  if (hit !== undefined && Date.now() - hit.at < TTL_MS) return hit.value;
  const response = await fetcher(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${String(response.status)}`);
  const value = (await response.json()) as unknown;
  cache.set(url, { at: Date.now(), value });
  return value;
}

export async function discover(origin: string, fetcher: Fetch = fetch): Promise<Discovery> {
  const base = normalizeOrigin(origin);
  const doc = (await getJson(`${base}${DISCOVERY_PATH}`, fetcher)) as Discovery;
  if (doc.issuer !== base) throw new Error(`discovery issuer mismatch: ${doc.issuer} ≠ ${base}`);
  return doc;
}

export async function installationJwks(origin: string, fetcher: Fetch = fetch, fresh = false): Promise<{ keys: Array<Record<string, string>> }> {
  const doc = await discover(origin, fetcher);
  if (fresh) cache.delete(doc.jwks_uri);
  return (await getJson(doc.jwks_uri, fetcher)) as { keys: Array<Record<string, string>> };
}

/** Test hook. */
export function clearDiscoveryCache(): void {
  cache.clear();
}
