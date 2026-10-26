import type { Permission } from '@amable/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useMemo } from 'react';
import { useI18n } from '../../../i18n';
import {
  apiErrorMessage,
  type ApiErrorMessages,
  type ApiMutationOptions,
  REFERENCE_STALE_MS,
  useApiMutation,
  useGrantedPermissions,
} from '../../../lib/feature-hooks';
import { tenantRoute } from '../../../routes/tenant';
import { landingClient, type LandingClient } from './client';

/** Every landing query of a tenant lives under ['landing', slug, …]. */
export const landingKeys = {
  root: (slug: string) => ['landing', slug] as const,
  me: (slug: string) => ['landing', slug, 'me'] as const,
  list: (slug: string, status: string, q: string) => ['landing', slug, 'list', status, q] as const,
  page: (slug: string, id: string) => ['landing', slug, 'page', id] as const,
  versions: (slug: string, id: string) => ['landing', slug, 'page', id, 'versions'] as const,
  savedSections: (slug: string) => ['landing', slug, 'savedSections'] as const,
  media: (slug: string) => ['landing', slug, 'media'] as const,
  lookup: (slug: string, what: string) => ['landing', slug, 'lookup', what] as const,
};

export function useLanding(): { slug: string; api: LandingClient } {
  const slug = useParams({ from: tenantRoute.id }).tenant;
  const api = useMemo(() => landingClient(slug), [slug]);
  return { slug, api };
}

/** Permissions of the active membership; actions stay hidden until known (the server enforces them). */
export function usePermissions(): {
  can: (permission: Permission) => boolean;
  ready: boolean;
  userId: string | null;
} {
  const { slug, api } = useLanding();
  const me = useQuery({
    queryKey: landingKeys.me(slug),
    queryFn: () => api.me(),
    staleTime: REFERENCE_STALE_MS,
    retry: false,
  });
  return { ...useGrantedPermissions(me.data), userId: me.data?.user?.id ?? null };
}

export function usePage(pageId: string) {
  const { slug, api } = useLanding();
  return useQuery({
    queryKey: landingKeys.page(slug, pageId),
    queryFn: () => api.pages.get(pageId),
  });
}

export function useAnalyticsSites() {
  const { slug, api } = useLanding();
  return useQuery({
    queryKey: landingKeys.lookup(slug, 'analyticsSites'),
    queryFn: () => api.lookups.analyticsSites(),
    staleTime: REFERENCE_STALE_MS,
    retry: false,
  });
}

export function useFormOptions() {
  const { slug, api } = useLanding();
  return useQuery({
    queryKey: landingKeys.lookup(slug, 'forms'),
    queryFn: () => api.lookups.forms(),
    staleTime: REFERENCE_STALE_MS,
    retry: false,
  });
}

export function useCheckoutOptions() {
  const { slug, api } = useLanding();
  return useQuery({
    queryKey: landingKeys.lookup(slug, 'checkouts'),
    queryFn: () => api.lookups.checkouts(),
    staleTime: REFERENCE_STALE_MS,
    retry: false,
  });
}

export function useEventTypeOptions() {
  const { slug, api } = useLanding();
  return useQuery({
    queryKey: landingKeys.lookup(slug, 'eventTypes'),
    queryFn: () => api.lookups.eventTypes(),
    staleTime: REFERENCE_STALE_MS,
    retry: false,
  });
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

const LANDING_ERRORS: ApiErrorMessages = {
  forbidden: 'landing.error.forbidden',
  notFound: 'landing.error.notFound',
  conflict: 'landing.error.conflict',
  tooLarge: 'landing.error.tooLarge',
  validation: 'landing.error.validation',
};

export function errorMessage(t: Translate, error: unknown): string {
  return apiErrorMessage(t, error, LANDING_ERRORS, (e) => {
    if (e.status === 409 && e.code === 'stale_draft') return t('landing.error.staleDraft');
    if (e.status === 423) return t('landing.error.locked');
    if (e.code === 'invalid_archive') return t('landing.transfer.invalidArchive');
    return null;
  });
}

export type LandingMutationOptions<TInput, TResult> = ApiMutationOptions<TInput, TResult>;

/** `useMutation` with cache invalidation and toasts. */
export function useLandingMutation<TInput, TResult>(
  options: LandingMutationOptions<TInput, TResult>,
) {
  const { slug } = useLanding();
  return useApiMutation(options, landingKeys.root(slug), errorMessage);
}
