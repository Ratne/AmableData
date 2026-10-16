import { elementNodeSchema, type BuilderDocument, type ElementNode } from '@amable/builder';
import type { Permission, Role } from '@amable/core';
import { stepUpFetch } from '../../../lib/step-up';
import type {
  AnalyticsSiteOption,
  CreatePageInput,
  CursorPage,
  EventTypeOption,
  FormOption,
  LandingPage,
  LandingPageWithDraft,
  LockState,
  MediaFile,
  PageStatus,
  PageVersion,
  SavedSection,
  UpdatePageInput,
} from './types';

/**
 * Typed client of the pages REST v2 surface (`/api/v2/t/{slug}`) plus the
 * lookups the editor needs (forms, booking event types, analytics sites).
 */

const CSRF_HEADER = 'x-amable-csrf';

export interface ApiErrorDetail {
  readonly path: string;
  readonly message: string;
}

export class LandingApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string | null,
    readonly details: readonly ApiErrorDetail[],
  ) {
    super(detail ?? `API ${String(status)} ${code}`);
  }
}

type QueryValue = string | number | boolean | null | undefined;

interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly json?: unknown;
  readonly body?: Blob;
  readonly contentType?: string;
  readonly signal?: AbortSignal;
  readonly keepalive?: boolean;
}

