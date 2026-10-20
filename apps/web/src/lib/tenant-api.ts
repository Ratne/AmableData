import type { Permission, Role } from '@amable/core';
import { stepUpFetch } from './step-up';

/**
 * Request layer of the typed tenant clients (`/api/v2/t/{slug}` REST v2 and
 * the `/api/t/{slug}` access layer): CSRF header, step-up, JSON errors with
 * field details and the redirect to the sign-in page when the session is gone.
 */

const CSRF_HEADER = 'x-amable-csrf';

export interface ApiErrorDetail {
  readonly path: string;
  readonly message: string;
}

export class TenantApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string | null,
    readonly details: readonly ApiErrorDetail[],
  ) {
    super(detail ?? `API ${String(status)} ${code}`);
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

let redirecting = false;

/** Session gone (expired, revoked, signed out elsewhere): back to the sign-in page. */
function onUnauthorized(): void {
  if (redirecting || window.location.pathname === '/login') return;
  redirecting = true;
  window.location.assign('/login');
}

type QueryValue = string | number | boolean | null | undefined;

/** Query string parameters: any object whose values are scalars (unset values are skipped). */
export type QueryParams = object;

export interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly query?: QueryParams;
  /** JSON body. */
  readonly json?: unknown;
  /** Raw body (CSV import, media upload). */
  readonly raw?: BodyInit;
  readonly contentType?: string;
  readonly signal?: AbortSignal;
  readonly keepalive?: boolean;
  /** POST with a fresh `Idempotency-Key` (the server keeps the reply for 24 h). Default true. */
  readonly idempotent?: boolean;
}

export function buildQuery(query: QueryParams | undefined): string {
  if (query === undefined) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query) as Array<[string, QueryValue | object]>) {
    if (value === undefined || value === null || value === '' || typeof value === 'object')
      continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

export async function request<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers = new Headers();
  let body: BodyInit | undefined;
  if (options.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(options.json);
  } else if (options.raw !== undefined) {
    const blobType = options.raw instanceof Blob ? options.raw.type : '';
    headers.set('content-type', options.contentType ?? (blobType || 'application/octet-stream'));
    body = options.raw;
  }
  if (method !== 'GET') headers.set(CSRF_HEADER, '1');
  if (method === 'POST' && options.idempotent !== false)
    headers.set('idempotency-key', crypto.randomUUID());

  const response = await stepUpFetch(`${url}${buildQuery(options.query)}`, {
    method,
    headers,
    body,
    credentials: 'same-origin',
    signal: options.signal,
    keepalive: options.keepalive,
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
      message?: string;
      details?: ApiErrorDetail[];
    } | null;
    if (response.status === 401) onUnauthorized();
    throw new TenantApiError(
      response.status,
      payload?.error ?? 'http_error',
      payload?.message ?? null,
      payload?.details ?? [],
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export interface TenantMe {
  readonly tenant: { readonly id: string; readonly slug: string; readonly name: string };
  readonly role: Role;
  readonly permissions: readonly Permission[];
  readonly user?: { readonly id: string; readonly name?: string };
}

export interface DirectoryMember {
  readonly id: string;
  readonly name: string;
}

export type Deleted = { id: string; deleted: true };

/** Verb helpers bound to the tenant's REST v2 base, plus the access layer's `me` and `directory`. */
export function tenantRest(slug: string, defaults: Pick<RequestOptions, 'idempotent'> = {}) {
  const base = `/api/v2/t/${encodeURIComponent(slug)}`;
  const tenantBase = `/api/t/${encodeURIComponent(slug)}`;
  const call = <T>(path: string, options: RequestOptions) =>
    request<T>(`${base}${path}`, { ...defaults, ...options });
  return {
    base,
    tenantBase,
    call,
    get: <T>(path: string, query?: QueryParams) => call<T>(path, { query }),
    post: <T>(path: string, json: unknown = {}) => call<T>(path, { method: 'POST', json }),
    patch: <T>(path: string, json: unknown) => call<T>(path, { method: 'PATCH', json }),
    put: <T>(path: string, json: unknown) => call<T>(path, { method: 'PUT', json }),
    del: <T = Deleted>(path: string) => call<T>(path, { method: 'DELETE' }),
    me: () => request<TenantMe>(`${tenantBase}/me`),
    directory: () => request<{ members: DirectoryMember[] }>(`${tenantBase}/directory`),
  };
}
