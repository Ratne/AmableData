import type { Permission } from '@amable/core';
import { toast } from '@amable/ui';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';
import { useI18n } from '../../../i18n';
import { tenantRoute } from '../../../routes/tenant';
import { EsignApiError, esignClient, type EsignClient, type ListRequestsParams } from './client';

/** Every e-signature query of a tenant lives under ['esign', slug, …]. */
export const esignKeys = {
  root: (slug: string) => ['esign', slug] as const,
  me: (slug: string) => ['esign', slug, 'me'] as const,
  templates: (slug: string) => ['esign', slug, 'templates'] as const,
  template: (slug: string, id: string) => ['esign', slug, 'template', id] as const,
  requests: (slug: string, filter: string) => ['esign', slug, 'requests', filter] as const,
  request: (slug: string, id: string) => ['esign', slug, 'request', id] as const,
  contacts: (slug: string, q: string) => ['esign', slug, 'contacts', q] as const,
};

export function useEsign(): { slug: string; api: EsignClient } {
  const slug = useParams({ from: tenantRoute.id }).tenant;
  const api = useMemo(() => esignClient(slug), [slug]);
  return { slug, api };
}

/** Permissions of the active membership; actions stay hidden until known (the server enforces them). */
export function useEsignPermissions(): { can: (permission: Permission) => boolean; ready: boolean } {
  const { slug, api } = useEsign();
  const me = useQuery({ queryKey: esignKeys.me(slug), queryFn: () => api.me(), staleTime: 60_000, retry: false });
  const granted = useMemo(() => new Set(me.data?.permissions ?? []), [me.data]);
  const can = useCallback((permission: Permission) => granted.has(permission), [granted]);
  return { can, ready: me.data !== undefined };
}

export function useTemplates() {
  const { slug, api } = useEsign();
  return useQuery({ queryKey: esignKeys.templates(slug), queryFn: async () => (await api.templates.list()).data });
}

export function useTemplate(id: string) {
  const { slug, api } = useEsign();
  return useQuery({ queryKey: esignKeys.template(slug, id), queryFn: () => api.templates.get(id) });
}

export function useRequests(params: Omit<ListRequestsParams, 'cursor'>) {
  const { slug, api } = useEsign();
  return useInfiniteQuery({
    queryKey: esignKeys.requests(slug, JSON.stringify(params)),
    queryFn: ({ pageParam }) => api.requests.list({ ...params, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
}

export function useRequestDetail(id: string) {
  const { slug, api } = useEsign();
  return useQuery({
    queryKey: esignKeys.request(slug, id),
    queryFn: () => api.requests.get(id),
    // Signers act on their own: follow the request while it is open or being sealed.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data === undefined) return false;
      const open = data.status === 'sent' || data.status === 'partially_signed';
      const sealing = data.status === 'completed' && !data.document_ready && (data.finalize_error === null || data.finalize_next_attempt_at !== null);
      return open ? 30_000 : sealing ? 5_000 : false;
    },
  });
}

type Translate = ReturnType<typeof useI18n>['t'];

export function errorMessage(t: Translate, error: unknown): string {
  if (error instanceof EsignApiError) {
    if (error.status === 403) return t('esign.error.forbidden');
    if (error.status === 404) return t('esign.error.notFound');
    if (error.status === 409) return error.detail ?? t('esign.error.conflict');
    if (error.status === 413) return t('esign.error.tooLarge');
    if (error.status === 415) return error.detail ?? t('esign.error.validation');
    if (error.status === 422 || error.status === 400) {
      const first = error.details[0];
      if (first !== undefined && error.code === 'validation_failed' && first.path !== 'body') return first.path ? `${first.path}: ${first.message}` : first.message;
      return error.detail ?? t('esign.error.validation');
    }
  }
  return t('common.error');
}

export interface EsignMutationOptions<TInput, TResult> {
  readonly mutationFn: (input: TInput) => Promise<TResult>;
  /** Default: the whole tenant e-signature cache. */
  readonly invalidate?: readonly QueryKey[];
  readonly success?: string | ((result: TResult) => string);
  readonly onSuccess?: (result: TResult, input: TInput) => void;
}

/** `useMutation` with cache invalidation and toasts. */
export function useEsignMutation<TInput, TResult>(options: EsignMutationOptions<TInput, TResult>) {
  const { slug } = useEsign();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: options.mutationFn,
    onSuccess: async (result, input) => {
      const keys = options.invalidate ?? [esignKeys.root(slug)];
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

/** Dates of the audit trail in the browser's locale and time zone. */
export function useEsignDates() {
  const { locale } = useI18n();
  return useMemo(() => {
    const full = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
    const precise = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' });
    const day = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
    const fmt = (format: Intl.DateTimeFormat) => (iso: string | null | undefined) => {
      if (!iso) return '—';
      const ms = Date.parse(iso);
      return Number.isNaN(ms) ? '—' : format.format(ms);
    };
    return { dateTime: fmt(full), precise: fmt(precise), day: fmt(day) };
  }, [locale]);
}
