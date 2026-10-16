import type {
  AddSuppressionInput,
  Broadcast,
  BroadcastEstimate,
  BroadcastSchedule,
  BroadcastStats,
  BroadcastSummary,
  Contact,
  CreateBroadcastInput,
  CreateEmailTemplateInput,
  CreateSnippetInput,
  CustomField,
  EmailSettings,
  EmailTemplate,
  EmailTemplateSummary,
  LiquidPreview,
  LiquidPreviewInput,
  LiquidSchema,
  Page,
  SavedSearch,
  ScheduleBucket,
  Snippet,
  Suppression,
  Tag,
  TestSendInput,
  UpdateBroadcastInput,
  UpdateEmailSettingsInput,
  UpdateEmailTemplateInput,
  UpdateSnippetInput,
} from '@amable/api-types';
import type { Permission } from '@amable/core';
import { toast } from '@amable/ui';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { apiFetch, ApiError } from '../../lib/api';

/** Typed client of the email + broadcast REST v2 routes (and the CRM lookups their pickers need). */
export function emailApi(slug: string) {
  const v2 = `/api/v2/t/${encodeURIComponent(slug)}`;
  const json = (body: unknown) => JSON.stringify(body);
  const qs = (params: Record<string, string | number | undefined>) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(key, String(value));
    const text = search.toString();
    return text === '' ? '' : `?${text}`;
  };
  return {
    templates: {
      list: (cursor?: string) => apiFetch<Page<EmailTemplateSummary>>(`${v2}/emailTemplates${qs({ limit: 100, cursor })}`),
      get: (id: string) => apiFetch<EmailTemplate>(`${v2}/emailTemplates/${id}`),
      create: (input: CreateEmailTemplateInput) =>
        apiFetch<EmailTemplate>(`${v2}/emailTemplates`, { method: 'POST', body: json(input) }),
      update: (id: string, input: UpdateEmailTemplateInput) =>
        apiFetch<EmailTemplate>(`${v2}/emailTemplates/${id}`, { method: 'PATCH', body: json(input) }),
      remove: (id: string) => apiFetch(`${v2}/emailTemplates/${id}`, { method: 'DELETE' }),
      test: (id: string, input: TestSendInput) =>
        apiFetch<{ sent: { email: string }[] }>(`${v2}/emailTemplates/${id}/test`, { method: 'POST', body: json(input) }),
    },
    snippets: {
      list: () => apiFetch<{ data: Snippet[] }>(`${v2}/emailSnippets`),
      create: (input: CreateSnippetInput) => apiFetch<Snippet>(`${v2}/emailSnippets`, { method: 'POST', body: json(input) }),
      update: (id: string, input: UpdateSnippetInput) =>
        apiFetch<Snippet>(`${v2}/emailSnippets/${id}`, { method: 'PATCH', body: json(input) }),
      remove: (id: string) => apiFetch(`${v2}/emailSnippets/${id}`, { method: 'DELETE' }),
    },
    suppressions: {
      list: (q: string, cursor?: string) => apiFetch<Page<Suppression>>(`${v2}/suppressions${qs({ limit: 100, q, cursor })}`),
      add: (input: AddSuppressionInput) => apiFetch<Suppression>(`${v2}/suppressions`, { method: 'POST', body: json(input) }),
      remove: (email: string) => apiFetch(`${v2}/suppressions/${encodeURIComponent(email)}`, { method: 'DELETE' }),
    },
    settings: {
      get: () => apiFetch<EmailSettings>(`${v2}/email/settings`),
      update: (input: UpdateEmailSettingsInput) =>
        apiFetch<EmailSettings>(`${v2}/email/settings`, { method: 'PATCH', body: json(input) }),
      resume: () => apiFetch<EmailSettings>(`${v2}/email/settings/resume`, { method: 'POST', body: '{}' }),
    },
    previewContext: (contactId: string) =>
      apiFetch<{ context: Record<string, unknown> }>(`${v2}/email/previewContext${qs({ contact_id: contactId })}`),
    liquid: {
      schema: () => apiFetch<LiquidSchema>(`${v2}/liquid/schema`),
      preview: (input: LiquidPreviewInput) =>
        apiFetch<LiquidPreview>(`${v2}/liquid/preview`, { method: 'POST', body: json(input) }),
    },
    broadcasts: {
      list: (cursor?: string) => apiFetch<Page<BroadcastSummary>>(`${v2}/broadcasts${qs({ limit: 100, cursor })}`),
      get: (id: string) => apiFetch<Broadcast>(`${v2}/broadcasts/${id}`),
      create: (input: CreateBroadcastInput) => apiFetch<Broadcast>(`${v2}/broadcasts`, { method: 'POST', body: json(input) }),
      update: (id: string, input: UpdateBroadcastInput) =>
        apiFetch<Broadcast>(`${v2}/broadcasts/${id}`, { method: 'PATCH', body: json(input) }),
      remove: (id: string) => apiFetch(`${v2}/broadcasts/${id}`, { method: 'DELETE' }),
      estimate: (id: string) => apiFetch<BroadcastEstimate>(`${v2}/broadcasts/${id}/estimate`),
      stats: (id: string) => apiFetch<BroadcastStats>(`${v2}/broadcasts/${id}/stats`),
      test: (id: string, input: TestSendInput) =>
        apiFetch<{ sent: { email: string }[] }>(`${v2}/broadcasts/${id}/test`, { method: 'POST', body: json(input) }),
      schedule: (id: string, schedule: BroadcastSchedule) =>
        apiFetch<{ broadcast: Broadcast; buckets: ScheduleBucket[] }>(`${v2}/broadcasts/${id}/schedule`, {
          method: 'POST',
          body: json(schedule),
        }),
      action: (id: string, action: 'pause' | 'resume' | 'cancel') =>
        apiFetch<Broadcast>(`${v2}/broadcasts/${id}/${action}`, { method: 'POST', body: '{}' }),
    },
    crm: {
      savedSearches: () => apiFetch<{ data: SavedSearch[] }>(`${v2}/savedSearches`),
      tags: () => apiFetch<Page<Tag>>(`${v2}/tags${qs({ limit: 200 })}`),
      customFields: () => apiFetch<{ data: CustomField[] }>(`${v2}/customFields/contacts`),
      searchContacts: (q: string) => apiFetch<Page<Contact>>(`${v2}/contacts${qs({ limit: 8, q })}`),
      contactsPage: (q: string, cursor?: string) =>
        apiFetch<Page<Contact>>(`${v2}/contacts${qs({ limit: 20, q, cursor })}`),
    },
    tenant: {
      me: () => apiFetch<{ permissions: Permission[] }>(`/api/t/${encodeURIComponent(slug)}/me`),
      directory: () => apiFetch<{ members: { id: string; name: string }[] }>(`/api/t/${encodeURIComponent(slug)}/directory`),
    },
  };
}

