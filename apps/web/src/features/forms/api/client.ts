import type {
  ConnectionTestResult,
  ConnectorInfo,
  CreateConnectionInput,
  CustomField,
  Form,
  FormConnection,
  FormConnectionWithSecret,
  FormEmbed,
  FormSubmission,
  FormSummary,
  LeadSource,
  ListFormsQuery,
  Page,
  SubmissionStatus,
  Tag,
  UpdateConnectionInput,
  UpdateFormInput,
} from '@amable/api-types';
import type { Permission, Role } from '@amable/core';
import type { FormDefinition } from '@amable/forms';
import { stepUpFetch } from '../../../lib/step-up';

/**
 * Typed client of the forms REST v2 surface (`/api/v2/t/{slug}`) plus the CRM
 * lookups the builder needs (contact custom fields, tags, lead sources, members).
 */

const CSRF_HEADER = 'x-amable-csrf';

export interface ApiErrorDetail {
  readonly path: string;
  readonly message: string;
}

export class FormsApiError extends Error {
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
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly json?: unknown;
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
  let body: string | undefined;
  if (options.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(options.json);
  }
  if (method !== 'GET') headers.set(CSRF_HEADER, '1');
  const response = await stepUpFetch(`${url}${buildQuery(options.query)}`, {
    method,
    headers,
    body,
    credentials: 'same-origin',
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
    throw new FormsApiError(
      response.status,
      payload?.error ?? 'http_error',
      payload?.message ?? null,
      payload?.details ?? [],
    );
  }
  return (await response.json()) as T;
}

export interface TenantMe {
  readonly tenant: { readonly id: string; readonly slug: string; readonly name: string };
  readonly role: Role;
  readonly permissions: readonly Permission[];
}

export interface DirectoryMember {
  readonly id: string;
  readonly name: string;
}

/** A form whose definition is typed with the @amable/forms schema (the API returns it normalized). */
export type TypedForm = Omit<Form, 'definition'> & { definition: FormDefinition };

type Deleted = { id: string; deleted: true };

export function formsClient(slug: string) {
  const base = `/api/v2/t/${encodeURIComponent(slug)}`;
  const tenantBase = `/api/t/${encodeURIComponent(slug)}`;
  const id = encodeURIComponent;
  const get = <T>(path: string, query?: RequestOptions['query']) => request<T>(`${base}${path}`, { query });
  const post = <T>(path: string, json: unknown = {}) => request<T>(`${base}${path}`, { method: 'POST', json });
  const patch = <T>(path: string, json: unknown) => request<T>(`${base}${path}`, { method: 'PATCH', json });
  const del = <T>(path: string) => request<T>(`${base}${path}`, { method: 'DELETE' });
  const form = (formId: string) => `/forms/${id(formId)}`;

  return {
    me: () => request<TenantMe>(`${tenantBase}/me`),
    directory: () => request<{ members: DirectoryMember[] }>(`${tenantBase}/directory`),
    forms: {
      list: (params: Partial<ListFormsQuery> = {}) => get<Page<FormSummary>>('/forms', { limit: 200, ...params }),
      get: (formId: string) => get<TypedForm>(form(formId)),
      create: (input: { name: string; definition?: FormDefinition }) => post<TypedForm>('/forms', input),
      update: (formId: string, input: Omit<UpdateFormInput, 'definition'> & { definition?: FormDefinition }) =>
        patch<TypedForm>(form(formId), input as UpdateFormInput),
      remove: (formId: string) => del<Deleted>(form(formId)),
      duplicate: (formId: string) => post<TypedForm>(`${form(formId)}/duplicate`),
      archive: (formId: string) => post<TypedForm>(`${form(formId)}/archive`),
      restore: (formId: string) => post<TypedForm>(`${form(formId)}/restore`),
      embed: (formId: string) => get<FormEmbed>(`${form(formId)}/embed`),
    },
    submissions: {
      list: (formId: string, params: { cursor?: string; status?: SubmissionStatus; limit?: number } = {}) =>
        get<Page<FormSubmission>>(`${form(formId)}/submissions`, { limit: 50, ...params }),
      get: (formId: string, submissionId: string) =>
        get<FormSubmission>(`${form(formId)}/submissions/${id(submissionId)}`),
      remove: (formId: string, submissionId: string) =>
        del<Deleted>(`${form(formId)}/submissions/${id(submissionId)}`),
      reprocess: (formId: string, submissionId: string) =>
        post<FormSubmission>(`${form(formId)}/submissions/${id(submissionId)}/reprocess`),
    },
    connections: {
      catalog: () => get<{ data: ConnectorInfo[] }>('/formConnectorTypes'),
      list: (formId: string) => get<{ data: FormConnection[] }>(`${form(formId)}/connections`),
      create: (formId: string, input: CreateConnectionInput) =>
        post<FormConnectionWithSecret>(`${form(formId)}/connections`, input),
      update: (formId: string, connectionId: string, input: UpdateConnectionInput) =>
        patch<FormConnection>(`${form(formId)}/connections/${id(connectionId)}`, input),
      remove: (formId: string, connectionId: string) =>
        del<Deleted>(`${form(formId)}/connections/${id(connectionId)}`),
      test: (formId: string, connectionId: string) =>
        post<ConnectionTestResult>(`${form(formId)}/connections/${id(connectionId)}/test`),
      rotateSecret: (formId: string, connectionId: string) =>
        post<FormConnectionWithSecret>(`${form(formId)}/connections/${id(connectionId)}/rotateSecret`),
    },
    crm: {
      customFields: () => get<{ data: CustomField[] }>('/customFields/contact'),
      leadSources: () => get<{ data: LeadSource[] }>('/leadSources'),
    },
  };
}

export type FormsClient = ReturnType<typeof formsClient>;
