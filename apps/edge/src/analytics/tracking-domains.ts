import type { GatewayTenantInfo } from '@amable/api-types';
import type { Env } from '../env';
import { callCore, GatewayCallError } from '../gateway';

/**
 * Custom tracking hostnames (`track.customer.com` CNAME → this worker): the
 * owning tenant and site come from the core worker's global index, through
 * the signed gateway like every customer hostname. Answers are cached per
 * isolate; only active hostnames resolve.
 */

export const TRACKING_HOST_OP = 'analytics.tracking_host';

export interface TrackingHost {
  readonly tenant: GatewayTenantInfo;
  readonly siteId: string;
}

type TrackingHostOps = {
  [TRACKING_HOST_OP]: { input: Record<string, never>; output: { site_id: string } };
};

const HIT_TTL_MS = 5 * 60_000;
const MISS_TTL_MS = 60_000;
const MAX_ENTRIES = 5_000;

const cache = new Map<string, { value: TrackingHost | null; until: number }>();

/** Test hook. */
export function clearTrackingHostCache(): void {
  cache.clear();
}

const NO_CLIENT = {
  ip: null,
  userAgent: null,
  country: null,
  visitorId: null,
  referer: null,
  acceptLanguage: null,
};

/**
 * Tenant and site of an active custom tracking hostname; `null` for unknown,
 * pending or failed hostnames. Gateway outages are not cached and resolve to `null`.
 */
export async function resolveTrackingHost(
  env: Env,
  hostname: string,
  now: number = Date.now(),
): Promise<TrackingHost | null> {
  const host = hostname.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  if (host === '' || host.length > 253) return null;
  const cached = cache.get(host);
  if (cached !== undefined && cached.until > now) return cached.value;
  let value: TrackingHost | null;
  try {
    const result = await callCore<TrackingHostOps, typeof TRACKING_HOST_OP>(
      env,
      TRACKING_HOST_OP,
      { host },
      NO_CLIENT,
      {},
    );
    value = { tenant: result.tenant, siteId: result.value.site_id };
  } catch (error) {
    if (!(error instanceof GatewayCallError) || error.body.status !== 404) {
      console.error('[tracking-domains] lookup failed', error);
      return null;
    }
    value = null;
  }
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(host, { value, until: now + (value === null ? MISS_TTL_MS : HIT_TTL_MS) });
  return value;
}
