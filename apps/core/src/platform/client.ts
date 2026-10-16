import { CP_INSTALLATION_PREFIX } from '@amable/core/platform';
import type { Env } from '../env';
import { platformLink } from './license';

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

let fetchOverride: FetchFn | null = null;

/** Test hook: routes every control plane call to a fake (null restores `fetch`). */
export function overrideControlPlaneFetch(next: FetchFn | null): void {
  fetchOverride = next;
}

export class ControlPlaneError extends Error {
  override readonly name = 'ControlPlaneError';
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`control plane ${String(status)} ${code}`);
  }
}

export interface ControlPlaneClient {
  readonly installationId: string;
  get<T>(route: string): Promise<T>;
  post<T>(route: string, body: unknown): Promise<T>;
  /** Raw request (multipart attachments, custom methods). `route` is relative to `/v1/installation`. */
  raw(route: string, init: RequestInit): Promise<Response>;
}

/**
 * License-authenticated client of the control plane installation API, or null
 * on an open source installation without a license. Network errors and non-2xx
 * answers throw `ControlPlaneError` (status 0 = unreachable).
 */
export function controlPlaneClient(env: Env): ControlPlaneClient | null {
  const link = platformLink(env);
  if (link.mode !== 'licensed') return null;
  const base = `${link.controlPlaneUrl}${CP_INSTALLATION_PREFIX}`;
  const doFetch: FetchFn = fetchOverride ?? ((input, init) => fetch(input, init));

  async function raw(route: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${link.mode === 'licensed' ? link.licenseKey : ''}`);
    try {
      return await doFetch(`${base}${route}`, { ...init, headers });
    } catch {
      throw new ControlPlaneError(0, 'unreachable');
    }
  }

  async function json<T>(route: string, init: RequestInit): Promise<T> {
    const res = await raw(route, init);
    const body = (await res.json().catch(() => null)) as (T & { error?: unknown }) | null;
    if (!res.ok) {
      throw new ControlPlaneError(res.status, typeof body?.error === 'string' ? body.error : 'error');
    }
    return body as T;
  }

  return {
    installationId: link.installationId,
    get: (route) => json(route, { method: 'GET' }),
    post: (route, body) =>
      json(route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    raw,
  };
}