function buildQuery(query: Readonly<Record<string, QueryValue>> | undefined): string {
  if (query === undefined) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

let redirecting = false;

async function request<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers = new Headers();
  let body: BodyInit | undefined;
  if (options.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(options.json);
  } else if (options.body !== undefined) {
    headers.set('content-type', options.contentType ?? (options.body.type || 'application/octet-stream'));
    body = options.body;
  }
  if (method !== 'GET') headers.set(CSRF_HEADER, '1');
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
    if (response.status === 401 && !redirecting && window.location.pathname !== '/login') {
      redirecting = true;
      window.location.assign('/login');
    }
    throw new LandingApiError(
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

export interface ListPagesParams {
  readonly q?: string;
  readonly status?: PageStatus;
  readonly folder_id?: string;
  readonly include_subfolders?: 'true';
  readonly cursor?: string;
  readonly limit?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** Accepts `{data: [...]}` or a bare array (the booking API is still being built). */
function listOf(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const data = asRecord(payload)?.['data'];
  return Array.isArray(data) ? data : [];
}

function eventTypeOptions(payload: unknown): EventTypeOption[] {
  const out: EventTypeOption[] = [];
  for (const item of listOf(payload)) {
    const row = asRecord(item);
    const slug = row?.['slug'];
    if (typeof slug !== 'string' || slug === '') continue;
    const name = row?.['name'] ?? row?.['title'];
    out.push({ slug, name: typeof name === 'string' && name !== '' ? name : slug });
  }
  return out;
}

export function landingClient(slug: string) {
  const base = `/api/v2/t/${encodeURIComponent(slug)}`;
  const tenantBase = `/api/t/${encodeURIComponent(slug)}`;
  const id = encodeURIComponent;
  const get = <T>(path: string, query?: RequestOptions['query']) => request<T>(`${base}${path}`, { query });
  const post = <T>(path: string, json: unknown = {}) => request<T>(`${base}${path}`, { method: 'POST', json });
  const patch = <T>(path: string, json: unknown) => request<T>(`${base}${path}`, { method: 'PATCH', json });
  const del = <T>(path: string) => request<T>(`${base}${path}`, { method: 'DELETE' });
  const page = (pageId: string) => `/pages/${id(pageId)}`;

  return {
    base,
    me: () => request<TenantMe>(`${tenantBase}/me`),
    pages: {
      list: (params: ListPagesParams = {}) => get<CursorPage<LandingPage>>('/pages', { limit: 100, ...params }),
      get: (pageId: string) => get<LandingPageWithDraft>(page(pageId)),
      create: (input: CreatePageInput) => post<LandingPage>('/pages', input),
      update: (pageId: string, input: UpdatePageInput) => patch<LandingPage>(page(pageId), input),
      remove: (pageId: string) => del<unknown>(page(pageId)),
      restore: (pageId: string) => post<LandingPage>(`${page(pageId)}/restore`),
      duplicate: (pageId: string) => post<LandingPage>(`${page(pageId)}/duplicate`),
      saveDraft: (pageId: string, document: BuilderDocument, baseRevision: number, keepalive = false) =>
        request<{ draft_revision: number }>(`${base}${page(pageId)}/draft`, {
          method: 'PUT',
          json: { document, base_revision: baseRevision },
          keepalive,
        }),
      publish: (pageId: string, note?: string) =>
        post<{ page: LandingPage; version: PageVersion }>(`${page(pageId)}/publish`, note ? { note } : {}),
      unpublish: (pageId: string) => post<LandingPage>(`${page(pageId)}/unpublish`),
      versions: (pageId: string) => get<{ data: PageVersion[] }>(`${page(pageId)}/versions`),
      restoreVersion: (pageId: string, versionId: string) =>
        post<unknown>(`${page(pageId)}/versions/${id(versionId)}/restore`),
      preview: (pageId: string) => get<{ html: string }>(`${page(pageId)}/preview`),
      lockStatus: (pageId: string) => get<Omit<LockState, 'type'>>(`${page(pageId)}/lock/status`),
      lockSocketUrl: (pageId: string) => {
        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        return `${proto}://${window.location.host}${base}${page(pageId)}/lock`;
      },
    },
    savedSections: {
      list: async (): Promise<SavedSection[]> => {
        const out: SavedSection[] = [];
        for (const item of listOf(await get<unknown>('/savedSections'))) {
          const row = item as Omit<SavedSection, 'node'> & { node: unknown };
          const node = elementNodeSchema.safeParse(row.node);
          if (node.success) out.push({ ...row, node: node.data });
        }
        return out;
      },
      create: (input: { name: string; category: string | null; node: ElementNode }) =>
        post<SavedSection>('/savedSections', input),
      update: (sectionId: string, input: { name?: string; category?: string | null }) =>
        patch<SavedSection>(`/savedSections/${id(sectionId)}`, input),
      remove: (sectionId: string) => del<unknown>(`/savedSections/${id(sectionId)}`),
    },
    media: {
      list: (cursor?: string) => get<CursorPage<MediaFile>>('/media', { limit: 60, cursor }),
      upload: (file: File) =>
        request<MediaFile>(`${base}/media`, {
          method: 'PUT',
          query: { filename: file.name },
          body: file,
          contentType: file.type || 'application/octet-stream',
        }),
      remove: (mediaId: string) => del<unknown>(`/media/${id(mediaId)}`),
    },
    lookups: {
      forms: async (): Promise<FormOption[]> => {
        const payload = await get<unknown>('/forms', { limit: 200 });
        const out: FormOption[] = [];
        for (const item of listOf(payload)) {
          const row = asRecord(item);
          const formId = row?.['id'];
          const name = row?.['name'];
          if (typeof formId === 'string') out.push({ id: formId, name: typeof name === 'string' ? name : formId });
        }
        return out;
      },
      /** `null` when the booking module is not deployed (404). */
      eventTypes: async (): Promise<EventTypeOption[] | null> => {
        try {
          return eventTypeOptions(await get<unknown>('/bookingEventTypes'));
        } catch (error) {
          if (error instanceof LandingApiError && (error.status === 404 || error.status === 501)) return null;
          throw error;
        }
      },
      analyticsSites: async (): Promise<AnalyticsSiteOption[]> => {
        const payload = await get<{ data: AnalyticsSiteOption[] }>('/analytics/sites');
        return payload.data;
      },
    },
  };
}

export type LandingClient = ReturnType<typeof landingClient>;
