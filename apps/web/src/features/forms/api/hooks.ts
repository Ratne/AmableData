import type { Permission } from '@amable/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useMemo } from 'react';
import { useI18n } from '../../../i18n';
import {
  apiErrorMessage,
  type ApiMutationOptions,
  REFERENCE_STALE_MS,
  useApiMutation,
  useGrantedPermissions,
} from '../../../lib/feature-hooks';
import { tenantRoute } from '../../../routes/tenant';
import { formsClient, type FormsClient } from './client';

/** Every forms query of a tenant lives under ['forms', slug, …]. */
export const formsKeys = {
  root: (slug: string) => ['forms', slug] as const,
  me: (slug: string) => ['forms', slug, 'me'] as const,
  list: (slug: string, status: string) => ['forms', slug, 'list', status] as const,
  form: (slug: string, id: string) => ['forms', slug, 'form', id] as const,
  embed: (slug: string, id: string) => ['forms', slug, 'form', id, 'embed'] as const,
  submissions: (slug: string, id: string) => ['forms', slug, 'form', id, 'submissions'] as const,
  connections: (slug: string, id: string) => ['forms', slug, 'form', id, 'connections'] as const,
  catalog: (slug: string) => ['forms', slug, 'catalog'] as const,
  crm: (slug: string, what: string) => ['forms', slug, 'crm', what] as const,
};

export function useForms(): { slug: string; api: FormsClient } {
  const slug = useParams({ from: tenantRoute.id }).tenant;
  const api = useMemo(() => formsClient(slug), [slug]);
  return { slug, api };
}

/** Permissions of the active membership; actions stay hidden until known (the server enforces them). */
export function usePermissions(): { can: (permission: Permission) => boolean; ready: boolean } {
  const { slug, api } = useForms();
  const me = useQuery({
    queryKey: formsKeys.me(slug),
    queryFn: () => api.me(),
    staleTime: REFERENCE_STALE_MS,
    retry: false,
  });
  return useGrantedPermissions(me.data);
}

export function useForm(formId: string) {
  const { slug, api } = useForms();
  return useQuery({ queryKey: formsKeys.form(slug, formId), queryFn: () => api.forms.get(formId) });
}

/** Contact custom fields, lead sources and members for the CRM mapping (tags: `TagPicker`). */
export function useCrmReferences() {
  const { slug, api } = useForms();
  const customFields = useQuery({
    queryKey: formsKeys.crm(slug, 'customFields'),
    queryFn: async () => (await api.crm.customFields()).data,
    staleTime: REFERENCE_STALE_MS,
  });
  const leadSources = useQuery({
    queryKey: formsKeys.crm(slug, 'leadSources'),
    queryFn: async () => (await api.crm.leadSources()).data,
    staleTime: REFERENCE_STALE_MS,
  });
  const members = useQuery({
    queryKey: formsKeys.crm(slug, 'members'),
    queryFn: async () => (await api.directory()).members,
    staleTime: REFERENCE_STALE_MS,
  });
  return {
    customFields: customFields.data ?? [],
    leadSources: leadSources.data ?? [],
    members: members.data ?? [],
  };
}

export function useDates(): { dateTime: (iso: string | null | undefined) => string } {
  const { locale } = useI18n();
  return useMemo(() => {
    const format = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
    return {
      dateTime: (iso) => {
        if (!iso) return '—';
        const ms = Date.parse(iso);
        return Number.isNaN(ms) ? '—' : format.format(ms);
      },
    };
  }, [locale]);
}

type Translate = ReturnType<typeof useI18n>['t'];

export function errorMessage(t: Translate, error: unknown): string {
  return apiErrorMessage(t, error, {
    forbidden: 'forms.error.forbidden',
    notFound: 'forms.error.notFound',
    validation: 'forms.error.validation',
  });
}

export type FormsMutationOptions<TInput, TResult> = ApiMutationOptions<TInput, TResult>;

/** `useMutation` with cache invalidation and toasts. */
export function useFormsMutation<TInput, TResult>(options: FormsMutationOptions<TInput, TResult>) {
  const { slug } = useForms();
  return useApiMutation(options, formsKeys.root(slug), errorMessage);
}
