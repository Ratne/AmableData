import { safeFetch } from '@amable/auth/security';
import type { Env } from '../env';

/**
 * Outgoing HTTP of the apps module (catalog, manifests, JWKS, hooks, actions):
 * SSRF-safe fetch with timeout and size cap. Loopback targets are reachable
 * only with ENVIRONMENT=dev, for apps running on the developer's machine.
 */

export interface AppHttpResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
}

export interface AppHttpOptions {
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/;

export function isLoopbackUrl(url: string): boolean {
  return LOOPBACK.test(url);
}

export async function appFetch(
  env: Pick<Env, 'ENVIRONMENT'>,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  options: AppHttpOptions = {},
): Promise<AppHttpResponse> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  if (isLoopbackUrl(url)) {
    if (env.ENVIRONMENT !== 'dev') throw new Error('loopback URLs are allowed only in development');
    const response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    if (text.length > maxBytes) throw new Error('response too large');
    return { status: response.status, headers: response.headers, text };
  }
  const response = await safeFetch(url, init, {
    fetchFn: (input, requestInit) => fetch(input, requestInit),
    timeoutMs,
    maxBytes,
    maxRedirects: 3,
  });
  return { status: response.status, headers: response.headers, text: new TextDecoder().decode(response.body) };
}
