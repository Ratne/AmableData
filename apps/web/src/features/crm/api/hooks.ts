import type { CustomFieldEntityPath, SearchEntity } from '@amable/api-types/crm';
import type { Permission } from '@amable/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';
import { useI18n } from '../../../i18n';
import {
  apiErrorMessage,
  type ApiMutationOptions,
  REFERENCE_STALE_MS,
  useApiMutation,
  useGrantedPermissions,
} from '../../../lib/feature-hooks';
import { tenantRoute } from '../../../routes/tenant';
import { fetchAllPages } from '../../../lib/api';
import { crmClient, type CrmClient } from './client';

/** Query keys: everything of a tenant lives under ['crm', slug, …] so one invalidation refreshes it. */
export const crmKeys = {
  root: (slug: string) => ['crm', slug] as const,
  me: (slug: string) => ['crm', slug, 'me'] as const,
  directory: (slug: string) => ['crm', slug, 'directory'] as const,
  tags: (slug: string) => ['crm', slug, 'tags'] as const,
  tagCategories: (slug: string) => ['crm', slug, 'tagCategories'] as const,
  customFields: (slug: string, entity: CustomFieldEntityPath) =>
    ['crm', slug, 'customFields', entity] as const,
  layout: (slug: string, entity: CustomFieldEntityPath) =>
    ['crm', slug, 'customFields', entity, 'layout'] as const,
  searchFields: (slug: string, entity: SearchEntity) =>
    ['crm', slug, 'searchFields', entity] as const,
  search: (slug: string) => ['crm', slug, 'search'] as const,
  contacts: (slug: string) => ['crm', slug, 'contacts'] as const,
  contact: (slug: string, id: string) => ['crm', slug, 'contacts', id] as const,
  companies: (slug: string) => ['crm', slug, 'companies'] as const,
  company: (slug: string, id: string) => ['crm', slug, 'companies', id] as const,
  timeline: (slug: string, subject: string, id: string) =>
    ['crm', slug, 'timeline', subject, id] as const,
  notes: (slug: string) => ['crm', slug, 'notes'] as const,
  tasks: (slug: string) => ['crm', slug, 'tasks'] as const,
  appointments: (slug: string) => ['crm', slug, 'appointments'] as const,
  calendar: (slug: string) => ['crm', slug, 'calendar'] as const,
  pipelines: (slug: string) => ['crm', slug, 'pipelines'] as const,
  opportunities: (slug: string) => ['crm', slug, 'opportunities'] as const,
  savedSearches: (slug: string) => ['crm', slug, 'savedSearches'] as const,
  leadSources: (slug: string) => ['crm', slug, 'leadSources'] as const,
};

export function useTenantSlug(): string {
  return useParams({ from: tenantRoute.id }).tenant;
}

/** The tenant slug and its bound API client. */
export function useCrm(): { slug: string; api: CrmClient } {
  const slug = useTenantSlug();
  const api = useMemo(() => crmClient(slug), [slug]);
  return { slug, api };
}

export function useTenantMe() {
  const { slug, api } = useCrm();
  return useQuery({
    queryKey: crmKeys.me(slug),
    queryFn: () => api.me(),
    staleTime: REFERENCE_STALE_MS,
    retry: false,
  });
}

/**
 * Permissions of the active membership (`GET /api/t/:slug/me`). Until they are
 * known every action is hidden; the server enforces access regardless.
 */
export function usePermissions(): { can: (permission: Permission) => boolean; ready: boolean } {
  const me = useTenantMe();
  return useGrantedPermissions(me.data);
}

export function useDirectory() {
  const { slug, api } = useCrm();
  const query = useQuery({
    queryKey: crmKeys.directory(slug),
    queryFn: async () => (await api.directory()).members,
    staleTime: REFERENCE_STALE_MS,
  });
  const members = useMemo(() => query.data ?? [], [query.data]);
  const byId = useMemo(() => new Map(members.map((m) => [m.id, m.name])), [members]);
  const nameOf = useCallback(
    (id: string | null | undefined) => (id ? (byId.get(id) ?? id) : ''),
    [byId],
  );
  return { members, nameOf, isPending: query.isPending };
}

export function useTags() {
  const { slug, api } = useCrm();
  const query = useQuery({
    queryKey: crmKeys.tags(slug),
    queryFn: () => fetchAllPages((cursor) => api.tags.list({ cursor })),
    staleTime: REFERENCE_STALE_MS,
  });
  const tags = useMemo(() => query.data ?? [], [query.data]);
  const byId = useMemo(() => new Map(tags.map((tag) => [tag.id, tag])), [tags]);
  return { ...query, tags, byId };
}

export function useTagCategories() {
  const { slug, api } = useCrm();
  return useQuery({
    queryKey: crmKeys.tagCategories(slug),
    queryFn: async () => (await api.tagCategories.list()).data,
    staleTime: REFERENCE_STALE_MS,
  });
}

export function useCustomFields(entity: CustomFieldEntityPath) {
  const { slug, api } = useCrm();
  const query = useQuery({
    queryKey: crmKeys.customFields(slug, entity),
    queryFn: async () => (await api.customFields.list(entity)).data,
    staleTime: REFERENCE_STALE_MS,
  });
  const fields = useMemo(() => query.data ?? [], [query.data]);
  const byKey = useMemo(() => new Map(fields.map((field) => [field.key, field])), [fields]);
  return { ...query, fields, byKey };
}

export function useCustomFieldLayout(entity: CustomFieldEntityPath) {
  const { slug, api } = useCrm();
  return useQuery({
    queryKey: crmKeys.layout(slug, entity),
    queryFn: () => api.customFields.layout(entity),
    staleTime: REFERENCE_STALE_MS,
  });
}

export function useSearchFields(entity: SearchEntity) {
  const { slug, api } = useCrm();
  return useQuery({
    queryKey: crmKeys.searchFields(slug, entity),
    queryFn: async () => (await api.search.fields(entity)).data,
    staleTime: REFERENCE_STALE_MS,
  });
}

export function useLeadSources() {
  const { slug, api } = useCrm();
  return useQuery({
    queryKey: crmKeys.leadSources(slug),
    queryFn: async () => (await api.leadSources.list()).data,
    staleTime: REFERENCE_STALE_MS,
  });
}

export function usePipelines() {
  const { slug, api } = useCrm();
  return useQuery({
    queryKey: crmKeys.pipelines(slug),
    queryFn: async () => (await api.pipelines.list()).data,
    staleTime: REFERENCE_STALE_MS,
  });
}

export function useSavedSearches() {
  const { slug, api } = useCrm();
  return useQuery({
    queryKey: crmKeys.savedSearches(slug),
    queryFn: async () => (await api.savedSearches.list()).data,
  });
}

type Translate = ReturnType<typeof useI18n>['t'];

/** User-facing text for an API failure: permission, validation details, not found, generic. */
export function errorMessage(t: Translate, error: unknown): string {
  return apiErrorMessage(t, error, {
    forbidden: 'crm.error.forbidden',
    notFound: 'crm.error.notFound',
    conflict: 'crm.error.conflict',
    tooLarge: 'crm.error.tooLarge',
    validation: 'crm.error.validation',
  });
}

export type CrmMutationOptions<TInput, TResult> = ApiMutationOptions<TInput, TResult>;

/** `useMutation` with tenant cache invalidation and toasts for success and failure. */
export function useCrmMutation<TInput, TResult>(options: CrmMutationOptions<TInput, TResult>) {
  const { slug } = useCrm();
  return useApiMutation(options, crmKeys.root(slug), errorMessage);
}
