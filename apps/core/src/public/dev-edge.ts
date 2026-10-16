import type { Env } from '../env';

/**
 * Header set by the edge port proxy of `scripts/dev.mjs`: its value is the Host the
 * browser used (e.g. `localhost:8788`). Only honored with ENVIRONMENT=dev.
 */
export const DEV_EDGE_HEADER = 'x-amable-dev-edge';

/** True when a dev request arrived through the edge port and must go to the edge worker. */
export function isDevEdgeRequest(request: Request, env: Pick<Env, 'ENVIRONMENT' | 'EDGE_DEV'>): boolean {
  return env.ENVIRONMENT === 'dev' && env.EDGE_DEV !== undefined && request.headers.has(DEV_EDGE_HEADER);
}

/** Rebuilds the request with the public edge host and hands it to the edge worker. */
export function forwardToDevEdge(request: Request, env: Pick<Env, 'EDGE_DEV'>): Promise<Response> {
  const edge = env.EDGE_DEV;
  if (edge === undefined) return Promise.resolve(new Response('Edge worker not bound', { status: 502 }));
  const host = request.headers.get(DEV_EDGE_HEADER) ?? '';
  const url = new URL(request.url);
  if (/^[a-z0-9.\-:[\]]+$/i.test(host)) url.host = host;
  const forwarded = new Request(url.toString(), request);
  forwarded.headers.delete(DEV_EDGE_HEADER);
  return edge.fetch(forwarded);
}
