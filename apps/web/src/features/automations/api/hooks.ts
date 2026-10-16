import type { AutomationStatus } from '@amable/api-types';
import { toast } from '@amable/ui';
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useI18n } from '../../../i18n';
import { CrmApiError } from '../../crm/api/client';
import { errorMessage, usePermissions, useTenantSlug } from '../../crm/api/hooks';
import { automationClient, type AutomationClient } from './client';

export const automationKeys = {
  root: (slug: string) => ['automations', slug] as const,
  list: (slug: string, status: AutomationStatus | 'all', folder: Record<string, string> = {}) =>
    ['automations', slug, 'list', status, folder] as const,
  detail: (slug: string, id: string) => ['automations', slug, 'detail', id] as const,
  versions: (slug: string, id: string) => ['automations', slug, 'detail', id, 'versions'] as const,
  stats: (slug: string, id: string) => ['automations', slug, 'detail', id, 'stats'] as const,
  enrollments: (slug: string, id: string) =>
    ['automations', slug, 'detail', id, 'enrollments'] as const,
  references: (slug: string, path: string) => ['automations', slug, 'references', path] as const,
};

export function useAutomationApi(): { slug: string; api: AutomationClient } {
  const slug = useTenantSlug();
  const api = useMemo(() => automationClient(slug), [slug]);
  return { slug, api };
}

/** `automations:read|write|publish` of the active membership (`GET /api/t/:slug/me`). */
export function useAutomationPermissions() {
  const { can, ready } = usePermissions();
  return {
    ready,
    canRead: can('automations:read'),
    canWrite: can('automations:write'),
    canPublish: can('automations:publish'),
    canTrigger: can('automations:trigger'),
  };
}

export function useAutomations(
  status: AutomationStatus | 'all',
  folder: { folder_id?: string; include_subfolders?: 'true' } = {},
) {
  const { slug, api } = useAutomationApi();
  return useQuery({
    queryKey: automationKeys.list(slug, status, folder),
    queryFn: async () => (await api.list({ ...(status === 'all' ? {} : { status }), ...folder })).data,
  });
}

/** Reference list of another module; `null` when the endpoint is not available (yet). */
export function useReferences(path: string, enabled = true) {
  const { slug, api } = useAutomationApi();
  return useQuery({
    queryKey: automationKeys.references(slug, path),
    queryFn: async () => {
      try {
        return await api.references(path);
      } catch (error) {
        if (error instanceof CrmApiError && (error.status === 404 || error.status === 405))
          return null;
        throw error;
      }
    },
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

export function isConflict(error: unknown): boolean {
  return error instanceof CrmApiError && error.status === 409;
}

export interface AutomationMutationOptions<TInput, TResult> {
  readonly mutationFn: (input: TInput) => Promise<TResult>;
  readonly invalidate?: readonly QueryKey[];
  readonly success?: string | ((result: TResult) => string);
  readonly onSuccess?: (result: TResult, input: TInput) => void;
  readonly onError?: (error: unknown) => boolean | void;
}

/** `useMutation` with cache invalidation and toasts (an `onError` returning true silences the toast). */
export function useAutomationMutation<TInput, TResult>(
  options: AutomationMutationOptions<TInput, TResult>,
) {
  const { slug } = useAutomationApi();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: options.mutationFn,
    onSuccess: async (result, input) => {
      const keys = options.invalidate ?? [automationKeys.root(slug)];
      await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
      if (options.success !== undefined) {
        toast.success(
          typeof options.success === 'function' ? options.success(result) : options.success,
        );
      }
      options.onSuccess?.(result, input);
    },
    onError: (error) => {
      if (options.onError?.(error) === true) return;
      toast.error(errorMessage(t, error));
    },
  });
}
