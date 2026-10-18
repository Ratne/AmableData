import type { Context } from 'hono';
import type { Env } from '../../env';
import { SITE_ID_RE } from '../rpc';
import { resolveTrackingHost } from '../tracking-domains';

/** Site whose funnels a tracking hostname serves. */
export interface LinkSite {
  siteId: string;
  tenantId: string | null;
  /** `''` on tracking hostnames, `/s/{siteId}` on the shared edge host (cookie path). */
  basePath: string;
}

/** Route prefix of the link routes on the shared edge host: the site travels in the path. */
export const SITE_PATH_PREFIX = '/s/:siteId{st_[a-z2-7]{20}}';

/** One way of mapping a request hostname to a site; null = not this resolver's hostname. */
export type LinkSiteResolver = (env: Env, host: string) => Promise<LinkSite | null>;

/** Custom tracking hostnames (`track.customer.com`), indexed by the core. */
export const trackingDomainResolver: LinkSiteResolver = async (env, host) => {
  const found = await resolveTrackingHost(env, host);
  return found === null ? null : { siteId: found.siteId, tenantId: found.tenant.id, basePath: '' };
};

export const DEFAULT_LINK_SITE_RESOLVERS: readonly LinkSiteResolver[] = [trackingDomainResolver];

/** First resolver answering for the hostname; null = unknown host (the link routes answer 404). */
export async function resolveLinkSite(
  env: Env,
  host: string,
  resolvers: readonly LinkSiteResolver[] = DEFAULT_LINK_SITE_RESOLVERS,
): Promise<LinkSite | null> {
  const h = host.toLowerCase().replace(/\.$/, '');
  for (const resolve of resolvers) {
    const site = await resolve(env, h);
    if (site !== null) return site;
  }
  return null;
}

/**
 * Site of a link request: from the `/s/{siteId}` prefix (shared edge host), else
 * from the hostname. The site's existence is checked by the DO call that follows.
 */
export async function requestLinkSite(
  c: Context<{ Bindings: Env }>,
  resolvers: readonly LinkSiteResolver[],
): Promise<LinkSite | null> {
  const fromPath = c.req.param('siteId');
  if (fromPath !== undefined) {
    return SITE_ID_RE.test(fromPath) ? { siteId: fromPath, tenantId: null, basePath: `/s/${fromPath}` } : null;
  }
  return resolveLinkSite(c.env, new URL(c.req.url).hostname, resolvers);
}
