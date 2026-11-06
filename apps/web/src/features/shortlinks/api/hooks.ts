import type { Permission } from '@amable/core';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useMemo } from 'react';
import type { useI18n } from '../../../i18n';
import {
  apiErrorMessage,
  REFERENCE_STALE_MS,
  useApiMutation,
  useGrantedPermissions,
  type ApiErrorMessages,
  type ApiMutationOptions,
  useTenantMeQuery,
} from '../../../lib/feature-hooks';
import { tenantRoute } from '../../../routes/tenant';
import { shortlinksClient, type ShortlinksClient } from './client';

/** Every short link query of a tenant lives under ['shortlinks', slug, …]. */
export const shortlinkKeys = {
  root: (slug: string) => ['shortlinks', slug] as const,
  links: (slug: string, archived: boolean) => ['shortlinks', slug, 'links', archived] as const,
  folders: (slug: string) => ['shortlinks', slug, 'folders'] as const,
  domains: (slug: string) => ['shortlinks', slug, 'domains'] as const,
  stats: (slug: string, id: string, days: number) => ['shortlinks', slug, 'stats', id, days] as const,
};

export function useShortlinks(): { slug: string; api: ShortlinksClient } {
  const slug = useParams({ from: tenantRoute.id }).tenant;
  const api = useMemo(() => shortlinksClient(slug), [slug]);
  return { slug, api };
}

export function useShortlinkPermissions(): { can: (permission: Permission) => boolean; ready: boolean } {
  const { slug } = useShortlinks();
  const me = useTenantMeQuery(slug);
  return useGrantedPermissions(me.data);
}

export function useLinks(includeArchived: boolean) {
  const { slug, api } = useShortlinks();
  return useQuery({
    queryKey: shortlinkKeys.links(slug, includeArchived),
    queryFn: async () =>
      (await api.links.list(includeArchived ? { include_archived: 'true' } : {})).data,
  });
}

export function useFolders() {
  const { slug, api } = useShortlinks();
  return useQuery({
    queryKey: shortlinkKeys.folders(slug),
    queryFn: async () => (await api.folders.list()).data,
  });
}

export function useShortlinkDomains() {
  const { slug, api } = useShortlinks();
  return useQuery({
    queryKey: shortlinkKeys.domains(slug),
    queryFn: async () => (await api.domains()).data,
    staleTime: REFERENCE_STALE_MS,
  });
}

export function useLinkStats(id: string, days: number) {
  const { slug, api } = useShortlinks();
  return useQuery({
    queryKey: shortlinkKeys.stats(slug, id, days),
    queryFn: () => api.links.stats(id, days),
  });
}

type Translate = ReturnType<typeof useI18n>['t'];

const SHORTLINK_ERRORS: ApiErrorMessages = {
  forbidden: 'shortlinks.error.forbidden',
  notFound: 'shortlinks.error.notFound',
  conflict: 'shortlinks.error.conflict',
  validation: 'shortlinks.error.validation',
};

export function errorMessage(t: Translate, error: unknown): string {
  return apiErrorMessage(t, error, SHORTLINK_ERRORS);
}

/** `useMutation` with cache invalidation (whole feature) and toasts. */
export function useShortlinkMutation<TInput, TResult>(options: ApiMutationOptions<TInput, TResult>) {
  const { slug } = useShortlinks();
  return useApiMutation(options, shortlinkKeys.root(slug), errorMessage);
}
