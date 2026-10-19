import type {
  Contact,
  CreateEsignRequestInput,
  CreateEsignTemplateInput,
  EsignRequest,
  EsignRequestDetail,
  EsignRequestStatus,
  EsignTemplate,
  Page,
  UpdateEsignTemplateInput,
} from '@amable/api-types';
import type { Permission, Role } from '@amable/core';
import { stepUpFetch } from '../../../lib/step-up';

/** Typed client of the e-signature REST v2 surface (`/api/v2/t/{slug}`): templates, files and requests. */

const CSRF_HEADER = 'x-amable-csrf';

export interface ApiErrorDetail {
  readonly path: string;
  readonly message: string;
}

export class EsignApiError extends Error {
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
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly json?: unknown;
  readonly body?: Blob;
  readonly contentType?: string;
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
  let body: string | Blob | undefined;
  if (options.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(options.json);
  } else if (options.body !== undefined) {
    headers.set('content-type', options.contentType ?? 'application/octet-stream');
    body = options.body;
  }
  if (method !== 'GET') headers.set(CSRF_HEADER, '1');
  const response = await stepUpFetch(`${url}${buildQuery(options.query)}`, { method, headers, body, credentials: 'same-origin' });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string; message?: string; details?: ApiErrorDetail[] } | null;
    if (response.status === 401 && !redirecting && window.location.pathname !== '/login') {
      redirecting = true;
      window.location.assign('/login');
    }
    throw new EsignApiError(response.status, payload?.error ?? 'http_error', payload?.message ?? null, payload?.details ?? []);
  }
  return (await response.json()) as T;
}

export interface TenantMe {
  readonly tenant: { readonly id: string; readonly slug: string; readonly name: string };
  readonly role: Role;
  readonly permissions: readonly Permission[];
}

export interface ListRequestsParams {
  readonly status?: EsignRequestStatus;
  readonly template_id?: string;
  readonly contact_id?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

type Deleted = { id: string; deleted: true };

export function esignClient(slug: string) {
  const base = `/api/v2/t/${encodeURIComponent(slug)}`;
  const tenantBase = `/api/t/${encodeURIComponent(slug)}`;
  const id = encodeURIComponent;
  const get = <T>(path: string, query?: RequestOptions['query']) => request<T>(`${base}${path}`, { query });
  const post = <T>(path: string, json: unknown = {}) => request<T>(`${base}${path}`, { method: 'POST', json });
  const template = (templateId: string) => `/esignTemplates/${id(templateId)}`;
  const req = (requestId: string) => `/esignRequests/${id(requestId)}`;

  return {
    me: () => request<TenantMe>(`${tenantBase}/me`),
    templates: {
      list: (query: { status?: EsignTemplate['status']; q?: string } = {}) => get<Page<EsignTemplate>>('/esignTemplates', { limit: 200, ...query }),
      get: (templateId: string) => get<EsignTemplate>(template(templateId)),
      create: (input: CreateEsignTemplateInput) => post<EsignTemplate>('/esignTemplates', input),
      update: (templateId: string, input: UpdateEsignTemplateInput) =>
        request<EsignTemplate>(`${base}${template(templateId)}`, { method: 'PATCH', json: input }),
      remove: (templateId: string) => request<Deleted>(`${base}${template(templateId)}`, { method: 'DELETE' }),
      uploadDocument: (templateId: string, file: Blob, filename: string) =>
        request<EsignTemplate>(`${base}${template(templateId)}/document`, {
          method: 'PUT',
          body: file,
          contentType: 'application/pdf',
          query: { filename },
        }),
      documentUrl: (templateId: string) => `${base}${template(templateId)}/document`,
      uploadPageImage: (templateId: string, page: number, image: Blob, sourceSha256: string) =>
        request<EsignTemplate>(`${base}${template(templateId)}/pages/${String(page)}/image`, {
          method: 'PUT',
          body: image,
          contentType: image.type || 'image/webp',
          query: { source_sha256: sourceSha256 },
        }),
      pageImageUrl: (templateId: string, page: number, version: string) =>
        `${base}${template(templateId)}/pages/${String(page)}/image?v=${encodeURIComponent(version)}`,
    },
    requests: {
      list: (params: ListRequestsParams = {}) => get<Page<EsignRequest>>('/esignRequests', { limit: 100, ...params }),
      get: (requestId: string) => get<EsignRequestDetail>(req(requestId)),
      create: (input: CreateEsignRequestInput) => post<EsignRequest>('/esignRequests', input),
      void: (requestId: string, reason?: string) => post<EsignRequest>(`${req(requestId)}/void`, reason === undefined || reason === '' ? {} : { reason }),
      remind: (requestId: string, signerId?: string) => post<EsignRequest>(`${req(requestId)}/remind`, signerId === undefined ? {} : { signer_id: signerId }),
      finalize: (requestId: string) => post<EsignRequest>(`${req(requestId)}/finalize`),
      signerLink: (requestId: string, signerId: string) => post<{ url: string }>(`${req(requestId)}/signers/${id(signerId)}/link`),
      documentUrl: (requestId: string, kind: 'completed' | 'original', download = false) =>
        `${base}${req(requestId)}/document${buildQuery({ kind, download: download ? 'true' : undefined })}`,
    },
    contacts: {
      search: (q: string) => get<Page<Contact>>('/contacts', { q: q || undefined, limit: 8 }),
      get: (contactId: string) => get<Contact>(`/contacts/${id(contactId)}`),
    },
  };
}

export type EsignClient = ReturnType<typeof esignClient>;
