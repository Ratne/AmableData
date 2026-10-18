import { EDGE_INSTALLATION_TENANT, type FunnelGraph } from '@amable/api-types';
import type { Env } from '../../env';
import { callCore, GatewayCallError } from '../../gateway';

/**
 * Public URLs of pages built with the AmableCRM page builder, used as funnel
 * destinations (`amable_page_id` without `url`). Pages live in the tenant's
 * CRM: the core answers through the signed gateway (installation op, the
 * tenant travels in the input). Answers are cached per isolate.
 */

export const PAGE_PUBLIC_URL_OP = 'pages.publicUrl';

type PageUrlOps = {
  [PAGE_PUBLIC_URL_OP]: { input: { tenant_id: string; page_id: string }; output: { url: string } };
};

const HIT_TTL_MS = 5 * 60_000;
const MISS_TTL_MS = 60_000;
const MAX_ENTRIES = 5_000;
const MAX_LOOKUPS = 20;

const cache = new Map<string, { url: string | null; until: number }>();

/** Test hook. */
export function clearHostedPageCache(): void {
  cache.clear();
}

const NO_CLIENT = { ip: null, userAgent: null, country: null, visitorId: null, referer: null, acceptLanguage: null };

/** Public URL of a published page; null when unknown, unpublished or the gateway is down (not cached). */
export async function resolveHostedPageUrl(
  env: Env,
  tenantId: string,
  pageId: string,
  now: number = Date.now(),
): Promise<string | null> {
  const key = `${tenantId}:${pageId}`;
  const cached = cache.get(key);
  if (cached !== undefined && cached.until > now) return cached.url;
  let url: string | null;
  try {
    url = (
      await callCore<PageUrlOps, typeof PAGE_PUBLIC_URL_OP>(env, PAGE_PUBLIC_URL_OP, EDGE_INSTALLATION_TENANT, NO_CLIENT, {
        tenant_id: tenantId,
        page_id: pageId,
      })
    ).value.url;
  } catch (error) {
    if (!(error instanceof GatewayCallError) || error.body.status !== 404) {
      console.error('[links] hosted page lookup failed', error instanceof Error ? error.message : String(error));
      return null;
    }
    url = null;
  }
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { url, until: now + (url === null ? MISS_TTL_MS : HIT_TTL_MS) });
  return url;
}

export type HostedPageLookup = (tenantId: string, pageId: string) => Promise<string | null>;

/**
 * Resolves the hosted pages of the graph (pages with only `amable_page_id`) and
 * pauses the unresolvable ones, so the engine rotates to another page or takes
 * the node's default exit instead of redirecting nowhere.
 */
export async function withHostedPages(
  graph: FunnelGraph,
  tenantId: string,
  lookup: HostedPageLookup,
): Promise<{ graph: FunnelGraph; urls: Map<string, string> }> {
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (node.kind !== 'page_group' || node.deleted_at != null) continue;
    for (const p of node.config.pages) if (p.url === undefined && p.amable_page_id !== undefined) ids.add(p.amable_page_id);
  }
  const urls = new Map<string, string>();
  if (ids.size === 0) return { graph, urls };
  await Promise.all(
    [...ids].slice(0, MAX_LOOKUPS).map(async (id) => {
      const url = await lookup(tenantId, id);
      if (url !== null) urls.set(id, url);
    }),
  );
  const nodes = graph.nodes.map((node) =>
    node.kind !== 'page_group'
      ? node
      : {
          ...node,
          config: {
            ...node.config,
            pages: node.config.pages.map((p) =>
              p.url === undefined && p.amable_page_id !== undefined && !urls.has(p.amable_page_id) ? { ...p, paused: true } : p,
            ),
          },
        },
  );
  return { graph: { ...graph, nodes }, urls };
}