export type EmailApi = ReturnType<typeof emailApi>;

export const emailKeys = {
  all: (slug: string) => ['email', slug] as const,
  templates: (slug: string) => ['email', slug, 'templates'] as const,
  template: (slug: string, id: string) => ['email', slug, 'template', id] as const,
  snippets: (slug: string) => ['email', slug, 'snippets'] as const,
  suppressions: (slug: string, q: string) => ['email', slug, 'suppressions', q] as const,
  settings: (slug: string) => ['email', slug, 'settings'] as const,
  broadcasts: (slug: string) => ['email', slug, 'broadcasts'] as const,
  broadcast: (slug: string, id: string) => ['email', slug, 'broadcast', id] as const,
  estimate: (slug: string, id: string) => ['email', slug, 'broadcast', id, 'estimate'] as const,
  stats: (slug: string, id: string) => ['email', slug, 'broadcast', id, 'stats'] as const,
  crm: (slug: string, what: string) => ['email', slug, 'crm', what] as const,
  liquidSchema: (slug: string) => ['email', slug, 'liquid', 'schema'] as const,
};

/** Tenant slug of the current route + its API client. */
export function useEmailApi(): { slug: string; api: EmailApi } {
  const { tenant } = useParams({ strict: false });
  const slug = tenant ?? 'demo';
  return { slug, api: emailApi(slug) };
}

export function usePermissions(): { can: (permission: Permission) => boolean; ready: boolean } {
  const { slug, api } = useEmailApi();
  const me = useQuery({ queryKey: ['tenant-me', slug], queryFn: api.tenant.me, staleTime: 60_000 });
  const set = new Set(me.data?.permissions ?? []);
  return { can: (p) => set.has(p), ready: me.isSuccess };
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.code ?? `HTTP ${String(error.status)}`;
  return error instanceof Error ? error.message : String(error);
}

/** Mutation with toast feedback and cache invalidation. */
export function useEmailMutation<TInput, TOutput>(options: {
  mutationFn: (input: TInput) => Promise<TOutput>;
  invalidate?: readonly QueryKey[];
  success?: string | ((output: TOutput) => string);
  onSuccess?: (output: TOutput) => void;
  errorText?: (message: string) => string;
}) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: options.mutationFn,
    onSuccess: async (output) => {
      for (const key of options.invalidate ?? []) await client.invalidateQueries({ queryKey: key });
      if (options.success !== undefined) {
        toast.success(typeof options.success === 'function' ? options.success(output) : options.success);
      }
      options.onSuccess?.(output);
    },
    onError: (error) => {
      const message = errorMessage(error);
      toast.error(options.errorText ? options.errorText(message) : message);
    },
  });
}
