import type { Page } from '@amable/api-types';
import type { Permission, Role } from '@amable/core';
import { useQuery } from '@tanstack/react-query';
import { stepUpFetch } from './step-up';
import { responseError, TenantApiError } from './tenant-api';

/** Header the core worker's CSRF guard requires on every state-changing cookie request. */
const CSRF_HEADER = 'x-amable-csrf';

/** Same class as the tenant clients' error, so `instanceof` checks hold whichever client failed. */
export { TenantApiError as ApiError };

/** Session-level calls (`/api/me`, sign-out, edit locks): a 401 reaches the caller, no sign-in redirect. */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('content-type'))
    headers.set('content-type', 'application/json');
  if (init.method && init.method !== 'GET' && init.method !== 'HEAD') headers.set(CSRF_HEADER, '1');
  const response = await stepUpFetch(path, { ...init, headers, credentials: 'same-origin' });
  if (!response.ok) throw await responseError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Drains a cursor-paginated endpoint (bounded: small reference lists only). */
export async function fetchAllPages<T>(
  load: (cursor: string | undefined) => Promise<Page<T>>,
  maxPages = 20,
): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await load(cursor);
    rows.push(...result.data);
    if (result.next_cursor === null) break;
    cursor = result.next_cursor;
  }
  return rows;
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
  readonly canCreateTenant: boolean;
}

/** Signed-in user and memberships; `null` when signed out (or the API is down in local UI work). */
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async (): Promise<MeResponse | null> => {
      try {
        return await apiFetch<MeResponse>('/api/me');
      } catch (error) {
        if (error instanceof TenantApiError && (error.status === 401 || error.status === 403))
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
