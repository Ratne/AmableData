const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$|\.localhost$/;
const ACME_CHALLENGE = '/.well-known/acme-challenge/';

/**
 * Permanent redirect of a plain-http page request to the same URL over https, or
 * null when the request is served as is. Only GET/HEAD move: beacons, postbacks
 * and webhooks from third parties would lose their body on a redirect. Loopback
 * hosts and ENVIRONMENT=dev stay on http (wrangler dev).
 */
export function httpsRedirect(request: Request, environment: string | undefined): Response | null {
  const url = new URL(request.url);
  if (url.protocol !== 'http:' || environment === 'dev' || LOOPBACK.test(url.hostname)) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  if (url.pathname.startsWith(ACME_CHALLENGE)) return null;
  url.protocol = 'https:';
  return new Response(null, { status: 301, headers: { location: url.toString() } });
}
