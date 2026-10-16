import type { Permission, Role } from '@amable/core';
import { useQuery } from '@tanstack/react-query';
import { stepUpFetch } from './step-up';

/** Header the core worker's CSRF guard requires on every state-changing cookie request. */
const CSRF_HEADER = 'x-amable-csrf';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`API ${String(status)}${code ? ` ${code}` : ''}`);
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('content-type'))
    headers.set('content-type', 'application/json');
  if (init.method && init.method !== 'GET' && init.method !== 'HEAD') headers.set(CSRF_HEADER, '1');
  const response = await stepUpFetch(path, { ...init, headers, credentials: 'same-origin' });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(response.status, body?.error ?? null);
  }
  return (await response.json()) as T;
}

export interface MeMembership {
  readonly slug: string;
  readonly name: string;
  readonly role: Role;
  readonly permissions: readonly Permission[];
}

export interface MeResponse {
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly name: string | null;
    readonly locale: string;
    readonly theme: string;
  };
  readonly memberships: readonly MeMembership[];
  readonly lastTenantSlug: string | null;
}

/** Signed-in user and memberships; `null` when signed out (or the API is down in local UI work). */
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async (): Promise<MeResponse | null> => {
      try {
        return await apiFetch<MeResponse>('/api/me');
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403))
          return null;
        throw error;
      }
    },
    retry: false,
    staleTime: 60_000,
  });
}

/** Best effort: the choice is already applied locally and mirrored in the cookie. */
export function savePreferences(prefs: { locale?: string; theme?: string }): void {
  void apiFetch('/api/me/preferences', { method: 'PATCH', body: JSON.stringify(prefs) }).catch(
    () => undefined,
  );
}

export async function switchTenant(slug: string): Promise<string> {
  const result = await apiFetch<{ path: string }>('/api/me/tenants/switch', {
    method: 'POST',
    body: JSON.stringify({ slug }),
  });
  return result.path;
}

export async function signOut(): Promise<void> {
  await apiFetch('/api/auth/logout', { method: 'POST', body: '{}' }).catch(() => undefined);
}
