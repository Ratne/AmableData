import type { Permission } from '@amable/core';
import { toast } from '@amable/ui';
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';
import { useI18n } from '../../../i18n';
import { tenantRoute } from '../../../routes/tenant';
import { LandingApiError, landingClient, type LandingClient } from './client';

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

const REFERENCE_STALE_MS = 60_000;

/** Permissions of the active membership; actions stay hidden until known (the server enforces them). */
export function usePermissions(): { can: (permission: Permission) => boolean; ready: boolean; userId: string | null } {
  const { slug, api } = useLanding();
  const me = useQuery({ queryKey: landingKeys.me(slug), queryFn: () => api.me(), staleTime: REFERENCE_STALE_MS, retry: false });
  const granted = useMemo(() => new Set(me.data?.permissions ?? []), [me.data]);
  const can = useCallback((permission: Permission) => granted.has(permission), [granted]);
  return { can, ready: me.data !== undefined, userId: me.data?.user?.id ?? null };
}

export function usePage(pageId: string) {
  const { slug, api } = useLanding();
  return useQuery({ queryKey: landingKeys.page(slug, pageId), queryFn: () => api.pages.get(pageId) });
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

export function errorMessage(t: Translate, error: unknown): string {
  if (error instanceof LandingApiError) {
    if (error.status === 403) return t('landing.error.forbidden');
    if (error.status === 404) return t('landing.error.notFound');
    if (error.status === 409 && error.code === 'stale_draft') return t('landing.error.staleDraft');
    if (error.status === 409) return error.detail ?? t('landing.error.conflict');
    if (error.status === 423) return t('landing.error.locked');
    if (error.status === 413) return t('landing.error.tooLarge');
    if (error.status === 422 || error.status === 400) {
      const first = error.details[0];
      if (first !== undefined) return first.path ? `${first.path}: ${first.message}` : first.message;
      return error.detail ?? t('landing.error.validation');
    }
  }
  return t('common.error');
}

export interface LandingMutationOptions<TInput, TResult> {
  readonly mutationFn: (input: TInput) => Promise<TResult>;
  /** Default: the whole tenant landing cache. */
  readonly invalidate?: readonly QueryKey[];
  readonly success?: string | ((result: TResult) => string);
  readonly onSuccess?: (result: TResult, input: TInput) => void;
}

/** `useMutation` with cache invalidation and toasts. */
export function useLandingMutation<TInput, TResult>(options: LandingMutationOptions<TInput, TResult>) {
  const { slug } = useLanding();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: options.mutationFn,
    onSuccess: async (result, input) => {
      const keys = options.invalidate ?? [landingKeys.root(slug)];
      await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
      if (options.success !== undefined) {
        toast.success(typeof options.success === 'function' ? options.success(result) : options.success);
      }
      options.onSuccess?.(result, input);
    },
    onError: (error) => {
      toast.error(errorMessage(t, error));
    },
  });
}
